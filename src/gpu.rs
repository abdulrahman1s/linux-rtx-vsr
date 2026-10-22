//! Minimal dynamically loaded C ABI for VFX 1.3 and nvJPEG. No Python or SDK
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
#[repr(C)]
struct JpegImage {
    channel: [*mut u8; 4],
    pitch: [usize; 4],
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
api!(Jpeg {
    create: unsafe extern "C" fn(*mut Ptr)->i32 = "nvjpegCreateSimple",
    destroy: unsafe extern "C" fn(Ptr)->i32 = "nvjpegDestroy",
    state_create: unsafe extern "C" fn(Ptr,*mut Ptr,Ptr)->i32 = "nvjpegEncoderStateCreate",
    state_destroy: unsafe extern "C" fn(Ptr)->i32 = "nvjpegEncoderStateDestroy",
    params_create: unsafe extern "C" fn(Ptr,*mut Ptr,Ptr)->i32 = "nvjpegEncoderParamsCreate",
    params_destroy: unsafe extern "C" fn(Ptr)->i32 = "nvjpegEncoderParamsDestroy",
    quality: unsafe extern "C" fn(Ptr,i32,Ptr)->i32 = "nvjpegEncoderParamsSetQuality",
    sampling: unsafe extern "C" fn(Ptr,i32,Ptr)->i32 = "nvjpegEncoderParamsSetSamplingFactors",
    encode: unsafe extern "C" fn(Ptr,Ptr,Ptr,*const JpegImage,i32,i32,i32,Ptr)->i32 = "nvjpegEncodeImage",
    retrieve: unsafe extern "C" fn(Ptr,Ptr,*mut u8,*mut usize,Ptr)->i32 = "nvjpegEncodeRetrieveBitstream",
});
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
    jpeg: Jpeg,
    effect: Ptr,
    context: Ptr,
    input: *mut Image,
    output: *mut Image,
    staging: *mut Image,
    rgb: *mut Image,
    jpeg_handle: Ptr,
    jpeg_state: Ptr,
    jpeg_params: Ptr,
    key: Option<(u32, u32, u32, u32, u32, u32)>,
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
            let jpeg = Jpeg::open(&config.jpeg_library)?;
            let mut e = Self {
                cuda,
                vfx,
                images,
                jpeg,
                effect: null_mut(),
                context: null_mut(),
                input: null_mut(),
                output: null_mut(),
                staging: null_mut(),
                rgb: null_mut(),
                jpeg_handle: null_mut(),
                jpeg_state: null_mut(),
                jpeg_params: null_mut(),
                key: None,
                config: config.clone(),
                _preloads: preloads,
            };
            check((e.cuda.retain)(&mut e.context, 0), "Retaining CUDA context")?;
            check((e.cuda.current)(e.context), "Selecting CUDA context")?;
            check((e.jpeg.create)(&mut e.jpeg_handle), "nvJPEG initialization")?;
            check(
                (e.jpeg.state_create)(e.jpeg_handle, &mut e.jpeg_state, null_mut()),
                "nvJPEG encoder initialization",
            )?;
            check(
                (e.jpeg.params_create)(e.jpeg_handle, &mut e.jpeg_params, null_mut()),
                "nvJPEG parameters",
            )?;
            check(
                (e.jpeg.quality)(e.jpeg_params, config.jpeg_quality as i32, null_mut()),
                "nvJPEG quality",
            )?;
            // 4:2:0 matches ordinary SDR video and reduces transport bandwidth.
            check(
                (e.jpeg.sampling)(e.jpeg_params, 2, null_mut()),
                "nvJPEG sampling",
            )?;
            Ok(e)
        }
    }
    fn clear(&mut self) {
        // SAFETY: owned SDK handles, null after destruction, context is current.
        unsafe {
            if !self.effect.is_null() {
                (self.vfx.destroy)(self.effect);
                self.effect = null_mut();
            }
            for p in [
                &mut self.input,
                &mut self.output,
                &mut self.staging,
                &mut self.rgb,
            ] {
                if !p.is_null() {
                    (self.images.destroy)(*p);
                    *p = null_mut();
                }
            }
        }
        self.key = None;
    }
    pub fn process(
        &mut self,
        data: &[u8],
        quality: u32,
        scale: f64,
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
                    alloc(w, h, 4, 1, 0, 1, 0, &mut self.rgb),
                    "Allocating JPEG input",
                )?;
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
            let inference = Instant::now();
            check((self.vfx.run)(self.effect, 0), "VideoSuperRes inference")?;
            check((self.cuda.sync)(), "Inference synchronization")?;
            let inference_ms = inference.elapsed().as_secs_f64() * 1000.;
            check(
                transfer(self.output, self.rgb, 1., null_mut(), null_mut()),
                "Converting output to RGB",
            )?;
            let descriptor = JpegImage {
                channel: [
                    (*self.rgb).pixels.cast(),
                    null_mut(),
                    null_mut(),
                    null_mut(),
                ],
                pitch: [(*self.rgb).pitch as usize, 0, 0, 0],
            };
            check(
                (self.jpeg.encode)(
                    self.jpeg_handle,
                    self.jpeg_state,
                    self.jpeg_params,
                    &descriptor,
                    5,
                    w as i32,
                    h as i32,
                    null_mut(),
                ),
                "Encoding enhanced JPEG",
            )?;
            let mut length = 0;
            check(
                (self.jpeg.retrieve)(
                    self.jpeg_handle,
                    self.jpeg_state,
                    null_mut(),
                    &mut length,
                    null_mut(),
                ),
                "Sizing JPEG",
            )?;
            check((self.cuda.sync)(), "Encoder synchronization")?;
            ensure!(
                length > 0 && length <= crate::protocol::MAX_FRAME,
                "Invalid encoded output size"
            );
            let mut bytes = vec![0u8; length];
            check(
                (self.jpeg.retrieve)(
                    self.jpeg_handle,
                    self.jpeg_state,
                    bytes.as_mut_ptr(),
                    &mut length,
                    null_mut(),
                ),
                "Downloading enhanced JPEG",
            )?;
            check((self.cuda.sync)(), "Output synchronization")?;
            bytes.truncate(length);
            Ok((
                bytes,
                serde_json::json!({"type":"frame","sequence":frame.sequence,"epoch":frame.epoch,"timestamp":frame.timestamp,"width":w,"height":h,"source_width":frame.width,"source_height":frame.height,"inference_ms":inference_ms,"configure_ms":configured,"service_ms":start.elapsed().as_secs_f64()*1000.,"engine":"NVIDIA VideoSuperRes","format":"jpeg"}),
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
            if !self.jpeg_params.is_null() {
                (self.jpeg.params_destroy)(self.jpeg_params);
            }
            if !self.jpeg_state.is_null() {
                (self.jpeg.state_destroy)(self.jpeg_state);
            }
            if !self.jpeg_handle.is_null() {
                (self.jpeg.destroy)(self.jpeg_handle);
            }
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
    #[ignore = "Requires a compatible NVIDIA GPU, driver, VFX 1.3 and nvJPEG runtime"]
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
            let (jpeg, stats) = engine.process(&bytes, 3, 2.).unwrap();
            assert_eq!(stats["width"], 1280);
            assert_eq!(stats["height"], 720);
            assert!(jpeg.len() > 1000 && jpeg.starts_with(&[0xff, 0xd8]));
            std::fs::create_dir_all("test-results").unwrap();
            std::fs::write(format!("test-results/nv12-{format}.jpg"), jpeg).unwrap();
        }
    }
}
