#!/usr/bin/env python3
import sys, json, time, os
D = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(D, "logs", "mcp.jsonl")
def log(o):
    with open(LOG, "a") as f: f.write(json.dumps({"ts": time.time(), **o}) + "\n")
def send(o):
    sys.stdout.write(json.dumps(o) + "\n"); sys.stdout.flush()
TOOL = {"name": "submit_result", "description": "Submit the final review result to DCTerminal.",
        "inputSchema": {"type": "object", "properties": {"verdict": {"type": "string", "enum": ["APPROVED", "CHANGES_REQUIRED"]}}, "required": ["verdict"]}}
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    try: msg = json.loads(line)
    except Exception: continue
    m = msg.get("method"); mid = msg.get("id")
    log({"dir": "in", "method": m, "params": msg.get("params")})
    if mid is None: continue
    if m == "initialize":
        send({"jsonrpc": "2.0", "id": mid, "result": {"protocolVersion": msg.get("params", {}).get("protocolVersion", "2025-06-18"), "capabilities": {"tools": {}}, "serverInfo": {"name": "dcterminal", "version": "0.0.1"}}})
    elif m == "tools/list":
        send({"jsonrpc": "2.0", "id": mid, "result": {"tools": [TOOL]}})
    elif m == "tools/call":
        log({"dir": "call", "arguments": msg.get("params", {}).get("arguments")})
        send({"jsonrpc": "2.0", "id": mid, "result": {"content": [{"type": "text", "text": "ok"}]}})
    elif m == "ping":
        send({"jsonrpc": "2.0", "id": mid, "result": {}})
    else:
        send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "method not found"}})
