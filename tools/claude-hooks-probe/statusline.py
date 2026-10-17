#!/usr/bin/env python3
import sys, json, time, os
D = os.path.dirname(os.path.abspath(__file__))
raw = sys.stdin.read()
with open(os.path.join(D, "logs", "statusline.jsonl"), "a") as f:
    f.write(json.dumps({"ts": time.time(), "raw": raw}) + "\n")
print("V0-STATUS ok")
