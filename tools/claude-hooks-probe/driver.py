import os, pty, select, time, signal, json, re, fcntl, termios, struct, sys
V = os.path.dirname(os.path.abspath(__file__))
REPO = os.path.join(V, "repo")
ANSI = re.compile(r'\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)|\x1b[()][A-Z0-9]|\x1b[=>78]')
H = lambda ev: f"{V}/hook.py {ev}"

def hooks_settings(events, extra=None):
    s = {"hooks": {}}
    for ev, matcher in events:
        entry = {"hooks": [{"type": "command", "command": H(ev)}]}
        if matcher is not None: entry["matcher"] = matcher
        s["hooks"].setdefault(ev, []).append(entry)
    if extra: s.update(extra)
    return json.dumps(s)

class Sess:
    def __init__(self, args, name):
        self.name = name
        self.raw = b""
        self.tlog = open(f"{V}/logs/{name}.screen.txt", "ab")
        env = dict(os.environ)
        env["CLAUDE_CONFIG_DIR"] = os.path.expanduser("~/.claude-account1")
        env["TERM"] = "xterm-256color"
        for k in list(env):
            if (k.startswith("CLAUDE") and k != "CLAUDE_CONFIG_DIR") or k.startswith("ANTHROPIC"): env.pop(k)
        env["V0_LOG"] = f"{V}/logs/{name}.hooks.jsonl"
        global CUR_LOG; CUR_LOG = env["V0_LOG"]
        pid, fd = pty.fork()
        if pid == 0:
            os.chdir(REPO)
            os.execvpe("/opt/homebrew/bin/claude", ["claude"] + args, env)
        self.pid, self.fd = pid, fd
        fcntl.ioctl(fd, termios.TIOCSWINSZ, struct.pack("HHHH", 40, 120, 0, 0))
        self.t0 = time.time()
        self.exited = None
    def pump(self, dur):
        end = time.time() + dur
        while True:
            left = end - time.time()
            if left <= 0: break
            r, _, _ = select.select([self.fd], [], [], min(left, 0.2))
            if r:
                try: d = os.read(self.fd, 65536)
                except OSError: d = b""
                if not d:
                    self.reap(); return
                self.raw += d; self.tlog.write(d); self.tlog.flush()
                # answer cursor position / device attr queries
                if b"\x1b[6n" in d: os.write(self.fd, b"\x1b[1;1R")
                if b"\x1b[c" in d: os.write(self.fd, b"\x1b[?62;c")
            self.reap(nohang=True)
            if self.exited is not None: return
    def reap(self, nohang=False):
        if self.exited is not None: return
        try:
            p, st = os.waitpid(self.pid, os.WNOHANG if nohang else 0)
            if p: self.exited = st
        except ChildProcessError: self.exited = -1
    def text(self, last=None):
        t = ANSI.sub("", self.raw.decode("utf-8", "replace"))
        return t[-last:] if last else t
    def wait_for(self, pat, timeout=90, since=0):
        end = time.time() + timeout
        while time.time() < end:
            self.pump(0.5)
            if re.search(pat, self.text()[since:]): return True
            if self.exited is not None: return False
        return False
    def idle(self, quiet=3, timeout=60):
        end = time.time() + timeout
        while time.time() < end:
            n = len(self.raw); self.pump(quiet)
            if len(self.raw) == n: return True
            if self.exited is not None: return True
        return False
    def send(self, s, delay=0.05):
        for ch in s:
            os.write(self.fd, ch.encode() if isinstance(ch, str) else ch); time.sleep(delay)
    def key(self, b):
        os.write(self.fd, b); time.sleep(0.3)
    def trust(self):
        self.idle(3, 40)
        if "trustthisfolder" in self.text().replace(" ",""):
            self.key(b"\x1b[B"); time.sleep(0.5); self.key(b"\r"); self.idle(3, 30)
    def prompt(self, s):
        self.send(s, 0.02); time.sleep(0.5); os.write(self.fd, b"\r")
    def kill(self, sig=signal.SIGTERM, wait=10):
        if self.exited is not None: return
        try: os.kill(self.pid, sig)
        except ProcessLookupError: pass
        end = time.time() + wait
        while time.time() < end and self.exited is None: self.pump(0.3)
        if self.exited is None:
            try: os.kill(self.pid, signal.SIGKILL)
            except ProcessLookupError: pass
            self.reap()

CUR_LOG = None
MCP = json.dumps({"mcpServers": {"dcterminal": {"command": "python3", "args": [f"{V}/mcp_server.py"]}}})
SL = {"statusLine": {"type": "command", "command": f"{V}/statusline.py"}}
def ctrl(label, d):
    json.dump(d, open(f"{V}/ctrl/{label}.json", "w"))
def events(path=None):
    path = path or CUR_LOG
    if not path or not os.path.exists(path): return []
    return [json.loads(l) for l in open(path)]

def wait_event(label, count, timeout=90, s=None):
    end = time.time() + timeout
    while time.time() < end:
        if len([e for e in events() if e["label"] == label]) >= count: return True
        if s: s.pump(0.5)
        else: time.sleep(0.5)
    return False
