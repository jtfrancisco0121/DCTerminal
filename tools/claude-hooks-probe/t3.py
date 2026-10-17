import sys; sys.path.insert(0, sys.path[0])
from driver import *
ALL=[("Stop",None),("UserPromptSubmit",None),("SessionStart",None),("SessionEnd",None),("Notification",None),("PreToolUse",None),("PostToolUse",None)]
s = Sess(["--model","haiku","--permission-mode","auto","--allowedTools","mcp__dcterminal__submit_result",
          "--mcp-config", MCP, "--settings", hooks_settings(ALL, SL)], "t3")
s.trust()
print("START:\n", s.text(1500))
ctrl("Stop", {"once": True, "stdout": json.dumps({"decision":"block","reason":"Call submit_result with your result before finishing."})})
mark=len(s.text())
s.prompt("Reply with exactly: OK")
print("stops>=2", wait_event("Stop", 2, 120, s)); s.idle(3, 30)
print("TURN1:\n", s.text()[mark:][-2500:])
ctrl("Stop", {"once": True, "exit": 2, "stderr": "Call submit_result with verdict CHANGES_REQUIRED before finishing."})
mark=len(s.text())
s.prompt("Reply with exactly: OK2")
print("stops>=4", wait_event("Stop", 4, 120, s)); s.idle(3, 30)
print("TURN2:\n", s.text()[mark:][-2500:])
s.prompt("/exit"); s.idle(3, 20); s.kill(); print("exit", s.exited)
