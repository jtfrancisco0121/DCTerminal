import sys; sys.path.insert(0, sys.path[0])
from driver import *
ALL=[("Stop",None),("UserPromptSubmit",None),("SessionEnd",None),("Notification",None),("StopFailure",None),("PostToolUse",None)]
s = Sess(["--model","haiku","--permission-mode","default","--settings", hooks_settings(ALL)], "t4b")
s.trust()
mark=len(s.text())
s.prompt("Count from 1 to 400, one number per line. No tools.")
# wait until numbers stream
ok = s.wait_for(r"1\s*2\s*3\s*4\s*5", 60, since=mark); print("streaming", ok)
s.pump(1); s.key(b"\x1b"); t_esc=time.time(); print("t_esc", t_esc)
s.idle(3, 30)
print("AFTER ESC:\n", s.text()[mark:][-700:])
print("stop after esc?", wait_event("Stop", 1, 10, s))
s.key(b"\x15"); s.idle(1,5)  # ctrl-u clear input in case
mark=len(s.text())
s.prompt("Reply with exactly: OK")
print("stop", wait_event("Stop", 1, 90, s)); t_done=time.time()
print("waiting 100s for idle notification")
print("idle notif", wait_event("Notification", 1, 100, s), time.time()-t_done)
s.prompt("/exit"); s.idle(3, 20); s.kill(); print("exit", s.exited)
