use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(default, deny_unknown_fields)]
pub struct Config {
    pub sdk_dir: PathBuf,
    // Accepted solely for upgrading old configuration; JPEG is no longer used.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jpeg_library: Option<PathBuf>,
    pub model_dir: Option<PathBuf>,
    pub extension_id: Option<String>,
    pub idle_seconds: u64,
    pub gpu_idle_seconds: u64,
    pub quality: u32,
    pub scale: f64,
    pub encode_qp: u32,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub jpeg_quality: Option<u32>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            sdk_dir: dirs::data_local_dir()
                .unwrap_or_default()
                .join("linux-rtx-vsr/runtime/nvvfx/libs"),
            jpeg_library: None,
            model_dir: None,
            extension_id: None,
            idle_seconds: 60,
            gpu_idle_seconds: 5,
            quality: 3,
            scale: 2.0,
            encode_qp: 14,
            jpeg_quality: None,
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (10..=3600).contains(&self.idle_seconds),
            "idle_seconds must be 10–3600"
        );
        ensure!(
            (1..=60).contains(&self.gpu_idle_seconds),
            "gpu_idle_seconds must be 1–60"
        );
        ensure!(
            self.gpu_idle_seconds < self.idle_seconds,
            "gpu_idle_seconds must be less than idle_seconds"
        );
        validate_settings(self.quality, self.scale)?;
        ensure!(
            self.encode_qp <= 51,
            "encode_qp must be 0–51 (lower improves AV1 quality and increases bandwidth)"
        );
        if let Some(id) = &self.extension_id {
            validate_id(id)?;
        }
        Ok(())
    }
}
pub fn validate_id(id: &str) -> Result<()> {
    ensure!(
        id.len() == 32 && id.bytes().all(|c| (b'a'..=b'p').contains(&c)),
        "extension ID must be the 32 a–p letters shown in chrome://extensions"
    );
    Ok(())
}
pub fn validate_settings(quality: u32, scale: f64) -> Result<()> {
    ensure!(
        (1..=4).contains(&quality),
        "AI quality must be 1 (low) through 4 (ultra)"
    );
    ensure!(
        scale.is_finite() && (1.0..=120.0).contains(&scale),
        "scale must be finite and between 1 and 120; output is bounded to an 8K landscape/portrait frame"
    );
    Ok(())
}
#[derive(Clone)]
pub struct Paths {
    pub config: PathBuf,
    pub state: PathBuf,
    pub data: PathBuf,
}
impl Paths {
    pub fn discover() -> Result<Self> {
        Ok(Self {
            config: dirs::config_dir()
                .context("HOME / XDG_CONFIG_HOME is unavailable")?
                .join("linux-rtx-vsr"),
            state: dirs::state_dir()
                .context("HOME / XDG_STATE_HOME is unavailable")?
                .join("linux-rtx-vsr"),
            data: dirs::data_local_dir()
                .context("HOME / XDG_DATA_HOME is unavailable")?
                .join("linux-rtx-vsr"),
        })
    }
    pub fn init(&self) -> Result<()> {
        for p in [&self.config, &self.state, &self.data] {
            fs::create_dir_all(p)?;
            fs::set_permissions(p, fs::Permissions::from_mode(0o700))?;
        }
        Ok(())
    }
    pub fn load(&self) -> Result<Config> {
        let p = self.config.join("config.json");
        let mut c: Config = if p.exists() {
            serde_json::from_slice(&fs::read(&p)?).with_context(|| {
                format!(
                    "Invalid {}; run config reset to restore defaults",
                    p.display()
                )
            })?
        } else {
            Config::default()
        };
        if let Some(dir) = std::env::var_os("LINUX_RTX_VSR_SDK_DIR") {
            c.sdk_dir = dir.into();
        }
        c.validate()?;
        Ok(c)
    }
    pub fn save(&self, config: &Config) -> Result<()> {
        config.validate()?;
        ensure!(
            !self.config.join("config.json").is_symlink(),
            "config.json is managed by a symlink (for example Home Manager); edit its declarative configuration instead of using config set/reset"
        );
        self.init()?;
        atomic_write(
            &self.config.join("config.json"),
            &serde_json::to_vec_pretty(config)?,
            0o600,
        )
    }
    pub fn set(&self, key: &str, value: &str) -> Result<()> {
        let mut v = serde_json::to_value(self.load()?)?;
        let field = v
            .get_mut(key)
            .with_context(|| format!("Unknown setting {key}; use config show"))?;
        *field = if field.is_string() || key.ends_with("_dir") || key == "extension_id" {
            if value == "null" && key != "sdk_dir" {
                serde_json::Value::Null
            } else {
                value.into()
            }
        } else {
            serde_json::from_str(value).context("Expected a JSON number")?
        };
        let c: Config = serde_json::from_value(v)?;
        self.save(&c)
    }
}
pub fn atomic_write(path: &Path, bytes: &[u8], mode: u32) -> Result<()> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    let tmp = path.with_extension(format!("tmp-{}", rand::random::<u64>()));
    let result = (|| -> Result<()> {
        let mut file = fs::OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(mode)
            .open(&tmp)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        fs::rename(&tmp, path)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}
pub fn browser_dir(browser: &str) -> Result<PathBuf> {
    let root = dirs::config_dir().context("No config directory")?;
    Ok(match browser {
        "chromium" => root.join("chromium"),
        "chrome" => root.join("google-chrome"),
        "brave" => root.join("BraveSoftware/Brave-Browser"),
        _ => bail!("Browser must be chromium, chrome, or brave (custom profiles: --manifest-dir)"),
    }
    .join("NativeMessagingHosts"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn declarative_configuration_is_not_replaced() {
        let tmp = tempfile::tempdir().unwrap();
        let paths = Paths {
            config: tmp.path().join("config"),
            state: tmp.path().join("state"),
            data: tmp.path().join("data"),
        };
        paths.init().unwrap();
        let managed = tmp.path().join("managed.json");
        fs::write(&managed, br#"{"quality": 2}"#).unwrap();
        std::os::unix::fs::symlink(&managed, paths.config.join("config.json")).unwrap();
        assert_eq!(paths.load().unwrap().quality, 2);
        assert!(
            paths
                .set("quality", "4")
                .unwrap_err()
                .to_string()
                .contains("declarative")
        );
        assert!(paths.save(&Config::default()).is_err());
        assert!(paths.config.join("config.json").is_symlink());
        assert_eq!(paths.load().unwrap().quality, 2);
    }
    #[test]
    fn persistence_and_validation() {
        let tmp = tempfile::tempdir().unwrap();
        let p = Paths {
            config: tmp.path().join("c"),
            state: tmp.path().join("s"),
            data: tmp.path().join("d"),
        };
        p.set("quality", "4").unwrap();
        p.set("model_dir", "/models with spaces").unwrap();
        assert_eq!(p.load().unwrap().quality, 4);
        assert_eq!(
            p.load().unwrap().model_dir.unwrap(),
            PathBuf::from("/models with spaces")
        );
        assert!(p.set("scale", "0.5").is_err());
        assert!(p.set("surprise", "1").is_err());
        assert_eq!(
            fs::metadata(p.config.join("config.json"))
                .unwrap()
                .permissions()
                .mode()
                & 0o777,
            0o600
        );
    }
}
