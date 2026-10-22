# Nix and NixOS

Only `x86_64-linux` is exposed. `flake.lock` pins nixpkgs; `Cargo.lock` and `bun.lock` pin application/development dependencies. Bun compiles the TypeScript extension during the application build. The development shell includes Bun and Just; no separate Node.js installation is needed. Nix checks fetch registry tarballs by their locked integrity hashes from `nix/bun-deps.json` and run offline. Refresh that list with `just sync-deps` after changing `bun.lock`. No proprietary SDK is needed to build or test the default package.

```sh
nix build                         # ./result/bin/linux-rtx-vsr
nix run . -- --help
nix develop                       # Rust, Bun, Just, FFmpeg, Chromium, formatters
nix fmt -- --check flake.nix nix/*.nix
nix flake check
```

Default builds include the executable (with embedded extension assets) and `share/linux-rtx-vsr` documentation/scripts. Use `extension` or `integration install` to export extension assets to a stable user directory. The repository checkout is not needed after installation.

## Recommended: declarative modules

The flake exports `nixosModules.default` and `homeManagerModules.default`. Choose one integration owner per browser/user. Both install the application, register a native host limited to this extension's fixed ID, and expose matching extension assets. Each enabled browser integration also installs its selected browser package. The modules leave kernel driver setup and your personal browser profile to you; native messaging starts the backend on demand. Idle GPU/process cleanup still applies.

Add this input to your system or Home Manager flake:

```nix
inputs.linux-rtx-vsr.url = "github:abdulrahman1s/linux-rtx-vsr";
```

Until this repository is published, use `path:/absolute/path/to/linux-vsr` instead. Lock the input with your usual `nix flake lock`; updates follow your normal system/Home Manager rebuild and rollback workflow.

### NixOS: install for the machine

Add the module to the `modules` list passed to `nixpkgs.lib.nixosSystem`:

```nix
modules = [
  inputs.linux-rtx-vsr.nixosModules.default
  ({ pkgs, ... }: {
    # Explicit acceptance of separately licensed NVIDIA/CUDA dependencies.
    nixpkgs.config.allowUnfree = true;
    programs.linux-rtx-vsr = {
      enable = true;
      runtime.enable = true;
      browsers.chromium = {
        enable = true;
        package = pkgs.chromium; # optional: this is the default
      };
    };
  })
];
```

Run `sudo nixos-rebuild switch --flake .#YOUR_HOST`. In Chromium, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select **`/etc/linux-rtx-vsr/extension`**. Run `linux-rtx-vsr doctor --gpu`, then use the extension's popup to enable a video or save an automatic site rule. There is no `integration install` step.

The module creates system-wide manifests under `/etc/chromium/native-messaging-hosts` or `/etc/opt/chrome/native-messaging-hosts` (Chrome and Brave share the latter directory). Every local user can use the extension; each user's configuration, state, credentials and backend remain separate. Native settings remain mutable through `config set`. Use Home Manager instead if you want per-user declarative settings or manifests.

`doctor` checks the installed `/etc/linux-rtx-vsr/extension/manifest.json` when present, so a NixOS installation does not require an additional exported copy in your home directory. It also recognizes Brave Origin's user registry and `/etc/linux-rtx-vsr/native-messaging-hosts` for custom sandbox integrations. Finding the latter verifies the manifest on the host; only a successful backend check in the browser confirms that the sandbox exposes it and can execute its launcher. Keep these binds in the browser's declarative sandbox configuration.

### Home Manager: install for one user

Add the module to `home-manager.lib.homeManagerConfiguration.modules`, or to `home-manager.users.YOUR_USER.imports` when Home Manager is a NixOS module:

```nix
imports = [ inputs.linux-rtx-vsr.homeManagerModules.default ];

programs.linux-rtx-vsr = {
  enable = true;
  runtime.enable = true;
  browsers.chromium.enable = true;
  settings = {
    quality = 3;
    scale = 2.0;
    gpu_idle_seconds = 5;
    idle_seconds = 60;
  };
};
```

The `pkgs` used by Home Manager must allow the NVIDIA unfree dependencies. For standalone Home Manager, configure this where you import nixpkgs:

```nix
pkgs = import inputs.nixpkgs {
  system = "x86_64-linux";
  config.allowUnfree = true;
};
```

With NixOS-integrated Home Manager and `home-manager.useGlobalPkgs = true`, use the system's `nixpkgs.config.allowUnfree` instead.

Run `home-manager switch --flake .#YOUR_USER` (or your normal NixOS rebuild for integrated Home Manager). Load **`~/.local/share/linux-rtx-vsr/extension`** with **Load unpacked** in Chromium; if you customize `xdg.dataHome`, use `$XDG_DATA_HOME/linux-rtx-vsr/extension`. Native manifests follow `xdg.configHome` for Chromium, Chrome and Brave. Run `linux-rtx-vsr doctor --gpu`.

