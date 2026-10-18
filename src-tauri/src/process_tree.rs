//! Kill an `agent acp` process and the children it spawns.
//!
//! On Windows `agent.cmd` starts `node`. The process is created suspended,
//! assigned to a job, then resumed, so `node` cannot start outside the job.
//! `KILL_ON_JOB_CLOSE` plus `taskkill /T` covers the tree. On Unix the child
//! is its own process group; killing the group reaps grandchildren.
//!
//! Stopping on Unix sends SIGTERM to the group first, so Claude can finish
//! its session log, and SIGKILL only after [`STOP_GRACE`]. A group is never
//! signalled blind after its leader was reaped: once the leader is gone its
//! pgid could belong to a new process, so it is only signalled while the
//! group still has members.

use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::thread::JoinHandle;
use std::time::Duration;
#[cfg(unix)]
use std::time::Instant;

/// How long a stopped agent or terminal gets to exit on SIGTERM (finishing
/// its session log) before the group is killed.
pub const STOP_GRACE: Duration = Duration::from_millis(1500);

pub struct ProcessTree {
    child: Child,
    killed: bool,
    /// `try_wait` collected the leader's exit, so its pid may be reused.
    reaped: bool,
    #[cfg(windows)]
    resumed: bool,
    #[cfg(windows)]
    job: winjob::Job,
}

