{ self }:
{
  config,
  lib,
  pkgs,
  ...
}:
let
  common = import ./module-common.nix {
    inherit
      self
      config
      lib
      pkgs
      ;
  };
  cfg = config.programs.linux-rtx-vsr;
  locations = {
    chromium = "chromium";
    chrome = "google-chrome";
    brave = "BraveSoftware/Brave-Browser";
  };
  optional =
    type: description:
    lib.mkOption {
      type = lib.types.nullOr type;
      default = null;
      inherit description;
    };
  settings = lib.filterAttrs (_: value: value != null) cfg.settings;
in
{
  options.programs.linux-rtx-vsr = common.options // {
    settings = lib.mkOption {
      default = { };
      description = "Optional declarative native configuration. Empty leaves config.json user-managed. Setting any field makes the file read-only; use Nix instead of CLI config set/reset. Browser site rules remain editable in the extension.";
      type = lib.types.submodule {
        options = {
          sdk_dir = optional lib.types.str "Existing VFX library directory when not using the packaged runtime.";
          jpeg_library = optional lib.types.str "Existing nvJPEG library path.";
          model_dir = optional lib.types.str "Optional external NVIDIA model directory.";
          quality = optional (lib.types.ints.between 1 4) "Default AI quality, 1 through 4.";
          scale = optional (lib.types.enum [
            1.5
            2.0
          ]) "Default scale factor.";
          jpeg_quality = optional (lib.types.ints.between 70 100) "JPEG output quality.";
          idle_seconds = optional (lib.types.ints.between 10 3600) "Backend idle timeout in seconds.";
          gpu_idle_seconds = optional (lib.types.ints.between 1 60) "GPU worker idle timeout in seconds, less than idle_seconds.";
        };
      };
    };
  };
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.system == "x86_64-linux";
        message = "linux-rtx-vsr supports only x86_64-linux.";
      }
      {
        assertion = (settings.gpu_idle_seconds or 5) < (settings.idle_seconds or 60);
        message = "linux-rtx-vsr: gpu_idle_seconds must be less than idle_seconds.";
      }
    ];
    home.packages = [ common.package ] ++ common.browserPackages;
    xdg.configFile =
      lib.listToAttrs (
        map (
          browser:
          lib.nameValuePair "${locations.${browser}}/NativeMessagingHosts/${common.host}.json" {
            text = builtins.toJSON common.manifest;
          }
        ) common.enabledBrowsers
      )
      // lib.optionalAttrs (settings != { }) {
        "linux-rtx-vsr/config.json".text = builtins.toJSON settings;
      };
    xdg.dataFile."linux-rtx-vsr/extension".source = common.extensionPath;
  };
}
