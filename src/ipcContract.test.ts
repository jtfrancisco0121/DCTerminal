// Ported from ADE (better-agentic-ide), src/lib/__tests__/tauriCommandContract.test.ts,
// MIT License, Copyright (c) 2025-2026 Alvin Reyes. Adapted for DCTerminal:
// type-based injected parameters, `async` and attribute forms of
// #[tauri::command], and an explicit allowlist for calls whose arguments are
// not an inline object literal.
import { beforeAll, describe, expect, it } from "vitest";

/**
 * Guards the contract between the UI's `invoke()` calls and the Rust commands
 * they target. Tauri finds a command by name and binds its arguments by name,
 * so an unregistered command or a misspelt argument key only fails at run
 * time, and silently when the caller swallows the rejection.
 */

/** Files whose `invoke` calls are checked. */
const UI_FILES = ["src/bridge.ts", "src/windowScope.ts"];

/**
 * Calls whose arguments are not an inline object literal, or spread another
 * object into one, by `file:command`. Their literal keys are still checked;
 * the rest is checked by hand and the reason says how.
 */
const NON_LITERAL_ARGS: Record<string, string> = {
  "src/bridge.ts:chain_loop_back":
    "`lane ? { ...rest, lane } : rest`: `rest` is the typed input (chainId, reviewerRoleId, tabId, verdict, handoffText), all chain_loop_back parameters.",
  "src/bridge.ts:session_agent_logs":
    "`tabId ? { tabId } : {}`: tabId is the only parameter.",
  "src/bridge.ts:reopen_closed_tab":
    "spreads `tabId ? { tabId } : {}`; tabId is a reopen_closed_tab parameter.",
  "src/bridge.ts:terminal_plan_file":
    "spreads `{ mentioned, claimed }` when names are given; both are terminal_plan_file parameters.",
};

/** Rust parameter types Tauri fills in itself; the caller never sends them. */
const INJECTED_TYPE =
  /^(?:tauri::)?(?:State|AppHandle|Window|WebviewWindow|Webview|ipc::Request|ipc::InvokeMessage)\b/;

type Fs = {
  readFileSync(path: URL, encoding: "utf8"): string;
  readdirSync(path: URL): string[];
  statSync(path: URL): { isDirectory(): boolean };
};

const ROOT = new URL("../", import.meta.url);
let fs: Fs;

beforeAll(async () => {
  // @ts-expect-error type error without @types/node package
  fs = (await import("node:fs")) as Fs;
});

function read(rel: string): string {
  return fs.readFileSync(new URL(rel, ROOT), "utf8");
}

function rustFiles(rel: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(new URL(rel, ROOT))) {
    const child = `${rel}/${entry}`;
    if (fs.statSync(new URL(child, ROOT)).isDirectory()) out.push(...rustFiles(child));
    else if (entry.endsWith(".rs")) out.push(child);
  }
  return out;
}

/** Tauri 2 turns snake_case Rust parameters into camelCase keys. */
function toCamel(snake: string): string {
  return snake.replace(/_([a-z0-9])/g, (_, c: string) => c.toUpperCase());
}

/** String delimiters: Rust's `'` starts a lifetime or char, not a string. */
type Lang = { pairs: Record<string, string>; quotes: string };

const RUST: Lang = { pairs: { "(": ")", "<": ">", "[": "]", "{": "}" }, quotes: '"' };
const TS: Lang = { pairs: { "(": ")", "[": "]", "{": "}" }, quotes: "\"'`" };
const TS_ANGLE: Lang = { pairs: { "<": ">" }, quotes: "\"'`" };

