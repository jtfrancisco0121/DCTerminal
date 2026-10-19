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
//!
//! A descendant that left the leader's session (`setsid`, Node's
//! `detached: true`) is missed by a group signal, so each Unix signal also
//! goes to the leader's [`Detached`] descendants, found by parent pid before
//! the group exits. A shell's jobs (own group, same session) are left alone.

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
    #[cfg(unix)]
    detached: Detached,
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
                #[cfg(unix)]
                detached: Detached::default(),
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
            if !self.killed && !group_alive(self.child.id()) && !self.detached.alive() {
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
        !matches!(self.try_wait(), Ok(Some(_)))
            || group_alive(self.child.id())
            || self.detached.alive()
    }

    #[cfg(unix)]
    fn signal_tree(&mut self, sig: i32) {
        let pid = self.child.id();
        // An unreaped leader holds its pgid; a reaped one only while the
        // group still has members.
        if !self.reaped || group_alive(pid) {
            self.detached.remember(pid);
            signal_group(pid, sig);
        }
        self.detached.signal(sig);
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

    /// SIGTERM to the group on a `proc-stop` thread, which kills it if
    /// anything is still running after `grace`. Returns at once, without
    /// waiting on the process or walking its descendants, so a caller may
    /// hold a registry lock. Windows has no SIGTERM: the thread kills at once.
    pub fn stop_gracefully(&self, grace: Duration) -> Option<JoinHandle<()>> {
        #[cfg(unix)]
        {
            match self.inner.lock() {
                Ok(tree) if !tree.killed => {}
                _ => return None,
            }
            let shared = self.clone();
            let deadline = Instant::now() + grace;
            match std::thread::Builder::new()
                .name("proc-stop".into())
                .spawn(move || {
                    shared.terminate();
                    shared.kill_after(deadline);
                })
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
            self.kill_on_thread(SharedProcess::kill_tree)
        }
    }

    /// Kill on a `proc-stop` thread and return at once, so a caller holding
    /// a registry lock never waits on the kill (`taskkill` on Windows, which
    /// has no SIGTERM to send first). Kills here only if no thread starts.
    #[cfg(any(not(unix), test))]
    fn kill_on_thread<F>(&self, kill: F) -> Option<JoinHandle<()>>
    where
        F: FnOnce(&SharedProcess) + Clone + Send + 'static,
    {
        let shared = self.clone();
        let on_thread = kill.clone();
        match std::thread::Builder::new()
            .name("proc-stop".into())
            .spawn(move || on_thread(&shared))
        {
            Ok(stopper) => Some(stopper),
            Err(_) => {
                kill(self);
                None
            }
        }
    }

    /// SIGTERM to the group and to children that left its session; the
    /// caller waits (see `windows.rs` exit).
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
    #[cfg(unix)]
    detached: Arc<Mutex<Detached>>,
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
                #[cfg(unix)]
                detached: Arc::default(),
            }
        }
    }

    /// The group as seen from outside the control thread (app exit).
    pub fn group(&self) -> PtyGroup {
        PtyGroup {
            pid: self.pid,
            done: Arc::clone(&self.done),
            #[cfg(unix)]
            detached: Arc::clone(&self.detached),
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
        self.ours() || lock(&self.detached).alive()
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
        signal_pty_tree(self.ours(), self.pid, &self.detached, sig);
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
    let Some(pid) = i32::try_from(pid).ok().filter(|pid| *pid > 1) else {
        return false;
    };
    // SAFETY: kill(2) with a negative pid signals that group only.
    unsafe { kill(-pid, sig) == 0 }
}

#[cfg(unix)]
extern "C" {
    fn kill(pid: i32, sig: i32) -> i32;
    fn getpgrp() -> i32;
    #[cfg(target_os = "macos")]
    fn getsid(pid: i32) -> i32;
}

/// One process, as seen when it was found. `start` tells a reused pid apart.
#[cfg(unix)]
#[derive(Clone, Copy, PartialEq)]
struct ProcInfo {
    pid: u32,
    ppid: u32,
    pgid: u32,
    sid: u32,
    start: u64,
}

/// Descendants of a group leader that left its session. They are found by
/// parent pid before the group is signalled: once the group exits they are
/// reparented and the link is lost. A child that already double-forked away
/// to init is missed. Enumeration failures find nothing (group-only stop).
#[cfg(unix)]
#[derive(Default)]
struct Detached(Vec<ProcInfo>);

#[cfg(unix)]
impl Detached {
    /// Adds `leader`'s live descendants outside its session (they called
    /// `setsid`). Others, such as a shell's jobs in their own group, are
    /// walked through but kept out. Call only while `leader`'s pid is ours.
    fn remember(&mut self, leader: u32) {
        let Some(session) = proc_info(leader).map(|info| info.sid) else {
            return;
        };
        let children = children_lister();
        let (mut parents, mut walked) = (vec![leader], 0);
        while let Some(parent) = parents.pop() {
            for child in children(parent) {
                walked += 1;
                if walked > 4096 {
                    return; // only a pid-reuse cycle gets this deep
                }
                parents.push(child.pid);
                if child.sid != session && !self.0.contains(&child) {
                    self.0.push(child);
                }
            }
        }
    }

    /// The remembered processes still running as themselves, never our own
    /// process or group, init, or a pid reused since.
    fn live(&self) -> impl Iterator<Item = u32> + '_ {
        // SAFETY: getpgrp(2) cannot fail.
        let own_group = unsafe { getpgrp() } as u32;
        self.0
            .iter()
            .filter(move |seen| {
                proc_info(seen.pid).is_some_and(|now| {
                    now.start == seen.start
                        && now.pgid != own_group
                        && seen.pid > 1
                        && seen.pid != std::process::id()
                })
            })
            .map(|seen| seen.pid)
    }

    fn alive(&self) -> bool {
        self.live().next().is_some()
    }

    fn signal(&mut self, sig: i32) {
        let live: Vec<u32> = self.live().collect();
        self.0.retain(|seen| live.contains(&seen.pid));
        for pid in live {
            // SAFETY: kill(2) on one pid just confirmed to be the same process.
            unsafe { kill(pid as i32, sig) };
        }
    }
}