Leaving `settings = { };` (the default) keeps native configuration user-managed. Setting any field creates a declarative `linux-rtx-vsr/config.json`: CLI `config set/reset` refuses to replace this managed symlink. Edit Nix and rebuild instead. The file is in the public Nix store: never place secrets there. Extension site rules and toolbar settings remain editable and persist in the browser, independently of this file. Quality/scale here are native defaults; the extension's per-session selections take precedence.

### Module options

| Option under `programs.linux-rtx-vsr` | Default                        | Purpose                                                                                 |
| ------------------------------------- | ------------------------------ | --------------------------------------------------------------------------------------- |
| `enable`                              | `false`                        | Install package, extension assets and native messaging manifests                        |
| `package`                             | This flake's free application  | Override the base package; must include matching `share/linux-rtx-vsr/extension` assets |
| `browsers.chromium.enable`            | `false`                        | Install Chromium and register its native host                                           |
| `browsers.chromium.package`           | `pkgs.chromium`                | Chromium package override; `null` registers without installing                          |
| `browsers.chrome.enable`              | `false`                        | Install Google Chrome and register its native host                                      |
| `browsers.chrome.package`             | `pkgs.google-chrome`           | Chrome package override; requires unfree acceptance unless overridden                   |
| `browsers.brave.enable`               | `false`                        | Install Brave and register its native host                                              |
| `browsers.brave.package`              | `pkgs.brave`                   | Brave package override; `null` registers without installing                             |
| `runtime.enable`                      | `false`                        | Wrap the app with packaged VFX/NVENC paths; explicitly opt into unfree runtime          |
| `runtime.package`                     | Pinned NVIDIA VFX package      | Override runtime root containing `nvvfx/libs`                                           |
| `runtime.driverLibraryPaths`          | `[ "/run/opengl-driver/lib" ]` | Persistent driver search paths; useful outside NixOS                                    |
| `settings` (Home Manager only)        | `{ }`                          | Optional typed declarative native settings                                              |

Browser integration is opt-in: enabling the application alone does not install/register any browser. To use a customized browser, assign its derivation directly:

```nix
programs.linux-rtx-vsr.browsers.chromium = {
  enable = true;
  package = pkgs.chromium.override { enableWideVine = false; };
};
```

Set a browser's `package = null;` if your system or another module already manages its installation. Native registration still applies. Package overrides must keep that browser's standard native messaging locations; changing the package does not change the integration family. Disabled browser entries do not evaluate/install their packages, so Chrome's default unfree package does not affect Chromium-only setups. Browser installation does not side-load the extension: follow **Load unpacked** above.

The previous list syntax is replaced by these browser attributes. For example, replace `browsers = [ "chromium" ];` with `browsers.chromium.enable = true;`.

Home Manager settings accept `quality` (1–4), native-benchmark `scale` (1–120), `encode_qp` (0–51, default 14), `gpu_idle_seconds` (1–60), `idle_seconds` (10–3600), `sdk_dir`, and `model_dir`. Browser sessions select a resolution target in the popup instead of the native benchmark scale. Legacy `jpeg_library`, `jpeg_quality` and `runtime.jpegPackage` settings are accepted but ignored; nvJPEG is no longer installed or loaded. Omitted/null fields use application defaults. GPU idle must be less than backend idle. Packaged-runtime SDK environment paths take precedence over their configuration fields. Leave `runtime.enable = false` when providing your own SDK configuration.

### Migration, updates and removal

The downstream `linux-rtx-vsr-brave.patch` and YouTube-default patch are integrated into the source. Remove those patch entries when updating a separately maintained Nix derivation. Legacy `jpegPackage` wrapper arguments are accepted and ignored; the wrapper no longer installs nvJPEG.

Before switching from the CLI installer, stop the backend and run `linux-rtx-vsr integration remove --browser chromium` for each previously installed browser. This removes CLI-owned manifests that could shadow the system-wide ones. Back up an existing `config.json` before adopting Home Manager `settings`; Home Manager reports existing-file collisions instead of overwriting your data. Likewise move an existing exported `~/.local/share/linux-rtx-vsr/extension` aside before Home Manager takes ownership. Load the module's extension path once after migration.

For updates, stop the backend, update the flake input and rebuild/switch; manifests, launchers and extension assets advance together and the active generation retains their store references. Click **Reload** on the extension and refresh video tabs. Some browser builds remember the resolved store directory instead of the selected symlink; if the extension still shows an old version, remove it and use **Load unpacked** with the module path again. A running old backend is not restarted by activation, so stop it before updating if it is still active. Rollbacks restore the corresponding paths; reload the extension afterward. Never run `integration install/remove` against module-owned manifests.

To remove, disable `programs.linux-rtx-vsr.enable`, rebuild/switch, and remove the extension in the browser. Mutable user config/state and browser site rules are deliberately retained; see the README for optional complete data removal. Neither module removes your host NVIDIA driver.

