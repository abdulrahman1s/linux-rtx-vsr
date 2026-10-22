# Keep the native messaging executable bound to its runtime across rebuilds.
{
  lib,
  symlinkJoin,
  makeWrapper,
  stdenv,
  package,
  runtime,
  jpegPackage,
  driverLibraryPaths ? [ "/run/opengl-driver/lib" ],
}:
symlinkJoin {
  name = "linux-rtx-vsr-${package.version or "custom"}-with-runtime";
  paths = [ package ];
  nativeBuildInputs = [ makeWrapper ];
  postBuild = ''
    wrapProgram $out/bin/linux-rtx-vsr \
      --set-default LINUX_RTX_VSR_EXECUTABLE "$out/bin/linux-rtx-vsr" \
      --set-default LINUX_RTX_VSR_SDK_DIR ${lib.escapeShellArg "${runtime}/nvvfx/libs"} \
      --set-default LINUX_RTX_VSR_JPEG_LIBRARY ${lib.escapeShellArg "${lib.getLib jpegPackage}/lib/libnvjpeg.so"} \
      --prefix LD_LIBRARY_PATH : ${
        lib.escapeShellArg (
          lib.concatStringsSep ":" ([ (lib.makeLibraryPath [ stdenv.cc.cc.lib ]) ] ++ driverLibraryPaths)
        )
      }
  '';
  dontDistribute = true;
  meta = package.meta;
}
