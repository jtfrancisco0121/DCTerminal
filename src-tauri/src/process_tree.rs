//! Kill an `agent acp` process and the children it spawns.
//!
//! On Windows `agent.cmd` starts `node`. `Child::kill` only stops the shim.
//! A job object with `KILL_ON_JOB_CLOSE` plus `taskkill /T` covers the tree.
//! On Unix the child is its own process group; killing the group reaps grandchildren.

use std::io;
use std::process::{Child, Command, ExitStatus};
use std::sync::{Arc, Mutex};

pub struct ProcessTree {
    child: Child,
    killed: bool,
    #[cfg(windows)]
    job: Option<winjob::Job>,
}

impl ProcessTree {
    pub fn from_child(child: Child) -> Self {
        #[cfg(windows)]
        let job = winjob::assign(&child);
        Self {
            child,
            killed: false,
            #[cfg(windows)]
            job,
        }
    }

    pub fn try_wait(&mut self) -> io::Result<Option<ExitStatus>> {
        self.child.try_wait()
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
            if let Some(job) = &self.job {
                job.terminate();
            }
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
    pub fn from_child(child: Child) -> Self {
        Self {
            inner: Arc::new(Mutex::new(ProcessTree::from_child(child))),
        }
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
        const CREATE_NO_WINDOW: u32 = 0x08000000;
        const CREATE_NEW_PROCESS_GROUP: u32 = 0x00000200;
        cmd.creation_flags(CREATE_NO_WINDOW | CREATE_NEW_PROCESS_GROUP);
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
    use std::os::windows::io::AsRawHandle;
    use std::process::Child;

    type Handle = *mut c_void;

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

    const KILL_ON_JOB_CLOSE: u32 = 0x2000;
    const EXTENDED_LIMIT_CLASS: i32 = 9;

    #[link(name = "kernel32")]
    extern "system" {
        fn CreateJobObjectW(attrs: *mut c_void, name: *const u16) -> Handle;
        fn SetInformationJobObject(
            job: Handle,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn TerminateJobObject(job: Handle, exit_code: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }

    pub struct Job(Handle);

    pub fn assign(child: &Child) -> Option<Job> {
        unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return None;
            }
            let mut info: ExtendedLimit = std::mem::zeroed();
            info.basic.limit_flags = KILL_ON_JOB_CLOSE;
            let ok = SetInformationJobObject(
                job,
                EXTENDED_LIMIT_CLASS,
                &info as *const ExtendedLimit as *const c_void,
                std::mem::size_of::<ExtendedLimit>() as u32,
            );
            if ok == 0 {
                CloseHandle(job);
                return None;
            }
            if AssignProcessToJobObject(job, child.as_raw_handle()) == 0 {
                CloseHandle(job);
                return None;
            }
            Some(Job(job))
        }
    }

    impl Job {
        pub fn terminate(&self) {
            unsafe {
                TerminateJobObject(self.0, 1);
            }
        }
    }

    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                TerminateJobObject(self.0, 1);
                CloseHandle(self.0);
            }
        }
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
        let dir = std::env::temp_dir().join(format!(
            "dcterminal_kill_{}",
            std::process::id()
        ));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        let pid_file = dir.join("sleep.pid");
        let script = format!(
            "sleep 120 & echo $! > '{}'; wait",
            pid_file.display()
        );
        let mut cmd = Command::new("sh");
        cmd.arg("-c").arg(script);
        prepare_command(&mut cmd);
        let child = cmd.spawn().expect("spawn sh");
        let shared = SharedProcess::from_child(child);
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
