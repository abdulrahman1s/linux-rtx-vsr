{ pkgs }:
let
  dependencies = builtins.fromJSON (builtins.readFile ./bun-deps.json);
  unpack =
    dep:
    let
      source = pkgs.fetchurl { inherit (dep) url hash; };
    in
    ''
      mkdir -p "$out/${dep.path}"
      tar -xf ${source} --strip-components=1 -C "$out/${dep.path}"
    '';
in
pkgs.runCommand "linux-rtx-vsr-bun-dependencies" { } (
  "mkdir -p $out\n" + pkgs.lib.concatMapStringsSep "\n" unpack dependencies
)
