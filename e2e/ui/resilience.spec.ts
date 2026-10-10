import type { Page } from "@playwright/test";
import type {
  PermissionRequestEvent,
  PromptFinishedEvent,
  QuestionRequestEvent,
  SessionUpdateEvent,
} from "../../src/bridge";
import { expect, roleTab, sessionIdFor, test, type TauriApp } from "./fixtures/tauri";

// Errors, edge cases and resilience: agent exits, failed starts, rejected
// commands, cancel/stop with cards up, concurrent tabs, stray and repeated
// events, very large transcripts, notifications, reloads, and an a11y smoke.

const status = (page: Page) => page.locator(".status-bar-status");
const log = (page: Page) => page.getByRole("log");

function chunkEvent(tabId: string, text: string, sessionId = sessionIdFor(tabId)): SessionUpdateEvent {
  return {
    tabId,
    sessionId,
    kind: "agent_message_chunk",
    textDelta: text,
    rawJson: JSON.stringify({
      sessionId,
      update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } },
    }),
  };
}

function finishedEvent(
  tabId: string,
  outcome: { agentText?: string; stopReason?: string } | { error: string; agentExited?: boolean },
  sessionId = sessionIdFor(tabId),
): PromptFinishedEvent {
  if ("error" in outcome) {
    return {
      sessionId,
      tabId,
      success: false,
      result: null,
      error: outcome.error,
      agentExited: outcome.agentExited ?? false,
    };
  }
  return {
    sessionId,
    tabId,
    success: true,
    result: { stopReason: outcome.stopReason ?? "end_turn", agentText: outcome.agentText ?? "", updateCount: 1 },
    error: null,
    agentExited: false,
  };
}

