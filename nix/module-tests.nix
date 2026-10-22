# Evaluate real NixOS and Home Manager modules without NVIDIA downloads or a VM.
{
  self,
  pkgs,
  home-manager,
}:
let
  inherit (pkgs) lib;
  host = "io.github.abdulrahman1s.linux_rtx_vsr";
  fakePackage = pkgs.runCommand "vsr-module-fixture" { meta.mainProgram = "linux-rtx-vsr"; } ''
    mkdir -p $out/bin $out/share/linux-rtx-vsr/extension
    cat > $out/bin/linux-rtx-vsr <<'EOF'
    #!${pkgs.runtimeShell}
    printf '%s\n' "''${LINUX_RTX_VSR_EXECUTABLE:-}" "''${LINUX_RTX_VSR_SDK_DIR:-}" "''${LINUX_RTX_VSR_JPEG_LIBRARY:-}" "''${LD_LIBRARY_PATH:-}"
    EOF
    chmod +x $out/bin/linux-rtx-vsr
    echo '{"version":"test"}' > $out/share/linux-rtx-vsr/extension/manifest.json
  '';
  browserNames = [
    "chromium"
    "chrome"
    "brave"
  ];
  browserFixtures = lib.genAttrs browserNames (
    name: pkgs.writeShellScriptBin "vsr-test-${name}" "exit 0"
  );
  browsers = lib.genAttrs browserNames (name: {
    enable = true;
    package = browserFixtures.${name};
  });
  os =
    enabled:
    self.inputs.nixpkgs.lib.nixosSystem {
      system = "x86_64-linux";
      modules = [
        self.nixosModules.default
        {
          system.stateVersion = "25.11";
          programs.linux-rtx-vsr = {
            enable = enabled;
            package = fakePackage;
            inherit browsers;
          };
        }
      ];
    };
  home =
    overrides:
    home-manager.lib.homeManagerConfiguration {
      inherit pkgs;
      modules = [
        self.homeManagerModules.default
        {
          home.username = "vsr-test";
          home.homeDirectory = "/home/vsr-test";
          home.stateVersion = "25.11";
          programs.linux-rtx-vsr = {
            enable = true;
            package = fakePackage;
            inherit browsers;
          }
          // overrides;
        }
      ];
    };
  osConfig = (os true).config;
  hm =
    (home {
      settings = {
        quality = 4;
        gpu_idle_seconds = 3;
        idle_seconds = 20;
      };
    }).config;
  hmDefault = (home { }).config;
  hmNoBrowsers = (home { browsers = { }; }).config;
  hmChromium = (home { browsers.chromium.enable = true; }).config;
  hmBrave = (home { browsers.brave.enable = true; }).config;
  hmRegistrationOnly =
    (home {
      browsers.chromium = {
        enable = true;
        package = null;
      };
    }).config;
  hmBrowserDisabled =
    (home {
      browsers.chromium = {
        enable = false;
        package = browserFixtures.chromium;
      };
    }).config;
  hmDisabled = (home { enable = false; }).config;
  hmInvalid =
    (home {
      settings = {
        gpu_idle_seconds = 30;
        idle_seconds = 10;
      };
    }).config;
  # Exercise runtime wrapping with tiny free fixtures. Production runtime paths
  # stay lazy, so these tests work with allowUnfree = false.
  hmRuntime =
    (home {
      runtime = {
        enable = true;
        package = fakePackage;
        jpegPackage = fakePackage;
        driverLibraryPaths = [ "/custom/driver path" ];
      };
    }).config;
  commonHome = import ./module-common.nix {
    inherit self pkgs lib;
    config = hm;
  };
  commonRuntime = import ./module-common.nix {
    inherit self pkgs lib;
    config = hmRuntime;
  };
  manifestPath = "chromium/NativeMessagingHosts/${host}.json";
  manifest = builtins.fromJSON (
    builtins.unsafeDiscardStringContext hm.xdg.configFile.${manifestPath}.text
  );
  runtimeManifest = builtins.fromJSON (
    builtins.unsafeDiscardStringContext hmRuntime.xdg.configFile.${manifestPath}.text
  );
