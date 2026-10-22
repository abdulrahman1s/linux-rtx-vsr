// SPDX-License-Identifier: MIT
// NVENC's versioned structures stay here; Rust owns loading, frame validation,
// CUDA allocation and lifetime. No SDK helpers, hidden queue or pixel copies.
#include "nvEncodeAPI.h"
#include <stdio.h>
#include <string.h>

typedef struct {
  NV_ENCODE_API_FUNCTION_LIST api;
  void *encoder;
  NV_ENC_REGISTERED_PTR resource;
  NV_ENC_INPUT_PTR mapped;
  NV_ENC_OUTPUT_PTR bitstream;
  uint32_t width, height, pitch;
  int locked;
} VsrEncoder;

typedef NVENCSTATUS (*CreateInstance)(NV_ENCODE_API_FUNCTION_LIST *);

static int check(VsrEncoder *s, NVENCSTATUS status, const char *operation,
                 char *error, size_t capacity) {
  if (status == NV_ENC_SUCCESS) return 0;
  const char *detail = s->encoder && s->api.nvEncGetLastErrorString
                           ? s->api.nvEncGetLastErrorString(s->encoder) : "";
  snprintf(error, capacity, "%s: NVENC status %d %s. AV1 encoding requires a supported Ada/Blackwell GPU and NVIDIA driver with Video Codec SDK 13 support (570+). Check libnvidia-encode.so.1 and available encoder sessions.",
           operation, (int)status, detail ? detail : "");
  return -1;
}

void vsr_encoder_destroy(VsrEncoder *s) {
  if (!s) return;
  if (s->encoder) {
    if (s->locked) s->api.nvEncUnlockBitstream(s->encoder, s->bitstream);
    if (s->mapped) s->api.nvEncUnmapInputResource(s->encoder, s->mapped);
    if (s->resource) s->api.nvEncUnregisterResource(s->encoder, s->resource);
    if (s->bitstream) s->api.nvEncDestroyBitstreamBuffer(s->encoder, s->bitstream);
    s->api.nvEncDestroyEncoder(s->encoder);
  }
  free(s);
}

VsrEncoder *vsr_encoder_create(CreateInstance create, void *context, void *pixels,
                              uint32_t width, uint32_t height, uint32_t pitch,
                              uint32_t qp, char *error, size_t capacity) {
  VsrEncoder *s = calloc(1, sizeof(*s));
  if (!s) { snprintf(error, capacity, "Cannot allocate NVENC session"); return NULL; }
  s->width = width; s->height = height; s->pitch = pitch;
  s->api.version = NV_ENCODE_API_FUNCTION_LIST_VER;
  if (check(s, create(&s->api), "Loading NVENC functions", error, capacity)) goto fail;
  NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS open = {0};
  open.version = NV_ENC_OPEN_ENCODE_SESSION_EX_PARAMS_VER;
  open.device = context;
  open.deviceType = NV_ENC_DEVICE_TYPE_CUDA;
  open.apiVersion = NVENCAPI_VERSION;
  if (check(s, s->api.nvEncOpenEncodeSessionEx(&open, &s->encoder), "Opening NVENC", error, capacity)) goto fail;
  NV_ENC_CAPS_PARAM caps = {0};
  caps.version = NV_ENC_CAPS_PARAM_VER;
  int max_width = 0, max_height = 0;
  caps.capsToQuery = NV_ENC_CAPS_WIDTH_MAX;
  if (check(s, s->api.nvEncGetEncodeCaps(s->encoder, NV_ENC_CODEC_AV1_GUID, &caps, &max_width), "Querying AV1 width limit", error, capacity)) goto fail;
  caps.capsToQuery = NV_ENC_CAPS_HEIGHT_MAX;
  if (check(s, s->api.nvEncGetEncodeCaps(s->encoder, NV_ENC_CODEC_AV1_GUID, &caps, &max_height), "Querying AV1 height limit", error, capacity)) goto fail;
  if (width > (uint32_t)max_width || height > (uint32_t)max_height) {
    snprintf(error, capacity, "Requested %ux%u exceeds this GPU's AV1 NVENC limit %dx%d. Lower the output target.", width, height, max_width, max_height);
    goto fail;
  }

  NV_ENC_PRESET_CONFIG preset = {0};
  preset.version = NV_ENC_PRESET_CONFIG_VER;
  preset.presetCfg.version = NV_ENC_CONFIG_VER;
  if (check(s, s->api.nvEncGetEncodePresetConfigEx(s->encoder, NV_ENC_CODEC_AV1_GUID,
      NV_ENC_PRESET_P1_GUID, NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY, &preset),
      "Querying AV1 preset", error, capacity)) goto fail;
  NV_ENC_CONFIG *c = &preset.presetCfg;
  c->profileGUID = NV_ENC_AV1_PROFILE_MAIN_GUID;
  c->gopLength = 120;
  c->frameIntervalP = 1;
  c->rcParams.rateControlMode = NV_ENC_PARAMS_RC_CONSTQP;
  c->rcParams.constQP = (NV_ENC_QP){qp, qp, qp};
  c->rcParams.enableLookahead = 0;
  c->rcParams.lookaheadDepth = 0;
  c->rcParams.zeroReorderDelay = 1;
  c->rcParams.multiPass = NV_ENC_MULTI_PASS_DISABLED;
  NV_ENC_CONFIG_AV1 *a = &c->encodeCodecConfig.av1Config;
  a->idrPeriod = 120;
  a->repeatSeqHdr = 1;
  a->chromaFormatIDC = 1;
  a->inputBitDepth = NV_ENC_BIT_DEPTH_8;
  a->outputBitDepth = NV_ENC_BIT_DEPTH_8;
  a->colorPrimaries = NV_ENC_VUI_COLOR_PRIMARIES_BT709;
  a->transferCharacteristics = NV_ENC_VUI_TRANSFER_CHARACTERISTIC_BT709;
  a->matrixCoefficients = NV_ENC_VUI_MATRIX_COEFFS_BT709;
  a->colorRange = 0;
  NV_ENC_INITIALIZE_PARAMS init = {0};
  init.version = NV_ENC_INITIALIZE_PARAMS_VER;
  init.encodeGUID = NV_ENC_CODEC_AV1_GUID;
  init.presetGUID = NV_ENC_PRESET_P1_GUID;
  init.tuningInfo = NV_ENC_TUNING_INFO_ULTRA_LOW_LATENCY;
  init.encodeWidth = init.darWidth = width;
  init.encodeHeight = init.darHeight = height;
  init.frameRateNum = 60; init.frameRateDen = 1;
  init.enablePTD = 1;
  init.encodeConfig = c;
  init.maxEncodeWidth = width; init.maxEncodeHeight = height;
  if (check(s, s->api.nvEncInitializeEncoder(s->encoder, &init), "Initializing AV1", error, capacity)) goto fail;
  NV_ENC_REGISTER_RESOURCE resource = {0};
  resource.version = NV_ENC_REGISTER_RESOURCE_VER;
  resource.resourceType = NV_ENC_INPUT_RESOURCE_TYPE_CUDADEVICEPTR;
  resource.width = width; resource.height = height; resource.pitch = pitch;
  resource.resourceToRegister = pixels;
  resource.bufferFormat = NV_ENC_BUFFER_FORMAT_NV12;
  resource.bufferUsage = NV_ENC_INPUT_IMAGE;
  if (check(s, s->api.nvEncRegisterResource(s->encoder, &resource), "Registering CUDA NV12", error, capacity)) goto fail;
  s->resource = resource.registeredResource;
  NV_ENC_CREATE_BITSTREAM_BUFFER buffer = {0};
  buffer.version = NV_ENC_CREATE_BITSTREAM_BUFFER_VER;
  if (check(s, s->api.nvEncCreateBitstreamBuffer(s->encoder, &buffer), "Allocating AV1 bitstream", error, capacity)) goto fail;
  s->bitstream = buffer.bitstreamBuffer;
  return s;
fail:
  vsr_encoder_destroy(s);
  return NULL;
}

