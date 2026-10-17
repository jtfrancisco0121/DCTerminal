import sys; sys.path.insert(0, sys.path[0])
from driver import *
def h(label, matcher=None):
    e={"hooks":[{"type":"command","command":f"{V}/hook.py {label}"}]}
    if matcher: e["matcher"]=matcher
    return [e]
settings={"hooks":{
 "Stop":h("Stop"),"UserPromptSubmit":h("UserPromptSubmit"),"Notification":h("Notification"),
 "PermissionRequest":h("PermissionRequest"),"PostToolUse":h("PostToolUse"),"SessionEnd":h("SessionEnd"),
 "PreToolUse":h("PreToolUse_mcp","mcp__dcterminal__submit_result")+h("PreToolUse_epm","ExitPlanMode")+h("PreToolUse_all")}}
ctrl("PreToolUse_mcp", {"stdout": json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow","permissionDecisionReason":"DCTerminal tool"}})})
ctrl("PreToolUse_epm", {"stdout": json.dumps({"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"Plan received by DCTerminal. Stop here."}})})
s = Sess(["--model","haiku","--permission-mode","plan","--mcp-config",MCP,"--settings",json.dumps(settings)], "t7")
s.trust()
def turn(p, n):
    mark=len(s.text()); s.prompt(p); t0=time.time(); got=None
    while time.time()-t0<120:
        s.pump(1); ev=[e["label"] for e in events()]
        if ev.count("Stop")>=n: got="stop"; break
        if "Doyouwant" in s.text()[mark:].replace(" ","") or "Wouldyouliketoproceed" in s.text()[mark:].replace(" ",""): got="dialog"; break
    s.idle(4, 30); print("OUTCOME", got); print("SCREEN:\n", s.text()[mark:][-2000:])
    if got=="dialog": s.key(b"\x1b"); s.idle(3,20)
turn("Call the submit_result tool with verdict APPROVED, then reply DONE.", 1)
turn("Plan how to add a CHANGELOG.md file. Keep the plan to 3 bullets.", 2)
s.prompt("/exit"); s.idle(3, 20); s.kill(); print("exit", s.exited)
for e in events():
    p=e["payload"]
    for k in ('transcript_path','cwd','scratchpad_dir','session_id'): p.pop(k,None)
    print(e["label"], round(e["ts"],2), json.dumps(p)[:1500])
