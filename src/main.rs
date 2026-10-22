mod config;
mod daemon;
mod gpu;
mod protocol;
mod worker;
#[cfg(not(all(target_os = "linux", target_arch = "x86_64")))]
compile_error!("linux-rtx-vsr currently supports Linux x86-64 only");
use anyhow::{Context, Result, ensure};
use clap::{Parser, Subcommand};
use config::{Paths, atomic_write};
use serde_json::json;
use std::{
    fs,
    path::{Path, PathBuf},
    process::Command,
    time::Instant,
};
include!(concat!(env!("OUT_DIR"), "/assets.rs"));

#[derive(Parser)]
#[command(version, about = "Local NVIDIA VideoSuperRes for Chromium on Linux")]
struct Cli {
    #[command(subcommand)]
    command: Commands,
}
#[derive(Subcommand)]
enum Commands {
    /// Start the idle-managed backend (also started by the browser on demand).
    Start,
    /// Request a clean shutdown without sending signals to PIDs.
    Stop,
    /// Show actual process and GPU allocation state.
    Status,
    /// Check prerequisites; --gpu runs actual VideoSuperRes inference.
    Doctor {
        #[arg(long)]
        gpu: bool,
    },
    /// Persistent settings; changes take effect after restarting the backend.
    Config {
        #[command(subcommand)]
        action: ConfigAction,
    },
    /// Export the bundled extension for Chromium's Load unpacked button.
    Extension {
        #[arg(long)]
        output: Option<PathBuf>,
    },
    /// Install or remove a native messaging manifest for this user.
    Integration {
        #[command(subcommand)]
        action: IntegrationAction,
    },
    /// Benchmark actual NVIDIA inference with deterministic generated SDR input.
    Benchmark {
        #[arg(long, default_value_t = 120)]
        frames: u32,
        #[arg(long, default_value_t = 640)]
        width: u32,
        #[arg(long, default_value_t = 360)]
        height: u32,
        #[arg(long)]
        output: Option<PathBuf>,
    },
    #[command(hide = true)]
    Daemon,
    #[command(hide = true)]
    NativeHost {
        origin: String,
        #[arg(trailing_var_arg = true)]
        _extra: Vec<String>,
    },
    #[command(hide = true)]
    GpuWorker,
}
#[derive(Subcommand)]
enum ConfigAction {
    Show,
    Path,
    Reset,
    Set { key: String, value: String },
}
#[derive(Subcommand)]
enum IntegrationAction {
    Install {
        #[arg(long, default_value = "chromium")]
        browser: String,
        #[arg(long)]
        manifest_dir: Option<PathBuf>,
        #[arg(long,default_value=daemon::EXTENSION_ID)]
        extension_id: String,
    },
    Remove {
        #[arg(long, default_value = "chromium")]
        browser: String,
        #[arg(long)]
        manifest_dir: Option<PathBuf>,
    },
}
fn main() {
    if let Err(e) = run() {
        eprintln!("linux-rtx-vsr: {e:#}");
        std::process::exit(1);
    }
}
fn run() -> Result<()> {
    let cli = Cli::parse();
    let paths = Paths::discover()?;
    match cli.command {
        Commands::Start => println!("{}", serde_json::to_string_pretty(&daemon::start(&paths)?)?),
        Commands::Stop => {
            daemon::stop(&paths)?;
            println!("Backend stopped");
        }
        Commands::Status => println!(
            "{}",
            serde_json::to_string_pretty(
                &daemon::request(&paths, json!({"op":"status"}))
                    .unwrap_or(json!({"running":false}))
            )?
        ),
        Commands::Daemon => daemon::run(paths.clone(), paths.load()?)?,
        Commands::NativeHost { origin, .. } => daemon::native_host(&paths, &origin)?,
        Commands::GpuWorker => worker::run(&paths.load()?)?,
        Commands::Config { action } => match action {
            ConfigAction::Show => println!("{}", serde_json::to_string_pretty(&paths.load()?)?),
            ConfigAction::Path => println!("{}", paths.config.join("config.json").display()),
            ConfigAction::Reset => paths.save(&config::Config::default())?,
            ConfigAction::Set { key, value } => {
                paths.set(&key, &value)?;
                println!("Saved. Restart the backend to apply changes.");
            }
        },
        Commands::Extension { output } => {
            export(&output.unwrap_or_else(|| paths.data.join("extension")))?;
        }
        Commands::Integration { action } => integration(&paths, action)?,
        Commands::Doctor { gpu } => doctor(&paths, gpu)?,
        Commands::Benchmark {
            frames,
            width,
            height,
            output,
        } => benchmark(&paths, frames, width, height, output.as_deref())?,
    }
    Ok(())
}
fn export(output: &Path) -> Result<()> {
    ensure!(!ASSETS.is_empty(), "Extension assets were not bundled");
    fs::create_dir_all(output)?;
    for (name, bytes) in ASSETS {
        let p = output.join(name);
        fs::create_dir_all(p.parent().unwrap())?;
        atomic_write(&p, bytes, 0o644)?;
    }
    println!(
        "Load unpacked extension from {}",
        output.canonicalize()?.display()
    );
    Ok(())
}
fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}
fn integration(paths: &Paths, action: IntegrationAction) -> Result<()> {
    paths.init()?;
    match action {
        IntegrationAction::Install {
            browser,
            manifest_dir,
            extension_id,
        } => {
            config::validate_id(&extension_id)?;
            let dir = manifest_dir
                .map(Ok)
                .unwrap_or_else(|| config::browser_dir(&browser))?;
            fs::create_dir_all(&dir)?;
            let executable = std::env::var_os("LINUX_RTX_VSR_EXECUTABLE")
                .map(PathBuf::from)
                .unwrap_or(std::env::current_exe()?)
                .canonicalize()?;
            let launcher = paths.data.join("native-host");
            let text = format!(
                "#!/bin/sh\nexec {} native-host \"$@\"\n",
                shell_quote(
                    executable
                        .to_str()
                        .context("Executable path must be UTF-8")?
                )
            );
            atomic_write(&launcher, text.as_bytes(), 0o700)?;
            let manifest = dir.join(format!("{}.json", daemon::HOST));
            atomic_write(
                &manifest,
                &serde_json::to_vec_pretty(
                    &json!({"name":daemon::HOST,"description":"Linux RTX VSR native integration","path":launcher,"type":"stdio","allowed_origins":[format!("chrome-extension://{extension_id}/")]}),
                )?,
                0o600,
            )?;
            let mut c = paths.load()?;
            c.extension_id = Some(extension_id);
            paths.save(&c)?;
            export(&paths.data.join("extension"))?;
            let record_path = paths.state.join("integrations.json");
            let mut records: serde_json::Map<String, serde_json::Value> = if record_path.exists() {
                serde_json::from_slice(&fs::read(&record_path)?)?
            } else {
                Default::default()
            };
            records.insert(manifest.to_string_lossy().into_owned(), json!(executable));
            atomic_write(&record_path, &serde_json::to_vec_pretty(&records)?, 0o600)?;
            println!(
                "Installed {}\nReload the extension and refresh video tabs. Run doctor to check runtime setup.",
                manifest.display()
            );
        }
        IntegrationAction::Remove {
            browser,
            manifest_dir,
        } => {
            let dir = manifest_dir
                .map(Ok)
                .unwrap_or_else(|| config::browser_dir(&browser))?;
            let manifest = dir.join(format!("{}.json", daemon::HOST));
            if manifest.exists() {
                let v: serde_json::Value = serde_json::from_slice(&fs::read(&manifest)?)?;
                ensure!(
                    v["name"] == daemon::HOST
                        && v["path"] == paths.data.join("native-host").to_string_lossy().as_ref(),
                    "Manifest belongs to a different installation; inspect {}",
                    manifest.display()
                );
                fs::remove_file(&manifest)?;
            }
            let record_path = paths.state.join("integrations.json");
            if record_path.exists() {
                let mut records: serde_json::Map<String, serde_json::Value> =
                    serde_json::from_slice(&fs::read(&record_path)?)?;
                records.remove(manifest.to_string_lossy().as_ref());
                atomic_write(&record_path, &serde_json::to_vec_pretty(&records)?, 0o600)?;
            }
            println!(
                "Removed native integration from {}. Remove the extension in chrome://extensions.",
                dir.display()
            );
        }
    }
    Ok(())
}
fn doctor(paths: &Paths, gpu: bool) -> Result<()> {
    let c = paths.load()?;
    println!(
        "linux-rtx-vsr {} / {}-{}",
        env!("CARGO_PKG_VERSION"),
        std::env::consts::OS,
        std::env::consts::ARCH
    );
    println!(
        "Config: {}\nState: {}",
        paths.config.display(),
        paths.state.display()
    );
    let mut failures = 0;
    let mut report = |label: &str, ok: bool, advice: &str| {
        println!(
            "{} {label}{}",
            if ok { "OK" } else { "FAIL" },
            if ok {
                String::new()
            } else {
                format!(": {advice}")
            }
        );
        if !ok {
            failures += 1;
        }
    };
    let smi = Command::new("nvidia-smi")
        .args([
            "--query-gpu=name,driver_version,memory.total,compute_cap",
            "--format=csv,noheader",
        ])
        .output();
    let ok = smi.as_ref().is_ok_and(|v| v.status.success());
    report(
        "NVIDIA driver query",
        ok,
        "Install a supported NVIDIA driver and ensure nvidia-smi is on PATH",
    );
    if let Ok(output) = smi {
        println!("{}", String::from_utf8_lossy(&output.stdout).trim());
        if output.status.success() {
            let line = String::from_utf8_lossy(&output.stdout);
            let fields = line
                .lines()
                .next()
                .unwrap_or("")
                .split(',')
                .map(str::trim)
                .collect::<Vec<_>>();
            let driver = fields
                .get(1)
                .unwrap_or(&"")
                .split('.')
                .filter_map(|n| n.parse::<u32>().ok())
                .collect::<Vec<_>>();
            let supported = match driver.as_slice() {
                [570, minor, ..] => *minor >= 190,
                [580, minor, ..] => *minor >= 82,
                [590, minor, ..] => *minor >= 44,
                [major, ..] => *major > 590,
                _ => false,
            };
            report(
                "GPU 0 VSR driver minimum",
                supported,
                "Use NVIDIA's supported 570.190+, 580.82+, or 590.44+ driver branch",
            );
            let capability = fields
                .get(3)
                .and_then(|s| s.parse::<f64>().ok())
                .unwrap_or(0.);
            report(
                "GPU 0 Tensor Core architecture",
                capability >= 7.5,
                "Initial target requires an RTX Turing or later GPU; run doctor --gpu to validate actual SDK support",
            );
        }
    }
    if let Some(model) = &c.model_dir {
        report(
            "Model directory",
            model.is_dir(),
            "Set model_dir to the SDK model folder, or null for the bundled runtime",
        );
    }
    for name in [
        "libVideoFX.so",
        "libNVCVImage.so",
        "libnvVFXVideoSuperRes.so",
        "libnvidia-ngx-vsr.so.1.8.3",
    ] {
        report(
            name,
            c.sdk_dir.join(name).is_file(),
            &format!(
                "Set sdk_dir to VFX 1.3 libraries; current path {}. See docs/runtime.md",
                c.sdk_dir.display()
            ),
        );
    }
    // SAFETY: only opens the configured library to check dynamic resolution.
    let jpeg = unsafe { libloading::Library::new(&c.jpeg_library) };
    report(
        "nvJPEG dynamic loader",
        jpeg.is_ok(),
        &format!(
            "Set jpeg_library to libnvjpeg.so (CUDA 12/13). Loader: {:?}",
            jpeg.err()
        ),
    );
    let mut found = false;
    let mut manifests = Vec::new();
    for browser in ["chromium", "chrome", "brave"] {
        manifests.push((
            format!("{browser} user"),
            config::browser_dir(browser)?.join(format!("{}.json", daemon::HOST)),
        ));
    }
    for (browser, dir) in [
        ("chromium", "/etc/chromium/native-messaging-hosts"),
        ("chrome/brave", "/etc/opt/chrome/native-messaging-hosts"),
    ] {
        manifests.push((
            format!("{browser} system"),
            Path::new(dir).join(format!("{}.json", daemon::HOST)),
        ));
    }
    for (browser, p) in manifests {
        if p.exists() {
            found = true;
            let valid = fs::read(&p)
                .ok()
                .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
                .is_some_and(|v| {
                    v["path"].as_str().is_some_and(|p| Path::new(p).is_file())
                        && v["allowed_origins"]
                            == json!([format!(
                                "chrome-extension://{}/",
                                c.extension_id.as_deref().unwrap_or(daemon::EXTENSION_ID)
                            )])
                });
            report(
                &format!("{browser} native manifest"),
                valid,
                "For Nix-managed integration, rebuild the configuration; otherwise re-run integration install",
            );
        }
    }
    let record_path = paths.state.join("integrations.json");
    if record_path.exists() {
        let records: serde_json::Map<String, serde_json::Value> =
            serde_json::from_slice(&fs::read(record_path)?)?;
        for (manifest, exe) in records {
            let valid = Path::new(&manifest).is_file()
                && exe.as_str().is_some_and(|p| Path::new(p).is_file());
            found |= valid;
            report(
                &format!("Recorded integration {manifest}"),
                valid,
                "Re-run integration install for this browser/profile after moving or updating the executable",
            );
        }
    }
    let extension_manifest = paths.data.join("extension/manifest.json");
    let version_ok = fs::read(&extension_manifest)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .is_some_and(|v| v["version"] == env!("CARGO_PKG_VERSION"));
    report(
        "Exported extension version",
        version_ok,
        "Re-run integration install or extension, then reload it in chrome://extensions and refresh video tabs",
    );
    report(
        "Browser native integration",
        found,
        "Run integration install --browser chromium (custom manifest directories must be inspected separately)",
    );
    println!(
        "Browser WebCodecs, CORS, audible sync, and visible overlay require the browser fixture; native checks cannot certify them."
    );
    if gpu {
        println!("Running real cold-start NVIDIA inference (not a substitute scaler)...");
        benchmark(paths, 3, 640, 360, None)?;
    }
    ensure!(
        failures == 0,
        "{failures} prerequisite check(s) failed; follow the recovery steps above"
    );
    Ok(())
}
fn benchmark(
    paths: &Paths,
    frames: u32,
    width: u32,
    height: u32,
    output: Option<&Path>,
) -> Result<()> {
    ensure!((1..=10000).contains(&frames), "frames must be 1–10000");
    ensure!(
        (64..=1920).contains(&width) && (64..=1080).contains(&height),
        "Benchmark source must be 64×64 through 1920×1080"
    );
    let config = paths.load()?;
    let mut bytes = vec![0; protocol::HEADER + width as usize * height as usize * 4];
    bytes[..4].copy_from_slice(b"RVS1");
    bytes[4..8].copy_from_slice(&width.to_le_bytes());
    bytes[8..12].copy_from_slice(&height.to_le_bytes());
    for y in 0..height {
        for x in 0..width {
            let i = protocol::HEADER + (y as usize * width as usize + x as usize) * 4;
            bytes[i..i + 4].copy_from_slice(&[
                ((x * 255 / width) ^ ((y / 16) % 2 * 63)) as u8,
                (y * 255 / height) as u8,
                ((x + y) % 256) as u8,
                255,
            ]);
        }
    }
    let start = Instant::now();
    let mut engine = gpu::Engine::new(&config)?;
    let load_ms = start.elapsed().as_secs_f64() * 1000.;
    let mut times = Vec::new();
    let mut jpeg = Vec::new();
    let mut first_ms = 0.;
    let mut total_bytes = 0;
    for n in 0..frames {
        bytes[16..20].copy_from_slice(&n.to_le_bytes());
        bytes[24..32].copy_from_slice(&(n as f64 / 60.).to_le_bytes());
        let at = Instant::now();
        let (b, _) = engine.process(&bytes, config.quality, config.scale)?;
        let ms = at.elapsed().as_secs_f64() * 1000.;
        if n == 0 {
            first_ms = ms;
        } else {
            times.push(ms);
        }
        total_bytes += b.len();
        jpeg = b;
    }
    let seconds = start.elapsed().as_secs_f64();
    times.sort_by(f64::total_cmp);
    if let Some(path) = output {
        fs::write(path, &jpeg)?;
    }
    let p = |q: f64| {
        times
            .get(((times.len().saturating_sub(1)) as f64 * q).round() as usize)
            .copied()
    };
    println!(
        "{}",
        serde_json::to_string_pretty(
            &json!({"version":env!("CARGO_PKG_VERSION"),"source":[width,height],"scale":config.scale,"quality":config.quality,"jpeg_quality":config.jpeg_quality,"frames":frames,"runtime_load_ms":load_ms,"first_frame_ms":first_ms,"warm_p50_ms":p(0.5),"warm_p95_ms":p(0.95),"overall_fps":frames as f64/seconds,"mean_output_bytes":total_bytes/frames as usize,"transport":"direct Rust SDK benchmark; excludes browser capture, transport, presentation and audio"})
        )?
    );
    Ok(())
}