impl ProcessTree {
    pub fn from_child(child: Child) -> io::Result<Self> {
        #[cfg(windows)]
        {
            let mut child = child;
            let job = match winjob::Job::create_and_assign(&child) {
                Ok(job) => job,
                Err(err) => {
                    // Still suspended: nothing has executed, including `node`.
                    let _ = child.kill();
                    let _ = child.wait();
                    return Err(err);
                }
            };
            Ok(Self {
                child,
                killed: false,
                reaped: false,
                resumed: false,
                job,
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child,
                killed: false,
                reaped: false,
            })
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        let status = self.child.try_wait()?;
        if status.is_some() {
            self.reaped = true;
            // Leader reaped and group empty: the pgid may be reused, so
            // nothing may signal it again.
            #[cfg(unix)]
            if !self.killed && !group_alive(self.child.id()) {
                self.killed = true;
            }
        }
        Ok(status)
    }

    /// On Windows, start the process after it has been placed in its job.
    /// Unix children are already running.
    pub fn resume(&mut self) -> io::Result<()> {
        #[cfg(windows)]
        {
            if self.resumed {
                return Ok(());
            }
            winjob::resume_process_threads(self.child.id())?;
            self.resumed = true;
        }
        Ok(())
    }

    /// Ask the group to exit (SIGTERM). Windows has no equivalent; there
    /// [`kill_tree`](Self::kill_tree) is the only stop.
    pub fn terminate(&mut self) {
        #[cfg(unix)]
        if !self.killed {
            self.signal_tree(SIGTERM);
        }
    }

    /// Whether anything of the tree may still be running.
    #[cfg(unix)]
    fn tree_alive(&mut self) -> bool {
        !matches!(self.try_wait(), Ok(Some(_))) || group_alive(self.child.id())
    }

    #[cfg(unix)]
    fn signal_tree(&self, sig: i32) {
        let pid = self.child.id();
        // An unreaped leader holds its pgid; a reaped one only while the
        // group still has members.
        if !self.reaped || group_alive(pid) {
            signal_group(pid, sig);
        }
    }

    pub fn kill_tree(&mut self) {
        if self.killed {
            return;
        }
        self.killed = true;
        #[cfg(unix)]
        {
            // Before `wait` reaps the leader, so the pgid is still ours.
            self.signal_tree(SIGKILL);
        }
        #[cfg(windows)]
        {
            self.job.terminate();
            let already_exited = matches!(self.child.try_wait(), Ok(Some(_)));
            if taskkill_needed(already_exited) {
                quiet_taskkill(self.child.id());
            }
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[derive(Clone)]
pub struct SharedProcess {
    inner: Arc<Mutex<ProcessTree>>,
}

impl SharedProcess {
    pub fn from_child(child: Child) -> io::Result<Self> {
        Ok(Self {
            inner: Arc::new(Mutex::new(ProcessTree::from_child(child)?)),
        })
    }

    pub fn resume(&self) -> io::Result<()> {
        let mut tree = self
            .inner
            .lock()
            .map_err(|err| io::Error::other(err.to_string()))?;
        tree.resume()
    }

    pub fn kill_tree(&self) {
        if let Ok(mut tree) = self.inner.lock() {
            tree.kill_tree();
        }
    }

    /// SIGTERM to the group now; a `proc-stop` thread kills it if anything
    /// is still running after `grace`. Returns at once, without waiting on
    /// the process. Windows: kills at once, as before.
    pub fn stop_gracefully(&self, grace: Duration) -> Option<JoinHandle<()>> {
        #[cfg(unix)]
        {
            match self.inner.lock() {
                Ok(mut tree) if !tree.killed => tree.terminate(),
                _ => return None,
            }
            let shared = self.clone();
            let deadline = Instant::now() + grace;
            match std::thread::Builder::new()
                .name("proc-stop".into())
                .spawn(move || shared.kill_after(deadline))
            {
                Ok(stopper) => Some(stopper),
                Err(_) => {
                    self.kill_tree();
                    None
                }
            }
        }
        #[cfg(not(unix))]
        {
            let _ = grace;
            self.kill_tree();
            None
        }
    }

    /// SIGTERM to the group only; the caller waits (see `windows.rs` exit).
    pub fn terminate(&self) {
        if let Ok(mut tree) = self.inner.lock() {
            tree.terminate();
        }
    }

    /// Polls every 50 ms, locking only per poll, until the tree is gone or
    /// `deadline` passes; then kills what is left.
    #[cfg(unix)]
    fn kill_after(&self, deadline: Instant) {
        loop {
            {
                let Ok(mut tree) = self.inner.lock() else {
                    return;
                };
                if tree.killed {
                    return;
                }
                if !tree.tree_alive() {
                    // Nothing left to signal; a later kill_tree must not
                    // signal the pgid either.
                    tree.killed = true;
                    return;
                }
                if Instant::now() >= deadline {
                    tree.kill_tree();
                    return;
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
    }

    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        let mut tree = self
            .inner
            .lock()
            .map_err(|err| io::Error::other(err.to_string()))?;
        tree.try_wait()
    }
}

/// `taskkill` writes `ERROR: The process "<pid>" not found.` when the pid is already gone.
#[cfg(any(windows, test))]
pub(crate) fn taskkill_needed(already_exited: bool) -> bool {
    !already_exited
}

#[cfg(windows)]
fn quiet_taskkill(pid: u32) {
    use std::process::Stdio;
    let _ = Command::new("taskkill")
        .args(["/F", "/T", "/PID", &pid.to_string()])
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status();
}

pub fn prepare_command(cmd: &mut Command) {
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        // New process group so we can signal the whole tree with a negative pid.
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
        // Primary thread stays suspended until `ProcessTree::resume`.
        // `std::process::Command` closes that thread handle, so resume uses toolhelp.
        const CREATE_SUSPENDED: u32 = 0x0000_0004;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP | CREATE_SUSPENDED);
    }
}

/// Kills a PTY child and the processes it has already spawned.
///
/// Unix: the child is a session leader (`setsid` inside portable-pty), so a
/// negative-pid signal covers the group. Windows: a job object with
/// `KILL_ON_JOB_CLOSE`, plus `taskkill /T`, matching ACP sessions.
pub struct PidGuard {
    pid: u32,
    /// The leader was reaped, so its pid (and pgid) may be reused.
    reaped: AtomicBool,
    /// Shared with [`PtyGroup`]: the group is no longer ours to signal.
    done: Arc<AtomicBool>,
    #[cfg(windows)]
    job: Option<winjob::Job>,
}

impl PidGuard {
    pub fn adopt(pid: u32) -> Self {
        #[cfg(windows)]
        {
            Self {
                pid,
                reaped: AtomicBool::new(false),
                done: Arc::new(AtomicBool::new(false)),
                job: winjob::Job::create_and_assign_pid(pid).ok(),
            }
        }
        #[cfg(not(windows))]
        {
            Self {
                pid,
                reaped: AtomicBool::new(false),
                done: Arc::new(AtomicBool::new(false)),
            }
        }
    }

    /// The group as seen from outside the control thread (app exit).
    pub fn group(&self) -> PtyGroup {
        PtyGroup {
            pid: self.pid,
            done: Arc::clone(&self.done),
        }
    }

    /// Called once the leader's exit has been collected. If the group is
    /// already empty it is done at once, so [`PtyGroup`] never relies on the
    /// pgid alone after this.
    pub fn mark_reaped(&self) {
        self.reaped.store(true, Ordering::SeqCst);
        #[cfg(unix)]
        let _ = self.ours();
    }

    /// Whether anything of the group may still be running. Unix only.
    #[cfg(unix)]
    pub fn group_alive(&self) -> bool {
        self.ours()
    }

    /// Whether the pgid is still ours: the leader is unreaped, or the group
    /// still has members. Once a reaped group is seen empty it stays done.
    #[cfg(unix)]
    fn ours(&self) -> bool {
        if self.done.load(Ordering::SeqCst) {
            return false;
        }
        if !self.reaped.load(Ordering::SeqCst) || group_alive(self.pid) {
            return true;
        }
        self.done.store(true, Ordering::SeqCst);
        false
    }

    /// Ask the group to exit (SIGTERM). Unix only.
    #[cfg(unix)]
    pub fn terminate(&self) {
        self.signal(SIGTERM);
    }

    #[cfg(unix)]
    fn signal(&self, sig: i32) {
        if self.ours() {
            signal_group(self.pid, sig);
        }
    }

    pub fn kill(&self) {
        if self.pid == 0 {
            return;
        }
        #[cfg(unix)]
        {
            self.signal(SIGKILL);
        }
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                job.terminate();
            }
            // An already-dead pid makes taskkill print "process not found" on the console.
            quiet_taskkill(self.pid);
        }
    }
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        self.kill();
        // The control thread is done with the child; whatever was left got
        // SIGKILL, and the pgid is no longer ours to signal.
        self.done.store(true, Ordering::SeqCst);
    }
}

#[cfg(unix)]
const SIGTERM: i32 = 15;
#[cfg(unix)]
const SIGKILL: i32 = 9;

/// Signal the process group `pid` leads. Returns whether it was delivered.
/// Never signals pid 0, 1 or -1 (our own group, init, everything).
#[cfg(unix)]
fn signal_group(pid: u32, sig: i32) -> bool {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    let Some(pid) = i32::try_from(pid).ok().filter(|pid| *pid > 1) else {
        return false;
    };
    // SAFETY: kill(2) with a negative pid signals that group only.
    unsafe { kill(-pid, sig) == 0 }
}

/// Signal 0: whether the group still has a member (a zombie counts).
#[cfg(unix)]
fn group_alive(pid: u32) -> bool {
    signal_group(pid, 0)
}

/// A PTY's process group (it leads its own session), for app exit. The
/// PTY's control thread still owns and reaps the child; once it is done with
/// the group (`done`), the pgid may be reused and is never signalled again.
/// Otherwise the group is signalled only while it has members.
#[derive(Clone)]
#[cfg_attr(not(unix), allow(dead_code))]
pub struct PtyGroup {
    pid: u32,
    done: Arc<AtomicBool>,
}

impl PtyGroup {
    /// Whether the group may still be ours and has a member. Always false on
    /// Windows, where exit does not wait.
    pub fn running(&self) -> bool {
        #[cfg(unix)]
        {
            !self.done.load(Ordering::SeqCst) && group_alive(self.pid)
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    /// SIGTERM to the group. No-op on Windows.
    pub fn terminate(&self) {
        #[cfg(unix)]
        if self.running() {
            signal_group(self.pid, SIGTERM);
        }
    }

    /// SIGKILL to the group if it is still running. No-op on Windows.
    pub fn kill(&self) {
        #[cfg(unix)]
        if self.running() {
            signal_group(self.pid, SIGKILL);
        }
    }
}

#[cfg(windows)]
mod winjob {
    use std::ffi::c_void;
    use std::io;
    use std::os::windows::io::{AsRawHandle, FromRawHandle, OwnedHandle, RawHandle};
    use std::process::Child;

    #[repr(C)]
    struct BasicLimit {
        per_process_user_time_limit: i64,
        per_job_user_time_limit: i64,
        limit_flags: u32,
        _pad: u32,
        minimum_working_set_size: usize,
        maximum_working_set_size: usize,
        active_process_limit: u32,
        _pad2: u32,
        affinity: usize,
        priority_class: u32,
        scheduling_class: u32,
    }

    #[repr(C)]
    struct IoCounters {
        read_operation_count: u64,
        write_operation_count: u64,
        other_operation_count: u64,
        read_transfer_count: u64,
        write_transfer_count: u64,
        other_transfer_count: u64,
    }

    #[repr(C)]
    struct ExtendedLimit {
        basic: BasicLimit,
        io: IoCounters,
        process_memory_limit: usize,
        job_memory_limit: usize,
        peak_process_memory_used: usize,
        peak_job_memory_used: usize,
    }

    #[repr(C)]
    struct ThreadEntry32 {
        size: u32,
        usage: u32,
        thread_id: u32,
        owner_process_id: u32,
        base_pri: i32,
        delta_pri: i32,
        flags: u32,
    }

    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const EXTENDED_LIMIT_CLASS: i32 = 9;
    const TH32CS_SNAPTHREAD: u32 = 0x0000_0004;
    const THREAD_SUSPEND_RESUME: u32 = 0x0002;

    #[cfg(target_pointer_width = "64")]
    const _: () = {
        assert!(std::mem::size_of::<ExtendedLimit>() == 144);
        assert!(std::mem::align_of::<ExtendedLimit>() == 8);
        assert!(std::mem::size_of::<ThreadEntry32>() == 28);
    };

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> RawHandle;
        fn SetInformationJobObject(
            job: RawHandle,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: RawHandle, process: RawHandle) -> i32;
        fn TerminateJobObject(job: RawHandle, exit_code: u32) -> i32;
        fn CreateToolhelp32Snapshot(flags: u32, process_id: u32) -> RawHandle;
        fn Thread32First(snapshot: RawHandle, entry: *mut ThreadEntry32) -> i32;
        fn Thread32Next(snapshot: RawHandle, entry: *mut ThreadEntry32) -> i32;
        fn OpenThread(access: u32, inherit_handle: i32, thread_id: u32) -> RawHandle;
        fn ResumeThread(thread: RawHandle) -> u32;
        fn OpenProcess(access: u32, inherit_handle: i32, process_id: u32) -> RawHandle;
    }

    /// Owns one Win32 job-object handle.
    ///
    /// `OwnedHandle` is `Send + Sync` because a kernel HANDLE is not bound to
    /// the thread that created it: `AssignProcessToJobObject`,
    /// `TerminateJobObject`, and `CloseHandle` are safe from any thread.
    /// The handle is closed when this value drops.
    pub struct Job(OwnedHandle);

    fn assert_job_is_threadsafe() {
        fn assert_send_sync<T: Send + Sync>() {}
        assert_send_sync::<Job>();
    }

    impl Job {
        pub fn create_and_assign(child: &Child) -> io::Result<Self> {
            assert_job_is_threadsafe();
            unsafe {
                let raw = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if raw.is_null() {
                    return Err(io::Error::last_os_error());
                }
                // Fresh unnamed job from CreateJobObjectW. We are the only owner.
                let job = OwnedHandle::from_raw_handle(raw);
                let mut info: ExtendedLimit = std::mem::zeroed();
                info.basic.limit_flags = KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job.as_raw_handle(),
                    EXTENDED_LIMIT_CLASS,
                    &info as *const ExtendedLimit as *const c_void,
                    std::mem::size_of::<ExtendedLimit>() as u32,
                );
                if configured == 0 {
                    return Err(io::Error::last_os_error());
                }
                let assigned = AssignProcessToJobObject(job.as_raw_handle(), child.as_raw_handle());
                if assigned == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Job(job))
            }
        }

