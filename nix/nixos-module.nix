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
    chromium = "chromium/native-messaging-hosts";
    chrome = "opt/chrome/native-messaging-hosts";
    # Brave uses Chrome's system-wide native messaging directory.
    brave = "opt/chrome/native-messaging-hosts";
    edge = "opt/edge/native-messaging-hosts";
    vivaldi = "opt/vivaldi/native-messaging-hosts";
    # Helium explicitly falls back to Chrome's system registry.
    helium = "opt/chrome/native-messaging-hosts";
  };
in
{
  options.programs.linux-rtx-vsr = common.options;
  config = lib.mkIf cfg.enable {
    assertions = [
      {
        assertion = pkgs.stdenv.hostPlatform.system == "x86_64-linux";
        message = "linux-rtx-vsr supports only x86_64-linux.";
      }
    ];
    environment.systemPackages = [ common.package ] ++ common.browserPackages;
    environment.etc =
      lib.listToAttrs (
        map (
          browser:
          lib.nameValuePair "${locations.${browser}}/${common.host}.json" {
            text = builtins.toJSON common.manifest;
          }
        ) common.enabledBrowsers
      )
      // {
        "linux-rtx-vsr/extension".source = common.extensionPath;
      };
  };
}
