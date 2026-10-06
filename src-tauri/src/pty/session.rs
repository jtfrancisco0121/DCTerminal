//! One PTY process: spawn, write, resize, and kill the process tree.
//!
//! Output is delivered on a channel. The master stays on a control thread so
//! resize and write do not race the reader.

use crate::process_tree::PidGuard;
use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use std::io::{self, Read, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;
use std::time::Duration;

#[derive(Debug, Clone)]
pub struct SpawnSpec {
    pub program: String,
    pub args: Vec<String>,
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
        thread::Builder::new()
            .name("pty-read".into())
            .spawn(move || read_loop(reader, read_out))
            .map_err(|err| io::Error::other(err.to_string()))?;
        thread::Builder::new()
            .name("pty-ctrl".into())
            .spawn(move || control_loop(master, writer, child, guard, ctrl_rx, out_tx))
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

fn read_loop(mut reader: Box<dyn Read + Send>, output: Sender<PtyOutput>) {
    let mut buf = [0u8; 8192];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if output.send(PtyOutput::Data(buf[..n].to_vec())).is_err() {
                    break;
                }
            }
        }
    }
}

fn control_loop(
    master: Box<dyn portable_pty::MasterPty + Send>,
    mut writer: Box<dyn Write + Send>,
    mut child: Box<dyn portable_pty::Child + Send + Sync>,
    guard: PidGuard,
    ctrl: Receiver<Ctrl>,
    output: Sender<PtyOutput>,
) {
    let mut exited = false;
    loop {
        match ctrl.recv_timeout(Duration::from_millis(200)) {
            Ok(Ctrl::Write(data)) => {
                let _ = writer.write_all(&data);
                let _ = writer.flush();
            }
            Ok(Ctrl::Resize { cols, rows, ack }) => {
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

    fn test_shell() -> Option<String> {
        if cfg!(windows) {
            let cmd = PathBuf::from(r"C:\Windows\System32\cmd.exe");
            if cmd.is_file() {
                Some(cmd.display().to_string())
            } else {
                None
            }
        } else if std::path::Path::new("/bin/sh").is_file() {
            Some("/bin/sh".to_string())
        } else {
            None
        }
    }

    fn wait_for_marker(session: &PtySession, marker: &str) -> bool {
        let mut collected = String::new();
        for _ in 0..40 {
            match session.recv_timeout(Duration::from_millis(100)) {
                Ok(Some(PtyOutput::Data(bytes))) => {
                    collected.push_str(&String::from_utf8_lossy(&bytes));
                    if collected.contains(marker) {
                        return true;
                    }
                }
                Ok(Some(PtyOutput::Exit { .. })) => return collected.contains(marker),
                _ => {}
            }
        }
        false
    }

    #[test]
    fn pty_spawn_write_resize_and_kill() {
        let Some(program) = test_shell() else {
            eprintln!("ignored: this platform has no cmd.exe or /bin/sh");
            return;
        };
        let cwd = std::env::temp_dir();
        let session = PtySession::spawn(SpawnSpec {
            program,
            args: Vec::new(),
            cwd,
            cols: 80,
            rows: 24,
        })
        .expect("spawn shell");
        let pid = session.pid();
        assert!(pid > 0, "shell pid");
        let line: &[u8] = if cfg!(windows) {
            b"echo pty_marker\r\n"
        } else {
            b"printf 'pty_marker\\n'\n"
        };
        session.write(line).expect("write");
        assert!(
            wait_for_marker(&session, "pty_marker"),
            "shell did not echo the marker"
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

    fn process_alive(pid: u32) -> bool {
        #[cfg(unix)]
        {
            std::path::Path::new(&format!("/proc/{pid}")).exists()
        }
        #[cfg(windows)]
        {
            let _ = pid;
            false
        }
    }
}
