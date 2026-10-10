//! One PTY process: spawn, write, resize, and kill the process tree.
//!
//! Output is delivered on a channel. The master stays on a control thread so
//! resize and write do not race the reader.

use crate::process_tree::PidGuard;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{self, Read, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

/// ConPTY's cursor-position query. It sends this on startup and blocks
/// further output until a cursor position report comes back.
const DSR_QUERY: &[u8] = b"\x1b[6n";
const DSR_REPLY: &[u8] = b"\x1b[1;1R";

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
    /// Set on top of the inherited environment (e.g. `CLAUDE_CONFIG_DIR`).
    pub env: Vec<(String, String)>,
    pub cwd: std::path::PathBuf,
    pub cols: u16,
    pub rows: u16,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum PtyOutput {
    Data(Vec<u8>),
    Exit { code: Option<i32> },
}

enum Ctrl {
    Write(Vec<u8>),
    /// A cursor-position report we generated. Does not mean the frontend is listening.
    Reply(Vec<u8>),
    Resize {
        cols: u16,
        rows: u16,
        ack: Sender<io::Result<()>>,
    },
    #[cfg(test)]
    Size(Sender<io::Result<(u16, u16)>>),
    Kill,
}

pub struct PtySession {
    ctrl: Sender<Ctrl>,
    output: Option<Receiver<PtyOutput>>,
    pid: u32,
}

impl PtySession {
    pub fn spawn(spec: SpawnSpec) -> io::Result<Self> {
        let cols = spec.cols.max(1);
        let rows = spec.rows.max(1);
        let system = native_pty_system();
        let pair = system
            .openpty(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|err| io::Error::other(err.to_string()))?;
        let mut command = CommandBuilder::new(&spec.program);
        for arg in &spec.args {
            command.arg(arg);
        }
        if spec.cwd.as_os_str().is_empty() {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "pty cwd is empty",
            ));
        }
        command.cwd(spec.cwd);
        command.env("TERM", "xterm-256color");
        for (key, value) in &spec.env {
            command.env(key, value);
        }
        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|err| io::Error::other(err.to_string()))?;
        let pid = child.process_id().unwrap_or(0);
        let guard = PidGuard::adopt(pid);
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|err| io::Error::other(err.to_string()))?;
        let master = pair.master;
        let (ctrl_tx, ctrl_rx) = mpsc::channel();
        let (out_tx, out_rx) = mpsc::channel();
        let read_out = out_tx.clone();
        let attached = Arc::new(AtomicBool::new(false));
        let read_ctrl = ctrl_tx.clone();
        let read_attached = Arc::clone(&attached);
        thread::Builder::new()
            .name("pty-read".into())
            .spawn(move || read_loop(reader, read_out, read_ctrl, read_attached))
            .map_err(|err| io::Error::other(err.to_string()))?;
        thread::Builder::new()
            .name("pty-ctrl".into())
            .spawn(move || control_loop(master, writer, child, guard, ctrl_rx, out_tx, attached))
            .map_err(|err| io::Error::other(err.to_string()))?;
        Ok(Self {
            ctrl: ctrl_tx,
            output: Some(out_rx),
            pid,
        })
    }

    pub fn take_output(&mut self) -> Option<Receiver<PtyOutput>> {
        self.output.take()
    }

    pub fn pid(&self) -> u32 {
        self.pid
    }

    pub fn write(&self, data: &[u8]) -> io::Result<()> {
        self.ctrl
            .send(Ctrl::Write(data.to_vec()))
            .map_err(|err| io::Error::other(err.to_string()))
    }

    pub fn resize(&self, cols: u16, rows: u16) -> io::Result<()> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.ctrl
            .send(Ctrl::Resize {
                cols: cols.max(1),
                rows: rows.max(1),
                ack: ack_tx,
            })
            .map_err(|err| io::Error::other(err.to_string()))?;
        ack_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|err| io::Error::other(err.to_string()))?
    }

    #[cfg(test)]
    pub fn size(&self) -> io::Result<(u16, u16)> {
        let (ack_tx, ack_rx) = mpsc::channel();
        self.ctrl
            .send(Ctrl::Size(ack_tx))
            .map_err(|err| io::Error::other(err.to_string()))?;
        ack_rx
            .recv_timeout(Duration::from_secs(2))
            .map_err(|err| io::Error::other(err.to_string()))?
    }

    pub fn kill(&self) {
        let _ = self.ctrl.send(Ctrl::Kill);
    }

    #[cfg(test)]
    pub fn recv_timeout(&self, timeout: Duration) -> io::Result<Option<PtyOutput>> {
        let Some(output) = self.output.as_ref() else {
            return Ok(None);
        };
        match output.recv_timeout(timeout) {
            Ok(event) => Ok(Some(event)),
            Err(mpsc::RecvTimeoutError::Timeout) => Ok(None),
            Err(mpsc::RecvTimeoutError::Disconnected) => Ok(None),
        }
    }
}