Flatpak/Snap browsers and custom `--user-data-dir` profiles may not see these standard manifest paths or execute store binaries. They need separate sandbox/profile integration and have not been validated. Chromium is the tested browser target; Chrome and Brave registration paths are provided, but real enhancement there remains untested. The [Chromium native messaging documentation](https://developer.chrome.com/docs/extensions/develop/concepts/native-messaging) and [Brave source](https://github.com/brave/brave-core/blob/master/app/brave_main_delegate.cc) describe the relevant locations.

## Opt-in NVIDIA runtime without modules

After reviewing [NVIDIA's separate terms](runtime.md), explicitly allow unfree evaluation and install the wrapper output:

```sh
NIXPKGS_ALLOW_UNFREE=1 nix profile add --impure .#with-runtime
linux-rtx-vsr integration install --browser chromium
linux-rtx-vsr doctor --gpu
```

For a one-off test:

```sh
NIXPKGS_ALLOW_UNFREE=1 nix run --impure .#with-runtime -- doctor --gpu
```

`with-runtime` and `nvidia-runtime` live under `legacyPackages.x86_64-linux` to keep their unfree evaluation out of ordinary `nix flake check`. Nix resolves these names for `nix build`, `nix run`, and `nix profile add`. The default build does not include the runtime. The wrapper supplies VFX 1.3 and host driver library paths and registers itself as the native executable, so on-demand browser startup retains the runtime environment.

The VFX runtime is extracted from a SHA-256-pinned NVIDIA archive. NVIDIA signed `libnvidia-ngx-*` objects remain untouched. Only other libraries receive Nix runtime-path fixes. The package disables substitutes/distribution for the proprietary closure; do not push it to public binary caches without independent redistribution rights. NVENC is loaded from the host driver; nvJPEG is not required.

The optional runtime downloads from NVIDIA's index at build time via a fixed-output fetch. A private network, NVIDIA access restriction, or removed upstream archive can prevent the build; use an entitled, verified archive in that case. Application builds remain independent of download access.

## NixOS host setup

Enable the normal host NVIDIA graphics driver in your NixOS configuration. A minimal example, adapted to the host's boot/kernel setup:

```nix
{
  services.xserver.videoDrivers = [ "nvidia" ];
  hardware.graphics.enable = true;
  hardware.nvidia.modesetting.enable = true;
  # Select a driver/package and open/proprietary kernel module appropriate
  # to your GPU using your existing NixOS hardware configuration.
}
```

Rebuild/reboot as needed and confirm `nvidia-smi` works. The kernel module and userspace driver must match. The wrapper searches `/run/opengl-driver/lib`; neither the package nor a flake development shell installs a kernel driver. Keep an installed package/profile reference while using the browser; a garbage-collected store executable cannot be launched from a stale manifest. Re-run `integration install` after updating the package to record its new wrapper path and export the matching extension version.

The modules above manage store paths declaratively, so they do not need a manual integration reinstall after each rebuild. They intentionally leave NVIDIA driver policy to your existing hardware configuration.

## Nix on another distribution

Keep the distribution's NVIDIA driver. Its `libcuda.so.1` and `libnvidia-encode.so.1` must be discoverable inside the launched application. Unlike NixOS, `/run/opengl-driver/lib` may not exist. Export the actual driver path before installing/running the wrapper, or create a stable wrapper that supplies it. Some distributions require nixGL for graphics programs; the native backend uses the CUDA driver, so verify `doctor --gpu` first rather than assuming nixGL is necessary. This combination has not been tested here.

If you create your own wrapper, register that stable wrapper with `LINUX_RTX_VSR_EXECUTABLE=/absolute/wrapper linux-rtx-vsr integration install ...`. The browser does not inherit arbitrary terminal environment changes after registration; put persistent requirements in the wrapper itself.

Home Manager can also manage integration on another distribution. Set `runtime.driverLibraryPaths` to its actual NVIDIA driver library directory (for example `/usr/lib/x86_64-linux-gnu` on some Debian-family hosts), then verify `doctor --gpu`. The module wrapper persists the paths for native messaging; a terminal-only `LD_LIBRARY_PATH` is insufficient. This host combination remains untested.

## Module validation

`nix flake check` evaluates both real module systems, including disabled modules and browser entries, all three browser registrations and package overrides, Chromium/Brave package defaults, registration-only mode, extension origin restrictions, Home Manager settings/defaults and invalid idle-time assertions. A free fixture exercises runtime wrapping without downloading proprietary code. The package build and Rust tests also check that declarative configuration cannot be replaced through the CLI. These checks do not activate a host configuration or prove a browser on another distribution supports enhancement.

The AV1 transport requires an AV1-encoding RTX Ada/Blackwell GPU. Nix supplies no proprietary encoder implementation: NVENC is part of your host NVIDIA driver. 8K is an experimental popup target; model, encoder, decoder, memory and display support must be checked on the actual host.
