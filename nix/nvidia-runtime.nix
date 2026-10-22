# Adapted from the user's Nix runtime packaging. Signed NGX objects must stay
# byte-for-byte intact: do not strip or patch their ELF headers/RPATHs.
{
  lib,
  stdenvNoCC,
  fetchurl,
  unzip,
  autoPatchelfHook,
  addDriverRunpath,
  stdenv,
}:
stdenvNoCC.mkDerivation {
  pname = "nvidia-vfx";
  version = "0.2.0.0";
  src = fetchurl {
    url = "https://pypi.nvidia.com/nvidia-vfx/nvidia_vfx-0.2.0.0-cp312-abi3-manylinux_2_27_x86_64.manylinux_2_28_x86_64.whl";
    hash = "sha256-AlKGant5im+SyFQ0Q9iPcW6MW7xqfd13onVHKNran6g=";
  };
  nativeBuildInputs = [
    unzip
    autoPatchelfHook
    addDriverRunpath
  ];
  buildInputs = [ stdenv.cc.cc.lib ];
  dontUnpack = true;
  dontBuild = true;
  dontStrip = true;
  dontPatchELF = true;
  dontAutoPatchelf = true;
  autoPatchelfIgnoreMissingDeps = [ "libcuda.so.1" ];
  appendRunpaths = [ "${addDriverRunpath.driverLink}/lib" ];
  installPhase = ''
    mkdir -p "$out"
    unzip -q "$src" 'nvvfx/libs/*' 'nvidia_vfx.libs/*' '*dist-info/licenses/*' -d "$out"
    for library in "$out"/nvvfx/libs/*.so.*; do
      link="''${library%%.so.*}.so"
      if [ ! -e "$link" ]; then ln -s "$(basename "$library")" "$link"; fi
    done
  '';
  postFixup = ''
    addAutoPatchelfSearchPath "$out"
    mapfile -d ''' libraries < <(find "$out" -type f -name '*.so*' ! -name 'libnvidia-ngx-*' -print0)
    autoPatchelf "''${libraries[@]}"
  '';
  dontDistribute = true;
  preferLocalBuild = true;
  allowSubstitutes = false;
  meta = {
    description = "User-installed NVIDIA VFX 1.3 runtime (no Python execution)";
    license = lib.licenses.unfree;
    platforms = [ "x86_64-linux" ];
    sourceProvenance = [ lib.sourceTypes.binaryNativeCode ];
  };
}
