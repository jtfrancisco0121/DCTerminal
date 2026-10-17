#!/usr/bin/env python3
import sys, json, time, os
D = os.path.dirname(os.path.abspath(__file__))
label = sys.argv[1] if len(sys.argv) > 1 else "unknown"
t0 = time.time()
raw = sys.stdin.read()
try: payload = json.loads(raw)
except Exception: payload = {"_raw": raw}
log = os.environ.get("V0_LOG", os.path.join(D, "logs", "hooks.jsonl"))
ctrl = os.path.join(D, "ctrl", label + ".json")
action = None
if os.path.exists(ctrl):
    with open(ctrl) as f: action = json.load(f)
    if action.get("once"): os.remove(ctrl)
with open(log, "a") as f:
    f.write(json.dumps({"ts": t0, "label": label, "action": action, "payload": payload}) + "\n")
if action:
    if action.get("stdout"): sys.stdout.write(action["stdout"])
    if action.get("stderr"): sys.stderr.write(action["stderr"])
    sys.exit(action.get("exit", 0))
