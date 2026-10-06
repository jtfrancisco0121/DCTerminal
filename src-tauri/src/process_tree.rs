//! Kill an `agent acp` process and the children it spawns.
//!
//! On Windows `agent.cmd` starts `node`. The process is created suspended,
//! assigned to a job, then resumed, so `node` cannot start outside the job.
//! `KILL_ON_JOB_CLOSE` plus `taskkill /T` covers the tree. On Unix the child
//! is its own process group; killing the group reaps grandchildren.

use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::{Arc, Mutex};

pub struct ProcessTree {
    child: Child,
    killed: bool,
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
                resumed: false,
                job,
            })
        }
        #[cfg(not(windows))]
        {
            Ok(Self {
                child,
                killed: false,
            })
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
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

    pub fn kill_tree(&mut self) {
        if self.killed {
            return;
        }
        self.killed = true;
        #[cfg(unix)]
        {
            kill_process_group(self.child.id());
        }
        #[cfg(windows)]
        {
            self.job.terminate();
            let pid = self.child.id().to_string();
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid])
                .status();
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

    pub fn try_wait(&self) -> io::Result<Option<ExitStatus>> {
        let mut tree = self
            .inner
            .lock()
            .map_err(|err| io::Error::other(err.to_string()))?;
        tree.try_wait()
    }
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
    #[cfg(windows)]
    job: Option<winjob::Job>,
}

impl PidGuard {
    pub fn adopt(pid: u32) -> Self {
        #[cfg(windows)]
        {
            Self {
                pid,
                job: winjob::Job::create_and_assign_pid(pid).ok(),
            }
        }
        #[cfg(not(windows))]
        {
            Self { pid }
        }
    }

    pub fn kill(&self) {
        if self.pid == 0 {
            return;
        }
        #[cfg(unix)]
        {
            kill_process_group(self.pid);
        }
        #[cfg(windows)]
        {
            if let Some(job) = &self.job {
                job.terminate();
            }
            let pid = self.pid.to_string();
            let _ = Command::new("taskkill")
                .args(["/F", "/T", "/PID", &pid])
                .status();
        }
    }
}

impl Drop for PidGuard {
    fn drop(&mut self) {
        self.kill();
    }
}

#[cfg(unix)]
fn kill_process_group(pid: u32) {
    extern "C" {
        fn kill(pid: i32, sig: i32) -> i32;
    }
    const SIGKILL: i32 = 9;
    unsafe {
        kill(-(pid as i32), SIGKILL);
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
                let assigned = AssignProcessToJobObject(job.as_raw_handle(), process.as_raw_handle());
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

#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs;
    use std::thread;
    use std::time::Duration;

    #[test]
    fn kill_tree_stops_a_grandchild() {
        let dir = std::env::temp_dir().join(format!("dcterminal_kill_{}", std::process::id()));
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
        thread::sleep(Duration::from_millis(100));
        assert!(
            !process_alive(sleep_pid),
            "grandchild sleep {sleep_pid} still alive"
        );
        let _ = fs::remove_dir_all(&dir);
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

    fn process_alive(pid: u32) -> bool {
        std::path::Path::new(&format!("/proc/{pid}")).exists()
    }
}
