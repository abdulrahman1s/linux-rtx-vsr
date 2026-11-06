//! Minimal dynamically loaded C ABI for VFX 1.3 and NVENC. No Python or CUDA
//! headers are needed to build. All CUDA objects live on one OS thread.
//! NvCVImage layout follows NVIDIA's MIT-licensed public header; see notices.
use crate::{
    config::Config,
    protocol::{Frame, Generation, HEADER},
};
use anyhow::{Context, Result, ensure};
use libloading::Library;
use std::{
    ffi::{c_char, c_void},
    path::Path,
    ptr::null_mut,
    time::Instant,
};
type Ptr = *mut c_void;
#[repr(C)]
#[derive(Default)]
struct Image {
    width: u32,
    height: u32,
    pitch: i32,
    format: i32,
    component_type: i32,
    pixel_bytes: u8,
    component_bytes: u8,
    components: u8,
    planar: u8,
    gpu: u8,
    color: u8,
    reserved: [u8; 2],
    pixels: Ptr,
    delete_ptr: Ptr,
    delete_proc: Option<unsafe extern "C" fn(Ptr)>,
    buffer_bytes: u64,
}

macro_rules! api {
    ($name:ident { $($field:ident : $ty:ty = $symbol:literal),* $(,)? }) => {
        struct $name { _lib: Library, $($field: $ty),* }
        impl $name {
            unsafe fn open(path: &Path) -> Result<Self> {
                // SAFETY: caller selects a trusted installed NVIDIA library.
                let lib = unsafe { Library::new(path) }.with_context(|| format!("Cannot load {}. Check runtime installation and driver library search paths",path.display()))?;
                // SAFETY: symbols use the documented NVIDIA C ABI signatures.
                unsafe { Ok(Self { $($field: *lib.get::<$ty>(concat!($symbol,"\0").as_bytes()).with_context(|| format!("Missing {}: incompatible runtime",$symbol))?),*, _lib: lib }) }
            }
        }
    }
}
api!(Cuda {
    init: unsafe extern "C" fn(u32)->i32 = "cuInit",
    retain: unsafe extern "C" fn(*mut Ptr,i32)->i32 = "cuDevicePrimaryCtxRetain",
    current: unsafe extern "C" fn(Ptr)->i32 = "cuCtxSetCurrent",
    sync: unsafe extern "C" fn()->i32 = "cuCtxSynchronize",
    release: unsafe extern "C" fn(i32)->i32 = "cuDevicePrimaryCtxRelease_v2",
});
api!(Vfx {
    create: unsafe extern "C" fn(*const c_char,*mut Ptr)->i32 = "NvVFX_CreateEffect",
    destroy: unsafe extern "C" fn(Ptr)->i32 = "NvVFX_DestroyEffect",
    image: unsafe extern "C" fn(Ptr,*const c_char,*mut Image)->i32 = "NvVFX_SetImage",
    u32: unsafe extern "C" fn(Ptr,*const c_char,u32)->i32 = "NvVFX_SetU32",
    f32: unsafe extern "C" fn(Ptr,*const c_char,f32)->i32 = "NvVFX_SetF32",
    string: unsafe extern "C" fn(Ptr,*const c_char,*const c_char)->i32 = "NvVFX_SetString",
    load: unsafe extern "C" fn(Ptr)->i32 = "NvVFX_Load",
    run: unsafe extern "C" fn(Ptr,i32)->i32 = "NvVFX_Run",
});
api!(Images {
    alloc: unsafe extern "C" fn(u32,u32,i32,i32,u32,u32,u32,*mut *mut Image)->i32 = "NvCVImage_Create",
    destroy: unsafe extern "C" fn(*mut Image) = "NvCVImage_Destroy",
    transfer: unsafe extern "C" fn(*const Image,*mut Image,f32,Ptr,*mut Image)->i32 = "NvCVImage_Transfer",
});
// Versioned NVENC structures live in the small, MIT-licensed C adapter.
// These pointers and every NVIDIA symbol stay private to this module.
unsafe extern "C" {
    fn vsr_encoder_create(
        create: unsafe extern "C" fn(Ptr) -> i32,
        context: Ptr,
        pixels: Ptr,
        width: u32,
        height: u32,
        pitch: u32,
        qp: u32,
        srgb: i32,
        error: *mut c_char,
        capacity: usize,
    ) -> Ptr;
    fn vsr_encoder_encode(
        encoder: Ptr,
        timestamp: u64,
        force_keyframe: i32,
        bytes: *mut *const u8,
        length: *mut usize,
        keyframe: *mut i32,
        error: *mut c_char,
        capacity: usize,
    ) -> i32;
    fn vsr_encoder_release(encoder: Ptr, error: *mut c_char, capacity: usize) -> i32;
    fn vsr_encoder_destroy(encoder: Ptr);
}
api!(Nvenc {
    create: unsafe extern "C" fn(Ptr)->i32 = "NvEncodeAPICreateInstance",
});
fn encoder_error(error: &[c_char]) -> String {
    // C adapter always terminates the supplied nonempty error buffer.
    unsafe {
        std::ffi::CStr::from_ptr(error.as_ptr())
            .to_string_lossy()
            .into_owned()
    }
}
pub fn encoder_available() -> Result<()> {
    // SAFETY: only resolve the NVENC entry point; creates no GPU objects.
    unsafe {
        Nvenc::open(Path::new("libnvidia-encode.so.1"))?;
    }
    Ok(())
}
fn check(code: i32, operation: &str) -> Result<()> {
    ensure!(
        code == 0,
        "{operation} failed (NVIDIA status {code}). Run doctor --gpu; check VFX 1.3 runtime, models, supported RTX GPU, available VRAM, and driver requirements in docs/runtime.md"
    );
    Ok(())
}
pub struct Engine {
    cuda: Cuda,
    vfx: Vfx,
    images: Images,
    nvenc: Nvenc,
    effect: Ptr,
    // VideoFrameGeneration interpolates between the previous and the current
    // enhanced frame, so super resolution still runs once per captured frame.
    generator: Ptr,
    context: Ptr,
    input: *mut Image,
    output: *mut Image,
    previous: *mut Image,
    generated: *mut Image,
    staging: *mut Image,
    encoded: *mut Image,
    encoder: Ptr,
    key: Option<(u32, u32, u32, u32, u32, u32, bool)>,
    codec: Option<String>,
    // Media timestamp of the enhanced frame held in `previous`.
    last: Option<f64>,
    pictures: u64,
    config: Config,
    // Preloaded feature libraries must outlive every SDK object.
    _preloads: Vec<Library>,
}
impl Engine {
    pub fn new(config: &Config) -> Result<Self> {
        // SAFETY: no pointers leave this module. Objects are created/used/destroyed
        // on the calling GPU worker thread; libraries remain loaded until Drop.
        unsafe {
            let cuda = Cuda::open(Path::new("libcuda.so.1"))?;
            check((cuda.init)(0), "CUDA initialization")?;
            let mut preloads = Vec::new();
            // Feature discovery uses SONAMEs. RTLD_GLOBAL makes explicit SDK
            // paths work without changing LD_LIBRARY_PATH in a running process.
            for name in [
                "libnppc.so.12",
                "libnppial.so.12",
                "libnppicc.so.12",
                "libnppidei.so.12",
                "libnppif.so.12",
                "libnppig.so.12",
                "libnppim.so.12",
                "libnppist.so.12",
                "libnppitc.so.12",
                "libcudnn.so.9",
                "libNVCVImage.so",
                "libnvngxruntime.so",
                "libVideoFXLocal.so",
                "libVideoFX.so",
                "libnvVFXVideoSuperRes.so",
                "libnvVFXVideoFrameGeneration.so",
                "libnvidia-ngx-vsr.so.1.8.3",
            ] {
                let p = config.sdk_dir.join(name);
                if p.exists() {
                    preloads.push(
                        libloading::os::unix::Library::open(
                            Some(&p),
                            libloading::os::unix::RTLD_NOW | libloading::os::unix::RTLD_GLOBAL,
                        )
                        .with_context(|| format!("Loading {}", p.display()))?
                        .into(),
                    );
                }
            }
            let vfx = Vfx::open(&config.sdk_dir.join("libVideoFX.so"))?;
            let images = Images::open(&config.sdk_dir.join("libNVCVImage.so"))?;
            let nvenc = Nvenc::open(Path::new("libnvidia-encode.so.1"))?;
            let mut e = Self {
                cuda,
                vfx,
                images,
                nvenc,
                effect: null_mut(),
                generator: null_mut(),
                context: null_mut(),
                input: null_mut(),
                output: null_mut(),
                previous: null_mut(),
                generated: null_mut(),
                staging: null_mut(),
                encoded: null_mut(),
                encoder: null_mut(),
                key: None,
                codec: None,
                last: None,
                pictures: 0,
                config: config.clone(),
                _preloads: preloads,
            };
            check((e.cuda.retain)(&mut e.context, 0), "Retaining CUDA context")?;
            check((e.cuda.current)(e.context), "Selecting CUDA context")?;
            Ok(e)
        }
    }
    fn clear(&mut self) {
        // SAFETY: owned SDK handles, null after destruction, context is current.
        unsafe {
            if !self.encoder.is_null() {
                vsr_encoder_destroy(self.encoder);
                self.encoder = null_mut();
            }
            for effect in [&mut self.effect, &mut self.generator] {
                if !effect.is_null() {
                    (self.vfx.destroy)(*effect);
                    *effect = null_mut();
                }
            }
            for p in [
                &mut self.input,
                &mut self.output,
                &mut self.previous,
                &mut self.generated,
                &mut self.staging,
                &mut self.encoded,
            ] {
                if !p.is_null() {
                    (self.images.destroy)(*p);
                    *p = null_mut();
                }
            }
        }
        self.key = None;
        self.codec = None;
        self.last = None;
    }
    // Returns encoded pictures in presentation order: generated in-between
    // frames first, then the enhanced captured frame.
    pub fn process(
        &mut self,
        data: &[u8],
        quality: u32,
        scale: f64,
        reset: bool,
        generation: Generation,
    ) -> Result<Vec<(Vec<u8>, serde_json::Value)>> {
        crate::config::validate_settings(quality, scale)?;
        let frame = Frame::parse(data)?;
        let (w, h) = frame.output(scale)?;
        let start = Instant::now();
        let generate = generation.max > 1;
        let key = (
            frame.width,
            frame.height,
            w,
            h,
            quality,
            frame.format,
            generate,
        );
        // SAFETY: Frame::parse validates all sizes before any GPU operation.
        // GPU buffers are owned until clear; encoding finishes before reuse.
        unsafe {
            check((self.cuda.current)(self.context), "Selecting CUDA context")?;
            if self.key != Some(key) {
                self.clear();
                let alloc = self.images.alloc;
                check(
                    alloc(frame.width, frame.height, 6, 1, 0, 1, 0, &mut self.input),
                    "Allocating VFX input",
                )?;
                check(
                    alloc(w, h, 6, 1, 0, 1, 0, &mut self.output),
                    "Allocating VFX output",
                )?;
                check(
                    alloc(w, h, 10, 1, 7, 1, 0, &mut self.encoded),
                    "Allocating NVENC NV12 surface",
                )?;
                // Use an explicitly signalled Rec.601 YUV matrix with Rec.709
                // primaries. NVIDIA's browser BGRX export path can otherwise
                // apply Rec.601 to Rec.709 YUV even with correct frame metadata.
                // Changing BOTH the actual matrix and its label preserves RGB;
                // this is not a gamut/gamma conversion or an RGB correction.
                (*self.encoded).color = 0; // Rec.601 matrix, limited, cosited.
                let mut error = [0 as c_char; 1024];
                self.encoder = vsr_encoder_create(
                    self.nvenc.create,
                    self.context,
                    (*self.encoded).pixels,
                    w,
                    h,
                    (*self.encoded).pitch as u32,
                    self.config.encode_qp,
                    i32::from(srgb(frame.format)),
                    error.as_mut_ptr(),
                    error.len(),
                );
                ensure!(!self.encoder.is_null(), "{}", encoder_error(&error));
                if frame.format != 0 {
                    check(
                        alloc(frame.width, frame.height, 10, 1, 7, 1, 0, &mut self.staging),
                        "Allocating NV12 staging",
                    )?;
                    (*self.staging).color = color(frame.format);
                }
                check(
                    (self.vfx.create)(c"VideoSuperRes".as_ptr(), &mut self.effect),
                    "Creating VideoSuperRes",
                )?;
                check(
                    (self.vfx.u32)(self.effect, c"QualityLevel".as_ptr(), quality),
                    "Setting AI quality",
                )?;
                check(
                    (self.vfx.image)(self.effect, c"SrcImage0".as_ptr(), self.input),
                    "Setting input",
                )?;
                check(
                    (self.vfx.image)(self.effect, c"DstImage0".as_ptr(), self.output),
                    "Setting output",
                )?;
                if let Some(dir) = &self.config.model_dir {
                    let path = std::ffi::CString::new(dir.as_os_str().as_encoded_bytes())?;
                    check(
                        (self.vfx.string)(self.effect, c"ModelDir".as_ptr(), path.as_ptr()),
                        "Setting model path",
                    )?;
                }
                check((self.vfx.load)(self.effect), "Loading VideoSuperRes models")?;
                if generate {
                    self.load_generator(w, h)?;
                }
                self.key = Some(key);
            }
            let configured = start.elapsed().as_secs_f64() * 1000.;
            let host = Image {
                width: frame.width,
                height: frame.height,
                pitch: (frame.width * if frame.format == 0 { 4 } else { 1 }) as i32,
                format: if frame.format == 0 { 6 } else { 10 },
                component_type: 1,
                pixel_bytes: if frame.format == 0 { 4 } else { 1 },
                component_bytes: 1,
                components: if frame.format == 0 { 4 } else { 3 },
                planar: if frame.format == 0 { 0 } else { 7 },
                color: color(frame.format),
                pixels: data[HEADER..].as_ptr() as Ptr,
                buffer_bytes: (data.len() - HEADER) as u64,
                ..Default::default()
            };
            let transfer = self.images.transfer;
            if frame.format == 0 {
                check(
                    transfer(&host, self.input, 1., null_mut(), null_mut()),
                    "Uploading RGBA",
                )?;
            } else {
                check(
                    transfer(&host, self.staging, 1., null_mut(), null_mut()),
                    "Uploading NV12",
                )?;
                check(
                    transfer(self.staging, self.input, 1., null_mut(), null_mut()),
                    "Converting NV12 to RGBA",
                )?;
            }
            check((self.cuda.sync)(), "Upload synchronization")?;
            let upload_ms = start.elapsed().as_secs_f64() * 1000. - configured;
            let inference = Instant::now();
            check((self.vfx.run)(self.effect, 0), "VideoSuperRes inference")?;
            check((self.cuda.sync)(), "Inference synchronization")?;
            let inference_ms = inference.elapsed().as_secs_f64() * 1000.;
            // A new connection starts a new decoder; never interpolate across it.
            if reset {
                self.last = None;
            }
            let previous = self.last.filter(|_| !self.generator.is_null());
            let count = previous.map_or(1, |at| generation.count(frame.timestamp - at));
            let mut pictures = Vec::with_capacity(count as usize);
            let force_keyframe = reset || self.codec.is_none();
            let stats = |encode_ms: f64, keyframe: bool, codec: &str| serde_json::json!({"type":"frame","sequence":frame.sequence,"epoch":frame.epoch,"timestamp":frame.timestamp,"width":w,"height":h,"source_width":frame.width,"source_height":frame.height,"upload_ms":upload_ms,"encode_ms":encode_ms,"codec":codec,"color_space":if srgb(frame.format) { "srgb" } else { "bt709" },"keyframe":keyframe,"inference_ms":inference_ms,"configure_ms":configured,"service_ms":start.elapsed().as_secs_f64()*1000.,"engine":"NVIDIA VideoSuperRes","input_format":if frame.format == 0 { "rgba" } else { "nv12" },"input_bytes":data.len(),"format":"av1","generated":false});
            if let Some(at) = previous {
                for index in 1..count {
                    let step = index as f32 / count as f32;
                    let generating = Instant::now();
                    check(
                        (self.vfx.f32)(self.generator, c"Timestep".as_ptr(), step),
                        "Setting frame generation timestep",
                    )?;
                    check(
                        (self.vfx.run)(self.generator, 0),
                        "VideoFrameGeneration inference",
                    )?;
                    let generation_ms = generating.elapsed().as_secs_f64() * 1000.;
                    let encode = Instant::now();
                    let (bytes, keyframe) = self.encode(self.generated, false)?;
                    let codec = self.codec.as_deref().unwrap_or_default();
                    let mut meta = stats(encode.elapsed().as_secs_f64() * 1000., keyframe, codec);
                    meta["generated"] = true.into();
                    meta["generation_ms"] = generation_ms.into();
                    meta["timestamp"] = (at + (frame.timestamp - at) * f64::from(step)).into();
                    pictures.push((bytes, meta));
                }
            }
            let encode = Instant::now();
            let (bytes, keyframe) = self.encode(self.output, force_keyframe)?;
            ensure!(
                !force_keyframe || keyframe,
                "NVENC did not honor the stream restart keyframe"
            );
            let codec = self
                .codec
                .as_ref()
                .context("NVENC stream started without a sequence header")?;
            let mut meta = stats(encode.elapsed().as_secs_f64() * 1000., keyframe, codec);
            meta["generated_frames"] = (count - 1).into();
            pictures.push((bytes, meta));
            if !self.generator.is_null() {
                check(
                    transfer(self.output, self.previous, 1., null_mut(), null_mut()),
                    "Keeping the previous enhanced frame",
                )?;
                check((self.cuda.sync)(), "Frame generation synchronization")?;
                self.last = Some(frame.timestamp);
            }
            Ok(pictures)
        }
    }
    unsafe fn load_generator(&mut self, w: u32, h: u32) -> Result<()> {
        // SAFETY: called while configuring, with the CUDA context current;
        // images are owned by this engine and outlive the effect.
        unsafe {
            for image in [&mut self.previous, &mut self.generated] {
                check(
                    (self.images.alloc)(w, h, 6, 1, 0, 1, 0, image),
                    "Allocating frame generation buffers",
                )?;
            }
            let effect = &mut self.generator;
            check(
                (self.vfx.create)(c"VideoFrameGeneration".as_ptr(), effect),
                "Creating VideoFrameGeneration",
            )?;
            let set =
                |name: &std::ffi::CStr, value| (self.vfx.u32)(self.generator, name.as_ptr(), value);
            check(set(c"InputWidth", w), "Setting frame generation width")?;
            check(set(c"InputHeight", h), "Setting frame generation height")?;
            // Medium costs ~1.4 ms per 4K frame on an RTX 5090; high costs ~7 ms,
            // too much beside super resolution at 60 fps.
            check(set(c"Mode", 1), "Setting frame generation mode")?;
            for (name, image) in [
                (c"SrcImage0", self.previous),
                (c"SrcImage1", self.output),
                (c"DstImage0", self.generated),
            ] {
                check(
                    (self.vfx.image)(self.generator, name.as_ptr(), image),
                    "Setting frame generation images",
                )?;
            }
            check(
                (self.vfx.load)(self.generator),
                "Loading VideoFrameGeneration models",
            )
        }
    }
    // Converts an enhanced RGBA picture to NV12 and encodes the next AV1 packet.
    unsafe fn encode(
        &mut self,
        image: *mut Image,
        force_keyframe: bool,
    ) -> Result<(Vec<u8>, bool)> {
        // SAFETY: image and the encoder surface are live engine buffers of the
        // configured output size; the packet is copied before it is released.
        unsafe {
            check(
                (self.images.transfer)(image, self.encoded, 1., null_mut(), null_mut()),
                "Converting enhanced output to NV12",
            )?;
            check((self.cuda.sync)(), "NVENC producer synchronization")?;
            let mut error = [0 as c_char; 1024];
            let mut packet = std::ptr::null();
            let mut length = 0;
            let mut keyframe = 0;
            self.pictures += 1;
            ensure!(
                vsr_encoder_encode(
                    self.encoder,
                    self.pictures,
                    i32::from(force_keyframe),
                    &mut packet,
                    &mut length,
                    &mut keyframe,
                    error.as_mut_ptr(),
                    error.len()
                ) == 0,
                "{}",
                encoder_error(&error)
            );
            let valid = !packet.is_null() && length > 0 && length <= crate::protocol::MAX_FRAME;
            let bytes = if valid {
                std::slice::from_raw_parts(packet, length).to_vec()
            } else {
                Vec::new()
            };
            let released = vsr_encoder_release(self.encoder, error.as_mut_ptr(), error.len());
            ensure!(valid, "NVENC returned an invalid encoded packet");
            ensure!(released == 0, "{}", encoder_error(&error));
            let keyframe = keyframe != 0;
            if keyframe {
                self.codec = Some(crate::av1::codec_string(&bytes)?);
            }
            Ok((bytes, keyframe))
        }
    }
}
// Format 4 is NV12 that the extension produced from sRGB-encoded RGB with
// the limited-range BT.709 matrix. It uploads exactly like format 1, but its
// transfer stays sRGB, as for RGBA input; never relabel it as BT.709.
fn srgb(format: u32) -> bool {
    matches!(format, 0 | 4)
}
fn color(format: u32) -> u8 {
    match format {
        1 | 4 => 1,
        2 => 0,
        3 => 5,
        _ => 0,
    }
}
impl Drop for Engine {
    fn drop(&mut self) {
        // SAFETY: only non-null handles returned by this module are destroyed.
        unsafe {
            if !self.context.is_null() {
                (self.cuda.current)(self.context);
                (self.cuda.sync)();
            }
            self.clear();
            if !self.context.is_null() {
                (self.cuda.release)(0);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    #[ignore = "Requires NVIDIA VFX, AV1 NVENC and ffmpeg/ffprobe"]
    fn nvidia_color_round_trip() {
        let config = crate::config::Paths::discover().unwrap().load().unwrap();
        let (w, h) = (640u32, 360u32);
        let mut engine = Engine::new(&config).unwrap();
        std::fs::create_dir_all("test-results").unwrap();
        let source = [187u8, 216, 12];
        for format in 0u32..=4 {
            let pixels = (w * h) as usize;
            let mut bytes = vec![
                0u8;
                HEADER
                    + if format == 0 {
                        pixels * 4
                    } else {
                        pixels * 3 / 2
                    }
            ];
            bytes[..4].copy_from_slice(b"RVS1");
            bytes[4..8].copy_from_slice(&w.to_le_bytes());
            bytes[8..12].copy_from_slice(&h.to_le_bytes());
            bytes[12..16].copy_from_slice(&format.to_le_bytes());
            if format == 0 {
                for pixel in bytes[HEADER..].as_chunks_mut::<4>().0 {
                    pixel.copy_from_slice(&[source[0], source[1], source[2], 255]);
                }
            } else {
                // Independent reference generation belongs only in this test.
                let (kr, kb) = if format == 2 {
                    (0.299, 0.114)
                } else {
                    (0.2126, 0.0722)
                };
                let [r, g, b] = source.map(f64::from);
                let y = kr * r + (1. - kr - kb) * g + kb * b;
                let (offset, luma, chroma) = if format == 3 {
                    (0., 255., 255.)
                } else {
                    (16., 219., 224.)
                };
                bytes[HEADER..HEADER + pixels].fill((offset + luma * y / 255.).round() as u8);
                for uv in bytes[HEADER + pixels..].as_chunks_mut::<2>().0 {
                    uv[0] = (128. + chroma * (b - y) / (2. * (1. - kb) * 255.)).round() as u8;
                    uv[1] = (128. + chroma * (r - y) / (2. * (1. - kr) * 255.)).round() as u8;
                }
            }
            let (packet, _) = engine
                .process(&bytes, 3, 2., true, Generation::OFF)
                .unwrap()
                .pop()
                .unwrap();
            let path = format!("test-results/color-{format}.obu");
            std::fs::write(&path, packet).unwrap();
            let decoded = std::process::Command::new("ffmpeg")
                .args([
                    "-v",
                    "error",
                    "-i",
                    &path,
                    "-frames:v",
                    "1",
                    "-f",
                    "rawvideo",
                    "-pix_fmt",
                    "rgb24",
                    "pipe:1",
                ])
                .output()
                .unwrap();
            assert!(
                decoded.status.success(),
                "{}",
                String::from_utf8_lossy(&decoded.stderr)
            );
            assert_eq!(decoded.stdout.len(), 1280 * 720 * 3);
            let center = (360 * 1280 + 640) * 3;
            let rgb = &decoded.stdout[center..center + 3];
            for (actual, expected) in rgb.iter().zip(source) {
                assert!(
                    actual.abs_diff(expected) <= 5,
                    "format {format}: {rgb:?} vs {source:?}"
                );
            }
            let probe = std::process::Command::new("ffprobe")
                .args([
                    "-v",
                    "error",
                    "-show_entries",
                    "stream=color_range,color_space,color_transfer,color_primaries",
                    "-of",
                    "json",
                    &path,
                ])
                .output()
                .unwrap();
            assert!(probe.status.success());
            let info: serde_json::Value = serde_json::from_slice(&probe.stdout).unwrap();
            let color = &info["streams"][0];
            assert_eq!(color["color_space"], "smpte170m");
            assert_eq!(color["color_primaries"], "bt709");
            assert_eq!(color["color_range"], "tv");
            assert_eq!(
                color["color_transfer"],
                if srgb(format) {
                    "iec61966-2-1"
                } else {
                    "bt709"
                }
            );
            eprintln!("Color format {format}: {rgb:?}, {color}");
        }
    }
    #[test]
    #[ignore = "Requires a compatible NVIDIA GPU, driver, VFX 1.3 and AV1 NVENC"]
    fn nvidia_nv12_inference() {
        let config = crate::config::Paths::discover().unwrap().load().unwrap();
        let (w, h) = (640u32, 360u32);
        let mut bytes = vec![128u8; HEADER + w as usize * h as usize * 3 / 2];
        bytes[..HEADER].fill(0);
        bytes[..4].copy_from_slice(b"RVS1");
        bytes[4..8].copy_from_slice(&w.to_le_bytes());
        bytes[8..12].copy_from_slice(&h.to_le_bytes());
        for y in 0..h {
            for x in 0..w {
                bytes[HEADER + (y * w + x) as usize] = (16 + x * 219 / w) as u8;
            }
        }
        let mut engine = Engine::new(&config).unwrap();
        for format in 1u32..=4 {
            bytes[12..16].copy_from_slice(&format.to_le_bytes());
            let (packet, stats) = engine
                .process(&bytes, 3, 2., true, Generation::OFF)
                .unwrap()
                .pop()
                .unwrap();
            assert_eq!(stats["width"], 1280);
            assert_eq!(stats["height"], 720);
            assert!(packet.len() > 100);
            assert!(stats["codec"].as_str().unwrap().starts_with("av01.0."));
            std::fs::create_dir_all("test-results").unwrap();
            std::fs::write(format!("test-results/nv12-{format}.obu"), packet).unwrap();
        }
        // Same-sized restarts retain the CUDA/NVENC session but must still
        // recover a fresh decoder. Concatenated output is decoded separately.
        bytes[12..16].copy_from_slice(&1u32.to_le_bytes());
        let mut stream = Vec::new();
        for n in 0u32..6 {
            bytes[16..20].copy_from_slice(&n.to_le_bytes());
            let reset = n == 0 || n == 3;
            let (packet, stats) = engine
                .process(&bytes, 3, 2., reset, Generation::OFF)
                .unwrap()
                .pop()
                .unwrap();
            assert_eq!(stats["keyframe"], reset);
            stream.extend_from_slice(&packet);
        }
        std::fs::write("test-results/nv12-predictive.obu", stream).unwrap();
    }

    #[test]
    #[ignore = "Requires a compatible NVIDIA GPU, driver, VFX 1.3 frame generation and AV1 NVENC"]
    fn nvidia_frame_generation() {
        let config = crate::config::Paths::discover().unwrap().load().unwrap();
        let (w, h) = (640u32, 360u32);
        let mut bytes = vec![128u8; HEADER + w as usize * h as usize * 3 / 2];
        bytes[..4].copy_from_slice(b"RVS1");
        bytes[4..8].copy_from_slice(&w.to_le_bytes());
        bytes[8..12].copy_from_slice(&h.to_le_bytes());
        bytes[12..16].copy_from_slice(&1u32.to_le_bytes());
        let mut engine = Engine::new(&config).unwrap();
        // A 30 fps source on a 60 Hz display gains one frame per capture.
        let generation = Generation {
            max: 4,
            interval: 1. / 60.,
        };
        let mut stream = Vec::new();
        let mut timestamps = Vec::new();
        for n in 0u32..8 {
            // A bar moving 16 pixels per frame gives the model real motion.
            for y in 0..h {
                for x in 0..w {
                    let bar = (x + w - n * 16 % w) % w < 64;
                    bytes[HEADER + (y * w + x) as usize] = if bar { 235 } else { 16 };
                }
            }
            bytes[16..20].copy_from_slice(&n.to_le_bytes());
            bytes[24..32].copy_from_slice(&(f64::from(n) / 30.).to_le_bytes());
            let pictures = engine.process(&bytes, 3, 2., n == 0, generation).unwrap();
            assert_eq!(pictures.len(), if n == 0 { 1 } else { 2 });
            for (index, (packet, stats)) in pictures.iter().enumerate() {
                assert_eq!(stats["generated"], index + 1 < pictures.len());
                assert_eq!(stats["width"], 1280);
                timestamps.push(stats["timestamp"].as_f64().unwrap());
                stream.extend_from_slice(packet);
            }
        }
        assert!(
            timestamps.windows(2).all(|pair| pair[1] > pair[0]),
            "{timestamps:?}"
        );
        assert!((timestamps[1] - 1. / 60.).abs() < 1e-9);
        std::fs::create_dir_all("test-results").unwrap();
        let path = "test-results/frame-generation.obu";
        std::fs::write(path, stream).unwrap();
        let probe = std::process::Command::new("ffprobe")
            .args([
                "-v",
                "error",
                "-count_frames",
                "-show_entries",
                "stream=nb_read_frames",
                "-of",
                "csv=p=0",
                path,
            ])
            .output()
            .unwrap();
        assert!(
            probe.status.success(),
            "{}",
            String::from_utf8_lossy(&probe.stderr)
        );
        assert_eq!(String::from_utf8_lossy(&probe.stdout).trim(), "15");
    }
}
