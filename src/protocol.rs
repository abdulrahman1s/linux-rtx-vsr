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
            1..=3 => {
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
        let w = ((self.width as f64 * scale / 8.).floor() as u32) * 8;
        let h = ((self.height as f64 * scale / 8.).floor() as u32) * 8;
        ensure!(
            w <= 7680 && h <= 7680 && u64::from(w) * u64::from(h) <= 7680 * 4320,
            "Output exceeds an 8K landscape/portrait frame; lower the target resolution"
        );
        Ok((w, h))
    }
}
#[cfg(test)]
mod tests {
    use super::*;
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