function permissionEvent(tabId: string, title: string, jsonRpcId = 9): PermissionRequestEvent {
  return {
    tabId,
    sessionId: sessionIdFor(tabId),
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
}

function questionEvent(tabId: string, prompt: string): QuestionRequestEvent {
  return {
    tabId,
    sessionId: sessionIdFor(tabId),
    jsonRpcId: 8,
    title: "Question",
    prompt,
    choices: [{ id: "a", label: "Option A" }],
  };
}

/** Starts every tab in order (each startup turn stays in flight). Ends on the last one. */
async function startAll(app: TauriApp, page: Page, tabs: { id: string; label: string }[]) {
  for (const tab of tabs) {
    await page.getByRole("tab", { name: new RegExp(`^${tab.label}`) }).click();
    await expect(page.getByRole("tab", { name: new RegExp(`^${tab.label}`) })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await app.start(tab.id);
    await expect(page.getByRole("heading", { name: tab.label, level: 2 })).toBeVisible();
  }
}

/** Commands that would sign the user in (open a login terminal, run `claude /login`, ...). */
const LOGIN_ATTEMPT = /login|auth|pty_open|terminal_start|open_url|shell\|open/i;
const LOGIN_STATUS_READS = new Set(["cli_login_status", "claude_account_logins"]);

test.describe("agent process failures", () => {
  test("the agent exiting mid-turn shows the error, blocks sending and offers Restart", async ({
    app,
    page,
  }) => {
    await app.open();
    const turn = await app.start("tab-1");
    await turn.chunk("Working on it");
    await expect(log(page)).toContainText("Working on it");
    await app.emit(
      "role_session/prompt-finished",
      finishedEvent("tab-1", { error: "agent exited (exit status: 1): segfault in adapter", agentExited: true }),
    );

    await expect(log(page)).toContainText("Working on it");
    await expect(page.getByText("agent exited (exit status: 1): segfault in adapter")).toBeVisible();
    await expect(status(page)).toHaveText("Needs you: stopped with an error");
    await expect(page.getByRole("tab", { name: /General.*Needs you: stopped with an error/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel turn" })).toBeDisabled();
    // A dead agent cannot take a follow-up.
    await page.getByRole("textbox", { name: "Follow-up message" }).fill("are you there?");
    await expect(page.getByRole("button", { name: "Send", exact: true }).first()).toBeDisabled();

    await page.getByRole("button", { name: "Restart" }).click();
    const stop = await app.waitForCall("dev_session_stop");
    expect(stop.args.tabId).toBe("tab-1");
    expect(String(stop.args.transcript)).toContain("Working on it");
    expect(await app.calls("dev_session_send")).toHaveLength(0);

    // Back on the start surface with the old transcript kept read-only.
    await expect(page.getByRole("button", { name: "Stop session" })).toHaveCount(0);
    await expect(status(page)).toHaveText("Not started");
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Start new session" }).click();
    const again = await app.start("tab-1");
    expect(await app.calls("role_session_start")).toHaveLength(2);
    await again.reply("Back online.");
    await expect(status(page)).toHaveText("Ready");
    await expect(page.getByText("segfault in adapter")).toHaveCount(0);
  });

  test("AUTH_ERROR on start shows the sign-in guidance and never tries to log in", async ({ app, page }) => {
    const guidance =
      "Claude Code is not signed in for ~/.claude. Open a terminal, run `CLAUDE_CONFIG_DIR=~/.claude claude` " +
      "(your `claude2`), and use `/login`. Then Retry. (Invalid API key · Please run /login)";
    await app.open({
      responses: {
        // role_session.rs: an AUTH_ERROR from connect becomes a `_auth` field error.
        role_session_start: {
          errors: [{ key: "_auth", message: guidance }],
          session: null,
          mergedChars: null,
          injectionStrategy: null,
          startupInjected: false,
          injectionInFlight: false,
          tabId: null,
          resumedSession: false,
          skippedStartupInjection: false,
          folderWarning: null,
          loadedViaSessionLoad: false,
          replayMessageCount: 0,
          replayTruncated: false,
          replay: [],
        },
      },
    });
    const before = (await app.calls()).length;
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await app.waitForCall("role_session_start");

    await expect(page.getByText(guidance, { exact: false })).toBeVisible();
    await expect(page.locator(".field-errors")).toContainText("/login");
    await expect(status(page)).toHaveText("Not started");
    await expect(page.getByRole("button", { name: "Stop session" })).toHaveCount(0);
    // Retry stays possible.
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();

    const after = (await app.calls()).slice(before).map((c) => c.cmd);
    const attempts = after.filter((cmd) => LOGIN_ATTEMPT.test(cmd) && !LOGIN_STATUS_READS.has(cmd));
    expect(attempts, "no automatic login after an auth failure").toEqual([]);
    expect(after.filter((cmd) => cmd === "role_session_start")).toHaveLength(1);
  });

  test("an AUTH_ERROR that ends a turn is shown as-is with no login attempt", async ({ app, page }) => {
    await app.open();
    const turn = await app.start("tab-1");
    await turn.chunk("Reading the repo");
    const before = (await app.calls()).length;
    // connection.rs exit_error_text: the adapter exited because the CLI is signed out.
    const error =
      "AUTH_ERROR: agent stdout closed — the Claude ACP adapter exited. Not logged in · Please run /login";
    await app.emit("role_session/prompt-finished", finishedEvent("tab-1", { error, agentExited: true }));
    await expect(page.getByText(error)).toBeVisible();
    await expect(page.getByRole("button", { name: "Restart" })).toBeVisible();
    await expect(status(page)).toHaveText("Needs you: stopped with an error");
    const after = (await app.calls()).slice(before).map((c) => c.cmd);
    expect(after.filter((cmd) => LOGIN_ATTEMPT.test(cmd) && !LOGIN_STATUS_READS.has(cmd))).toEqual([]);
    expect(after).not.toContain("role_session_start");
  });

  test("a start command that rejects shows the error and leaves Start usable", async ({ app, page }) => {
    await app.open({
      handlers: {
        role_session_start: () => {
          throw new Error("failed to spawn claude-agent-acp: No such file or directory (os error 2)");
        },
      },
    });
    await page.getByRole("button", { name: "Start", exact: true }).click();
    await app.waitForCall("role_session_start");
    await expect(page.locator(".field-errors")).toContainText(
      "failed to spawn claude-agent-acp: No such file or directory (os error 2)",
    );
    await expect(status(page)).toHaveText("Not started");
    await expect(page.getByRole("button", { name: "Stop session" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Start", exact: true })).toBeEnabled();
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
  });

  test("a missing working folder shows a warning on the start form", async ({ app, page }) => {
    await app.open({ tabs: [roleTab("tab-1", "role_general", "General", { folderStatus: "missing" })] });
    await expect(
      page.getByText("Working folder was not found (it may have been moved or deleted): /Users/e2e/Projects/demo"),
    ).toBeVisible();
    await expect(page.getByText("unavailable")).toBeVisible();
  });

  test("a start that returns a folder warning shows it in the status bar", async ({ app, page }) => {
    const warning =
      "Another agent-mode tab is already using this folder (/Users/e2e/Projects/demo). " +
      "Both sessions can run; two agents writing the same repo may conflict.";
    await app.open({
      handlers: {
        role_session_start: (a, state) => {
          const tab = state.tabs.find((t: { id: string }) => t.id === a.tabId);
          tab.phase = "running";
          tab.acpSessionId = `sess-${tab.id}`;
          return {
            errors: [],
            session: {
              sessionId: `sess-${tab.id}`,
              modeId: "agent",
              cwd: tab.cwd,
              model: "default",
              effort: null,
              effortOptions: [],
              supportsImages: true,
            },
            mergedChars: 24,
            injectionStrategy: "send_on_start",
            startupInjected: false,
            injectionInFlight: true,
            tabId: tab.id,
            resumedSession: false,
            skippedStartupInjection: false,
            folderWarning:
              "Another agent-mode tab is already using this folder (/Users/e2e/Projects/demo). " +
              "Both sessions can run; two agents writing the same repo may conflict.",
            loadedViaSessionLoad: false,
            replayMessageCount: 0,
            replayTruncated: false,
            replay: [],
            modelVia: "unchanged",
          };
        },
      },
    });
    const turn = await app.start("tab-1");
    await expect(page.locator(".status-bar-message-warn")).toHaveText(warning);
    await turn.reply("Started anyway.");
    await expect(status(page)).toHaveText("Ready");
    await expect(page.locator(".status-bar-message-warn")).toHaveText(warning);
  });

  test("a turn that times out shows the error and the tab keeps working", async ({ app, page }) => {
    await app.open();
    const turn = await app.start("tab-1");
    await turn.reply("Ready.");
    const composer = page.getByRole("textbox", { name: "Follow-up message" });
    await composer.fill("run the slow thing");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send");
    await expect(status(page)).toHaveText("Agent working…");

    // connection.rs: the ACP request gave up waiting.
    await turn.fail("timeout waiting for response id=8");
    await expect(page.getByText("timeout waiting for response id=8")).toBeVisible();
    await expect(status(page)).not.toHaveText("Agent working…");
    await expect(page.getByRole("button", { name: "Cancel turn" })).toBeDisabled();

    await composer.fill("try again");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send", (args) => args.prompt === "try again");
    await expect(page.getByText("timeout waiting for response id=8")).toBeHidden();
    await turn.reply("Second try worked.");
    await expect(status(page)).toHaveText("Ready");
    await expect(log(page)).toContainText("Second try worked.");
  });
});

test.describe("cancel and stop", () => {
  test("Cancel turn sends the tab id and a cancelled stop reason returns to Ready", async ({ app, page }) => {
    await app.open();
    const turn = await app.start("tab-1");
    await turn.chunk("Partial answer");
    await page.getByRole("button", { name: "Cancel turn" }).click();
    const cancel = await app.waitForCall("dev_session_cancel");
    expect(cancel.args).toEqual({ tabId: "tab-1" });
    await expect(log(page)).toContainText("Cancelling the current turn…");

    await turn.finish("cancelled");
    await expect(status(page)).toHaveText("Ready");
    await expect(page.getByText("Last turn: cancelled")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel turn" })).toBeDisabled();
    await expect(log(page)).toContainText("Partial answer");
    // A cancelled turn leaves no mark on the tab.
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
    expect(await app.calls("dev_session_stop")).toHaveLength(0);
  });

  test("Cancel turn while a permission card is up clears it once the turn ends", async ({ app, page }) => {
    await app.open();
    const turn = await app.start("tab-1");
    await turn.permission("Run npm publish");
    const card = page.getByRole("dialog", { name: "Run npm publish" });
    await expect(card).toBeVisible();
    await page.getByRole("button", { name: "Cancel turn" }).click();
    expect((await app.waitForCall("dev_session_cancel")).args).toEqual({ tabId: "tab-1" });
    // The backend answers the pending request when it cancels; the UI must not answer it too.
    await turn.finish("cancelled");
    await expect(card).toBeHidden();
    await expect(status(page)).toHaveText("Ready");
    expect(await app.calls("respond_permission_request")).toHaveLength(0);
  });

  const cards = [
    {
      kind: "permission",
      raise: (app: TauriApp) => app.turn("tab-1").permission("Delete the build folder"),
      card: (page: Page) => page.getByRole("dialog", { name: "Delete the build folder" }),
      respond: "respond_permission_request",
    },
    {
      kind: "plan",
      raise: (app: TauriApp) => app.turn("tab-1").plan("## Plan\n1. Rewrite the parser"),
      card: (page: Page) => page.locator(".session-cards").getByRole("heading", { name: "Ready to code?" }),
      respond: "respond_plan_request",
    },
    {
      kind: "question",
      raise: (app: TauriApp) =>
        app.turn("tab-1").question("Which database?", [{ id: "pg", label: "Postgres" }]),
      card: (page: Page) => page.getByRole("dialog", { name: "Question" }),
      respond: "respond_question_request",
    },
  ] as const;

  for (const c of cards) {
    test(`Stop session while a ${c.kind} card is up clears the card`, async ({ app, page }) => {
      await app.open();
      await app.start("tab-1");
      await app.turn("tab-1").chunk("Thinking about it");
      await c.raise(app);
      await expect(c.card(page)).toBeVisible();
      await expect(page.getByRole("tab", { name: /General.*Needs you/ })).toBeVisible();

      await page.getByRole("button", { name: "Stop session" }).click();
      const stop = await app.waitForCall("dev_session_stop");
      expect(stop.args.tabId).toBe("tab-1");
      expect(String(stop.args.transcript)).toContain("Thinking about it");
      await expect(c.card(page)).toBeHidden();
      await expect(page.getByRole("button", { name: "Stop session" })).toHaveCount(0);
      await expect(status(page)).toHaveText("Not started");
      await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
      // dev_session_stop tears the session down; the card is not answered separately.
      for (const cmd of ["respond_permission_request", "respond_plan_request", "respond_question_request"]) {
        expect(await app.calls(cmd), cmd).toHaveLength(0);
      }
      expect(c.respond).toMatch(/^respond_/);
    });
  }
});

test.describe("many tabs and stray events", () => {
  const four = [
    { id: "tab-1", label: "Alpha", tag: "A" },
    { id: "tab-2", label: "Beta", tag: "B" },
    { id: "tab-3", label: "Gamma", tag: "G" },
    { id: "tab-4", label: "Delta", tag: "D" },
  ];
  const textFor = (tag: string, n: number) =>
    Array.from({ length: n }, (_, i) => `${tag}${i}.`).join(" ");

  test("interleaved streams on four tabs land in the right transcripts with per-tab marks", async ({
    app,
    page,
  }) => {
    await app.open({ tabs: four.map((t) => roleTab(t.id, "role_general", t.label)) });
    await startAll(app, page, four);

    // 40 chunks per tab, round-robin, in a few bursts like a busy backend.
    const N = 40;
    for (let start = 0; start < N; start += 10) {
      const batch: [string, unknown][] = [];
      for (let i = start; i < start + 10; i += 1) {
        for (const t of four) batch.push(["acp/session-update", chunkEvent(t.id, `${i === 0 ? "" : " "}${t.tag}${i}.`)]);
      }
      await app.emitMany(batch);
    }
    await expect(log(page)).toContainText(textFor("D", N));
    await expect(log(page)).not.toContainText("A0.");
    for (const t of four.slice(0, 3)) {
      await expect(page.getByRole("tab", { name: new RegExp(`^${t.label}.*Working`) })).toBeVisible();
    }

    await app.nextFrame();
    await app.emitMany([
      ["role_session/prompt-finished", finishedEvent("tab-1", { agentText: textFor("A", N) })],
      ["acp/permission-request", permissionEvent("tab-2", "Run make deploy")],
      ["role_session/prompt-finished", finishedEvent("tab-3", { error: "agent exited (exit status: 2)" })],
      ["role_session/prompt-finished", finishedEvent("tab-4", { agentText: textFor("D", N) })],
    ]);
    await expect(page.getByRole("tab", { name: /^Alpha.*Finished, not viewed yet/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Beta.*Needs you: permission request/ })).toBeVisible();
    await expect(page.getByRole("tab", { name: /^Gamma.*Needs you: stopped with an error/ })).toBeVisible();
    // The watched tab gets no mark.
    await expect(page.getByRole("tab", { name: "Delta", exact: true })).toBeVisible();
    await expect(status(page)).toHaveText("Ready");

    await page.getByRole("tab", { name: /^Alpha/ }).click();
    await expect(page.getByRole("heading", { name: "Alpha", level: 2 })).toBeVisible();
    await expect(log(page)).toContainText(textFor("A", N));
    await expect(log(page)).not.toContainText("B0.");
    await expect(log(page)).not.toContainText("D0.");
    await expect(page.getByRole("tab", { name: "Alpha", exact: true })).toBeVisible();

    await page.getByRole("tab", { name: /^Beta/ }).click();
    await expect(page.getByRole("dialog", { name: "Run make deploy" })).toBeVisible();
    await expect(log(page)).toContainText(textFor("B", N));
    await expect(log(page)).not.toContainText("G0.");

    await page.getByRole("tab", { name: /^Gamma/ }).click();
    await expect(log(page)).toContainText(textFor("G", N));
    await expect(page.getByText("agent exited (exit status: 2)")).toBeVisible();
    await expect(page.getByRole("dialog", { name: "Run make deploy" })).toHaveCount(0);
  });

  /** Two running tabs; closes Beta, then a burst of events for Beta, unknown and empty tab ids. */
  async function strayEventsAfterClose(app: TauriApp, page: Page) {
    await app.open({
      tabs: [roleTab("tab-1", "role_general", "Alpha"), roleTab("tab-2", "role_general", "Beta")],
      responses: {
        get_notification_settings: { enabled: true, system: false, toastWhenFocused: true },
      },
    });
    await startAll(app, page, [
      { id: "tab-1", label: "Alpha" },
      { id: "tab-2", label: "Beta" },
    ]);
    await app.turn("tab-1").chunk("alpha text");

    // Close Beta (running), then let a late event burst for it and for tabs nobody knows arrive.
    await page.getByRole("button", { name: "Stop and close Beta" }).click();
    expect((await app.waitForCall("close_tab")).args).toMatchObject({ tabId: "tab-2" });
    await expect(page.getByRole("tab", { name: /^Beta/ })).toHaveCount(0);
    await expect(page.getByRole("heading", { name: "Alpha", level: 2 })).toBeVisible();
    await expect(log(page)).toContainText("alpha text");

    const events: [string, unknown][] = [];
    for (const id of ["tab-2", "tab-ghost", ""]) {
      events.push(["acp/session-update", chunkEvent(id, `stray for ${id || "nobody"}`)]);
      events.push(["acp/permission-request", permissionEvent(id, `Stray permission ${id}`)]);
      events.push(["acp/question-request", questionEvent(id, `Stray question ${id}?`)]);
      events.push(["role_session/prompt-finished", finishedEvent(id, { error: `stray error ${id}` })]);
    }
    // An event for the live tab but an old session id (a stopped earlier session).
    events.push(["acp/session-update", chunkEvent("tab-1", "stale session text", "sess-old")]);
    await app.emitMany(events);
    await app.nextFrame();
  }

  test("events for unknown, empty and closed tabs are ignored", async ({ app, page }) => {
    await strayEventsAfterClose(app, page);
    await app.turn("tab-1").chunk(" still streaming");
    await expect(log(page)).toContainText("alpha text still streaming");
    await expect(log(page)).not.toContainText("stray");
    await expect(log(page)).not.toContainText("stale session text");
    await expect(page.locator(".session-terminal")).not.toContainText(/stray/i);
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(page.getByRole("tab")).toHaveCount(1);
    await expect(status(page)).toHaveText("Agent working…");
  });

  test("events for closed and unknown tabs raise no notifications", async ({ app, page }) => {
    test.fail(
      true,
      "known bug: the permission/question/plan/prompt-finished listeners call notifyAgent for any " +
        "tabId, so a late event for a closed tab or an unknown tab shows an 'Agent stopped with an " +
        "error' toast (src/StartupForm.tsx:869,892,901,907)",
    );
    await strayEventsAfterClose(app, page);
    await app.turn("tab-1").chunk(" still streaming");
    await expect(log(page)).toContainText("alpha text still streaming");
    await expect(page.locator(".agent-toast")).toHaveCount(0, { timeout: 1000 });
  });

  test("duplicate and out-of-order events render once", async ({ app, page }) => {
    await app.open();
    const turn = await app.start("tab-1");
    // A tool update that overtakes its own tool_call, then the call twice.
    await turn.toolCall({ id: "t2", title: "Read config", kind: "read", status: "completed", input: { file_path: "a.ts" } });
    await turn.toolCall({ id: "t1", title: "List files", kind: "execute", input: { command: "ls" } });
    await turn.toolCall({ id: "t1", title: "List files", kind: "execute", input: { command: "ls" } });
    await turn.toolCall({ id: "t1", title: "List files", kind: "execute", status: "completed", input: { command: "ls" } });
    await turn.chunk("first ");
    await turn.chunk("second");
    await turn.permission("Run ls -la");
    await turn.permission("Run ls -la");

    await expect(page.getByRole("dialog", { name: "Run ls -la" })).toHaveCount(1);
    await expect(log(page).getByText("List files")).toHaveCount(1);
    await expect(log(page).getByText("Read config")).toHaveCount(1);
    await expect(log(page)).toContainText("first second");

    await page.getByRole("dialog", { name: "Run ls -la" }).getByRole("button", { name: "Allow once" }).click();
    await expect(app.calls("respond_permission_request")).resolves.toHaveLength(1);
    await turn.finish();
    // The same finish delivered twice.
    await app.emit("role_session/prompt-finished", finishedEvent("tab-1", { agentText: "first second" }));
    await expect(status(page)).toHaveText("Ready");
    await expect(log(page).getByText("first second", { exact: true })).toHaveCount(1);
    await expect(log(page)).not.toContainText("first secondfirst second");
    await expect(page.getByRole("button", { name: "Activity (2)" })).toBeVisible();
    await expect(page.getByRole("dialog")).toHaveCount(0);
  });
});

test.describe("large transcripts", () => {
  test("2,000 streamed chunks render and the composer stays responsive", async ({ app, page }) => {
    test.setTimeout(45_000);
    await app.open();
    const turn = await app.start("tab-1");
    const total = 2000;
    const started = Date.now();
    for (let start = 0; start < total; start += 250) {
      const batch: [string, unknown][] = [];
      for (let i = start; i < start + 250; i += 1) {
        batch.push(["acp/session-update", chunkEvent("tab-1", i % 50 === 49 ? `w${i}\n\n` : `w${i} `)]);
      }
      await app.emitMany(batch);
    }
    await expect(log(page)).toContainText("w1999", { timeout: 15_000 });
    const streamMs = Date.now() - started;
    expect(streamMs, `2,000 chunks took ${streamMs} ms`).toBeLessThan(10_000);

    await turn.finish();
    await expect(status(page)).toHaveText("Ready");
    const composer = page.getByRole("textbox", { name: "Follow-up message" });
    const typed = Date.now();
    await composer.fill("still snappy");
    await expect(composer).toHaveValue("still snappy");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send", (args) => args.prompt === "still snappy");
    const typeMs = Date.now() - typed;
    expect(typeMs, `typing and sending took ${typeMs} ms`).toBeLessThan(3_000);
    await expect(log(page)).toContainText("w0 w1 w2");
  });

  test("a single huge message renders in full", async ({ app, page }) => {
    test.setTimeout(45_000);
    await app.open();
    const turn = await app.start("tab-1");
    const line = "The quick brown fox jumps over the lazy dog. ".repeat(4);
    const body = Array.from({ length: 1500 }, (_, i) => `${i}: ${line}`).join("\n\n");
    const message = `${body}\n\nEND-OF-HUGE-MESSAGE`;
    expect(message.length).toBeGreaterThan(250_000);
    const started = Date.now();
    await turn.chunk(message);
    await expect(log(page)).toContainText("END-OF-HUGE-MESSAGE", { timeout: 15_000 });
    await turn.finish();
    await expect(status(page)).toHaveText("Ready");
    const ms = Date.now() - started;
    expect(ms, `a ${message.length}-char message took ${ms} ms`).toBeLessThan(10_000);
    await expect(log(page).getByText("END-OF-HUGE-MESSAGE")).toHaveCount(1);
    await expect(page.getByRole("textbox", { name: "Follow-up message" })).toBeEditable();
  });
});

test.describe("notifications", () => {
  test("a background tab needing input gets a Needs-you mark; the OS notification fires only when unwatched", async ({
    app,
    page,
  }) => {
    // tauri-plugin-notification sends through window.Notification; record what it sends.
    await page.addInitScript(() => {
      const sent: { title: string; body?: string }[] = [];
      class FakeNotification {
        static permission = "granted";
        static requestPermission = async () => "granted";
        constructor(title: string, options?: { body?: string }) {
          sent.push({ title, body: options?.body });
        }
      }
      Object.defineProperty(window, "Notification", { value: FakeNotification, configurable: true });
      (window as unknown as { __sentNotifications: typeof sent }).__sentNotifications = sent;
    });
    const sent = () =>
      page.evaluate(() => (window as unknown as { __sentNotifications: { title: string }[] }).__sentNotifications);

    await app.open({
      tabs: [roleTab("tab-1", "role_general", "Alpha"), roleTab("tab-2", "role_general", "Beta")],
      responses: {
        get_notification_settings: { enabled: true, system: true, toastWhenFocused: true },
      },
    });
    await startAll(app, page, [
      { id: "tab-1", label: "Alpha" },
      { id: "tab-2", label: "Beta" },
    ]);
    // Beta is watched. Its permission card shows in place: no toast, no OS notification.
    await app.turn("tab-2").permission("Run tests", 21);
    await expect(page.getByRole("dialog", { name: "Run tests" })).toBeVisible();
    await expect(page.locator(".agent-toast")).toHaveCount(0);

    // Alpha is in the background: a Needs-you mark and an in-app toast, but no OS
    // notification while the window has focus.
    await app.turn("tab-1").question("Which branch should I use?", [{ id: "main", label: "main" }]);
    await expect(page.getByRole("tab", { name: /^Alpha.*Needs you: agent asked a question/ })).toBeVisible();
    const toast = page.getByRole("alert").filter({ hasText: "Alpha has a question" });
    await expect(toast).toBeVisible();
    await expect(toast).toContainText("Which branch should I use?");
    expect(await sent()).toEqual([]);

    // Window loses focus: nothing is watched now, so a finish on Beta reaches the OS.
    await page.getByRole("dialog", { name: "Run tests" }).getByRole("button", { name: "Allow once" }).click();
    await app.waitForCall("respond_permission_request");
    await page.evaluate(() => {
      document.hasFocus = () => false;
      window.dispatchEvent(new Event("blur"));
    });
    await app.turn("tab-2").reply("All 42 tests pass.");
    await expect.poll(sent).toEqual([{ title: "Beta finished", body: "All 42 tests pass." }]);

    // Opening Alpha clears its mark and toast.
    await page.evaluate(() => {
      document.hasFocus = () => true;
      window.dispatchEvent(new Event("focus"));
    });
    await page.getByRole("tab", { name: /^Alpha/ }).click();
    await expect(page.getByRole("dialog", { name: "Question" })).toBeVisible();
    await expect(page.getByRole("alert").filter({ hasText: "Alpha has a question" })).toHaveCount(0);
  });
});

test.describe("rejected commands", () => {
  test("a failing role save shows the error in the editor", async ({ app, page }) => {
    await app.open({
      handlers: {
        save_role: () => {
          throw new Error("could not write roles.json: Permission denied (os error 13)");
        },
      },
    });
    await page.getByRole("button", { name: "Settings" }).click();
    const roles = page.getByRole("region", { name: "Roles" });
    await roles.getByLabel("Name", { exact: true }).fill("Planner v2");
    await roles.getByRole("button", { name: "Save", exact: true }).click();
    await app.waitForCall("save_role");
    await expect(roles.getByText("could not write roles.json: Permission denied (os error 13)")).toBeVisible();
    await expect(roles.getByText("Saved.")).toHaveCount(0);
    // The editor keeps the unsaved edit and stays usable.
    await expect(roles.getByLabel("Name", { exact: true })).toHaveValue("Planner v2");
    await expect(roles.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
  });

  test("a failing transcript save shows a notice in the chat", async ({ app, page }) => {
    await app.open({
      handlers: {
        transcript_save: () => {
          throw new Error("No space left on device (os error 28)");
        },
      },
    });
    const turn = await app.start("tab-1");
    await turn.reply("Some output worth keeping.");
    await expect(
      page.getByText("Could not save the transcript: No space left on device (os error 28)"),
    ).toBeVisible();
    await expect(status(page)).toHaveText("Ready");
    await expect(page.getByRole("textbox", { name: "Follow-up message" })).toBeEditable();
  });

  test("a rejected cancel and a rejected permission answer show their errors", async ({ app, page }) => {
    await app.open({
      handlers: {
        dev_session_cancel: () => {
          throw new Error("no active agent session");
        },
        respond_permission_request: () => {
          throw new Error("permission request 9 is no longer pending");
        },
      },
    });
    const turn = await app.start("tab-1");
    await turn.permission("Write src/main.ts");
    const card = page.getByRole("dialog", { name: "Write src/main.ts" });
    await card.getByRole("button", { name: "Allow once" }).click();
    await app.waitForCall("respond_permission_request");
    await expect(page.getByText("permission request 9 is no longer pending")).toBeVisible();
    // Not answered, so the card stays for another try.
    await expect(card).toBeVisible();

    await page.getByRole("button", { name: "Cancel turn" }).click();
    await app.waitForCall("dev_session_cancel");
    await expect(page.getByText("no active agent session")).toBeVisible();
    await expect(page.getByRole("button", { name: "Cancel turn" })).toBeEnabled();
  });

  test("roles that fail to load leave the app running", async ({ app, page }) => {
    await app.open({
      handlers: {
        list_roles: () => {
          throw new Error("roles.json is corrupt: expected value at line 1 column 1");
        },
      },
    });
    await app.waitForCall("list_roles");
    await expect(page.getByRole("tab", { name: "General", exact: true })).toBeVisible();
    await expect(status(page)).toHaveText("Not started");
    // Terminals do not need roles and stay available.
    await expect(page.getByRole("button", { name: "Terminal", exact: true }).first()).toBeVisible();
  });

  test("roles that fail to load show why", async ({ app, page }) => {
    test.fail(
      true,
      "known bug: a roles load failure is swallowed (catch(() => setRoles([]))), so the role picker " +
        "just disappears with no notice (src/App.tsx:23)",
    );
    await app.open({
      handlers: {
        list_roles: () => {
          throw new Error("roles.json is corrupt: expected value at line 1 column 1");
        },
      },
    });
    await app.waitForCall("list_roles");
    await expect(page.getByText(/roles\.json is corrupt/)).toBeVisible({ timeout: 2000 });
  });
});

test.describe("reload", () => {
  /** Reloads the page; the fake backend keeps its tabs the way the Rust side would. */
  async function reloadKeepingBackend(page: Page) {
    const tabs = (await page.evaluate(() => window.__E2E.state.tabs)) as { id: string; phase: string }[];
    await page.addInitScript((kept) => {
      window.__E2E.state.tabs = kept;
    }, tabs);
    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.__E2E.listenerCount("acp/session-update")))
      .toBeGreaterThan(0);
    return tabs;
  }

  test("a reload mid-turn reattaches the running session", async ({ app, page }) => {
    test.fail(
      true,
      "known bug: after a webview reload a running tab is never reattached. Bootstrap only sets the " +
        'active id for phase "running" (src/StartupForm.tsx:806-813), no command asks the backend for ' +
        "the live session, and later events are dropped because the tab has no session " +
        "(src/liveTabs.ts:67-71). The agent keeps running with no Stop button.",
    );
    await app.open();
    const turn = await app.start("tab-1");
    await turn.chunk("before the reload");
    await expect(log(page)).toContainText("before the reload");

    const tabs = await reloadKeepingBackend(page);
    expect(tabs.find((t) => t.id === "tab-1")?.phase).toBe("running");
    // What does come back: the tab, still marked running.
    await expect(page.getByRole("tab", { name: /^General/ })).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("button", { name: "Stop and close General" })).toBeVisible();

    // What should come back: the live chat, which keeps streaming.
    await expect(page.getByRole("button", { name: "Stop session" })).toBeVisible({ timeout: 2000 });
    await turn.chunk(" and after it");
    await expect(log(page)).toContainText("and after it", { timeout: 2000 });
  });
});