#[cfg(target_os = "macos")]
fn proc_info(pid: u32) -> Option<ProcInfo> {
    /// `struct proc_bsdinfo` from <sys/proc_info.h>.
    #[repr(C)]
    struct BsdInfo {
        head: [u32; 4],
        ppid: u32,
        ids: [u32; 7],
        names: [u8; 48],
        nfiles: u32,
        pgid: u32,
        tail: [u32; 4],
        start_sec: u64,
        start_usec: u64,
    }
    const _: () = assert!(std::mem::size_of::<BsdInfo>() == 136);
    extern "C" {
        fn proc_pidinfo(pid: i32, flavor: i32, arg: u64, buf: *mut BsdInfo, size: i32) -> i32;
    }
    const PROC_PIDTBSDINFO: i32 = 3;
    let size = std::mem::size_of::<BsdInfo>() as i32;
    // SAFETY: an all-zero proc_bsdinfo is valid; the kernel fills at most `size` bytes.
    let mut info: BsdInfo = unsafe { std::mem::zeroed() };
    let got = unsafe {
        proc_pidinfo(
            i32::try_from(pid).ok()?,
            PROC_PIDTBSDINFO,
            0,
            &mut info,
            size,
        )
    };
    // SAFETY: getsid(2) only reads; -1 (error) skips the pid.
    let sid = u32::try_from(unsafe { getsid(pid as i32) }).ok()?;
    (got == size).then_some(ProcInfo {
        pid,
        ppid: info.ppid,
        pgid: info.pgid,
        sid,
        start: info.start_sec * 1_000_000 + info.start_usec,
    })
}

