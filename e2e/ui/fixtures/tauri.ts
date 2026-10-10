import { test as base, expect, type Locator, type Page } from "@playwright/test";
import type {
  PermissionRequestEvent,
  PlanRequestEvent,
  PromptFinishedEvent,
  PtyPacket,
  QuestionRequestEvent,
  Role,
  SessionUpdateEvent,
  TabSummary,
} from "../../../src/bridge";
import { builtInRoles, CWD, roleTab } from "./data";
import { installTauriMock } from "./mock";
import type { InvokeCall, MockConfig } from "./types";

/** In-page handler; runs in the browser, so it may only use `args` and `state`. */
export type PageHandler = (args: any, state: any) => unknown;

export type OpenOptions = {
  tabs?: TabSummary[];
  activeTabId?: string | null;
  answers?: Record<string, Record<string, string>>;
  /** Edit the built-in roles before the app sees them. */
  roles?: (roles: Role[]) => Role[];
  responses?: Record<string, unknown>;
  handlers?: Record<string, PageHandler>;
  strict?: boolean;
};

export const sessionIdFor = (tabId: string) => `sess-${tabId}`;

export class TauriApp {
  constructor(readonly page: Page) {}

  /** Installs the IPC mock, loads the app, and waits for its backend listeners. */
  async open(options: OpenOptions = {}): Promise<void> {
    const tabs = options.tabs ?? [roleTab("tab-1", "role_general", "General")];
    const roles = options.roles ? options.roles(builtInRoles()) : builtInRoles();
    const config: MockConfig = {
      cwd: CWD,
      roles,
      tabs,
      activeTabId: options.activeTabId === undefined ? (tabs[0]?.id ?? null) : options.activeTabId,
      answers: options.answers,
      responses: options.responses,
      handlers: Object.fromEntries(
        Object.entries(options.handlers ?? {}).map(([cmd, fn]) => [cmd, fn.toString()]),
      ),
      strict: options.strict,
    };
    await this.page.addInitScript(installTauriMock, config);
    await this.page.goto("/");
    await expect
      .poll(() => this.page.evaluate(() => window.__E2E.listenerCount("acp/session-update")))
      .toBeGreaterThan(0);
  }

  /** Delivers a backend event to every frontend `listen()` for it. */
  async emit(event: string, payload: unknown): Promise<void> {
    await this.page.evaluate(([e, p]) => window.__E2E.emit(e as string, p), [event, payload] as const);
  }

  async emitMany(events: [string, unknown][]): Promise<void> {
    await this.page.evaluate((list) => {
      for (const [event, payload] of list) window.__E2E.emit(event, payload);
    }, events);
  }

  async calls(cmd?: string): Promise<InvokeCall[]> {
    const all = await this.page.evaluate(() => window.__E2E.calls as InvokeCall[]);
    return cmd ? all.filter((c) => c.cmd === cmd) : all;
  }

  /** Waits for a call to `cmd` (optionally matching) and returns the latest one. */
  async waitForCall(
    cmd: string,
    match: (args: Record<string, unknown>) => boolean = () => true,
  ): Promise<InvokeCall> {
    let found: InvokeCall | undefined;
    await expect
      .poll(async () => {
        found = (await this.calls(cmd)).filter((c) => match(c.args)).at(-1);
        return !!found;
      }, { message: `waiting for invoke("${cmd}")` })
      .toBe(true);
    return found!;
  }

  async respond(cmd: string, value: unknown): Promise<void> {
    await this.page.evaluate(([c, v]) => window.__E2E.respond(c as string, v), [cmd, value] as const);
  }

  async handle(cmd: string, fn: PageHandler): Promise<void> {
    await this.page.evaluate(([c, s]) => window.__E2E.handle(c, s), [cmd, fn.toString()] as const);
  }

  // ---- Terminal tabs (e2e/ui/terminal*.spec.ts) ----
  /** Sends `text` as one PTY data packet (base64, like the Rust reader) to PTY `ptyId`. */
  async ptyOutput(ptyId: string, text: string): Promise<void> {
    await this.ptyBytes(ptyId, new TextEncoder().encode(text));
  }

