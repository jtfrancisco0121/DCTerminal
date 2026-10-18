import sys; sys.path.insert(0, sys.path[0])
from driver import *
s = Sess(["--model", "haiku", "--settings", hooks_settings([("Stop",None),("UserPromptSubmit",None),("SessionStart",None)])], "probe")
s.idle(4, 40)
print(s.text(3000))
s.kill()
print("exit", s.exited)