in
assert
  !(builtins.hasAttr "chromium/native-messaging-hosts/${host}.json" (os false)
  .config.environment.etc);
assert builtins.hasAttr "chromium/native-messaging-hosts/${host}.json" osConfig.environment.etc;
assert builtins.hasAttr "opt/chrome/native-messaging-hosts/${host}.json" osConfig.environment.etc;
assert
  osConfig.environment.etc."linux-rtx-vsr/extension".source
  == "${fakePackage}/share/linux-rtx-vsr/extension";
assert builtins.hasAttr "google-chrome/NativeMessagingHosts/${host}.json" hm.xdg.configFile;
assert builtins.hasAttr "BraveSoftware/Brave-Browser/NativeMessagingHosts/${host}.json"
  hm.xdg.configFile;
# Both module systems install enabled browser packages and remove all module
# contributions when disabled. Evaluate defaults lazily (Chrome is unfree).
assert lib.all (
  name: builtins.elem browserFixtures.${name} osConfig.environment.systemPackages
) browserNames;
assert lib.all (name: builtins.elem browserFixtures.${name} hm.home.packages) browserNames;
assert lib.all (
  name: !(builtins.elem browserFixtures.${name} (os false).config.environment.systemPackages)
) browserNames;
assert lib.all (
  name: !(builtins.elem browserFixtures.${name} hmDisabled.home.packages)
) browserNames;
assert !(builtins.hasAttr manifestPath hmNoBrowsers.xdg.configFile);
assert !(builtins.hasAttr manifestPath hmBrowserDisabled.xdg.configFile);
assert !(builtins.elem browserFixtures.chromium hmBrowserDisabled.home.packages);
assert builtins.hasAttr manifestPath hmChromium.xdg.configFile;
assert builtins.elem pkgs.chromium hmChromium.home.packages;
assert hmChromium.programs.linux-rtx-vsr.browsers.chrome.enable == false;
assert builtins.hasAttr "BraveSoftware/Brave-Browser/NativeMessagingHosts/${host}.json"
  hmBrave.xdg.configFile;
assert builtins.elem pkgs.brave hmBrave.home.packages;
assert builtins.hasAttr manifestPath hmRegistrationOnly.xdg.configFile;
assert !(builtins.elem pkgs.chromium hmRegistrationOnly.home.packages);
assert manifest.allowed_origins == [ "chrome-extension://pdobgdmlfcnimbnndkchfocncchfoadm/" ];
assert (builtins.fromJSON hm.xdg.configFile."linux-rtx-vsr/config.json".text).quality == 4;
assert !(builtins.hasAttr "linux-rtx-vsr/config.json" hmDefault.xdg.configFile);
assert !(builtins.hasAttr manifestPath hmDisabled.xdg.configFile);
assert runtimeManifest.allowed_origins == manifest.allowed_origins;
assert lib.all (item: item.assertion) hm.assertions;

assert
  !(builtins.tryEval (home { settings.quality = 5; }).config.programs.linux-rtx-vsr.settings.quality)
  .success;
assert !(builtins.tryEval hmInvalid.assertions).success;
pkgs.runCommand "linux-rtx-vsr-module-checks" { } ''
  test -x ${commonHome.manifest.path}
  test -x ${commonRuntime.manifest.path}
  ${commonHome.manifest.path}
  ${commonRuntime.manifest.path} > runtime-environment
  grep -Fx "${lib.getExe commonRuntime.package}" runtime-environment
  grep -Fx "${fakePackage}/nvvfx/libs" runtime-environment
  # A legacy jpegPackage setting must not add nvJPEG to the runtime closure.
  test -z "$(${pkgs.gnugrep}/bin/grep LINUX_RTX_VSR_JPEG_LIBRARY ${lib.getExe commonRuntime.package} || true)"
  grep -F "/custom/driver path" runtime-environment
  # Verify that the generated runtime wrapper binds all three persistent paths.
  grep -F LINUX_RTX_VSR_EXECUTABLE ${lib.getExe commonRuntime.package}
  grep -F '${fakePackage}/nvvfx/libs' ${lib.getExe commonRuntime.package}
  grep -F '/custom/driver path' ${lib.getExe commonRuntime.package}
  touch $out
''
