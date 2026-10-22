//! Supervised Rust GPU process. NVIDIA's global runtime caches survive object
//! destruction, so process teardown is required to reliably release all VRAM.
use crate::{config::Config, gpu::Engine, protocol::MAX_FRAME};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs::File,
    io::{Read, Write},
    os::fd::{AsRawFd, FromRawFd, RawFd},
    os::unix::process::CommandExt,
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    time::{Duration, Instant},
};

pub struct GpuProcess {
    child: Child,
    input: ChildStdin,
    output: ChildStdout,
    frame: SharedFrame,
}
impl GpuProcess {
    pub fn spawn() -> Result<Self> {
        let frame = SharedFrame::create()?;
        let frame_fd = frame.file.as_raw_fd();
        let mut command = Command::new(std::env::current_exe()?);
        let parent = std::process::id() as libc::pid_t;
        // SAFETY: the post-fork closure performs only async-signal-safe Linux
        // syscalls, touches no locks, and checks the parent-death race.
        unsafe {
            command.pre_exec(move || {
                // Only this child inherits the anonymous frame store. Other
                // children retain CLOEXEC; no filesystem path exposes pixels.
                if libc::fcntl(frame_fd, libc::F_SETFD, 0) < 0 {
                    return Err(std::io::Error::last_os_error());
                }
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
            .arg("--frame-fd")
            .arg(frame_fd.to_string())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Cannot start the Rust GPU worker")?;
        Ok(Self {
            input: child.stdin.take().unwrap(),
            output: child.stdout.take().unwrap(),
            child,
            frame,
        })
    }
    pub fn process(
        &mut self,
        bytes: &[u8],
        quality: u32,
        scale: f64,
        reset: bool,
    ) -> Result<(Vec<u8>, Value)> {
        let started = Instant::now();
        self.frame.write(bytes)?;
        let copy_ms = started.elapsed().as_secs_f64() * 1000.;
        let meta = serde_json::to_vec(
            &json!({"quality":quality,"scale":scale,"length":bytes.len(),"reset":reset}),
        )?;
        write_packet(&mut self.input, &meta)?;
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
        meta["shared_copy_ms"] = json!(copy_ms);
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

// One bounded, reusable input slot. The dispatcher writes it before sending a
// command through stdin and cannot reuse it until the complete response arrives.
// The child maps it read-only and completes all GPU access before replying.
// Pipes provide the inter-process ordering; there is never concurrent access.
struct SharedFrame {
    file: File,
    address: *mut libc::c_void,
    writable: bool,
}
impl SharedFrame {
    fn create() -> Result<Self> {
        // SAFETY: constant NUL-terminated name and valid Linux memfd flags.
        let fd = unsafe {
            libc::memfd_create(
                c"rtx-vsr-frame".as_ptr(),
                libc::MFD_CLOEXEC | libc::MFD_ALLOW_SEALING,
            )
        };
        ensure!(
            fd >= 0,
            "Cannot create shared frame memory: {}",
            std::io::Error::last_os_error()
        );
        // SAFETY: successful memfd_create returned a fresh owned descriptor.
        let file = unsafe { File::from_raw_fd(fd) };
        file.set_len(MAX_FRAME as u64)?;
        // Prevent accidental truncation/SIGBUS in either mapping. Pages are
        // allocated on demand: the 64 MiB limit is not eagerly initialized.
        // SAFETY: descriptor is owned, command and flags are valid for memfd.
        ensure!(
            unsafe {
                libc::fcntl(
                    fd,
                    libc::F_ADD_SEALS,
                    libc::F_SEAL_GROW | libc::F_SEAL_SHRINK | libc::F_SEAL_SEAL,
                )
            } >= 0,
            "Cannot seal shared frame memory: {}",
            std::io::Error::last_os_error()
        );
        Self::map(file, true)
    }
    fn inherited(fd: RawFd) -> Result<Self> {
        ensure!(fd >= 3, "Missing inherited GPU frame descriptor");
        // Duplicate rather than taking ownership of a caller-supplied fd.
        // SAFETY: fcntl validates fd; a successful duplicate is independently owned.
        let duplicate = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 3) };
        ensure!(duplicate >= 0, "Invalid inherited GPU frame descriptor");
        // SAFETY: successful fcntl returned a fresh owned descriptor.
        let file = unsafe { File::from_raw_fd(duplicate) };
        // SAFETY: query only, on the independently owned file descriptor.
        let seals = unsafe { libc::fcntl(duplicate, libc::F_GET_SEALS) };
        let required = libc::F_SEAL_GROW | libc::F_SEAL_SHRINK;
        ensure!(
            seals >= 0
                && seals & required == required
                && file.metadata()?.len() == MAX_FRAME as u64,
            "GPU frame store must be a sealed 64 MiB memfd"
        );
        Self::map(file, false)
    }
    fn map(file: File, writable: bool) -> Result<Self> {
        let protection = libc::PROT_READ | if writable { libc::PROT_WRITE } else { 0 };
        // SAFETY: sealed file has the exact mapping length, offset is aligned,
        // and ownership below keeps both mapping and descriptor alive.
        let address = unsafe {
            libc::mmap(
                std::ptr::null_mut(),
                MAX_FRAME,
                protection,
                libc::MAP_SHARED,
                file.as_raw_fd(),
                0,
            )
        };
        ensure!(
            address != libc::MAP_FAILED,
            "Cannot map GPU frame store: {}",
            std::io::Error::last_os_error()
        );
        Ok(Self {
            file,
            address,
            writable,
        })
    }
    fn write(&mut self, bytes: &[u8]) -> Result<()> {
        ensure!(
            self.writable && bytes.len() <= MAX_FRAME,
            "Invalid shared frame write"
        );
        // SAFETY: writable mapping covers bytes.len(), source is separate
        // WebSocket storage, and process() owns the slot until its reply.
        unsafe {
            std::ptr::copy_nonoverlapping(bytes.as_ptr(), self.address.cast::<u8>(), bytes.len())
        };
        Ok(())
    }
    fn read(&self, length: usize) -> Result<&[u8]> {
        ensure!(length <= MAX_FRAME, "Invalid shared frame length");
        // SAFETY: mapping is live and sealed against shrinking. The parent
        // cannot overwrite it until this command has completed and replied.
        Ok(unsafe { std::slice::from_raw_parts(self.address.cast::<u8>(), length) })
    }
}
impl Drop for SharedFrame {
    fn drop(&mut self) {
        // SAFETY: exactly the live mapping created in map(), unmapped once.
        unsafe { libc::munmap(self.address, MAX_FRAME) };
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
pub fn run(config: &Config, frame_fd: RawFd) -> Result<()> {
    let frame = SharedFrame::inherited(frame_fd)?;
    let mut input = std::io::stdin().lock();
    let mut output = std::io::stdout().lock();
    let mut engine = None;
    while let Some(meta) = read_packet(&mut input, 2048)? {
        let result = (|| -> Result<(Vec<u8>, Value)> {
            let meta: Value = serde_json::from_slice(&meta)?;
            let length = meta["length"]
                .as_u64()
                .context("Missing GPU frame length")?;
            let bytes = frame.read(usize::try_from(length)?)?;
            let quality = meta["quality"].as_u64().context("Invalid quality")?;
            ensure!(quality <= 4, "Invalid quality");
            let scale = meta["scale"].as_f64().context("Invalid scale")?;
            let reset = meta["reset"].as_bool().context("Invalid stream reset")?;
            crate::config::validate_settings(quality as u32, scale)?;
            crate::protocol::Frame::parse(bytes)?;
            if engine.is_none() {
                engine = Some(Engine::new(config)?);
            }
            engine
                .as_mut()
                .unwrap()
                .process(bytes, quality as u32, scale, reset)
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

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_frames_reuse_storage_and_reject_invalid_bounds() {
        let mut writer = SharedFrame::create().unwrap();
        let mut reader = SharedFrame::inherited(writer.file.as_raw_fd()).unwrap();
        let bytes = vec![37; 1920 * 1080 * 3 / 2 + 32];
        writer.write(&bytes).unwrap();
        assert_eq!(reader.read(bytes.len()).unwrap(), bytes);
        writer.write(&[1, 2, 3]).unwrap();
        assert_eq!(reader.read(3).unwrap(), [1, 2, 3]);
        assert!(reader.read(MAX_FRAME + 1).is_err());
        assert!(reader.write(&[0]).is_err());
        assert!(writer.file.set_len(0).is_err());
        assert!(SharedFrame::inherited(-1).is_err());
        let unsealed = tempfile::tempfile().unwrap();
        assert!(SharedFrame::inherited(unsealed.as_raw_fd()).is_err());
    }
}