// Returned bytes are valid until release or destroy. Each call is synchronous:
// one input produces one AV1 picture, or an error. No B frames or lookahead:
// predictive coding saves bandwidth without waiting for future input pictures.
int vsr_encoder_encode(VsrEncoder *s, uint64_t timestamp, int force_keyframe,
                       const uint8_t **bytes, size_t *length, int *keyframe,
                       char *error, size_t capacity) {
  NV_ENC_MAP_INPUT_RESOURCE map = {0};
  map.version = NV_ENC_MAP_INPUT_RESOURCE_VER;
  map.registeredResource = s->resource;
  if (check(s, s->api.nvEncMapInputResource(s->encoder, &map), "Mapping CUDA NV12", error, capacity)) return -1;
  s->mapped = map.mappedResource;
  NV_ENC_PIC_PARAMS pic = {0};
  pic.version = NV_ENC_PIC_PARAMS_VER;
  pic.inputBuffer = s->mapped; pic.bufferFmt = NV_ENC_BUFFER_FORMAT_NV12;
  pic.inputWidth = s->width; pic.inputHeight = s->height; pic.inputPitch = s->pitch;
  pic.outputBitstream = s->bitstream;
  pic.pictureStruct = NV_ENC_PIC_STRUCT_FRAME;
  pic.inputTimeStamp = timestamp;
  if (force_keyframe)
    pic.encodePicFlags = NV_ENC_PIC_FLAG_FORCEIDR | NV_ENC_PIC_FLAG_OUTPUT_SPSPPS;
  if (check(s, s->api.nvEncEncodePicture(s->encoder, &pic), "Encoding AV1 without buffering", error, capacity)) return -1;
  NV_ENC_LOCK_BITSTREAM lock = {0};
  lock.version = NV_ENC_LOCK_BITSTREAM_VER;
  lock.outputBitstream = s->bitstream;
  if (check(s, s->api.nvEncLockBitstream(s->encoder, &lock), "Reading AV1 packet", error, capacity)) return -1;
  s->locked = 1;
  *bytes = lock.bitstreamBufferPtr; *length = lock.bitstreamSizeInBytes;
  *keyframe = lock.pictureType == NV_ENC_PIC_TYPE_IDR || lock.pictureType == NV_ENC_PIC_TYPE_I;
  return 0;
}

int vsr_encoder_release(VsrEncoder *s, char *error, size_t capacity) {
  if (s->locked) {
    if (check(s, s->api.nvEncUnlockBitstream(s->encoder, s->bitstream), "Unlocking AV1 packet", error, capacity)) return -1;
    s->locked = 0;
  }
  if (s->mapped) {
    if (check(s, s->api.nvEncUnmapInputResource(s->encoder, s->mapped), "Unmapping CUDA surface", error, capacity)) return -1;
    s->mapped = NULL;
  }
  return 0;
}
