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
    os::{
        fd::AsRawFd,
        unix::{
            net::{UnixListener, UnixStream},
            process::CommandExt,
        },
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
// Upload-only sockets a session still expects, by the secret it handed out.
struct Uplinks {
    senders: Vec<Option<mpsc::SyncSender<Bytes>>>,
    ended: Arc<AtomicBool>,
}
struct Shared {
    grants: Mutex<HashMap<String, Instant>>,
    uplinks: Mutex<HashMap<String, Uplinks>>,
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
    reset: bool,
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
        uplinks: Mutex::new(HashMap::new()),
        last: Mutex::new(Instant::now()),
        stop: AtomicBool::new(false),
        streaming: AtomicBool::new(false),
        connections: AtomicUsize::new(0),
        loaded: AtomicBool::new(false),
    });
    // One slot covers the reply-to-receive handoff: try_send on a rendezvous
    // channel can report "busy" just after the worker has completed a reply.
    // The sole stream still awaits each result before submitting another job.
    let (tx, rx) = mpsc::sync_channel::<Job>(1);
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
                        engine.as_mut().unwrap().process(
                            &job.bytes,
                            job.quality,
                            job.scale,
                            job.reset,
                        )
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
            // A session is a primary socket plus up to MAX_UPLINKS uploads;
            // leave room for a restarting session to overlap the old one.
            if shared.connections.fetch_add(1, Ordering::Relaxed) < 2 * (MAX_UPLINKS + 1) + 4 {
                let shared = shared.clone();
                let tx = tx.clone();
                let origin = origin.clone();
                thread::spawn(move || {
                    let _guard = Connection(shared.clone());
                    if let Err(e) = stream(socket, &origin, shared, tx)
                        && !closed_by_peer(&e)
                    {
                        eprintln!("Stream ended: {e:#}");
                    }
                });
            } else {
                shared.connections.fetch_sub(1, Ordering::Relaxed);
            }
        }
        // Wake as soon as either listener has a client instead of adding up to
        // 20 ms to every grant/stream start; the timeout re-checks stop/idle.
        let mut ready = [control.as_raw_fd(), tcp.as_raw_fd()].map(|fd| libc::pollfd {
            fd,
            events: libc::POLLIN,
            revents: 0,
        });
        // SAFETY: two initialized pollfds for listeners that outlive the call.
        unsafe { libc::poll(ready.as_mut_ptr(), ready.len() as libc::nfds_t, 100) };
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
// Removing the extension iframe terminates its worker without a closing
// handshake. That is the normal end of a session, not a backend failure.
fn closed_by_peer(error: &anyhow::Error) -> bool {
    use tungstenite::error::{Error, ProtocolError};
    match error.downcast_ref::<Error>() {
        Some(Error::ConnectionClosed | Error::AlreadyClosed) => true,
        Some(Error::Protocol(ProtocolError::ResetWithoutClosingHandshake)) => true,
        Some(Error::Io(error)) => matches!(
            error.kind(),
            std::io::ErrorKind::ConnectionReset | std::io::ErrorKind::BrokenPipe
        ),
        _ => false,
    }
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
                Ok(json!({"token":shared.grant()?,"port":port,"protocol":3}))
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
    let frame_limits = |config: &mut WebSocketConfig| {
        config.max_message_size = Some(MAX_FRAME);
        config.max_frame_size = Some(MAX_FRAME);
    };
    if let Some(secret) = auth["uplink"].as_str() {
        ws.set_config(frame_limits);
        return uplink(ws, &shared, secret, auth["index"].as_u64());
    }
    if auth["protocol"] != 3 {
        ws.send(Message::text(json!({"type":"error","message":"AV1 streaming requires matching application and extension versions; reload both"}).to_string()))?;
        return Ok(());
    }
    ensure!(
        shared.claim(auth["token"].as_str().unwrap_or("")),
        "Session authorization expired; enable enhancement again"
    );
    ws.set_config(frame_limits);
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
    let ended = Arc::new(AtomicBool::new(false));
    // Browsers bound WebSocket upload per worker thread (~127 MB/s measured),
    // below 1080p60 NV12. The extension can spread frames round-robin over
    // upload-only sockets from separate workers; this session reads them back
    // in that order and still sends every result over the primary socket.
    let count = auth["uplinks"].as_u64().unwrap_or(0) as usize;
    ensure!(count <= MAX_UPLINKS, "Invalid uplink count");
    let (senders, receivers): (Vec<_>, Vec<_>) =
        (0..count).map(|_| mpsc::sync_channel::<Bytes>(1)).unzip();
    let secret = token();
    if count > 0 {
        shared.uplinks.lock().unwrap().insert(
            secret.clone(),
            Uplinks {
                senders: senders.into_iter().map(Some).collect(),
                ended: ended.clone(),
            },
        );
    }
    let _uplinks = UplinkLease(&shared, &secret, &ended);
    ws.send(Message::text(
        json!({"type":"ready","protocol":3,"uplink":(count > 0).then_some(&secret)}).to_string(),
    ))?;
    // Overlap reading/validating the next capture, GPU work on the current one
    // and sending the previous result. Serially these added several ms per
    // frame and left too little headroom at 60 fps. From here this thread only
    // reads; the writer owns every outgoing message on a cloned socket. The
    // reader's tungstenite state writes only automatic ping/close replies.
    let mut output = tungstenite::WebSocket::from_raw_socket(
        ws.get_ref().try_clone()?,
        tungstenite::protocol::Role::Server,
        Some(ws_config),
    );
    let ended = &*ended;
    // Bounded like the extension's in-flight window; a slow writer blocks
    // reading instead of queueing raw frames.
    let (outgoing, results) = mpsc::sync_channel::<Outgoing>(MAX_IN_FLIGHT);
    thread::scope(|scope| {
        // Moving the receiver in means an exited writer fails further sends
        // instead of leaving the reader blocked on a full channel.
        let writer = scope.spawn(move || {
            let result = send_results(&mut output, &results);
            ended.store(true, Ordering::Relaxed);
            result
        });
        let read = if receivers.is_empty() {
            read_frames(
                primary_frames(&mut ws, &shared, ended),
                &shared,
                &tx,
                &outgoing,
                quality,
                scale,
            )
        } else {
            // The primary socket now only signals the end of the session.
            let watcher = scope.spawn(|| {
                let result = watch_primary(&mut ws, &shared, ended);
                ended.store(true, Ordering::Relaxed);
                result
            });
            let read = read_frames(
                uplink_frames(&receivers, &shared, ended),
                &shared,
                &tx,
                &outgoing,
                quality,
                scale,
            );
            ended.store(true, Ordering::Relaxed);
            read.and(
                watcher
                    .join()
                    .unwrap_or_else(|_| Err(anyhow::anyhow!("Stream watcher panicked"))),
            )
        };
        drop(outgoing);
        let written = writer
            .join()
            .unwrap_or_else(|_| Err(anyhow::anyhow!("Stream writer panicked")));
        read.and(written)
    })
}
// Matches extension/src/frame-budget.ts MAX_IN_FLIGHT.
const MAX_IN_FLIGHT: usize = 4;
enum Outgoing {
    Frame {
        received_wall_ms: f64,
        dispatch_at: Instant,
        reply: mpsc::Receiver<Reply>,
    },
    Error(String),
}
fn wall_ms() -> Result<f64> {
    Ok(std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)?
        .as_secs_f64()
        * 1000.)
}
fn read_frames(
    mut next: impl FnMut() -> Result<Option<Bytes>>,
    shared: &Shared,
    tx: &mpsc::SyncSender<Job>,
    outgoing: &mpsc::SyncSender<Outgoing>,
    quality: u32,
    scale: f64,
) -> Result<()> {
    // A decoder belongs to one connection, while the GPU process survives short
    // pauses/seeks. Every new connection must start a fresh prediction chain.
    let mut first_frame = true;
    while let Some(bytes) = next()? {
        // Reject malformed or oversized frames here. A worker-side
        // failure restarts the GPU process and forces a cold model load.
        if let Err(error) =
            crate::protocol::Frame::parse(&bytes).and_then(|frame| frame.output(scale))
        {
            let _ = outgoing.send(Outgoing::Error(format!("{error:#}")));
            break;
        }
        let received_wall_ms = wall_ms()?;
        let dispatch_at = Instant::now();
        shared.touch();
        let (reply, rx) = mpsc::sync_channel(1);
        let job = Job {
            bytes,
            quality,
            scale,
            reset: first_frame,
            reply,
        };
        first_frame = false;
        // Blocks only while the GPU thread holds one running and one
        // queued job; this connection's lease excludes other streams.
        if tx.send(job).is_err() {
            let _ = outgoing.send(Outgoing::Error("GPU worker stopped".into()));
            break;
        }
        if outgoing
            .send(Outgoing::Frame {
                received_wall_ms,
                dispatch_at,
                reply: rx,
            })
            .is_err()
        {
            break;
        }
    }
    Ok(())
}
// Poll often enough for stop(), but tolerate short capture stalls on
// buffered/transitioning players without dropping an authorized stream.
const STALL: Duration = Duration::from_secs(15);
fn timed_out(error: &tungstenite::Error) -> bool {
    matches!(error, tungstenite::Error::Io(error) if matches!(
        error.kind(),
        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
    ))
}
// Frames sent on the primary socket itself; None at the end of the stream.
fn primary_frames<'a>(
    ws: &'a mut tungstenite::WebSocket<TcpStream>,
    shared: &'a Shared,
    ended: &'a AtomicBool,
) -> impl FnMut() -> Result<Option<Bytes>> + 'a {
    let mut last_frame = Instant::now();
    move || {
        while !shared.stop.load(Ordering::Relaxed) && !ended.load(Ordering::Relaxed) {
            match ws.read() {
                Ok(Message::Binary(bytes)) => {
                    last_frame = Instant::now();
                    return Ok(Some(bytes));
                }
                Ok(Message::Close(_)) => break,
                // tungstenite answers pings itself while reading.
                Ok(Message::Ping(_) | Message::Pong(_)) => {}
                Ok(_) => bail!("Expected binary video frame"),
                Err(error) if timed_out(&error) && last_frame.elapsed() < STALL => {}
                Err(error) => return Err(error.into()),
            }
        }
        Ok(None)
    }
}
// Frames from the uplinks in the extension's round-robin send order, so the
// encoder's prediction chain sees them exactly as captured.
fn uplink_frames<'a>(
    receivers: &'a [mpsc::Receiver<Bytes>],
    shared: &'a Shared,
    ended: &'a AtomicBool,
) -> impl FnMut() -> Result<Option<Bytes>> + 'a {
    let (mut index, mut last_frame) = (0, Instant::now());
    move || {
        while !shared.stop.load(Ordering::Relaxed) && !ended.load(Ordering::Relaxed) {
            match receivers[index].recv_timeout(Duration::from_millis(500)) {
                Ok(bytes) => {
                    index = (index + 1) % receivers.len();
                    last_frame = Instant::now();
                    return Ok(Some(bytes));
                }
                Err(mpsc::RecvTimeoutError::Timeout) if last_frame.elapsed() < STALL => {}
                Err(mpsc::RecvTimeoutError::Timeout) => bail!("No video frame for 15 seconds"),
                // A closed uplink ends the session, as a closed primary does.
                Err(mpsc::RecvTimeoutError::Disconnected) => break,
            }
        }
        Ok(None)
    }
}
fn watch_primary(
    ws: &mut tungstenite::WebSocket<TcpStream>,
    shared: &Shared,
    ended: &AtomicBool,
) -> Result<()> {
    while !shared.stop.load(Ordering::Relaxed) && !ended.load(Ordering::Relaxed) {
        match ws.read() {
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Ok(_) => bail!("Frames must use the session's uplinks"),
            Err(error) if timed_out(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
const MAX_UPLINKS: usize = 4;
// Withdraws unclaimed uplink slots and stops joined uplinks with the session.
struct UplinkLease<'a>(&'a Shared, &'a str, &'a AtomicBool);
impl Drop for UplinkLease<'_> {
    fn drop(&mut self) {
        self.2.store(true, Ordering::Relaxed);
        self.0.uplinks.lock().unwrap().remove(self.1);
    }
}
// An upload-only socket joining an authorized session. Each index is claimed
// once; frames are handed over unparsed and validated by the session reader.
fn uplink(
    mut ws: tungstenite::WebSocket<TcpStream>,
    shared: &Shared,
    secret: &str,
    index: Option<u64>,
) -> Result<()> {
    let (frames, ended) = {
        let mut uplinks = shared.uplinks.lock().unwrap();
        let slot = uplinks
            .get_mut(secret)
            .context("Upload session expired; enable enhancement again")?;
        let frames = index
            .and_then(|i| slot.senders.get_mut(usize::try_from(i).ok()?))
            .and_then(Option::take)
            .context("Invalid or duplicate upload socket")?;
        (frames, slot.ended.clone())
    };
    while !shared.stop.load(Ordering::Relaxed) && !ended.load(Ordering::Relaxed) {
        match ws.read() {
            Ok(Message::Binary(bytes)) => {
                if frames.send(bytes).is_err() {
                    break;
                }
            }
            Ok(Message::Close(_)) => break,
            Ok(Message::Ping(_) | Message::Pong(_)) => {}
            Ok(_) => bail!("Expected binary video frame"),
            Err(error) if timed_out(&error) => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(())
}
fn send_results(
    ws: &mut tungstenite::WebSocket<TcpStream>,
    results: &mpsc::Receiver<Outgoing>,
) -> Result<()> {
    let error = |ws: &mut tungstenite::WebSocket<TcpStream>, message: String| {
        ws.send(Message::text(
            json!({"type":"error","message":message}).to_string(),
        ))
    };
    // Results arrive in submission order: one GPU thread runs jobs FIFO.
    for item in results {
        let (received_wall_ms, dispatch_at, reply) = match item {
            Outgoing::Frame {
                received_wall_ms,
                dispatch_at,
                reply,
            } => (received_wall_ms, dispatch_at, reply),
            Outgoing::Error(message) => {
                error(ws, message)?;
                break;
            }
        };
        match reply.recv_timeout(Duration::from_secs(30))? {
            Ok((bytes, mut stats)) => {
                stats["response_bytes"] = json!(bytes.len());
                stats["received_wall_ms"] = json!(received_wall_ms);
                stats["dispatch_ms"] = json!(dispatch_at.elapsed().as_secs_f64() * 1000.);
                stats["completed_wall_ms"] = json!(wall_ms()?);
                ws.send(Message::text(stats.to_string()))?;
                ws.send(Message::Binary(bytes.into()))?;
            }
            Err(e) => {
                error(ws, format!("{e:#}"))?;
                break;
            }
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
            uplinks: Mutex::new(HashMap::new()),
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
