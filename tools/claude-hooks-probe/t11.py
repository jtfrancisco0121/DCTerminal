import sys, uuid, glob; sys.path.insert(0, sys.path[0])
from driver import *
sid = str(uuid.uuid4()); print("SID", sid)
ALL=[("Stop",None),("UserPromptSubmit",None),("SessionStart",None),("SessionEnd",None)]
S = hooks_settings(ALL)
s = Sess(["--model","haiku","--session-id",sid,"--settings",S], "t11")
s.trust()
s.prompt("Reply with exactly: OK")
print("stop1", wait_event("Stop", 1, 90, s)); s.idle(2, 15)
t=time.time(); s.kill(signal.SIGTERM, 15); print("exit status", s.exited, "after", round(time.time()-t,2), "s")
time.sleep(2)
f = glob.glob(os.path.expanduser(f"~/.claude-account1/projects/*/{sid}.jsonl")); print("JSONL", f)
lines = open(f[0]).read().splitlines(); print("lines before resume", len(lines))
for l in lines:
    d=json.loads(l); print("  ", d.get("type"), d.get("subtype",""), (json.dumps(d.get("message",{}).get("content",""))[:80] if isinstance(d.get("message"),dict) else ""))
n_before=len(lines)
s2 = Sess(["--model","haiku","--resume",sid,"--settings",S,"Reply with exactly: RESUMED"], "t11")
t0=time.time()
print("stop2", wait_event("Stop", 2, 90, s2), "secs", round(time.time()-t0,1)); s2.idle(2, 15)
print("SCREEN2:\n", s2.text()[-1200:])
s2.prompt("/exit"); s2.idle(3, 20); s2.kill()
lines = open(f[0]).read().splitlines(); print("lines after resume", len(lines), "new:")
for l in lines[n_before:]:
    d=json.loads(l); print("  ", d.get("type"), d.get("subtype",""), d.get("sessionId"), (json.dumps(d.get("message",{}).get("content",""))[:80] if isinstance(d.get("message"),dict) else ""))
print("other jsonl files created since start:", [p for p in glob.glob(os.path.expanduser("~/.claude-account1/projects/*/*.jsonl")) if os.path.getmtime(p) > t0-200 and sid not in p])
for e in events():
    p=e["payload"]
    for k in ('transcript_path','cwd','scratchpad_dir'): p.pop(k,None)
    print(e["label"], round(e["ts"],2), json.dumps(p)[:500])