#[cfg(target_os = "macos")]
fn children_lister() -> impl Fn(u32) -> Vec<ProcInfo> {
    extern "C" {
        fn proc_listpids(kind: u32, typeinfo: u32, buf: *mut i32, size: i32) -> i32;
    }
    const PROC_PPID_ONLY: u32 = 6;
    |ppid| {
        let mut pids = vec![0i32; 1024];
        let size = (pids.len() * 4) as i32;
        // SAFETY: the kernel writes at most `size` bytes of pids.
        let bytes = unsafe { proc_listpids(PROC_PPID_ONLY, ppid, pids.as_mut_ptr(), size) };
        pids.truncate(usize::try_from(bytes).unwrap_or(0) / 4);
        pids.into_iter()
            .filter_map(|pid| proc_info(u32::try_from(pid).ok().filter(|pid| *pid > 1)?))
            .filter(|info| info.ppid == ppid)
            .collect()
    }
}

#[cfg(target_os = "linux")]
fn proc_info(pid: u32) -> Option<ProcInfo> {
    parse_stat(pid, &std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?)
}

/// One `/proc/<pid>/stat` line. The comm may hold spaces and ')', so fields
/// count from the last ')': state ppid pgrp session ... starttime (22nd).
#[cfg(any(target_os = "linux", test))]
fn parse_stat(pid: u32, stat: &str) -> Option<ProcInfo> {
    let fields: Vec<&str> = stat.rsplit_once(')')?.1.split_whitespace().collect();
    Some(ProcInfo {
        pid,
        ppid: fields.get(1)?.parse().ok()?,
        pgid: fields.get(2)?.parse().ok()?,
        sid: fields.get(3)?.parse().ok()?,
        start: fields.get(19)?.parse().ok()?,
    })
}

/// One `/proc` walk per snapshot, not one per tree level.
#[cfg(target_os = "linux")]
fn children_lister() -> impl Fn(u32) -> Vec<ProcInfo> {
    let table: Vec<ProcInfo> = std::fs::read_dir("/proc")
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| entry.file_name().to_str()?.parse().ok())
        .filter(|pid| *pid > 1)
        .filter_map(proc_info)
        .collect();
    move |ppid| {
        table
            .iter()
            .filter(|info| info.ppid == ppid)
            .copied()
            .collect()
    }
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn proc_info(_pid: u32) -> Option<ProcInfo> {
    None
}

#[cfg(all(unix, not(any(target_os = "macos", target_os = "linux"))))]
fn children_lister() -> impl Fn(u32) -> Vec<ProcInfo> {
    |_| Vec::new()
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
    #[cfg(unix)]
    detached: Arc<Mutex<Detached>>,
}

impl PtyGroup {
    /// Whether the group may still be ours and has a member. Always false on
    /// Windows, where exit does not wait.
    pub fn running(&self) -> bool {
        #[cfg(unix)]
        {
            self.group_running() || lock(&self.detached).alive()
        }
        #[cfg(not(unix))]
        {
            false
        }
    }

    #[cfg(unix)]
    fn group_running(&self) -> bool {
        !self.done.load(Ordering::SeqCst) && group_alive(self.pid)
    }

    /// SIGTERM to the group. No-op on Windows.
    pub fn terminate(&self) {
        #[cfg(unix)]
        signal_pty_tree(self.group_running(), self.pid, &self.detached, SIGTERM);
    }

    /// SIGKILL to the group if it is still running. No-op on Windows.
    pub fn kill(&self) {
        #[cfg(unix)]
        signal_pty_tree(self.group_running(), self.pid, &self.detached, SIGKILL);
    }
}

/// Signals a PTY's group while it is `ours`, after noting its detached
/// descendants, then the detached ones still alive.
#[cfg(unix)]
fn signal_pty_tree(ours: bool, pid: u32, detached: &Mutex<Detached>, sig: i32) {
    let mut detached = lock(detached);
    if ours {
        detached.remember(pid);
        signal_group(pid, sig);
    }
    detached.signal(sig);
}

