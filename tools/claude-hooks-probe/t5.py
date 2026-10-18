import sys; sys.path.insert(0, sys.path[0])
from driver import *
name, model, mode, allowed = sys.argv[1], sys.argv[2], sys.argv[3], sys.argv[4] == "1"
prompt = sys.argv[5] if len(sys.argv) > 5 else "Call the submit_result tool with verdict APPROVED, then reply DONE."
ALL=[("Stop",None),("UserPromptSubmit",None),("Notification",None),("PreToolUse",None),("PermissionRequest",None),("PostToolUse",None),("SessionEnd",None)]
args=["--model",model,"--permission-mode",mode,"--mcp-config",MCP,"--settings",hooks_settings(ALL)]
if allowed: args += ["--allowedTools","mcp__dcterminal__submit_result"]
s = Sess(args, name)
s.trust()
print("START:\n", s.text(900))
mark=len(s.text())
s.prompt(prompt)
t0=time.time(); got=False
while time.time()-t0 < 120:
    s.pump(1)
    ev=[e["label"] for e in events()]
    if "Stop" in ev: got="stop"; break
    if "PermissionRequest" in ev: got="perm"; break
    if re.search(r"Doyouwant|Would you like to proceed|Do you want", s.text()[mark:].replace(" ","")) : got="dialog"; break
print("outcome", got); s.idle(3, 20)
print("SCREEN:\n", s.text()[mark:][-1800:])
if got in ("perm","dialog"):
    s.key(b"\x1b"); s.idle(3, 20)
s.prompt("/exit"); s.idle(3, 20); s.kill(); print("exit", s.exited)
for e in events():
    p=e["payload"]
    for k in ('transcript_path','cwd','scratchpad_dir','session_id'): p.pop(k,None)
    print(e["label"], round(e["ts"],2), json.dumps(p)[:700])
