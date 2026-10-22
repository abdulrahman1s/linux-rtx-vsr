//! Minimal dynamically loaded C ABI for VFX 1.3 and NVENC. No Python or CUDA
//! headers are needed to build. All CUDA objects live on one OS thread.
//! NvCVImage layout follows NVIDIA's MIT-licensed public header; see notices.
use crate::{
    config::Config,
    protocol::{Frame, HEADER},
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
    context: Ptr,
    input: *mut Image,
    output: *mut Image,
    staging: *mut Image,
    encoded: *mut Image,
    encoder: Ptr,
    key: Option<(u32, u32, u32, u32, u32, u32)>,
    codec: Option<String>,
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
                context: null_mut(),
                input: null_mut(),
                output: null_mut(),
                staging: null_mut(),
                encoded: null_mut(),
                encoder: null_mut(),
                key: None,
                codec: None,
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
            if !self.effect.is_null() {
                (self.vfx.destroy)(self.effect);
                self.effect = null_mut();
            }
            for p in [
                &mut self.input,
                &mut self.output,
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
    }
    pub fn process(
        &mut self,
        data: &[u8],
        quality: u32,
        scale: f64,
        reset: bool,
    ) -> Result<(Vec<u8>, serde_json::Value)> {
        crate::config::validate_settings(quality, scale)?;
        let frame = Frame::parse(data)?;
        let (w, h) = frame.output(scale)?;
        let start = Instant::now();
        let key = (frame.width, frame.height, w, h, quality, frame.format);
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
                (*self.encoded).color = 1; // BT.709, limited range, cosited NV12.
                let mut error = [0 as c_char; 1024];
                self.encoder = vsr_encoder_create(
                    self.nvenc.create,
                    self.context,
                    (*self.encoded).pixels,
                    w,
                    h,
                    (*self.encoded).pitch as u32,
                    self.config.encode_qp,
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
            let encode = Instant::now();
            check(
                transfer(self.output, self.encoded, 1., null_mut(), null_mut()),
                "Converting enhanced output to BT.709 NV12",
            )?;
            check((self.cuda.sync)(), "NVENC producer synchronization")?;
            let mut error = [0 as c_char; 1024];
            let mut packet = std::ptr::null();
            let mut length = 0;
            let mut keyframe = 0;
            let force_keyframe = reset || self.codec.is_none();
            ensure!(
                vsr_encoder_encode(
                    self.encoder,
                    frame.sequence as u64,
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
            ensure!(
                !force_keyframe || keyframe,
                "NVENC did not honor the stream restart keyframe"
            );
            if keyframe {
                self.codec = Some(crate::av1::codec_string(&bytes)?);
            }
            let codec = self
                .codec
                .as_ref()
                .context("NVENC stream started without a sequence header")?;
            let encode_ms = encode.elapsed().as_secs_f64() * 1000.;
            Ok((
                bytes,
                serde_json::json!({"type":"frame","sequence":frame.sequence,"epoch":frame.epoch,"timestamp":frame.timestamp,"width":w,"height":h,"source_width":frame.width,"source_height":frame.height,"upload_ms":upload_ms,"encode_ms":encode_ms,"codec":codec,"keyframe":keyframe,"inference_ms":inference_ms,"configure_ms":configured,"service_ms":start.elapsed().as_secs_f64()*1000.,"engine":"NVIDIA VideoSuperRes","input_format":if frame.format == 0 { "rgba" } else { "nv12" },"input_bytes":data.len(),"format":"av1"}),
            ))
        }
    }
}
fn color(format: u32) -> u8 {
    match format {
        1 => 1,
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
        for format in 1u32..=3 {
            bytes[12..16].copy_from_slice(&format.to_le_bytes());
            let (packet, stats) = engine.process(&bytes, 3, 2., true).unwrap();
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
            let (packet, stats) = engine.process(&bytes, 3, 2., reset).unwrap();
            assert_eq!(stats["keyframe"], reset);
            stream.extend_from_slice(&packet);
        }
        std::fs::write("test-results/nv12-predictive.obu", stream).unwrap();
    }
}
