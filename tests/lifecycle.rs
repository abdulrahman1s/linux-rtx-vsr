use serde_json::{Value, json};
use std::{
    io::{Read, Write},
    os::unix::net::UnixStream,
    process::{Command, Output},
    thread,
    time::{Duration, Instant},
};
fn cli(root: &std::path::Path, args: &[&str]) -> Output {
    Command::new(env!("CARGO_BIN_EXE_linux-rtx-vsr"))
        .args(args)
        .env("XDG_CONFIG_HOME", root.join("config"))
        .env("XDG_STATE_HOME", root.join("state"))
        .env("XDG_DATA_HOME", root.join("data"))
        .output()
        .unwrap()
}
#[test]
fn backend_lifecycle_origin_security_and_idle_exit() {
    let temp = tempfile::tempdir().unwrap();
    let root = temp.path();
    for args in [
        &["config", "set", "idle_seconds", "10"][..],
        &["config", "set", "gpu_idle_seconds", "1"][..],
    ] {
        assert!(cli(root, args).status.success());
    }
    let first = cli(root, &["start"]);
    assert!(
        first.status.success(),
        "{}",
        String::from_utf8_lossy(&first.stderr)
    );
    let a: Value = serde_json::from_slice(&first.stdout).unwrap();
    assert_eq!(a["gpu_loaded"], false);
    let b: Value = serde_json::from_slice(&cli(root, &["start"]).stdout).unwrap();
    assert_eq!(a["pid"], b["pid"]);
    let endpoint: Value = serde_json::from_slice(
        &std::fs::read(root.join("state/linux-rtx-vsr/endpoint.json")).unwrap(),
    )
    .unwrap();
    let mut socket = UnixStream::connect(root.join("state/linux-rtx-vsr/control.sock")).unwrap();
    writeln!(socket, "{}", json!({"op":"grant"})).unwrap();
    let mut response = String::new();
    socket.read_to_string(&mut response).unwrap();
    let grant: Value = serde_json::from_str(&response).unwrap();
    let port = endpoint["port"].as_u64().unwrap();
    let bad = tungstenite::connect(format!("ws://127.0.0.1:{port}/v1/stream"));
    assert!(bad.is_err(), "Originless browser connection must fail");
    use tungstenite::client::IntoClientRequest;
    let mut req = format!("ws://127.0.0.1:{port}/v1/stream")
        .into_client_request()
        .unwrap();
    req.headers_mut().insert(
        "Origin",
        format!("chrome-extension://{}", "pdobgdmlfcnimbnndkchfocncchfoadm")
            .parse()
            .unwrap(),
    );
    let (mut ws, _) = tungstenite::connect(req.clone()).unwrap();
    ws.send(tungstenite::Message::text(
        json!({"token":grant["token"],"quality":3,"scale":2}).to_string(),
    ))
    .unwrap();
    assert!(ws.read().unwrap().to_text().unwrap().contains("ready"));
    let (mut replay, _) = tungstenite::connect(req.clone()).unwrap();
    replay
        .send(tungstenite::Message::text(
            json!({"token":grant["token"],"quality":3,"scale":2}).to_string(),
        ))
        .unwrap();
    assert!(replay.read().is_err());
    let mut second = UnixStream::connect(root.join("state/linux-rtx-vsr/control.sock")).unwrap();
    writeln!(second, "{}", json!({"op":"grant"})).unwrap();
    let mut response = String::new();
    second.read_to_string(&mut response).unwrap();
    let grant: Value = serde_json::from_str(&response).unwrap();
    let (mut competing, _) = tungstenite::connect(req).unwrap();
    competing
        .send(tungstenite::Message::text(
            json!({"token":grant["token"],"quality":3,"scale":2}).to_string(),
        ))
        .unwrap();
    assert!(
        competing
            .read()
            .unwrap()
            .to_text()
            .unwrap()
            .contains("Another tab")
    );
    // A malformed frame reaches the real Rust GPU subprocess but is rejected
    // before loading NVIDIA libraries. Ordinary CI verifies worker recovery.
    ws.send(tungstenite::Message::Binary(vec![1, 2, 3].into()))
        .unwrap();
    assert!(
        ws.read()
            .unwrap()
            .to_text()
            .unwrap()
            .contains("Frame exceeds")
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&cli(root, &["status"]).stdout).unwrap()["gpu_loaded"],
        false
    );
    let _ = ws.close(None);
    drop(ws);
    assert!(cli(root, &["stop"]).status.success());
    assert_eq!(
        serde_json::from_slice::<Value>(&cli(root, &["status"]).stdout).unwrap()["running"],
        false
    );
    assert!(cli(root, &["start"]).status.success());
    let at = Instant::now();
    while at.elapsed() < Duration::from_secs(12)
        && root.join("state/linux-rtx-vsr/control.sock").exists()
    {
        thread::sleep(Duration::from_millis(100));
    }
    assert!(
        !root.join("state/linux-rtx-vsr/control.sock").exists(),
        "Idle daemon must exit even while status is polled"
    );
}
