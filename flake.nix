{
  description = "Local NVIDIA VideoSuperRes for Chromium on Linux";
  inputs.nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
  inputs.home-manager = {
    url = "github:nix-community/home-manager/release-26.05";
    inputs.nixpkgs.follows = "nixpkgs";
  };
  outputs =
    {
      self,
      nixpkgs,
      home-manager,
    }:
    let
      system = "x86_64-linux";
      pkgs = import nixpkgs { inherit system; };
      lib = pkgs.lib;
      version = (builtins.fromTOML (builtins.readFile ./Cargo.toml)).package.version;
      source = lib.cleanSourceWith {
        src = ./.;
        filter =
          path: type:
          lib.cleanSourceFilter path type
          && !(builtins.elem (baseNameOf path) [
            "target"
            "build"
            "node_modules"
            "dist"
            "test-results"
            "result"
            "__pycache__"
          ]);
      };
      bunDeps = import ./nix/bun-deps.nix { inherit pkgs; };
      cargoVendor = pkgs.rustPlatform.importCargoLock { lockFile = ./Cargo.lock; };
      application = pkgs.rustPlatform.buildRustPackage {
        pname = "linux-rtx-vsr";
        inherit version;
        src = source;
        cargoDeps = cargoVendor;
        nativeBuildInputs = [
          pkgs.bun
        ];
        postInstall = ''
          mkdir -p $out/share/linux-rtx-vsr
          bun scripts/build-extension.ts
          cp -r docs licenses scripts README.md LICENSE THIRD_PARTY.md $out/share/linux-rtx-vsr/
          cp -r build/extension $out/share/linux-rtx-vsr/
          bun scripts/collect-licenses.ts --offline --output $out/share/linux-rtx-vsr/licenses/rust-dependencies.txt
        '';
        meta = {
          description = "Local NVIDIA VideoSuperRes for Chromium";
          homepage = "https://github.com/abdulrahman1s/linux-rtx-vsr";
          license = lib.licenses.mit;
          mainProgram = "linux-rtx-vsr";
          platforms = [ system ];
        };
      };
      runtime = pkgs.callPackage ./nix/nvidia-runtime.nix { };
      withRuntime = pkgs.callPackage ./nix/runtime-wrapper.nix {
        package = application;
        inherit runtime;
      };
    in
    {
      nixosModules.default = import ./nix/nixos-module.nix { inherit self; };
      homeManagerModules.default = import ./nix/home-manager-module.nix { inherit self; };
      packages.${system} = {
        default = application;
      };
      # Keep unfree opt-in outputs lazy so ordinary flake checks require no
      # NVIDIA license acceptance, proprietary downloads, or GPU access.
      legacyPackages.${system} = {
        with-runtime = withRuntime;
        nvidia-runtime = runtime;
      };
      apps.${system} = {
        default = {
          type = "app";
          program = "${application}/bin/linux-rtx-vsr";
          meta.description = "Local NVIDIA VideoSuperRes for Chromium";
        };
      };
      devShells.${system}.default = pkgs.mkShell {
        packages = [
          pkgs.cargo
          pkgs.rustc
          pkgs.rustfmt
          pkgs.clippy
          pkgs.bun
          pkgs.unzip
          pkgs.zip
          pkgs.ffmpeg
          pkgs.chromium
          pkgs.nixfmt
          pkgs.just
          pkgs.shellcheck
        ];
        LD_LIBRARY_PATH = "/run/opengl-driver/lib";
        CHROMIUM_PATH = "${pkgs.chromium}/bin/chromium";
      };
      formatter.${system} = pkgs.nixfmt;
      checks.${system} = {
        installers =
          pkgs.runCommand "linux-rtx-vsr-installer-checks" { nativeBuildInputs = [ pkgs.shellcheck ]; }
            ''
              cd ${source}
              shellcheck -x scripts/install.sh scripts/install-runtime.sh scripts/runtime-archive.sh
              touch $out
            '';
        modules = import ./nix/module-tests.nix {
          inherit self pkgs home-manager;
        };
        build = application;
        rust-format =
          pkgs.runCommand "rust-format"
            {
              nativeBuildInputs = [
                pkgs.cargo
                pkgs.rustfmt
              ];
            }
            ''
              cp -r ${source} source; chmod -R u+w source; cd source
              cargo fmt --check
              touch $out
            '';
        extension =
          pkgs.runCommand "extension-checks"
            {
              nativeBuildInputs = [
                pkgs.bun
                pkgs.just
                pkgs.unzip
              ];
            }
            ''
              cp -r ${source} source; chmod -R u+w source; cd source
              cp -r ${bunDeps} node_modules; chmod -R u+w node_modules
              export HOME=$TMPDIR
              bun run format:check
              just --fmt --check
              bun run check
              bun test
              touch $out
            '';
      };
    };
}
