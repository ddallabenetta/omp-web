// omp-desktop: Tauri v2 desktop shell for omp-web.
//
// In release builds the bundled Bun runtime starts the omp-web Next.js server
// as a sidecar on a free loopback port, then the main window navigates to
// http://127.0.0.1:<port>. In dev mode (`bun run tauri dev`) the server is
// already running via beforeDevCommand and the webview loads devUrl.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::fs::OpenOptions;
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{Ipv4Addr, SocketAddr, TcpListener, TcpStream};
use std::path::PathBuf;
use std::process::{Child, Command, Stdio};
use std::sync::Mutex;
use std::thread;
use std::time::{Duration, Instant};

use tauri::{AppHandle, Manager, Url};

const WINDOW_LABEL: &str = "main";
const HOST: &str = "127.0.0.1";
const NEXT_ENTRY: &str = "node_modules/next/dist/bin/next";

/// Appends a line to the desktop log in the temp dir and mirrors it to
/// stderr. GUI-launched apps have no terminal, so stderr alone is
/// unreachable; the file makes the sidecar observable.
fn desktop_log(line: &str) {
    if let Ok(mut file) = OpenOptions::new()
        .create(true)
        .append(true)
        .open(std::env::temp_dir().join("omp-desktop.log"))
    {
        let _ = writeln!(file, "{line}");
    }
    eprintln!("{line}");
}

/// Spawns a reader that forwards a child stream line-by-line to the log.
fn drain_to_log<R: Read + Send + 'static>(stream: R) {
    thread::spawn(move || {
        let reader = BufReader::new(stream);
        for line in reader.lines().map_while(Result::ok) {
            desktop_log(&format!("[server] {line}"));
        }
    });
}

/// Name of the bundled Bun runtime for the compiled target. Both macOS
/// binaries are always bundled (universal app), so the architecture selects
/// the right one at runtime.
fn bun_binary_name() -> &'static str {
    #[cfg(all(target_os = "macos", target_arch = "aarch64"))]
    {
        "bun-darwin-aarch64"
    }
    #[cfg(all(target_os = "macos", target_arch = "x86_64"))]
    {
        "bun-darwin-x64"
    }
    #[cfg(all(target_os = "windows", target_arch = "x86_64"))]
    {
        "bun-windows-x64.exe"
    }
    #[cfg(not(any(
        all(target_os = "macos", target_arch = "aarch64"),
        all(target_os = "macos", target_arch = "x86_64"),
        all(target_os = "windows", target_arch = "x86_64"),
    )))]
    {
        "bun-unsupported-platform"
    }
}

/// The running Bun sidecar, kept in managed state so its process group can be
/// torn down when the app exits.
struct ServerChild(Mutex<Option<Child>>);

impl ServerChild {
    fn kill(&self) {
        let child = self.0.lock().ok().and_then(|mut guard| guard.take());
        if let Some(child) = child {
            kill_process_group(child.id());
        }
    }
}

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .setup(|app| {
            // Track the webview URL — ground truth for "stuck on the
            // placeholder" vs "server page loaded" vs "load failed".
            if let Some(window) = app.get_webview_window(WINDOW_LABEL) {
                thread::spawn(move || {
                    let mut last: Option<String> = None;
                    loop {
                        let current = window.url().map(|url| url.to_string());
                        let current = match current {
                            Ok(url) => url,
                            Err(_) => String::from("<unavailable>"),
                        };
                        if last.as_deref() != Some(current.as_str()) {
                            last = Some(current.clone());
                            desktop_log(&format!("[webview] url: {current}"));
                        }
                        thread::sleep(Duration::from_millis(500));
                    }
                });
            }
            if !tauri::is_dev() {
                if let Err(error) = start_server(app) {
                    desktop_log(&format!("[omp-desktop] failed to start the bundled server: {error}"));
                    app.handle().exit(1);
                }
            }
            Ok(())
        })
        .build(tauri::generate_context!())
        .expect("failed to build omp-desktop application")
        .run(|app, event| {
            if matches!(
                event,
                tauri::RunEvent::Exit | tauri::RunEvent::ExitRequested { .. }
            ) {
                if let Some(server) = app.try_state::<ServerChild>() {
                    server.kill();
                }
            }
        });
}

