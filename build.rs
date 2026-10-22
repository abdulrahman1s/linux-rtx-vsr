use std::{env, fs, path::Path, process::Command};
fn main() {
    // The MIT NVENC header is vendored. The adapter needs only a C compiler;
    // proprietary SDK headers, CUDA tooling and driver libraries are runtime-only.
    println!("cargo:rerun-if-changed=native");
    println!("cargo:rerun-if-env-changed=CC");
    println!("cargo:rerun-if-env-changed=AR");
    let out = std::path::PathBuf::from(env::var_os("OUT_DIR").unwrap());
    assert!(
        Command::new(env::var_os("CC").unwrap_or_else(|| "cc".into()))
            .args([
                "-std=c11",
                "-O2",
                "-fPIC",
                "-Wall",
                "-Wextra",
                "-Werror",
                "-c",
                "native/nvenc.c",
                "-o"
            ])
            .arg(out.join("nvenc.o"))
            .status()
            .expect("A C compiler is required")
            .success()
    );
    assert!(
        Command::new(env::var_os("AR").unwrap_or_else(|| "ar".into()))
            .arg("crs")
            .arg(out.join("libvsr_nvenc.a"))
            .arg(out.join("nvenc.o"))
            .status()
            .expect("ar is required")
            .success()
    );
    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static=vsr_nvenc");
    println!("cargo:rerun-if-changed=extension");
    println!("cargo:rerun-if-changed=scripts/build-extension.ts");
    let assets_dir = Path::new(&env::var("OUT_DIR").unwrap()).join("extension");
    let status = Command::new("bun")
        .arg("scripts/build-extension.ts")
        .arg(&assets_dir)
        .status()
        .expect("Bun is required to compile the extension; install Bun or use nix develop");
    assert!(status.success(), "Extension compilation failed");
    let mut assets = Vec::new();
    fn walk(root: &Path, at: &Path, assets: &mut Vec<(String, String)>) {
        if !at.exists() {
            return;
        }
        for entry in fs::read_dir(at).unwrap() {
            let p = entry.unwrap().path();
            if p.is_dir() {
                walk(root, &p, assets);
            } else {
                assets.push((
                    p.strip_prefix(root).unwrap().to_str().unwrap().into(),
                    fs::canonicalize(p).unwrap().to_str().unwrap().into(),
                ));
            }
        }
    }
    walk(&assets_dir, &assets_dir, &mut assets);
    assets.sort();
    let code = format!(
        "const ASSETS: &[(&str,&[u8])] = &[{}];",
        assets
            .into_iter()
            .map(|(name, path)| format!("({name:?},include_bytes!({path:?}))"))
            .collect::<Vec<_>>()
            .join(",")
    );
    fs::write(
        Path::new(&env::var("OUT_DIR").unwrap()).join("assets.rs"),
        code,
    )
    .unwrap();
}