  /** Raw bytes as one PTY data packet, e.g. half of a UTF-8 sequence. */
  async ptyBytes(ptyId: string, bytes: Uint8Array): Promise<void> {
    const data = btoa(Array.from(bytes, (b) => String.fromCharCode(b)).join(""));
    await this.ptyPacket(ptyId, { kind: "data", data, code: null });
  }

  /** The PTY's process exited with `code`. */
  async ptyExit(ptyId: string, code: number | null): Promise<void> {
    await this.ptyPacket(ptyId, { kind: "exit", data: "", code });
  }

  private async ptyPacket(ptyId: string, packet: PtyPacket): Promise<void> {
    const sent = await this.page.evaluate(
      ([id, p]) => window.__E2E.ptySend(id as string, p),
      [ptyId, packet] as const,
    );
    if (!sent) throw new Error(`no PTY channel for ${ptyId}`);
  }
  // ---- end Terminal tabs ----

  async nextFrame(): Promise<void> {
    await this.page.evaluate(
      () => new Promise((done) => requestAnimationFrame(() => requestAnimationFrame(done))),
    );
  }

  turn(tabId: string): Turn {
    return new Turn(this, tabId);
  }

  /** Presses Start on the open draft tab and returns its (in-flight) startup turn. */
  async start(tabId: string): Promise<Turn> {
    const before = (await this.calls("role_session_start")).length;
    await this.page.getByRole("button", { name: "Start", exact: true }).click();
    await expect.poll(async () => (await this.calls("role_session_start")).length).toBe(before + 1);
    await expect(this.page.getByRole("button", { name: "Stop session" }).first()).toBeVisible();
    return this.turn(tabId);
  }

  /** Pastes image files into `target` the way a clipboard paste would. */
  async pasteImage(
    target: Locator,
    file: { name: string; mime: string; base64: string },
  ): Promise<void> {
    await target.evaluate((el, f) => {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      const data = new DataTransfer();
      data.items.add(new File([bytes], f.name, { type: f.mime }));
      let event: Event = new ClipboardEvent("paste", {
        clipboardData: data,
        bubbles: true,
        cancelable: true,
      });
      // WebKit ignores clipboardData in the constructor.
      if (!(event as ClipboardEvent).clipboardData) {
        event = new Event("paste", { bubbles: true, cancelable: true });
        Object.defineProperty(event, "clipboardData", { value: data });
      }
      el.dispatchEvent(event);
    }, file);
  }
}

/** Scripts one agent turn on a tab, emitting the events the Rust side would. */
export class Turn {
  readonly sessionId: string;
  private text = "";
  private batch: [string, unknown][] | null = null;

  constructor(private readonly app: TauriApp, readonly tabId: string) {
    this.sessionId = sessionIdFor(tabId);
  }

  async update(update: Record<string, unknown>, textDelta: string | null): Promise<void> {
    const payload: SessionUpdateEvent = {
      tabId: this.tabId,
      sessionId: this.sessionId,
      kind: String(update.sessionUpdate),
      textDelta,
      rawJson: JSON.stringify({ sessionId: this.sessionId, update }),
    };
    await this.send("acp/session-update", payload);
  }

  private async send(event: string, payload: unknown): Promise<void> {
    if (this.batch) this.batch.push([event, payload]);
    else await this.app.emit(event, payload);
  }

  /**
   * Delivers everything `script` emits in one browser task, the way a burst of
   * backend events can land inside a single animation frame.
   */
  async burst(script: (turn: Turn) => Promise<void>): Promise<void> {
    this.batch = [];
    try {
      await script(this);
    } finally {
      const events = this.batch;
      this.batch = null;
      await this.app.emitMany(events);
    }
  }

  async chunk(text: string): Promise<void> {
    this.text += text;
    await this.update({ sessionUpdate: "agent_message_chunk", content: { type: "text", text } }, text);
  }

