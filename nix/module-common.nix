# Shared options and native host data; no activation scripts or mutable installs.
{
  self,
  config,
  lib,
  pkgs,
}:
let
  cfg = config.programs.linux-rtx-vsr;
  browserPackageNames = {
    chromium = "chromium";
    chrome = "google-chrome";
    brave = "brave";
    edge = "microsoft-edge";
    vivaldi = "vivaldi";
    helium = "helium";
  };
  enabledBrowsers = lib.filter (browser: cfg.browsers.${browser}.enable) (
    builtins.attrNames browserPackageNames
  );
  browserPackages = lib.filter (package: package != null) (
    map (browser: cfg.browsers.${browser}.package) enabledBrowsers
  );
  host = "io.github.abdulrahman1s.linux_rtx_vsr";
  extensionId = "pdobgdmlfcnimbnndkchfocncchfoadm";
  package =
    if cfg.runtime.enable then
      pkgs.callPackage ./runtime-wrapper.nix {
        package = cfg.package;
        runtime = cfg.runtime.package;
        inherit (cfg.runtime) driverLibraryPaths;
      }
    else
      cfg.package;
  launcher = pkgs.writeShellScript "linux-rtx-vsr-native-host" ''
    exec ${lib.getExe package} native-host "$@"
  '';
in
{
  inherit
    package
    host
    enabledBrowsers
    browserPackages
    ;
  extensionPath = "${package}/share/linux-rtx-vsr/extension";
  manifest = {
    name = host;
    description = "Linux RTX VSR native integration";
    path = toString launcher;
    type = "stdio";
    allowed_origins = [ "chrome-extension://${extensionId}/" ];
  };
  options = {
    enable = lib.mkEnableOption "local NVIDIA video enhancement and declarative browser integration";
    package = lib.mkOption {
      type = lib.types.package;
      default = self.packages.${pkgs.stdenv.hostPlatform.system}.default;
      defaultText = lib.literalExpression "inputs.linux-rtx-vsr.packages.${pkgs.stdenv.hostPlatform.system}.default";
      description = "Base application package, including matching extension assets.";
    };
    browsers = lib.mapAttrs (browser: packageName: {
      enable = lib.mkEnableOption "${browser} installation and native messaging integration";
      package = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = if browser == "helium" then null else pkgs.${packageName};
        defaultText = lib.literalExpression (if browser == "helium" then "null" else "pkgs.${packageName}");
        description = "Browser package to install when ${browser} integration is enabled. Set null to register an already installed browser without managing its package. Custom packages must use the standard ${browser} native messaging locations.";
      };
    }) browserPackageNames;
    runtime = {
      enable = lib.mkEnableOption "the separately licensed NVIDIA VFX runtime (NVENC comes from the driver)";
      package = lib.mkOption {
        type = lib.types.package;
        default = pkgs.callPackage ./nvidia-runtime.nix { };
        defaultText = lib.literalExpression "pkgs.callPackage ./nvidia-runtime.nix { }";
        description = "VFX runtime with nvvfx/libs; requires accepting NVIDIA terms and unfree packages.";
      };
      jpegPackage = lib.mkOption {
        type = lib.types.nullOr lib.types.package;
        default = null;
        description = "Deprecated, ignored compatibility option. AV1 streaming uses the NVIDIA driver's NVENC library, not nvJPEG.";
      };
      driverLibraryPaths = lib.mkOption {
        type = lib.types.listOf lib.types.str;
        default = [ "/run/opengl-driver/lib" ];
        description = "CUDA driver library search paths. Override for non-NixOS hosts.";
      };
    };
  };
}