impl Drop for PtySession {
    fn drop(&mut self) {
        self.kill();
    }
}

fn read_loop(
    mut reader: Box<dyn Read + Send>,
    output: Sender<PtyOutput>,
    ctrl: Sender<Ctrl>,
    attached: Arc<AtomicBool>,
) {
    let mut gate = DsrGate::default();
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => {
                let tail = gate.finish();
                if !tail.is_empty() {
                    let _ = output.send(PtyOutput::Data(tail));
                }
                break;
            }
            Ok(n) => {
                let (forward, reply) = gate.push(&buf[..n], attached.load(Ordering::Relaxed));
                if !reply.is_empty() && ctrl.send(Ctrl::Reply(reply)).is_err() {
                    break;
                }
                if !forward.is_empty() && output.send(PtyOutput::Data(forward)).is_err() {
                    break;
                }
            }
        }
    }
}

/// Holds a split `ESC [ 6 n` and answers it until xterm is attached.
#[derive(Default)]
struct DsrGate {
    held: Vec<u8>,
}

impl DsrGate {
    fn push(&mut self, input: &[u8], frontend_attached: bool) -> (Vec<u8>, Vec<u8>) {
        self.held.extend_from_slice(input);
        let bytes = std::mem::take(&mut self.held);
        let mut forward = Vec::new();
        let mut reply = Vec::new();
        let mut index = 0;
        while index < bytes.len() {
            if bytes[index] != 0x1b {
                forward.push(bytes[index]);
                index += 1;
                continue;
            }
            let rest = &bytes[index..];
            if rest.starts_with(DSR_QUERY) {
                if frontend_attached {
                    forward.extend_from_slice(DSR_QUERY);
                } else {
                    reply.extend_from_slice(DSR_REPLY);
                }
                index += DSR_QUERY.len();
                continue;
            }
            if DSR_QUERY.starts_with(rest) {
                self.held.extend_from_slice(rest);
                break;
            }
            forward.push(bytes[index]);
            index += 1;
        }
        (forward, reply)
    }

    fn finish(&mut self) -> Vec<u8> {
        std::mem::take(&mut self.held)
    }
}

fn control_loop(
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    guard: PidGuard,
    ctrl: Receiver<Ctrl>,
    output: Sender<PtyOutput>,
    attached: Arc<AtomicBool>,
) {
    let mut exited = false;
    loop {
        match ctrl.recv_timeout(Duration::from_millis(200)) {
            Ok(Ctrl::Write(data)) => {
                // A frontend write means xterm is listening and will answer later queries.
                attached.store(true, Ordering::Relaxed);
                let _ = writer.write_all(&data);
                let _ = writer.flush();
            }
            Ok(Ctrl::Reply(data)) => {
                let _ = writer.write_all(&data);
                let _ = writer.flush();
            }
            Ok(Ctrl::Resize { cols, rows, ack }) => {
                attached.store(true, Ordering::Relaxed);
                let result = master
                    .resize(PtySize {
                        rows,
                        cols,
                        pixel_width: 0,
                        pixel_height: 0,
                    })
                    .map_err(|err| io::Error::other(err.to_string()));
                let _ = ack.send(result);
            }
            #[cfg(test)]
            Ok(Ctrl::Size(ack)) => {
                let result = master
                    .get_size()
                    .map(|size| (size.cols, size.rows))
                    .map_err(|err| io::Error::other(err.to_string()));
                let _ = ack.send(result);
            }
            Ok(Ctrl::Kill) | Err(mpsc::RecvTimeoutError::Disconnected) => {
                finish(&guard, child.as_mut(), &output, &mut exited);
                break;
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                if let Ok(Some(status)) = child.try_wait() {
                    if !exited {
                        let _ = output.send(PtyOutput::Exit {
                            code: Some(status.exit_code() as i32),
                        });
                    }
                    break;
                }
            }
        }
    }
    drop(writer);
    drop(master);
}

