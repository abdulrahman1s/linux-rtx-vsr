use crate::{
    config::{Config, Paths, atomic_write},
    protocol::MAX_FRAME,
    worker::GpuProcess,
};
use anyhow::{Context, Result, bail, ensure};
use fs2::FileExt;
use rand::RngCore;
use serde_json::{Value, json};
use std::{
    collections::HashMap,
    fs,
    io::{BufRead, BufReader, Write},
    net::{TcpListener, TcpStream},
    os::unix::{
        net::{UnixListener, UnixStream},
        process::CommandExt,
    },
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicUsize, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
use tungstenite::{
    Bytes, Message,
    handshake::server::{ErrorResponse, Request, Response},
    protocol::WebSocketConfig,
};

pub const HOST: &str = "io.github.abdulrahman1s.linux_rtx_vsr";
pub const EXTENSION_ID: &str = "pdobgdmlfcnimbnndkchfocncchfoadm";
pub fn token() -> String {
    let mut b = [0u8; 32];
    rand::thread_rng().fill_bytes(&mut b);
    b.iter().map(|v| format!("{v:02x}")).collect()
}
struct Shared {
    grants: Mutex<HashMap<String, Instant>>,
    last: Mutex<Instant>,
    stop: AtomicBool,
    streaming: AtomicBool,
    connections: AtomicUsize,
    loaded: AtomicBool,
}
impl Shared {
    fn touch(&self) {
        *self.last.lock().unwrap() = Instant::now();
    }
    fn grant(&self) -> Result<String> {
        let mut grants = self.grants.lock().unwrap();
        grants.retain(|_, at| at.elapsed() < Duration::from_secs(15));
        ensure!(
            grants.len() < 32,
            "Too many pending session requests; wait 15 seconds"
        );
        let key = token();
        grants.insert(key.clone(), Instant::now());
        Ok(key)
    }
    fn claim(&self, key: &str) -> bool {
        self.grants
            .lock()
            .unwrap()
            .remove(key)
            .is_some_and(|at| at.elapsed() < Duration::from_secs(15))
    }
}
pub fn request(paths: &Paths, message: Value) -> Result<Value> {
    let mut socket = UnixStream::connect(paths.state.join("control.sock"))
        .context("Backend is stopped; run linux-rtx-vsr start")?;
    socket.set_read_timeout(Some(Duration::from_secs(5)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    serde_json::to_writer(&mut socket, &message)?;
    socket.write_all(b"\n")?;
    let mut line = String::new();
    BufReader::new(socket).take_line(&mut line)?;
    let response: Value = serde_json::from_str(&line)?;
    if let Some(error) = response.get("error") {
        bail!("{}", error.as_str().unwrap_or("Backend error"));
    }
    Ok(response)
}
trait LimitedLine {
    fn take_line(&mut self, line: &mut String) -> Result<usize>;
}
impl<T: BufRead> LimitedLine for T {
    fn take_line(&mut self, line: &mut String) -> Result<usize> {
        use std::io::Read;
        let n = self.take(65537).read_line(line)?;
        ensure!(n <= 65536, "Control message exceeds 64 KiB");
        Ok(n)
    }
}
pub fn start(paths: &Paths) -> Result<Value> {
    paths.init()?;
    paths.load()?;
    if let Ok(v) = request(paths, json!({"op":"status"})) {
        return Ok(v);
    }
    let log_path = paths.state.join("backend.log");
    if fs::metadata(&log_path).is_ok_and(|m| m.len() > 1024 * 1024) {
        fs::rename(&log_path, paths.state.join("backend.previous.log"))?;
    }
    let log = fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(log_path)?;
    let mut child = Command::new(std::env::current_exe()?)
        .arg("daemon")
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(log)
        .spawn()?;
    for _ in 0..100 {
        if let Ok(v) = request(paths, json!({"op":"status"})) {
            return Ok(v);
        }
        if let Some(status) = child.try_wait()? {
            if let Ok(v) = request(paths, json!({"op":"status"})) {
                return Ok(v);
            }
            bail!(
                "Backend exited with {status}. Inspect {}",
                paths.state.join("backend.log").display()
            );
        }
        thread::sleep(Duration::from_millis(50));
    }
    bail!(
        "Backend did not become ready in 5 seconds; inspect {}",
        paths.state.join("backend.log").display()
    )
}
pub fn stop(paths: &Paths) -> Result<()> {
    // No PID files or signals: never kill an unrelated recycled PID.
    let lock_path = paths.state.join("backend.lock");
    if !lock_path.exists() {
        return Ok(());
    }
    let lock = fs::OpenOptions::new()
        .read(true)
        .write(true)
        .open(lock_path)?;
    if lock.try_lock_exclusive().is_ok() {
        return Ok(());
    }
    if paths.state.join("control.sock").exists() {
        request(paths, json!({"op":"stop"}))?;
    }
    for _ in 0..100 {
        if lock.try_lock_exclusive().is_ok() {
            return Ok(());
        }
        thread::sleep(Duration::from_millis(50));
    }
    bail!("Backend is still finishing a GPU call; retry stop after it completes")
}
type Reply = Result<(Vec<u8>, Value)>;
struct Job {
    bytes: Bytes,
    quality: u32,
    scale: f64,
    reply: mpsc::SyncSender<Reply>,
}
pub fn run(paths: Paths, config: Config) -> Result<()> {
    paths.init()?;
    let lock = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(paths.state.join("backend.lock"))?;
    lock.try_lock_exclusive()
        .context("A backend is already running")?;
    let control_path = paths.state.join("control.sock");
    let _ = fs::remove_file(&control_path);
    let control = UnixListener::bind(&control_path)?;
    let tcp = TcpListener::bind(("127.0.0.1", 0))?;
    let port = tcp.local_addr()?.port();
    control.set_nonblocking(true)?;
    tcp.set_nonblocking(true)?;
    let shared = Arc::new(Shared {
        grants: Mutex::new(HashMap::new()),
        last: Mutex::new(Instant::now()),
        stop: AtomicBool::new(false),
        streaming: AtomicBool::new(false),
        connections: AtomicUsize::new(0),
        loaded: AtomicBool::new(false),
    });
    let (tx, rx) = mpsc::sync_channel::<Job>(0);
    let gpu_shared = shared.clone();
    let gpu_config = config.clone();
    let worker = thread::spawn(move || {
        let mut engine: Option<GpuProcess> = None;
        loop {
            match rx.recv_timeout(Duration::from_secs(gpu_config.gpu_idle_seconds)) {
                Ok(job) => {
                    let result = (|| {
                        if engine.is_none() {
                            engine = Some(GpuProcess::spawn()?);
                            gpu_shared.loaded.store(true, Ordering::Relaxed);
                        }
                        engine
                            .as_mut()
                            .unwrap()
                            .process(&job.bytes, job.quality, job.scale)
                    })();
                    if result.is_err() {
                        engine = None;
                        gpu_shared.loaded.store(false, Ordering::Relaxed);
                    }
                    let _ = job.reply.send(result);
                }
                Err(mpsc::RecvTimeoutError::Timeout) => {
                    engine = None;
                    gpu_shared.loaded.store(false, Ordering::Relaxed);
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
    });
    atomic_write(
        &paths.state.join("endpoint.json"),
        &serde_json::to_vec(&json!({"port":port,"pid":std::process::id()}))?,
        0o600,
    )?;
    let origin = format!(
        "chrome-extension://{}",
        config.extension_id.as_deref().unwrap_or(EXTENSION_ID)
    );
    while !shared.stop.load(Ordering::Relaxed)
        && shared.last.lock().unwrap().elapsed() < Duration::from_secs(config.idle_seconds)
    {
        if let Ok((socket, _)) = control.accept() {
            let shared = shared.clone();
            // Control handlers are bounded too. Do not let a stalled local
            // client block stop/status or create unbounded background threads.
            if shared.connections.fetch_add(1, Ordering::Relaxed) < 8 {
                thread::spawn(move || {
                    let _guard = Connection(shared.clone());
                    let _ = control_client(socket, &shared, port);
                });
            } else {
                shared.connections.fetch_sub(1, Ordering::Relaxed);
            }
        }
        if let Ok((socket, _)) = tcp.accept() {
            if shared.connections.fetch_add(1, Ordering::Relaxed) < 8 {
                let shared = shared.clone();
                let tx = tx.clone();
                let origin = origin.clone();
                thread::spawn(move || {
                    let _guard = Connection(shared.clone());
                    if let Err(e) = stream(socket, &origin, shared, tx) {
                        eprintln!("Stream ended: {e:#}");
                    }
                });
            } else {
                shared.connections.fetch_sub(1, Ordering::Relaxed);
            }
        }
        thread::sleep(Duration::from_millis(20));
    }
    shared.stop.store(true, Ordering::Relaxed);
    drop(control);
    drop(tcp);
    let _ = fs::remove_file(control_path);
    let _ = fs::remove_file(paths.state.join("endpoint.json"));
    // Existing client threads have a three-second read deadline and release
    // their sender. A driver call cannot be safely interrupted in-process.
    drop(tx);
    let _ = worker.join();
    Ok(())
}
struct Connection(Arc<Shared>);
impl Drop for Connection {
    fn drop(&mut self) {
        self.0.connections.fetch_sub(1, Ordering::Relaxed);
    }
}
struct Session(Arc<Shared>);
impl Drop for Session {
    fn drop(&mut self) {
        self.0.streaming.store(false, Ordering::Relaxed);
    }
}
fn control_client(mut socket: UnixStream, shared: &Shared, port: u16) -> Result<()> {
    socket.set_read_timeout(Some(Duration::from_secs(2)))?;
    socket.set_write_timeout(Some(Duration::from_secs(2)))?;
    let mut line = String::new();
    BufReader::new(socket.try_clone()?).take_line(&mut line)?;
    let result = (|| -> Result<Value> {
        let request: Value = serde_json::from_str(&line)?;
        match request["op"].as_str() {
            Some("status") => Ok(
                json!({"running":true,"pid":std::process::id(),"gpu_loaded":shared.loaded.load(Ordering::Relaxed),"streaming":shared.streaming.load(Ordering::Relaxed)}),
            ),
            Some("stop") => {
                shared.stop.store(true, Ordering::Relaxed);
                Ok(json!({"stopping":true}))
            }
            Some("grant") => {
                shared.touch();
                Ok(json!({"token":shared.grant()?,"port":port,"protocol":2}))
            }
            _ => bail!("Unknown control operation"),
        }
    })();
    serde_json::to_writer(
        &mut socket,
        &result.unwrap_or_else(|e| json!({"error":format!("{e:#}")})),
    )?;
    socket.write_all(b"\n")?;
    Ok(())
}
#[allow(clippy::result_large_err)] // tungstenite requires this exact callback result type.
fn stream(
    socket: TcpStream,
    origin: &str,
    shared: Arc<Shared>,
    tx: mpsc::SyncSender<Job>,
) -> Result<()> {
    socket.set_nodelay(true)?;
    socket.set_read_timeout(Some(Duration::from_secs(3)))?;
    socket.set_write_timeout(Some(Duration::from_secs(3)))?;
    let origin = origin.to_owned();
    let callback = move |request: &Request,
                         response: Response|
          -> std::result::Result<Response, ErrorResponse> {
        if request.uri().path() != "/v1/stream"
            || request
                .headers()
                .get("origin")
                .and_then(|s| s.to_str().ok())
                != Some(origin.as_str())
        {
            let mut r = ErrorResponse::new(Some("Extension origin required".into()));
            *r.status_mut() = tungstenite::http::StatusCode::FORBIDDEN;
            return Err(r);
        }
        Ok(response)
    };
    let ws_config = WebSocketConfig::default()
        .max_message_size(Some(2048))
        .max_frame_size(Some(2048))
        .max_write_buffer_size(MAX_FRAME * 2)
        .write_buffer_size(0);
    let mut ws = tungstenite::accept_hdr_with_config(socket, callback, Some(ws_config))?;
    let auth = ws.read()?;
    ensure!(auth.len() <= 2048, "Authentication message too large");
    let auth: Value = serde_json::from_str(auth.to_text()?)?;
    if auth["protocol"] != 2 {
        ws.send(Message::text(json!({"type":"error","message":"AV1 streaming requires matching application and extension versions; reload both"}).to_string()))?;
        return Ok(());
    }
    ensure!(
        shared.claim(auth["token"].as_str().unwrap_or("")),
        "Session authorization expired; enable enhancement again"
    );
    ws.set_config(|config| {
        config.max_message_size = Some(MAX_FRAME);
        config.max_frame_size = Some(MAX_FRAME);
    });
    // Removing an iframe closes its worker/socket asynchronously. Allow the
    // previous session to release its lease during rapid seek/fullscreen
    // restart, without taking over an active stream from another tab.
    let lease_deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if shared
            .streaming
            .compare_exchange(false, true, Ordering::Relaxed, Ordering::Relaxed)
            .is_ok()
        {
            break;
        }
        if Instant::now() >= lease_deadline {
            ws.send(Message::text(
                json!({"type":"error","message":"Another tab is enhancing. Disable it first."})
                    .to_string(),
            ))?;
            return Ok(());
        }
        thread::sleep(Duration::from_millis(10));
    }
    let _session = Session(shared.clone());
    let quality = auth["quality"].as_u64().context("Missing quality")?;
    ensure!(quality <= 4, "Invalid quality");
    let quality = quality as u32;
    let scale = auth["scale"].as_f64().context("Missing scale")?;
    crate::config::validate_settings(quality, scale)?;
    ws.send(Message::text(
        json!({"type":"ready","protocol":2}).to_string(),
    ))?;
    while !shared.stop.load(Ordering::Relaxed) {
        match ws.read()? {
            Message::Binary(bytes) => {
                let received_wall_ms = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)?
                    .as_secs_f64()
                    * 1000.;
                let dispatch_at = Instant::now();
                shared.touch();
                let (reply, rx) = mpsc::sync_channel(1);
                let job = Job {
                    bytes,
                    quality,
                    scale,
                    reply,
                };
                if tx.try_send(job).is_err() {
                    ws.send(Message::text(json!({"type":"error","message":"GPU worker busy; enable again in a moment"}).to_string()))?;
                    break;
                }
                match rx.recv_timeout(Duration::from_secs(30))? {
                    Ok((bytes, mut stats)) => {
                        stats["response_bytes"] = json!(bytes.len());
                        stats["received_wall_ms"] = json!(received_wall_ms);
                        stats["dispatch_ms"] = json!(dispatch_at.elapsed().as_secs_f64() * 1000.);
                        stats["completed_wall_ms"] = json!(
                            std::time::SystemTime::now()
                                .duration_since(std::time::UNIX_EPOCH)?
                                .as_secs_f64()
                                * 1000.
                        );
                        ws.send(Message::text(stats.to_string()))?;
                        ws.send(Message::Binary(bytes.into()))?;
                    }
                    Err(error) => {
                        ws.send(Message::text(
                            json!({"type":"error","message":format!("{error:#}")}).to_string(),
                        ))?;
                        break;
                    }
                }
            }
            Message::Close(_) => break,
            Message::Ping(b) => ws.send(Message::Pong(b))?,
            _ => bail!("Expected binary video frame"),
        }
    }
    Ok(())
}
pub fn native_host(paths: &Paths, origin: &str) -> Result<()> {
    let config = paths.load()?;
    let expected = format!(
        "chrome-extension://{}/",
        config.extension_id.as_deref().unwrap_or(EXTENSION_ID)
    );
    ensure!(
        origin == expected,
        "Native messaging origin does not match installed extension"
    );
    use std::io::Read;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    loop {
        let mut length = [0u8; 4];
        match input.read(&mut length[..1]) {
            Ok(0) => break,
            Ok(_) => input.read_exact(&mut length[1..])?,
            Err(e) => return Err(e.into()),
        }
        let length = u32::from_le_bytes(length) as usize;
        ensure!(length <= 65536, "Native message exceeds 64 KiB");
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes)?;
        let response = (|| -> Result<Value> {
            let v: Value = serde_json::from_slice(&bytes)?;
            match v["op"].as_str() {
                Some("grant") => {
                    start(paths)?;
                    request(paths, json!({"op":"grant"}))
                }
                Some("status") => {
                    Ok(request(paths, json!({"op":"status"})).unwrap_or(json!({"running":false})))
                }
                _ => bail!("Unknown browser operation"),
            }
        })()
        .unwrap_or_else(|e| json!({"error":format!("{e:#}")}));
        let bytes = serde_json::to_vec(&response)?;
        output.write_all(&(bytes.len() as u32).to_le_bytes())?;
        output.write_all(&bytes)?;
        output.flush()?;
    }
    Ok(())
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn grants_are_single_use_expiring_and_bounded() {
        let s = Shared {
            grants: Mutex::new(HashMap::new()),
            last: Mutex::new(Instant::now()),
            stop: AtomicBool::new(false),
            streaming: AtomicBool::new(false),
            connections: AtomicUsize::new(0),
            loaded: AtomicBool::new(false),
        };
        let g = s.grant().unwrap();
        assert!(s.claim(&g));
        assert!(!s.claim(&g));
        s.grants
            .lock()
            .unwrap()
            .insert("old".into(), Instant::now() - Duration::from_secs(16));
        assert!(!s.claim("old"));
        for _ in 0..32 {
            s.grant().unwrap();
        }
        assert!(s.grant().is_err());
    }
}
