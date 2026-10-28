#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
    path::PathBuf,
    process::{Child, Command, Stdio},
    sync::Mutex,
};

struct BackendProcess(Mutex<Option<Child>>);

fn stop_backend(process: &BackendProcess) {
    if let Ok(mut child) = process.0.lock() {
        if let Some(mut child) = child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

fn main() {
    let mut app = tauri::Builder::default()
        .setup(|app| {
            let root = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("..");
            let venv_python = root.join(".venv").join("Scripts").join("python.exe");
            let python = if venv_python.is_file() { venv_python } else { PathBuf::from("python") };
            let child = Command::new(python)
                .args(["-m", "uvicorn", "backend.app.main:app", "--host", "127.0.0.1", "--port", "8765"])
                .current_dir(root)
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn()?;
            app.manage(BackendProcess(Mutex::new(Some(child))));
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build DubParty desktop app");

    app.run(|app_handle, event| {
        if matches!(event, tauri::RunEvent::Exit) {
            if let Some(process) = app_handle.try_state::<BackendProcess>() {
                stop_backend(&process);
            }
        }
    });
}
