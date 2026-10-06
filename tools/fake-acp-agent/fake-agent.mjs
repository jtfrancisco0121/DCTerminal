#!/usr/bin/env node
/**
 * Stand-in for the Cursor `agent` binary.
 * Speaks a small ACP subset on `agent acp`, and stays interactive otherwise.
 * It never reads or writes ~/.cursor.
 */
import readline from "node:readline";

const FAKE_MODELS = [
  ["composer-2.5", "Composer 2.5"],
  ["composer-2.5-fast", "Composer 2.5 Fast"],
  ["auto", "Auto"],
  ["gpt-5", "GPT-5"],
];

function modelConfigOptions() {
  return [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: currentModel,
      options: FAKE_MODELS.map(([value, name]) => ({ value, name })),
    },
  ];
}

const args = process.argv.slice(2);

if (args.includes("--version") || args.includes("-v")) {
  process.stdout.write("0.0.0-dcterminal-fake\n");
  process.exit(0);
}

if (args.includes("--list-models")) {
  process.stdout.write("Available models\n");
  for (const [id, label] of FAKE_MODELS) {
    process.stdout.write(`${id} - ${label}${id === "composer-2.5" ? "  (current)" : ""}\n`);
  }
  process.exit(0);
}

const modelAt = args.indexOf("--model");
let currentModel = modelAt !== -1 ? (args[modelAt + 1] ?? "composer-2.5") : "composer-2.5";
const acpAt = args.indexOf("acp");

const resumeAt = args.indexOf("--resume");
if (resumeAt !== -1) {
  const id = args[resumeAt + 1] ?? "";
  process.stdout.write(`resumed ${id}\n`);
  echoStdin();
} else if (acpAt !== -1 && args.slice(0, acpAt).every((arg, i) => i === modelAt || i === modelAt + 1)) {
  runAcp();
} else {
  process.stdout.write("fake-agent ready\n");
  echoStdin();
}

function echoStdin() {
  process.stdin.on("data", (chunk) => {
    process.stdout.write(chunk);
  });
  process.stdin.on("end", () => process.exit(0));
}

function send(value) {
  process.stdout.write(`${JSON.stringify(value)}\n`);
}

function sessionId() {
  return process.env.DCT_FAKE_SESSION_ID || "fake-session-0001";
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function failure(id, message, code = -32000) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

function chunk(session, text) {
  send({
    jsonrpc: "2.0",
    method: "session/update",
    params: {
      sessionId: session,
      update: {
        sessionUpdate: "agent_message_chunk",
        content: { type: "text", text },
      },
    },
  });
}

function runAcp() {
  const input = readline.createInterface({ input: process.stdin });
  input.on("line", (line) => {
    const trimmed = line.trim();
    if (!trimmed) return;
    let message;
    try {
      message = JSON.parse(trimmed);
    } catch {
      return;
    }
    const id = message.id;
    const method = message.method;
    if (id === undefined || !method) return;
    handle(id, method, message.params ?? {});
  });
}

function handle(id, method, params) {
  if (method === "initialize") {
    result(id, {
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: false, audio: false, embeddedContext: false },
        sessionCapabilities: { list: {} },
      },
      authMethods: [
        {
          id: "cursor_login",
          name: "Cursor Login",
          description: "Fake login for tests.",
        },
      ],
    });
    return;
  }
  if (method === "authenticate") {
    if (process.env.DCT_FAKE_AUTH === "deny") {
      failure(id, "not authenticated");
      return;
    }
    result(id, {});
    return;
  }
  if (method === "session/new") {
    // DCT_FAKE_MODELS=none hides model options, so the app restarts with --model.
    if (process.env.DCT_FAKE_MODELS === "none") {
      result(id, { sessionId: sessionId() });
      return;
    }
    result(id, { sessionId: sessionId(), configOptions: modelConfigOptions() });
    return;
  }
  if (method === "session/set_config_option" && process.env.DCT_FAKE_MODELS !== "none") {
    if (params.configId !== "model" || !FAKE_MODELS.some(([value]) => value === params.value)) {
      failure(id, "unknown config value");
      return;
    }
    currentModel = params.value;
    result(id, { configOptions: modelConfigOptions() });
    return;
  }
  if (method === "session/set_mode" || method === "session/cancel") {
    result(id, {});
    return;
  }
  if (method === "session/load") {
    if (process.env.DCT_FAKE_LOAD === "fail") {
      failure(id, "session not found");
      return;
    }
    const idText = typeof params.sessionId === "string" ? params.sessionId : sessionId();
    chunk(idText, "Earlier note from the saved session.");
    result(id, { sessionId: idText });
    return;
  }
  if (method === "session/prompt") {
    const idText = typeof params.sessionId === "string" ? params.sessionId : sessionId();
    chunk(idText, "DCTerminal fake agent ready");
    result(id, { stopReason: "end_turn" });
    return;
  }
  failure(id, "Method not found", -32601);
}