        /// Assign an already-running process. Used for ConPTY children, which
        /// portable-pty starts itself so they cannot be created suspended.
        pub fn create_and_assign_pid(pid: u32) -> io::Result<Self> {
            const PROCESS_SET_QUOTA: u32 = 0x0100;
            const PROCESS_TERMINATE: u32 = 0x0001;
            assert_job_is_threadsafe();
            unsafe {
                let raw = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
                if raw.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let job = OwnedHandle::from_raw_handle(raw);
                let mut info: ExtendedLimit = std::mem::zeroed();
                info.basic.limit_flags = KILL_ON_JOB_CLOSE;
                let configured = SetInformationJobObject(
                    job.as_raw_handle(),
                    EXTENDED_LIMIT_CLASS,
                    &info as *const ExtendedLimit as *const c_void,
                    std::mem::size_of::<ExtendedLimit>() as u32,
                );
                if configured == 0 {
                    return Err(io::Error::last_os_error());
                }
                let proc_raw = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE, 0, pid);
                if proc_raw.is_null() {
                    return Err(io::Error::last_os_error());
                }
                let process = OwnedHandle::from_raw_handle(proc_raw);
                let assigned =
                    AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle());
                if assigned == 0 {
                    return Err(io::Error::last_os_error());
                }
                Ok(Job(job))
            }
        }

        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0.as_raw_handle(), 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            self.terminate();
        }
    }

    pub fn resume_process_threads(pid: u32) -> io::Result<()> {
        unsafe {
            let raw = CreateToolhelp32Snapshot(TH32CS_SNAPTHREAD, 0);
            if raw.is_null() || raw == invalid_handle() {
                return Err(io::Error::last_os_error());
            }
            let snapshot = OwnedHandle::from_raw_handle(raw);
            let mut entry: ThreadEntry32 = std::mem::zeroed();
            entry.size = std::mem::size_of::<ThreadEntry32>() as u32;
            if Thread32First(snapshot.as_raw_handle(), &mut entry) == 0 {
                return Err(io::Error::other(format!(
                    "could not enumerate threads for suspended process {pid}"
                )));
            }
            let mut resumed = 0u32;
            loop {
                if entry.owner_process_id == pid {
                    resume_one(entry.thread_id)?;
                    resumed += 1;
                }
                if Thread32Next(snapshot.as_raw_handle(), &mut entry) == 0 {
                    break;
                }
            }
            if resumed == 0 {
                return Err(io::Error::other(format!(
                    "suspended process {pid} has no thread to resume"
                )));
            }
            Ok(())
        }
    }

    fn resume_one(thread_id: u32) -> io::Result<()> {
        unsafe {
            let raw = OpenThread(THREAD_SUSPEND_RESUME, 0, thread_id);
            if raw.is_null() {
                return Err(io::Error::last_os_error());
            }
            // OpenThread gave us the only owner of this thread handle.
            let thread = OwnedHandle::from_raw_handle(raw);
            let prev = ResumeThread(thread.as_raw_handle());
            if prev == u32::MAX {
                return Err(io::Error::last_os_error());
            }
        }
        Ok(())
    }

    fn invalid_handle() -> RawHandle {
        (-1isize) as RawHandle
    }
}

