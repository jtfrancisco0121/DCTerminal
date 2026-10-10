"""Scripted fake ACP agent for DCTerminal's backend tests (test-only).

Usage: python3 fake_agent.py <scenario.json> <received.ndjson>

Speaks NDJSON JSON-RPC on stdin/stdout like claude-agent-acp / `agent acp`.
Every message read from stdin is appended to <received.ndjson> before it is
handled, so a test can assert exactly what the client sent.

Scenario keys (all optional):
  initialize        result for `initialize`
  session_new       result for `session/new` / `session/load` (sessionId is set)
  load_replay       session/update bodies sent before the `session/load` result
                    (the history an agent replays when a session is resumed)
  session_id        session id (default "fake-session-1")
  set_model         true: `session/set_model` succeeds (default: method not found)
  prompts           list of turns; each turn is a list of steps, used in order
  strict_permission true: a malformed `session/request_permission` answer
                    fails the turn with a JSON-RPC error (like the adapter's
                    schema check would)

Steps:
  {"update": {...}}            session/update notification (sessionUpdate ...)
  {"say": "text"}              agent_message_chunk
  {"raw": {...}}               any JSON line, verbatim
  {"request": {"method", "params"}, "id": n}
                               agent->client request; waits for the client's
                               answer, then says "[reply <id>] <result json>"
  {"wait_cancel": true}        waits for session/cancel
  {"sleep": seconds}           only for timing tests
  {"stderr": "text"}           a line on stderr
  {"exit": code}               exits at once (crash)
  {"end": "stopReason"}        ends the turn now with this stop reason
A turn ends with stopReason "cancelled" when a session/cancel arrived during
it, otherwise "end_turn".
"""

import copy
import json
import os
import sys
import time

scenario = json.load(open(sys.argv[1]))
received = open(sys.argv[2], "a")
session_id = scenario.get("session_id", "fake-session-1")
prompts = list(scenario.get("prompts", []))
held = []
next_agent_id = [900]

DEFAULT_INIT = {
    "protocolVersion": 1,
    "agentCapabilities": {
        "loadSession": True,
        "promptCapabilities": {"image": True, "embeddedContext": True},
    },
    "authMethods": [],
}
session_result = copy.deepcopy(scenario.get("session_new", {}))
session_result["sessionId"] = session_id


def send(obj):
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def read_stdin():
    while True:
        line = sys.stdin.readline()
        if not line:
            sys.exit(0)
        line = line.strip()
        if not line:
            continue
        msg = json.loads(line)
        received.write(json.dumps(msg) + "\n")
        received.flush()
        return msg


def next_msg():
    if held:
        return held.pop(0)
    return read_stdin()


def wait_for(pred):
    for i, msg in enumerate(held):
        if pred(msg):
            return held.pop(i)
    while True:
        msg = read_stdin()
        if pred(msg):
            return msg
        held.append(msg)


def is_cancel(msg):
    return msg.get("method") == "session/cancel"


def update(body):
    send({
        "jsonrpc": "2.0",
        "method": "session/update",
        "params": {"sessionId": session_id, "update": body},
    })


def say(text):
    update({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": text}})


def permission_answer_error(result):
    outcome = result.get("outcome") if isinstance(result, dict) else None
    if not isinstance(outcome, dict):
        return "outcome must be an object, got %s" % json.dumps(outcome)
    kind = outcome.get("outcome")
    if kind == "cancelled":
        return None
    if kind == "selected" and isinstance(outcome.get("optionId"), str):
        return None
    return "bad outcome %s" % json.dumps(outcome)


def run_turn(req_id, steps):
    for step in steps:
        if "update" in step:
            update(step["update"])
        elif "say" in step:
            say(step["say"])
        elif "raw" in step:
            send(step["raw"])
        elif "request" in step:
            rid = step.get("id")
            if rid is None:
                rid = next_agent_id[0]
                next_agent_id[0] += 1
            body = step["request"]
            send({"jsonrpc": "2.0", "id": rid, "method": body["method"],
                  "params": body.get("params", {})})
            reply = wait_for(lambda m: m.get("id") == rid and "method" not in m)
            answer = reply.get("result", {"error": reply.get("error")})
            if (scenario.get("strict_permission")
                    and body["method"] == "session/request_permission"):
                problem = permission_answer_error(answer)
                if problem:
                    send({"jsonrpc": "2.0", "id": req_id, "error": {
                        "code": -32602, "message": "invalid permission response: " + problem}})
                    return
            say("[reply %s] %s" % (rid, json.dumps(answer, sort_keys=True)))
        elif "wait_cancel" in step:
            wait_for(is_cancel)
            held.append({"method": "session/cancel"})
        elif "sleep" in step:
            time.sleep(step["sleep"])
        elif "stderr" in step:
            sys.stderr.write(step["stderr"] + "\n")
            sys.stderr.flush()
        elif "exit" in step:
            sys.stdout.flush()
            sys.stderr.flush()
            os._exit(step["exit"])
        elif "end" in step:
            send({"jsonrpc": "2.0", "id": req_id, "result": {"stopReason": step["end"]}})
            return
    cancelled = any(is_cancel(m) for m in held)
    held[:] = [m for m in held if not is_cancel(m)]
    send({"jsonrpc": "2.0", "id": req_id,
          "result": {"stopReason": "cancelled" if cancelled else "end_turn"}})


def find_option(config_id):
    for opt in session_result.get("configOptions", []):
        if opt.get("id") == config_id:
            return opt
    return None


def option_values(options):
    out = []
    for item in options or []:
        if "value" in item:
            out.append(item["value"])
        else:
            out.extend(option_values(item.get("options")))
    return out


def main():
    while True:
        msg = next_msg()
        method = msg.get("method")
        mid = msg.get("id")
        params = msg.get("params") or {}
        if method is None or method == "session/cancel":
            continue
        if method == "initialize":
            send({"jsonrpc": "2.0", "id": mid, "result": scenario.get("initialize", DEFAULT_INIT)})
        elif method == "authenticate":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method in ("session/new", "session/load"):
            if method == "session/load":
                for body in scenario.get("load_replay", []):
                    update(body)
            send({"jsonrpc": "2.0", "id": mid, "result": session_result})
        elif method == "session/set_mode":
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "session/set_config_option":
            opt = find_option(params.get("configId"))
            if opt is None or params.get("value") not in option_values(opt.get("options")):
                send({"jsonrpc": "2.0", "id": mid, "error": {
                    "code": -32602, "message": "Invalid value for config option"}})
            else:
                opt["currentValue"] = params["value"]
                send({"jsonrpc": "2.0", "id": mid,
                      "result": {"configOptions": session_result["configOptions"]}})
        elif method == "session/set_model" and scenario.get("set_model"):
            send({"jsonrpc": "2.0", "id": mid, "result": {}})
        elif method == "session/prompt":
            run_turn(mid, prompts.pop(0) if prompts else [{"say": "ok"}])
        elif mid is not None:
            send({"jsonrpc": "2.0", "id": mid, "error": {"code": -32601, "message": "Method not found"}})


main()