fn start_server(app: &mut tauri::App) -> Result<(), String> {
    let port = free_port().map_err(|error| error.to_string())?;
    let root = server_root(app)?;

    let bun = root.join(bun_binary_name());
    if !bun.is_file() {
        return Err(format!(
            "bundled Bun runtime not found: {} (expected next to the server payload in {})",
            bun.display(),
            root.display()
        ));
    }

    let mut command = Command::new(&bun);
    command
        .current_dir(&root)
        .arg("--bun")
        .arg(NEXT_ENTRY)
        .arg("start")
        .arg("-H")
        .arg(HOST)
        .arg("-p")
        .arg(port.to_string())
        // Relative project paths in the browser resolve against this
        // directory (lib/directory-browser.ts reads OMP_WEB_LAUNCH_CWD).
        .env(
            "OMP_WEB_LAUNCH_CWD",
            app.path().home_dir().map_err(|error| error.to_string())?,
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    if let Some(no_proxy) = loopback_no_proxy() {
        command.env("NO_PROXY", &no_proxy).env("no_proxy", &no_proxy);
    }
    make_process_group(&mut command);

    let mut child = command
        .spawn()
        .map_err(|error| format!("failed to spawn bundled Bun ({}): {error}", bun.display()))?;

    // Drain the server's stdout/stderr into the desktop log; the pipes would
    // otherwise fill up and block the child.
    if let Some(stream) = child.stdout.take() {
        drain_to_log(stream);
    }
    if let Some(stream) = child.stderr.take() {
        drain_to_log(stream);
    }

    app.manage(ServerChild(Mutex::new(Some(child))));

    let handle = app.handle().clone();
    thread::spawn(move || match wait_until_ready(port) {
        Ok(()) => {
            desktop_log(&format!("[omp-desktop] server ready on http://{HOST}:{port}/"));
            navigate_main(&handle, port);
        }
        Err(error) => {
            desktop_log(&format!("[omp-desktop] bundled server failed to become ready: {error}"));
            handle.exit(1);
        }
    });

    desktop_log(&format!("[omp-desktop] omp-web server starting on http://{HOST}:{port}/"));
    Ok(())
}

/// Reserves a free loopback port (the listener is dropped immediately, the
/// server binds the same port moments later).
fn free_port() -> std::io::Result<u16> {
    let listener = TcpListener::bind(SocketAddr::from((Ipv4Addr::LOCALHOST, 0)))?;
    Ok(listener.local_addr()?.port())
}

/// Locates the server payload (node_modules, .next, public, the bundled Bun,
/// ...). Resources land in the app's resource_dir; the parent directory is
/// checked as a fallback for layouts that nest them one level deeper.
fn server_root(app: &tauri::App) -> Result<PathBuf, String> {
    let resources = app
        .path()
        .resource_dir()
        .map_err(|error| error.to_string())?;
    if resources.join("node_modules").is_dir() {
        return Ok(resources);
    }
    if let Some(parent) = resources.parent() {
        if parent.join("node_modules").is_dir() {
            return Ok(parent.to_path_buf());
        }
    }
    Err(format!(
        "server payload not found: expected node_modules next to {}",
        resources.display()
    ))
}

/// Polls the server until it answers an HTTP request (up to 60s).
fn wait_until_ready(port: u16) -> Result<(), String> {
    let deadline = Instant::now() + Duration::from_secs(60);
    let mut last = String::from("no HTTP response");
    while Instant::now() < deadline {
        match http_get(port) {
            Ok(true) => return Ok(()),
            Ok(false) => last = String::from("server answered with a non-HTTP reply"),
            Err(error) => last = error.to_string(),
        }
        thread::sleep(Duration::from_millis(250));
    }
    Err(format!("timed out after 60s: {last}"))
}

fn http_get(port: u16) -> std::io::Result<bool> {
    let addr = SocketAddr::from((Ipv4Addr::LOCALHOST, port));
    let mut stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500))?;
    stream.set_read_timeout(Some(Duration::from_secs(2)))?;
    stream.write_all(
        format!("GET / HTTP/1.1\r\nHost: {HOST}:{port}\r\nConnection: close\r\n\r\n").as_bytes(),
    )?;
    let mut buffer = [0_u8; 64];
    let read = stream.read(&mut buffer)?;
    Ok(read > 0 && buffer.starts_with(b"HTTP/"))
}

fn navigate_main(handle: &AppHandle, port: u16) {
    let url = match Url::parse(&format!("http://{HOST}:{port}/")) {
        Ok(url) => url,
        Err(error) => {
            desktop_log(&format!("[omp-desktop] invalid server URL: {error}"));
            handle.exit(1);
            return;
        }
    };
    match handle.get_webview_window(WINDOW_LABEL) {
        Some(window) => {
            if let Err(error) = window.navigate(url) {
                desktop_log(&format!("[omp-desktop] failed to navigate to the omp-web server: {error}"));
                handle.exit(1);
            }
        }
        None => {
            desktop_log("[omp-desktop] main window not found");
            handle.exit(1);
        }
    }
}

/// Runs the child as a process-group leader so the whole tree can be torn
/// down with one signal (unix: `kill -TERM -pid`; windows: `taskkill /T`).
fn make_process_group(command: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        // CREATE_NEW_PROCESS_GROUP
        command.creation_flags(0x0000_0200);
    }
}

/// Fire-and-forget termination of the sidecar's process group.
fn kill_process_group(pid: u32) {
    #[cfg(unix)]
    {
        let _ = Command::new("kill")
            .args(["-TERM", &format!("-{pid}")])
            .spawn();
    }
    #[cfg(windows)]
    {
        let _ = Command::new("taskkill")
            .args(["/pid", &pid.to_string(), "/T", "/F"])
            .spawn();
    }
}

/// Bun 1.4 sends loopback requests through `HTTP_PROXY` as well, which breaks
/// local providers behind a proxy; it honors `NO_PROXY`, read once at startup,
/// so the loopback hosts are appended before Bun is spawned (bin/runtime.js
/// does the same for the npm launcher).
fn loopback_no_proxy() -> Option<String> {
    let proxied = ["HTTP_PROXY", "HTTPS_PROXY", "http_proxy", "https_proxy"]
        .iter()
        .any(|name| std::env::var_os(name).is_some_and(|value| !value.is_empty()));
    if !proxied {
        return None;
    }
    let current = std::env::var("NO_PROXY")
        .or_else(|_| std::env::var("no_proxy"))
        .unwrap_or_default();
    if current.trim() == "*" {
        return None;
    }
    let mut entries: Vec<String> = current
        .split(',')
        .map(|entry| entry.trim().to_string())
        .filter(|entry| !entry.is_empty())
        .collect();
    let before = entries.len();
    for host in ["localhost", "127.0.0.1", "::1"] {
        if !entries.iter().any(|entry| entry == host) {
            entries.push(host.to_string());
        }
    }
    (entries.len() != before).then(|| entries.join(","))
}
