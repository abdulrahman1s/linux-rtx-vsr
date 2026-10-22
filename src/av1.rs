// Copyright (c) 2026 maxiarat1 and contributors
// Adapted from vsr_service/av1.py under MIT; see licenses/linux-nvidia-vsr-MIT.txt.
// Read the actual profile/level/tier instead of guessing a 4K decoder config.
use anyhow::{Context, Result, ensure};
struct Bits<'a> {
    data: &'a [u8],
    offset: usize,
}
impl Bits<'_> {
    fn read(&mut self, count: usize) -> Result<u32> {
        ensure!(
            count <= 32 && self.offset + count <= self.data.len() * 8,
            "Truncated AV1 sequence header"
        );
        let mut value = 0;
        for _ in 0..count {
            value =
                (value << 1) | ((self.data[self.offset / 8] >> (7 - self.offset % 8)) & 1) as u32;
            self.offset += 1;
        }
        Ok(value)
    }
}
pub fn codec_string(packet: &[u8]) -> Result<String> {
    let mut offset = 0;
    while offset < packet.len() {
        let header = packet[offset];
        offset += 1;
        ensure!(header & 0x81 == 0, "Invalid AV1 OBU header");
        if header & 4 != 0 {
            offset += 1;
        }
        ensure!(offset <= packet.len(), "Truncated AV1 extension");
        let mut size = packet.len() - offset;
        if header & 2 != 0 {
            size = 0;
            let mut terminated = false;
            for shift in (0..56).step_by(7) {
                let byte = *packet.get(offset).context("Truncated AV1 OBU size")?;
                offset += 1;
                size |= ((byte & 127) as usize) << shift;
                if byte & 128 == 0 {
                    terminated = true;
                    break;
                }
            }
            ensure!(terminated, "Invalid AV1 OBU size");
        }
        ensure!(size <= packet.len() - offset, "Truncated AV1 OBU");
        if (header >> 3) & 15 == 1 {
            let mut bits = Bits {
                data: &packet[offset..offset + size],
                offset: 0,
            };
            let profile = bits.read(3)?;
            bits.read(1)?; // still_picture
            let reduced = bits.read(1)? != 0;
            if !reduced {
                if bits.read(1)? != 0 {
                    // timing_info_present_flag
                    bits.read(32)?;
                    bits.read(32)?;
                    if bits.read(1)? != 0 {
                        let mut zeros = 0;
                        while zeros < 32 && bits.read(1)? == 0 {
                            zeros += 1;
                        }
                        if zeros < 32 {
                            bits.read(zeros)?;
                        }
                    }
                    if bits.read(1)? != 0 {
                        bits.read(5)?;
                        bits.read(32)?;
                        bits.read(5)?;
                        bits.read(5)?;
                    }
                }
                bits.read(1)?; // initial_display_delay_present_flag
                bits.read(5)?; // operating_points_cnt_minus_1
                bits.read(12)?; // first operating_point_idc
            }
            let level = bits.read(5)?;
            let tier = if !reduced && level > 7 {
                bits.read(1)?
            } else {
                0
            };
            ensure!(profile == 0, "Unexpected NVENC AV1 profile");
            // The encoder explicitly configures profile 0, NV12, 8-bit.
            return Ok(format!(
                "av01.0.{level:02}{}.08",
                if tier == 1 { 'H' } else { 'M' }
            ));
        }
        offset += size;
    }
    anyhow::bail!("NVENC packet has no AV1 sequence header")
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn reads_reduced_header_and_rejects_truncation() {
        assert_eq!(codec_string(&[0x0a, 2, 0x1a, 0]).unwrap(), "av01.0.08M.08");
        for packet in [
            vec![],
            vec![0x0a],
            vec![0x0a, 128],
            vec![0x0a, 4, 0],
            vec![0x12, 0],
        ] {
            assert!(codec_string(&packet).is_err());
        }
    }
}