  async thought(text: string): Promise<void> {
    await this.update({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text } }, text);
  }

  /** `kind` is the ACP tool kind (execute, edit, read, fetch, delete, other). */
  async toolCall(call: {
    id: string;
    title: string;
    kind?: string;
    status?: "pending" | "in_progress" | "completed" | "failed";
    input?: { command?: string; file_path?: string; url?: string };
  }): Promise<void> {
    const status = call.status ?? "pending";
    await this.update(
      {
        sessionUpdate: status === "pending" ? "tool_call" : "tool_call_update",
        toolCallId: call.id,
        title: call.title,
        kind: call.kind ?? "other",
        status,
        rawInput: call.input ?? {},
      },
      `${call.title} (${status})`,
    );
  }

  async commands(list: { name: string; description?: string; hint?: string }[]): Promise<void> {
    await this.update(
      {
        sessionUpdate: "available_commands_update",
        availableCommands: list.map((c) => ({
          name: c.name,
          description: c.description ?? "",
          input: c.hint ? { hint: c.hint } : null,
        })),
      },
      null,
    );
  }

  async plan(markdown: string, jsonRpcId = 7): Promise<void> {
    const payload: PlanRequestEvent = {
      tabId: this.tabId,
      sessionId: this.sessionId,
      jsonRpcId,
      title: "Ready to code?",
      entries: [{ content: markdown, status: "pending" }],
      markdown,
      keepOptionId: "reject",
    };
    await this.send("acp/plan-request", payload);
  }

  async question(prompt: string, choices: { id: string; label: string }[], jsonRpcId = 8): Promise<void> {
    const payload: QuestionRequestEvent = {
      tabId: this.tabId,
      sessionId: this.sessionId,
      jsonRpcId,
      title: "Question",
      prompt,
      choices,
    };
    await this.send("acp/question-request", payload);
  }

  async permission(title: string, jsonRpcId = 9): Promise<void> {
    const payload: PermissionRequestEvent = {
      tabId: this.tabId,
      sessionId: this.sessionId,
      jsonRpcId,
      title,
      message: title,
      toolClass: "shell",
      displayKind: "tool",
      network: false,
      options: [
        { id: "allow-once", label: "Allow once" },
        { id: "reject-once", label: "Reject" },
      ],
      rawParams: "{}",
    };
    await this.send("acp/permission-request", payload);
  }

  /**
   * Ends the turn. Outside a burst it first waits two frames so streamed
   * chunks (flushed on requestAnimationFrame) are applied.
   */
  async finish(stopReason = "end_turn"): Promise<void> {
    if (!this.batch) await this.app.nextFrame();
    const payload: PromptFinishedEvent = {
      sessionId: this.sessionId,
      tabId: this.tabId,
      success: true,
      result: { stopReason, agentText: this.text, updateCount: 1 },
      error: null,
      agentExited: false,
    };
    await this.send("role_session/prompt-finished", payload);
    this.text = "";
  }

  async fail(error: string): Promise<void> {
    if (!this.batch) await this.app.nextFrame();
    const payload: PromptFinishedEvent = {
      sessionId: this.sessionId,
      tabId: this.tabId,
      success: false,
      result: null,
      error,
      agentExited: false,
    };
    await this.send("role_session/prompt-finished", payload);
  }

  /** Streams `reply` in a few chunks and ends the turn. */
  async reply(reply: string): Promise<void> {
    const parts = reply.match(/[\s\S]{1,24}/g) ?? [];
    for (const part of parts) await this.chunk(part);
    await this.finish();
  }
}

export const test = base.extend<{ app: TauriApp }>({
  app: async ({ page }, use) => {
    const errors: string[] = [];
    page.on("pageerror", (err) => errors.push(err.message));
    await use(new TauriApp(page));
    expect(errors, "uncaught page errors").toEqual([]);
  },
});

export { expect, roleTab };

declare global {
  interface Window {
    __E2E: {
      state: any;
      calls: InvokeCall[];
      emit: (event: string, payload: unknown) => void;
      listenerCount: (event: string) => number;
      respond: (cmd: string, value: unknown) => void;
      handle: (cmd: string, source: string) => void;
      /** Terminal tabs: delivers one PtyPacket; false when PTY `ptyId` has no channel. */
      ptySend: (ptyId: string, packet: unknown) => boolean;
    };
  }
}
