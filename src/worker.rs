//! Supervised Rust GPU process. NVIDIA's global runtime caches survive object
//! destruction, so process teardown is required to reliably release all VRAM.
use crate::{config::Config, gpu::Engine, protocol::MAX_FRAME};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    os::fd::AsRawFd,
    os::unix::process::CommandExt,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};

pub struct GpuProcess {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
}
impl GpuProcess {
    pub fn spawn() -> Result<Self> {
        let mut command = Command::new(std::env::current_exe()?);
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: the post-fork closure performs only async-signal-safe Linux
        // syscalls, touches no locks, and checks the parent-death race.
        unsafe {
            command.pre_exec(move || {
                if libc::prctl(
                    libc::PR_SET_PDEATHSIG,
                    libc::SIGKILL,
                    0 as libc::c_ulong,
                    0 as libc::c_ulong,
                    0 as libc::c_ulong,
                ) != 0
                {
                    return Err(std::io::Error::last_os_error());
                }
                if libc::getppid() != parent {
                    libc::_exit(1);
                }
                Ok(())
            });
        }
        let mut child = command
            .arg("gpu-worker")
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Cannot start the Rust GPU worker")?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: child.stdout.take().unwrap(),
            child,
        })
    }
    pub fn process(&mut self, bytes: &[u8], quality: u32, scale: f64) -> Result<(Vec<u8>, Value)> {
        let started = Instant::now();
        let meta = serde_json::to_vec(&json!({"quality":quality,"scale":scale}))?;
        write_packet(&mut self.input, &meta)?;
        write_packet(&mut self.input, bytes)?;
        self.input.flush()?;
        let deadline = Instant::now() + Duration::from_secs(30);
        let meta = self.read_packet(8192, deadline)?;
        let mut meta: Value = serde_json::from_slice(&meta)
            .context("GPU worker protocol failed; check backend.log")?;
        let bytes = self.read_packet(MAX_FRAME, deadline)?;
        if let Some(error) = meta["error"].as_str() {
            anyhow::bail!("{error}");
        }
        meta["worker_round_trip_ms"] = json!(started.elapsed().as_secs_f64() * 1000.);
        Ok((bytes, meta))
    }
    fn read_packet(&mut self, limit: usize, deadline: Instant) -> Result<Vec<u8>> {
        let mut length = [0u8; 4];
        self.read_until(&mut length, deadline)?;
        let length = u32::from_le_bytes(length) as usize;
        ensure!(
            length <= limit,
            "GPU worker response exceeds protocol bounds"
        );
        let mut bytes = vec![0; length];
        self.read_until(&mut bytes, deadline)?;
        Ok(bytes)
    }
    fn read_until(&mut self, mut bytes: &mut [u8], deadline: Instant) -> Result<()> {
        while !bytes.is_empty() {
            let remaining = deadline.saturating_duration_since(Instant::now());
            ensure!(
                !remaining.is_zero(),
                "NVIDIA worker exceeded 30 seconds and will be restarted. Check driver logs / available VRAM, then enable again"
            );
            let mut poll = libc::pollfd {
                fd: self.output.as_raw_fd(),
                events: libc::POLLIN,
                revents: 0,
            };
            // SAFETY: one initialized pollfd, its descriptor remains owned by
            // this object, and the timeout is bounded to thirty seconds.
            let result =
                unsafe { libc::poll(&mut poll, 1, remaining.as_millis().min(30000) as i32) };
            if result < 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    continue;
                }
                return Err(error.into());
            }
            ensure!(
                result > 0,
                "NVIDIA worker timed out; enable again to restart it and inspect driver logs"
            );
            let count = self.output.read(bytes)?;
            ensure!(
                count > 0,
                "NVIDIA worker exited unexpectedly. Run doctor --gpu and inspect backend.log"
            );
            bytes = &mut bytes[count..];
        }
        Ok(())
    }
}
impl Drop for GpuProcess {
    fn drop(&mut self) {
        // This is an owned Child, never an externally supplied/recycled PID.
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
fn write_packet(output: &mut impl Write, bytes: &[u8]) -> Result<()> {
    ensure!(bytes.len() <= MAX_FRAME, "GPU packet exceeds 64 MiB");
    output.write_all(&(bytes.len() as u32).to_le_bytes())?;
    output.write_all(bytes)?;
    Ok(())
}
fn read_packet(input: &mut impl Read, limit: usize) -> Result<Option<Vec<u8>>> {
    let mut length = [0; 4];
    match input.read(&mut length[..1])? {
        0 => return Ok(None),
        _ => input.read_exact(&mut length[1..])?,
    }
    let length = u32::from_le_bytes(length) as usize;
    ensure!(length <= limit, "Invalid GPU input length");
    let mut bytes = vec![0; length];
    input.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}
pub fn run(config: &Config) -> Result<()> {
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut engine = None;
    while let Some(meta) = read_packet(&mut input, 2048)? {
        let bytes = read_packet(&mut input, MAX_FRAME)?.context("Missing GPU frame payload")?;
        let result = (|| -> Result<(Vec<u8>, Value)> {
            let meta: Value = serde_json::from_slice(&meta)?;
            let quality = meta["quality"].as_u64().context("Invalid quality")?;
            ensure!(quality <= 4, "Invalid quality");
            let scale = meta["scale"].as_f64().context("Invalid scale")?;
            crate::config::validate_settings(quality as u32, scale)?;
            crate::protocol::Frame::parse(&bytes)?;
            if engine.is_none() {
                engine = Some(Engine::new(config)?);
            }
            engine
                .as_mut()
                .unwrap()
                .process(&bytes, quality as u32, scale)
        })();
        let (bytes, meta) = match result {
            Ok(result) => result,
            Err(error) => {
                engine = None;
                (vec![], json!({"error":format!("{error:#}")}))
            }
        };
        write_packet(&mut output, &serde_json::to_vec(&meta)?)?;
        write_packet(&mut output, &bytes)?;
        output.flush()?;
    }
    Ok(())
}