fn finish(
    guard: &PidGuard,
    child: &mut dyn portable_pty::Child,
    output: &Sender<PtyOutput>,
    exited: &mut bool,
) {
    guard.kill();
    let _ = child.kill();
    let code = child
        .try_wait()
        .ok()
        .flatten()
        .map(|status| status.exit_code() as i32);
    if !*exited {
        *exited = true;
        let _ = output.send(PtyOutput::Exit { code });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn test_shell() -> Option<(String, Vec<String>)> {
        if cfg!(windows) {
            let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");
            if cmd.is_file() {
                // /Q turns command echo off. /D skips AutoRun. /K stays open.
                return Some((
                    cmd.display().to_string(),
                    vec!["/Q".into(), "/D".into(), "/K".into()],
                ));
            }
            let powershell =
                PathBuf::from(r"C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe");
            if powershell.is_file() {
                return Some((
                    powershell.display().to_string(),
                    vec!["-NoProfile".into(), "-NoLogo".into(), "-NoExit".into()],
                ));
            }
            None
        } else if std::path::Path::new("/bin/sh").is_file() {
            Some(("/bin/sh".to_string(), Vec::new()))
        } else {
            None
        }
    }

    /// ConPTY inserts cursor sequences between echoed characters. The marker
    /// is the command's output after those sequences are removed.
    fn strip_vt(input: &str) -> String {
        let mut out = String::with_capacity(input.len());
        let mut chars = input.chars().peekable();
        while let Some(ch) = chars.next() {
            if ch != '\u{1b}' {
                out.push(ch);
                continue;
            }
            match chars.peek() {
                Some('[') => {
                    chars.next();
                    for next in chars.by_ref() {
                        if ('@'..='~').contains(&next) {
                            break;
                        }
                    }
                }
                Some(']') => {
                    chars.next();
                    while let Some(next) = chars.next() {
                        if next == '\u{7}' {
                            break;
                        }
                        if next == '\u{1b}' && chars.peek() == Some(&'\\') {
                            chars.next();
                            break;
                        }
                    }
                }
                Some(_) => {
                    chars.next();
                }
                None => {}
            }
        }
        out
    }

    fn wait_for_output(session: &PtySession, marker: &str) -> bool {
        let deadline = std::time::Instant::now() + Duration::from_secs(15);
        let mut raw = Vec::new();
        while std::time::Instant::now() < deadline {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let slice = remaining.min(Duration::from_millis(200));
            match session.recv_timeout(slice) {
                Ok(Some(PtyOutput::Data(bytes))) => {
                    raw.extend_from_slice(&bytes);
                    let text = strip_vt(&String::from_utf8_lossy(&raw));
                    if text.contains(marker) {
                        return true;
                    }
                }
                Ok(Some(PtyOutput::Exit { .. })) => {
                    let text = strip_vt(&String::from_utf8_lossy(&raw));
                    return text.contains(marker);
                }
                _ => {}
            }
        }
        false
    }

    #[test]
    fn an_unattached_terminal_answers_conpty_dsr() {
        let mut gate = DsrGate::default();
        let (forward, reply) = gate.push(b"\x1b[6nC:\\>", false);
        assert_eq!(reply, b"\x1b[1;1R");
        assert_eq!(forward, b"C:\\>");

        let (again, no_reply) = gate.push(b"\x1b[6nready", true);
        assert!(no_reply.is_empty());
        assert_eq!(again, b"\x1b[6nready");
    }

    #[test]
    fn a_split_dsr_is_answered_once_the_query_is_complete() {
        let mut gate = DsrGate::default();
        let (forward, reply) = gate.push(b"\x1b[6", false);
        assert!(forward.is_empty());
        assert!(reply.is_empty());
        let (forward, reply) = gate.push(b"nprompt", false);
        assert_eq!(reply, b"\x1b[1;1R");
        assert_eq!(forward, b"prompt");
    }

    /// The read loop, not the test, writes the cursor report. No frontend is attached.
    #[cfg(unix)]
    #[test]
    fn the_backend_answers_dsr_before_a_frontend_is_attached() {
        if std::process::Command::new("node")
            .arg("--version")
            .output()
            .is_err()
        {
            eprintln!("ignored: node is not on PATH");
            return;
        }
        let dir =
            crate::test_support::test_root().join(format!("dcterminal-dsr-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).expect("dsr temp dir");
        let script = dir.join("dsr.mjs");
        std::fs::write(
            &script,
            "import fs from \"node:fs\";\n\
             fs.writeSync(1, Buffer.from(\"\\u001b[6n\"));\n\
             try { process.stdin.setRawMode(true); } catch { /* not a tty */ }\n\
             process.stdin.resume();\n\
             let pending = Buffer.alloc(0);\n\
             process.stdin.on(\"data\", (chunk) => {\n\
             pending = Buffer.concat([pending, chunk]);\n\
             if (pending.includes(Buffer.from(\"\\u001b[1;1R\"))) {\n\
             fs.writeSync(1, \"pty_marker\\n\");\n\
             }\n\
             });\n\
             setInterval(() => {}, 1000);\n",
        )
        .expect("write dsr script");
        let session = PtySession::spawn(SpawnSpec {
            program: "node".into(),
            args: vec![script.display().to_string()],
            env: Vec::new(),
            cwd: dir.clone(),
            cols: 80,
            rows: 24,
        })
        .expect("spawn node");
        let answered = wait_for_output(&session, "pty_marker");
        session.kill();
        let _ = std::fs::remove_dir_all(&dir);
        assert!(answered, "backend did not answer the cursor query");
    }

    #[test]
    fn ansi_sequences_do_not_hide_the_marker() {
        let wrapped = "\u{1b}[0mp\u{1b}[32mty_marker\u{1b}[0m";
        assert!(strip_vt(wrapped).contains("pty_marker"));
    }

    #[test]
    fn pty_spawn_write_resize_and_kill() {
        let Some((program, args)) = test_shell() else {
            eprintln!("ignored: this platform has no cmd.exe, powershell, or /bin/sh");
            return;
        };
        let cwd = crate::test_support::test_root().to_path_buf();
        let session = PtySession::spawn(SpawnSpec {
            program,
            args,
            env: Vec::new(),
            cwd,
            cols: 80,
            rows: 24,
        })
        .expect("spawn shell");
        let pid = session.pid();
        assert!(pid > 0, "shell pid");
        // cmd /Q does not echo the typed line. Wait for the command's output.
        let line: &[u8] = if cfg!(windows) {
            b"echo pty_marker\r"
        } else {
            b"printf 'pty_marker\\n'\n"
        };
        if cfg!(windows) {
            // ConPTY emits CSI 6 n at startup and will not run the command
            // until something answers with a cursor position report.
            session
                .write(b"\x1b[1;1R")
                .expect("answer device status report");
        }
        session.write(line).expect("write");
        assert!(
            wait_for_output(&session, "pty_marker"),
            "shell did not print the marker"
        );
        session.resize(40, 12).expect("resize");
        let (cols, rows) = session.size().expect("size");
        assert_eq!((cols, rows), (40, 12));
        session.kill();
        let mut saw_exit = false;
        for _ in 0..30 {
            if matches!(
                session.recv_timeout(Duration::from_millis(50)),
                Ok(Some(PtyOutput::Exit { .. }))
            ) {
                saw_exit = true;
                break;
            }
        }
        assert!(saw_exit, "kill did not report an exit");
        #[cfg(unix)]
        {
            let mut gone = false;
            for _ in 0..20 {
                if !process_alive(pid) {
                    gone = true;
                    break;
                }
                thread::sleep(Duration::from_millis(50));
            }
            assert!(gone, "shell {pid} was still alive after kill");
        }
    }

    #[cfg(unix)]
    fn process_alive(pid: u32) -> bool {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
}