#[cfg(test)]
mod taskkill_tests {
    use super::taskkill_needed;

    #[test]
    fn taskkill_is_skipped_when_the_process_already_exited() {
        assert!(!taskkill_needed(true));
        assert!(taskkill_needed(false));
    }
}

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn kill_tree_stops_a_grandchild() {
        let dir = crate::test_support::test_root()
            .join(format!("dcterminal_kill_{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("sleep.pid");
        let script = format!("sleep 120 & echo $! > '{}'; wait", pid_file.display());
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        prepare_command(&mut cmd);
        let child = cmd.spawn().expect("spawn sh");
        let shared = SharedProcess::from_child(child).expect("adopt child");
        shared.resume().expect("unix resume is a no-op");
        let sleep_pid = wait_for_pid(&pid_file);
        shared.kill_tree();
        let gone = wait_until_gone(sleep_pid);
        let _ = fs::remove_dir_all(&dir);
        assert!(gone, "grandchild sleep {sleep_pid} still alive");
    }

    /// `sh -c script` in its own group, after `ready` exists (traps set).
    fn spawn_ready(dir: &std::path::Path, script: &str) -> SharedProcess {
        let ready = dir.join("ready");
        let mut cmd = Command::new("sh");
        cmd.arg("-c")
            .arg(format!("{script}\ntouch '{}'\nwhile :; do sleep 0.05; done", ready.display()))
            // sh reports its killed `sleep` ("Terminated: 15"); keep test output clean.
            .stderr(std::process::Stdio::null());
        prepare_command(&mut cmd);
        let shared = SharedProcess::from_child(cmd.spawn().expect("spawn sh")).expect("adopt");
        assert!(wait_for_file(&ready, Duration::from_secs(5)), "script ready");
        shared
    }

    fn wait_for_file(path: &std::path::Path, limit: Duration) -> bool {
        let start = std::time::Instant::now();
        while start.elapsed() < limit {
            if path.exists() {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn leader_pid(shared: &SharedProcess) -> u32 {
        shared.inner.lock().unwrap().child.id()
    }

    // Regression: Stop sent SIGKILL only, so Claude never wrote the end of
    // its session log.
    #[test]
    fn stopping_lets_the_group_handle_sigterm() {
        let dir = crate::test_support::TempDir::new("stop_term");
        let handled = dir.join("handled");
        let shared = spawn_ready(
            dir.path(),
            &format!("trap \"touch '{}'; exit 0\" TERM", handled.display()),
        );
        let stopper = shared.stop_gracefully(STOP_GRACE);
        assert!(wait_for_file(&handled, Duration::from_secs(3)), "TERM trap ran");
        if let Some(stopper) = stopper {
            stopper.join().unwrap();
        }
        assert!(matches!(shared.try_wait(), Ok(Some(_))), "process exited");
    }

    #[test]
    fn stopping_returns_at_once_and_kills_a_term_ignorer() {
        let dir = crate::test_support::TempDir::new("stop_ignorer");
        let shared = spawn_ready(dir.path(), "trap '' TERM");
        let pid = leader_pid(&shared);
        let start = std::time::Instant::now();
        let stopper = shared.stop_gracefully(STOP_GRACE);
        let took = start.elapsed();
        assert!(took < Duration::from_millis(200), "stop took {took:?}");
        thread::sleep(Duration::from_millis(500));
        assert!(process_alive(pid), "a TERM-ignorer gets the grace period");
        let deadline = std::time::Instant::now() + STOP_GRACE + Duration::from_secs(1);
        while process_alive(pid) && std::time::Instant::now() < deadline {
            thread::sleep(Duration::from_millis(20));
        }
        assert!(!process_alive(pid), "killed once the grace ran out");
        if let Some(stopper) = stopper {
            stopper.join().unwrap();
        }
    }

    // Review: once the leader was reaped and its group seen empty, the pgid
    // may belong to a new process, so a later Stop must not signal it.
    #[test]
    fn stopping_an_exited_reaped_process_sends_no_signal() {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg("exit 0");
        prepare_command(&mut cmd);
        let shared = SharedProcess::from_child(cmd.spawn().expect("spawn sh")).expect("adopt");
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while !matches!(shared.try_wait(), Ok(Some(_))) {
            assert!(std::time::Instant::now() < deadline, "sh exited");
            thread::sleep(Duration::from_millis(20));
        }
        assert!(
            shared.stop_gracefully(STOP_GRACE).is_none(),
            "no SIGTERM and no stop thread for a finished group"
        );
        assert!(shared.inner.lock().unwrap().killed, "marked done");
    }

    /// `sh -c script` as its own process group leader.
    fn spawn_group(script: &str) -> Child {
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        prepare_command(&mut cmd);
        cmd.spawn().expect("spawn sh")
    }

    // Review: once the control thread is done with a terminal (`done`), its
    // pgid may lead an unrelated group, so app exit must not wait on or
    // signal it even though that group is alive.
    #[test]
    fn a_done_pty_group_is_never_signalled_even_while_its_pgid_is_alive() {
        let mut child = spawn_group("sleep 30");
        let group = PtyGroup {
            pid: child.id(),
            done: Arc::new(AtomicBool::new(true)),
        };
        assert!(!group.running(), "a done group is not running");
        group.terminate();
        group.kill();
        thread::sleep(Duration::from_millis(200));
        let untouched = matches!(child.try_wait(), Ok(None));
        let _ = child.kill();
        let _ = child.wait();
        assert!(untouched, "the unrelated group got no signal");
    }

    // Review: between "leader reaped and group empty" and the control thread
    // setting `done`, app exit relied on the pgid alone, which may already
    // lead an unrelated group.
    #[test]
    fn marking_an_empty_group_reaped_makes_it_done_at_once() {
        let mut child = spawn_group("exit 0");
        let guard = PidGuard::adopt(child.id());
        child.wait().expect("reap sh");
        guard.mark_reaped();
        assert!(guard.done.load(Ordering::SeqCst), "done as soon as reaped");
        assert!(!guard.group().running());
    }

    /// The killed grandchild is reparented and reaped by init; poll for it.
    fn wait_until_gone(pid: u32) -> bool {
        for _ in 0..100 {
            if !process_alive(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    fn wait_for_pid(path: &std::path::Path) -> u32 {
        for _ in 0..50 {
            if let Ok(text) = fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    return pid;
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("grandchild pid file was not written");
    }

    /// `kill(pid, 0)`: works on macOS too (there is no `/proc` there).
    fn process_alive(pid: u32) -> bool {
        crate::test_support::pid_alive(pid) != Some(false)
    }
}