/** Index just past the bracket that closes the one at `open`. */
function closeOf(text: string, open: number, lang: Lang): number {
  const pairs = lang.pairs;
  const closers = new Set(Object.values(pairs));
  const stack: string[] = [];
  for (let i = open; i < text.length; i++) {
    const ch = text[i];
    if (lang.quotes.includes(ch)) {
      i = skipString(text, i, lang);
      continue;
    }
    if (ch === "-" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if (ch === "=" && text[i + 1] === ">") {
      i++;
      continue;
    }
    if (pairs[ch]) stack.push(pairs[ch]);
    else if (closers.has(ch)) {
      stack.pop();
      if (stack.length === 0) return i + 1;
    }
  }
  return text.length;
}

/** Index of the quote that ends the string starting at `start`. */
function skipString(text: string, start: number, lang: Lang): number {
  const quote = text[start];
  for (let i = start + 1; i < text.length; i++) {
    if (text[i] === "\\") {
      i++;
    } else if (quote === "`" && text[i] === "$" && text[i + 1] === "{") {
      i = closeOf(text, i + 1, { pairs: { "{": "}" }, quotes: lang.quotes }) - 1;
    } else if (text[i] === quote) {
      return i;
    }
  }
  return text.length;
}

/** Splits at commas outside any brackets or strings. */
function splitTopLevel(text: string, lang: Lang): string[] {
  const pairs = lang.pairs;
  const parts: string[] = [];
  let depth = 0;
  let start = 0;
  const closers = new Set(Object.values(pairs));
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (lang.quotes.includes(ch)) {
      i = skipString(text, i, lang);
    } else if ((ch === "-" || ch === "=") && text[i + 1] === ">") {
      i++;
    } else if (pairs[ch]) {
      depth++;
    } else if (closers.has(ch)) {
      depth--;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(text.slice(start));
  return parts.map((part) => part.trim()).filter(Boolean);
}

type RustCommand = {
  file: string;
  args: Set<string>;
  /** Caller-supplied parameters that are not `Option<…>`: a call must send them. */
  required: Set<string>;
};

/** `Option<…>` (any path to it): Tauri reads a missing key as `None`. */
const OPTION_TYPE = /^(?:(?:std|core)::option::)?Option\s*</;

/** Every `#[tauri::command]` fn: name -> definitions (file, camelCase keys). */
function parseRustCommands(): Map<string, RustCommand[]> {
  const commands = new Map<string, RustCommand[]>();
  const re =
    /#\[tauri::command(?:\([^)]*\))?\]\s*(?:#\[[^\]]*\]\s*)*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(\w+)\s*(<[^(]*>)?\s*\(/g;
  for (const file of rustFiles("src-tauri/src")) {
    // Line comments out, so a comment inside a parameter list cannot split it.
    const source = read(file).replace(/\/\/.*$/gm, "");
    let m: RegExpExecArray | null;
    while ((m = re.exec(source)) !== null) {
      const open = m.index + m[0].length - 1;
      const close = closeOf(source, open, RUST);
      const params = splitTopLevel(source.slice(open + 1, close - 1), RUST);
      const args = new Set<string>();
      const required = new Set<string>();
      for (const param of params) {
        const colon = param.indexOf(":");
        if (colon < 0) continue;
        const name = param.slice(0, colon).replace(/^mut\s+/, "").trim();
        const type = param.slice(colon + 1).trim();
        if (INJECTED_TYPE.test(type)) continue;
        args.add(toCamel(name));
        if (!OPTION_TYPE.test(type)) required.add(toCamel(name));
      }
      const list = commands.get(m[1]) ?? [];
      list.push({ file, args, required });
      commands.set(m[1], list);
    }
  }
  return commands;
}

/** Command paths in lib.rs's generate_handler! list, e.g. `commands::foo::bar`. */
function parseRegistered(): string[] {
  const lib = read("src-tauri/src/lib.rs");
  const block = /generate_handler!\[([\s\S]*?)\]/.exec(lib);
  if (!block) return [];
  return block[1]
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

type InvokeCall = {
  file: string;
  line: number;
  command: string | null;
  /** Top-level keys of an inline object literal; null when not a literal. */
  args: string[] | null;
  /** The literal spreads another object (`...x`), so its keys are unknown. */
  spread: boolean;
};

/** Top-level keys of the object literal `{ ... }` in `body`. */
function literalKeys(body: string): { keys: string[]; spread: boolean } {
  const keys: string[] = [];
  let spread = false;
  for (const entry of splitTopLevel(body, TS)) {
    if (entry.startsWith("...")) {
      spread = true;
      continue;
    }
    const key =
      /^["']?([A-Za-z_$][\w$]*)["']?\s*:/.exec(entry)?.[1] ?? // key: value
      /^([A-Za-z_$][\w$]*)$/.exec(entry)?.[1] ?? // shorthand
      /^(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/.exec(entry)?.[1]; // method
    if (key) keys.push(key);
  }
  return { keys, spread };
}

function parseInvokeCalls(file: string): InvokeCall[] {
  const source = read(file);
  const calls: InvokeCall[] = [];
  const re = /\binvoke\s*(?=[<(])/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    let i = m.index + m[0].length;
    if (source[i] === "<") i = closeOf(source, i, TS_ANGLE);
    while (/\s/.test(source[i])) i++;
    if (source[i] !== "(") continue;
    const close = closeOf(source, i, TS);
    const [first, second, ...rest] = splitTopLevel(source.slice(i + 1, close - 1), TS);
    const line = source.slice(0, m.index).split("\n").length;
    const name = /^["'`](\w+)["'`]$/.exec(first ?? "")?.[1] ?? null;
    let args: string[] | null = [];
    let spread = false;
    if (second !== undefined) {
      if (second.startsWith("{") && second.endsWith("}") && rest.length === 0) {
        const literal = literalKeys(second.slice(1, -1));
        args = literal.keys;
        spread = literal.spread;
      } else {
        args = null;
      }
    }
    calls.push({ file, line, command: name, args, spread });
  }
  return calls;
}

let rustCommands: Map<string, RustCommand[]>;
let registered: string[];
let calls: InvokeCall[];

beforeAll(() => {
  rustCommands = parseRustCommands();
  registered = parseRegistered();
  calls = UI_FILES.flatMap(parseInvokeCalls);
});

/** The definition a registered path points at (by module path when names repeat). */
function definitionFor(path: string): RustCommand | undefined {
  const name = path.split("::").pop() ?? "";
  const defs = rustCommands.get(name) ?? [];
  if (defs.length <= 1) return defs[0];
  const modules = path.split("::").slice(0, -1);
  return defs.find((def) => modules.every((part) => def.file.includes(part)));
}

describe("IPC contract between bridge.ts and the Rust commands", () => {
  it("finds the Rust commands, the handler list and the invoke calls", () => {
    expect(rustCommands.size).toBeGreaterThan(50);
    expect(registered.length).toBeGreaterThan(50);
    expect(calls.length).toBeGreaterThan(50);
    // windowScope.ts reaches window_context through invoke too.
    expect(calls.some((call) => call.file === "src/windowScope.ts")).toBe(true);
  });

  it("reads parameter names and argument keys the way Tauri binds them", () => {
    // Injected State parameters (named `store`, `transcripts`) are left out.
    expect([...(rustCommands.get("reopen_closed_tab")?.[0].args ?? [])].sort()).toEqual([
      "tabId",
      "windowId",
    ]);
    const respond = calls.find((call) => call.command === "respond_permission_request");
    expect(respond?.args).toEqual(["tabId", "jsonRpcId", "outcome", "optionId"]);
    // A Channel is caller-supplied, so it stays a parameter.
    const ptyOpen = rustCommands.get("pty_open")?.[0].args;
    expect(ptyOpen?.has("onOutput")).toBe(true);
    // `Option<…>` parameters may be left out; the rest are required.
    const write = rustCommands.get("files_write")?.[0];
    expect([...(write?.required ?? [])].sort()).toEqual(["path", "tabId", "text"]);
  });

  it("starts the app through the library's run()", () => {
    expect(read("src-tauri/src/main.rs")).toMatch(/dcterminal_lib::run\(\)/);
  });

  it("registers only commands that exist", () => {
    for (const path of registered) {
      expect(definitionFor(path), `generate_handler! lists ${path}, which has no #[tauri::command] fn`).toBeDefined();
    }
  });

  it("names a registered command in every invoke call", () => {
    const names = new Set(registered.map((path) => path.split("::").pop()));
    for (const call of calls) {
      expect(call.command, `${call.file}:${call.line} invokes a command whose name is not a string literal`).not.toBeNull();
      expect(
        names.has(call.command ?? ""),
        `${call.file}:${call.line} invokes "${call.command}", which is not in lib.rs's generate_handler! list`,
      ).toBe(true);
    }
  });

  it("passes only argument keys the Rust command accepts", () => {
    for (const call of calls) {
      if (call.args === null) continue;
      const path = registered.find((entry) => entry.split("::").pop() === call.command);
      const def = path ? definitionFor(path) : undefined;
      if (!def) continue; // reported by the registration test
      for (const key of call.args) {
        expect(
          def.args.has(key),
          `${call.file}:${call.line} passes "${key}" to "${call.command}", which takes ` +
            `{${[...def.args].join(", ")}}. Tauri binds by name, so the call fails at run time.`,
        ).toBe(true);
      }
    }
  });

  it("sends every parameter the Rust command requires", () => {
    for (const call of calls) {
      // Non-literal and spread calls are on the allowlist, checked by hand.
      if (call.args === null || call.spread) continue;
      const path = registered.find((entry) => entry.split("::").pop() === call.command);
      const def = path ? definitionFor(path) : undefined;
      if (!def) continue; // reported by the registration test
      for (const key of def.required) {
        expect(
          call.args.includes(key),
          `${call.file}:${call.line} calls "${call.command}" without "${key}", which is not an Option<…>. ` +
            "Tauri refuses the call at run time.",
        ).toBe(true);
      }
    }
  });

  it("lists every call it cannot check in the allowlist, and nothing else", () => {
    const unchecked = calls
      .filter((call) => call.args === null || call.spread)
      .map((call) => `${call.file}:${call.command}`);
    expect(unchecked.sort()).toEqual(Object.keys(NON_LITERAL_ARGS).sort());
  });
});
