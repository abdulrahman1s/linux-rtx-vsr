use std::{env, fs, path::Path, process::Command};
fn main() {
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
