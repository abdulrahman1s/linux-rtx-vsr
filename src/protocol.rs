use anyhow::{Result, ensure};
pub const MAX_FRAME: usize = 64 * 1024 * 1024;
pub const HEADER: usize = 32;
#[derive(Debug, Clone, Copy)]
pub struct Frame {
    pub width: u32,
    pub height: u32,
    pub format: u32,
    pub sequence: u32,
    pub epoch: u32,
    pub timestamp: f64,
}
impl Frame {
    pub fn parse(data: &[u8]) -> Result<Self> {
        ensure!(
            data.len() >= HEADER && data.len() <= MAX_FRAME,
            "Frame exceeds the 64 MiB limit or has no header"
        );
        ensure!(
            &data[..4] == b"RVS1",
            "Invalid frame protocol; update both application and extension"
        );
        let u = |n| u32::from_le_bytes(data[n..n + 4].try_into().unwrap());
        let f = Self {
            width: u(4),
            height: u(8),
            format: u(12),
            sequence: u(16),
            epoch: u(20),
            timestamp: f64::from_le_bytes(data[24..32].try_into().unwrap()),
        };
        ensure!(
            (64..=7680).contains(&f.width)
                && (64..=7680).contains(&f.height)
                && u64::from(f.width) * u64::from(f.height) <= 7680 * 4320,
            "Input must be at least 64×64 and at most an 8K landscape/portrait frame within 64 MiB"
        );
        ensure!(
            f.timestamp.is_finite() && f.timestamp >= 0.0,
            "Invalid source timestamp"
        );
        let pixels = (f.width as usize) * (f.height as usize);
        let size = match f.format {
            0 => pixels * 4,
            1..=4 => {
                ensure!(
                    f.width.is_multiple_of(2) && f.height.is_multiple_of(2),
                    "NV12 dimensions must be even"
                );
                pixels * 3 / 2
            }
            _ => anyhow::bail!("Unsupported pixel format"),
        };
        ensure!(
            data.len() == HEADER + size,
            "Pixel length does not match dimensions / format"
        );
        Ok(f)
    }
    pub fn output(&self, scale: f64) -> Result<(u32, u32)> {
        ensure!(
            scale.is_finite() && (1.0..=120.0).contains(&scale),
            "Invalid output scale"
        );
        // Target-derived scales such as 3840 / 854 multiply back to
        // 3839.999…; tolerate that rounding instead of losing an 8-pixel block.
        let align = |n: u32| ((n as f64 * scale / 8. + 1e-6).floor() as u32) * 8;
        let (w, h) = (align(self.width), align(self.height));
        ensure!(
            w <= 7680 && h <= 7680 && u64::from(w) * u64::from(h) <= 7680 * 4320,
            "Output exceeds an 8K landscape/portrait frame; lower the target resolution"
        );
        Ok((w, h))
    }
}
// Frame generation: NVIDIA VideoFrameGeneration interpolates between
// consecutive enhanced frames so the source rate approaches the display rate.
pub const MAX_GENERATION: u32 = 4;
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Generation {
    // Output frames per captured frame at most; 1 disables generation.
    pub max: u32,
    // Shortest useful media-time spacing between output frames in seconds:
    // the display refresh period times the playback rate.
    pub interval: f64,
}
impl Generation {
    pub const OFF: Self = Self {
        max: 1,
        interval: 1.,
    };
    pub fn parse(value: &serde_json::Value) -> Result<Self> {
        if value.is_null() {
            return Ok(Self::OFF);
        }
        let max = value["max"].as_u64().unwrap_or(0);
        let interval = value["interval"].as_f64().unwrap_or(f64::NAN);
        ensure!(
            (1..=u64::from(MAX_GENERATION)).contains(&max)
                && interval.is_finite()
                && (0.001..=1.).contains(&interval),
            "Invalid frame generation settings"
        );
        Ok(Self {
            max: max as u32,
            interval,
        })
    }
    pub fn to_json(self) -> serde_json::Value {
        serde_json::json!({"max":self.max,"interval":self.interval})
    }
    // Output frames for a captured gap: the most that still lands at least one
    // display refresh apart. A 10% allowance keeps 30 fps on a 60 Hz display
    // at two despite timestamp rounding. Seeks, loops and stalls generate none.
    pub fn count(self, gap: f64) -> u32 {
        if self.max < 2 || !(gap > 0. && gap <= 0.25) {
            return 1;
        }
        ((gap / self.interval * 1.1).floor() as u32).clamp(1, self.max)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn generation_fills_the_display_rate_without_exceeding_it() {
        let at = |hz: f64, max| Generation {
            max,
            interval: 1. / hz,
        };
        assert_eq!(at(60., 4).count(1. / 30.), 2);
        assert_eq!(at(60., 4).count(1. / 24.), 2);
        assert_eq!(at(60., 4).count(1. / 60.), 1);
        assert_eq!(at(60., 4).count(1. / 50.), 1);
        assert_eq!(at(144., 4).count(1. / 60.), 2);
        assert_eq!(at(144., 4).count(1. / 24.), 4);
        assert_eq!(at(144., 2).count(1. / 24.), 2);
        assert_eq!(Generation::OFF.count(1. / 24.), 1);
        for gap in [0., -0.01, 0.3, f64::NAN] {
            assert_eq!(at(144., 4).count(gap), 1);
        }
        assert_eq!(
            Generation::parse(&serde_json::Value::Null).unwrap(),
            Generation::OFF
        );
        let parsed = Generation::parse(&serde_json::json!({"max":2,"interval":0.0167})).unwrap();
        assert_eq!(parsed.max, 2);
        for bad in [
            serde_json::json!({"max":5,"interval":0.01}),
            serde_json::json!({"max":0,"interval":0.01}),
            serde_json::json!({"max":2,"interval":0}),
            serde_json::json!({"max":2}),
            serde_json::json!(true),
        ] {
            assert!(Generation::parse(&bad).is_err(), "{bad}");
        }
    }
    #[test]
    fn target_scales_align_and_bound_8k_landscape_and_portrait() {
        let mut frame = Frame {
            width: 1920,
            height: 1080,
            format: 0,
            sequence: 0,
            epoch: 0,
            timestamp: 0.,
        };
        assert_eq!(frame.output(4.).unwrap(), (7680, 4320));
        frame.width = 1080;
        frame.height = 1920;
        assert_eq!(frame.output(4.).unwrap(), (4320, 7680));
        assert!(frame.output(4.1).is_err());
        assert!(frame.output(f64::NAN).is_err());
        assert!(frame.output(f64::INFINITY).is_err());
        frame.width = 1920;
        frame.height = 800;
        assert_eq!(frame.output(2560. / 1920.).unwrap(), (2560, 1064));
        frame.width = 854;
        frame.height = 480;
        assert_eq!(frame.output(3840. / 854.).unwrap(), (3840, 2152));
        assert_eq!(frame.output(1920. / 854.).unwrap(), (1920, 1072));
        assert_eq!(frame.output(7680. / 854.).unwrap(), (7680, 4312));
    }
    #[test]
    fn rejects_malformed_and_unbounded_frames() {
        for n in 0..HEADER {
            assert!(Frame::parse(&vec![0; n]).is_err());
        }
        let mut b = vec![0; HEADER + 64 * 64 * 4];
        b[..4].copy_from_slice(b"RVS1");
        b[4..8].copy_from_slice(&64u32.to_le_bytes());
        b[8..12].copy_from_slice(&64u32.to_le_bytes());
        assert!(Frame::parse(&b).is_ok());
        b.push(0);
        assert!(Frame::parse(&b).is_err());
        b.pop();
        b[24..32].copy_from_slice(&f64::NAN.to_le_bytes());
        assert!(Frame::parse(&b).is_err());
    }
}