#[cfg(unix)]
fn lock(detached: &Mutex<Detached>) -> std::sync::MutexGuard<'_, Detached> {
    detached
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
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
pub(crate) mod tests {
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
            detached: Arc::default(),
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
    pub(crate) fn wait_until_gone(pid: u32) -> bool {
        for _ in 0..100 {
            if !process_alive(pid) {
                return true;
            }
            thread::sleep(Duration::from_millis(20));
        }
        false
    }

    pub(crate) fn wait_for_pid(path: &std::path::Path) -> u32 {
        for _ in 0..100 {
            if let Ok(text) = fs::read_to_string(path) {
                if let Ok(pid) = text.trim().parse::<u32>() {
                    return pid;
                }
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("grandchild pid file was not written");
    }

    // Review: on Windows a Stop ran `taskkill` inline, under the session
    // registry lock its caller held, so every chat waited on it.
    #[test]
    fn a_kill_without_sigterm_runs_after_the_caller_lets_go_of_its_lock() {
        let shared = SharedProcess::from_child(spawn_group("sleep 30")).expect("adopt");
        let registry = Arc::new(Mutex::new(()));
        let (tx, rx) = std::sync::mpsc::channel();
        let stopper = {
            let _held = registry.lock().unwrap();
            let registry = Arc::clone(&registry);
            shared.kill_on_thread(move |process| {
                // A killer that waited on the lock would wait forever; poll.
                let deadline = std::time::Instant::now() + Duration::from_secs(2);
                let mut free = registry.try_lock().is_ok();
                while !free && std::time::Instant::now() < deadline {
                    thread::sleep(Duration::from_millis(20));
                    free = registry.try_lock().is_ok();
                }
                let _ = tx.send(free);
                process.kill_tree();
            })
        };
        if let Some(stopper) = stopper {
            stopper.join().unwrap();
        }
        assert!(
            rx.recv().unwrap(),
            "the kill ran while its caller still held the registry lock"
        );
        assert!(matches!(shared.try_wait(), Ok(Some(_))), "process killed");
    }

    /// A `sh -c` line whose program forks a child that leaves the session
    /// (`setsid`, like Node's `detached: true`) and writes its pid to
    /// `pid_file`, and a job-control-style child (own group, same session,
    /// like a shell's `&` or `nohup` job) that writes `<pid_file>.job`. The
    /// parent stays. None when there is no `perl`.
    pub(crate) fn detached_child_script(
        pid_file: &std::path::Path,
        ignore_term: bool,
    ) -> Option<String> {
        let perl = Command::new("perl").arg("-e1").status();
        if !perl.is_ok_and(|status| status.success()) {
            eprintln!("skipped: no perl to start a detached child");
            return None;
        }
        Some(format!(
            "perl -MPOSIX -e 'unless (fork) {{ setpgid(0, 0); \
             open my $f, \">\", \"$ARGV[0].job\" or die; print $f $$; close $f; sleep 60; exit }} \
             if (fork) {{ sleep 60; exit }} POSIX::setsid(); \
             $SIG{{TERM}} = \"IGNORE\" if {}; open my $f, \">\", $ARGV[0] or die; \
             print $f $$; close $f; sleep 60' '{}'",
            u8::from(ignore_term),
            pid_file.display()
        ))
    }

    /// The (detached, job) pids from [`detached_child_script`].
    pub(crate) fn wait_for_children(pid_file: &std::path::Path) -> (u32, u32) {
        let job = wait_for_pid(std::path::Path::new(&format!("{}.job", pid_file.display())));
        (wait_for_pid(pid_file), job)
    }

    /// After a stop: the detached child is gone, the same-session job is
    /// not (closing a tab must not kill a shell's `nohup` jobs).
    pub(crate) fn assert_only_detached_stopped((detached, job): (u32, u32), what: &str) {
        let gone = wait_until_gone(detached);
        let job_kept = crate::test_support::pid_alive(job) == Some(true);
        reap_leftover(detached);
        reap_leftover(job);
        assert!(gone, "detached child {detached} survived {what}");
        assert!(job_kept, "same-session job {job} was killed by {what}");
    }

    /// Kills a leftover test process so a failed run does not leak it.
    pub(crate) fn reap_leftover(pid: u32) {
        extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        if pid > 1 && crate::test_support::pid_alive(pid) == Some(true) {
            // SAFETY: kill(2) on one pid the test itself started.
            unsafe { kill(pid as i32, SIGKILL) };
        }
    }

    // Ticket 14yq6g2z34b: a child that left the group (setsid) survived
    // Stop, even one that ignores SIGTERM until the grace runs out.
    #[test]
    fn stopping_kills_a_detached_child_after_the_grace() {
        let dir = crate::test_support::TempDir::new("stop_detached");
        let pid_file = dir.join("detached.pid");
        let Some(script) = detached_child_script(&pid_file, true) else {
            return;
        };
        let shared = SharedProcess::from_child(spawn_group(&script)).expect("adopt");
        let children = wait_for_children(&pid_file);
        if let Some(stopper) = shared.stop_gracefully(STOP_GRACE) {
            stopper.join().unwrap();
        }
        assert_only_detached_stopped(children, "Stop");
    }

    #[test]
    fn kill_tree_kills_a_detached_child() {
        let dir = crate::test_support::TempDir::new("kill_detached");
        let pid_file = dir.join("detached.pid");
        let Some(script) = detached_child_script(&pid_file, false) else {
            return;
        };
        let shared = SharedProcess::from_child(spawn_group(&script)).expect("adopt");
        let children = wait_for_children(&pid_file);
        shared.kill_tree();
        assert_only_detached_stopped(children, "kill_tree");
    }

    // Review: the guards were untested. A remembered pid that now has
    // another start time (reused), sits in our own group, is our own pid,
    // or is init is never signalled.
    #[test]
    fn remembered_pids_that_fail_a_guard_are_never_signalled() {
        let mut reused = spawn_group("sleep 30");
        let mut same_group = Command::new("sleep").arg("30").spawn().expect("spawn sleep");
        let mut seen = proc_info(reused.id()).expect("info for a live child");
        seen.start += 1;
        let mut detached = Detached(vec![seen]);
        let own = [same_group.id(), std::process::id(), 1];
        detached.0.extend(own.into_iter().filter_map(proc_info));
        assert!(!detached.alive(), "no remembered pid passes the guards");
        detached.signal(SIGKILL);
        thread::sleep(Duration::from_millis(200));
        let untouched = [&mut reused, &mut same_group].map(|child| {
            let alive = matches!(child.try_wait(), Ok(None));
            let _ = child.kill();
            let _ = child.wait();
            alive
        });
        assert_eq!(untouched, [true, true], "a guarded pid got SIGKILL");
    }

    // Review: the Linux `/proc/<pid>/stat` parser was never compiled on
    // macOS. A comm may hold ") " and spaces; fields count from the last ')'.
    #[test]
    fn parses_a_proc_stat_line_whose_comm_holds_parens() {
        let mut line = String::from("4242 ((a) b) (c d)) S 77 88 99 34816 -1");
        for field in 9..=21 {
            line.push_str(&format!(" {field}"));
        }
        line.push_str(" 123456 0 0\n");
        let info = parse_stat(4242, &line).expect("parsed");
        assert_eq!((info.pid, info.ppid, info.pgid), (4242, 77, 88));
        assert_eq!((info.sid, info.start), (99, 123456));
        assert!(parse_stat(1, "1 (short) S 0").is_none());
        assert!(parse_stat(1, "no parens at all").is_none());
    }

    /// `kill(pid, 0)`: works on macOS too (there is no `/proc` there).
    fn process_alive(pid: u32) -> bool {
        crate::test_support::pid_alive(pid) != Some(false)
    }
}
