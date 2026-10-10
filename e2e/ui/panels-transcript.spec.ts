// Chat transcript rendering, session cards, find in chat, Search all chats, and resumed sessions.
import type { Page } from "@playwright/test";
import type { HistoryHit, SessionUpdateEvent } from "../../src/bridge";
import type { CursorHistoryEntry } from "../../src/cursorHistory";
import { CWD } from "./fixtures/data";
import { expect, test, type TauriApp } from "./fixtures/tauri";

const log = (page: Page) => page.getByRole("log");
const status = (page: Page) => page.locator(".status-bar-status");

const REPORT = [
  "# Release report",
  "",
  "## Summary",
  "",
  "Everything **passed** with `npm test`.",
  "",
  "- first item",
  "- second item",
  "",
  "1. step one",
  "2. step two",
  "",
  "| Suite | Result |",
  "| --- | --- |",
  "| unit | pass |",
  "| e2e | pass |",
  "",
  "```ts",
  "const answer: number = 42;",
  "```",
  "",
  "<img src=x onerror=\"window.__pwned=1\"> raw HTML stays text",
  "",
].join("\n");

async function started(app: TauriApp) {
  await app.open();
  return app.start("tab-1");
}

test.describe("transcript rendering", () => {
  test("markdown: headings, lists, tables, and code blocks", async ({ app, page }) => {
    const turn = await started(app);
    await turn.reply(REPORT);
    await expect(status(page)).toHaveText("Ready");

    const body = log(page).locator(".session-agent-body").last();
    await expect(body.getByRole("heading", { level: 1, name: "Release report" })).toBeVisible();
    await expect(body.getByRole("heading", { level: 2, name: "Summary" })).toBeVisible();
    await expect(body.locator("strong")).toHaveText("passed");
    await expect(body.locator("p code")).toHaveText("npm test");
    await expect(body.locator("ul > li")).toHaveText(["first item", "second item"]);
    await expect(body.locator("ol > li")).toHaveText(["step one", "step two"]);

    const table = body.locator(".session-markdown-table-wrap").getByRole("table");
    await expect(table.getByRole("columnheader")).toHaveText(["Suite", "Result"]);
    await expect(table.getByRole("row")).toHaveCount(3);
    await expect(table.getByRole("row").nth(2)).toHaveText(/e2e\s*pass/);

    const code = body.locator("pre > code");
    await expect(code).toHaveText("const answer: number = 42;");
    await expect(code).toHaveClass(/language-ts/);

    // Agent HTML is not rendered.
    await expect(body.locator("img")).toHaveCount(0);
    expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
    await expect(body).toContainText("raw HTML stays text");
  });

  // Requested coverage: code blocks with a copy button. The chat renders plain <pre><code>
  // (SessionTerminal markdownComponents only overrides `table`), so there is nothing to click.
  test("code blocks have no copy button (feature not built)", async ({ app, page }) => {
    const turn = await started(app);
    await turn.reply("```sh\nnpm run build\n```\n");
    const pre = log(page).locator("pre").last();
    await expect(pre).toHaveText("npm run build");
    await expect(pre.locator("xpath=..").getByRole("button")).toHaveCount(0);
  });

  test("long lines wrap; only code blocks scroll sideways", async ({ app, page }) => {
    const turn = await started(app);
    const word = "x".repeat(600);
    const prose = Array.from({ length: 120 }, (_, i) => `word${i}`).join(" ");
    const longCode = `const s = "${"y".repeat(800)}";`;
    // One chunk: a long reply split into many small chunks only slows the test down.
    await turn.chunk(`${prose}\n\n${word}\n\n\`\`\`\n${longCode}\n\`\`\`\n`);
    await turn.finish();
    await expect(status(page)).toHaveText("Ready");

    const screen = log(page);
    await expect(screen).toContainText("word119");
    const sizes = await screen.evaluate((el) => {
      const body = el.querySelector(".session-agent-body") as HTMLElement;
      const paragraphs = Array.from(body.querySelectorAll("p")) as HTMLElement[];
      const pre = body.querySelector("pre") as HTMLElement;
      return {
        log: [el.scrollWidth, el.clientWidth],
        paragraphs: paragraphs.map((p) => [p.scrollWidth, p.clientWidth, p.getBoundingClientRect().height]),
        pre: [pre.scrollWidth, pre.clientWidth],
      };
    });
    // The chat itself never scrolls sideways.
    expect(sizes.log[0]).toBeLessThanOrEqual(sizes.log[1] + 1);
    for (const [scroll, client, height] of sizes.paragraphs) {
      expect(scroll).toBeLessThanOrEqual(client + 1);
      // Wrapped onto several lines.
      expect(height).toBeGreaterThan(40);
    }
    // A long code line scrolls inside its own block.
    expect(sizes.pre[0]).toBeGreaterThan(sizes.pre[1]);
  });

  test("thoughts are collapsed until opened", async ({ app, page }) => {
    const turn = await started(app);
    await turn.thought("Considering which files ");
    await turn.thought("to touch first.");
    await turn.reply("Plan ready.");
    const thought = log(page).locator("details.session-stream-thought");
    await expect(thought).toHaveCount(1);
    await expect(thought.locator("summary")).toHaveText("Reasoning (collapsed)");
    await expect(thought.locator("pre")).toBeHidden();
    await thought.locator("summary").click();
    await expect(thought.locator("pre")).toBeVisible();
    await expect(thought.locator("pre")).toHaveText("Considering which files to touch first.");
  });

  test("tool calls: one line per call whose status follows the updates", async ({ app, page }) => {
    const turn = await started(app);
    const tools = log(page).locator("[data-segment-id] > .session-stream-tool");
    const cards = page.locator(".session-cards");

    await turn.toolCall({ id: "t1", title: "Run tests", kind: "execute", input: { command: "npm test" } });
    await expect(tools).toHaveCount(1);
    await expect(tools.first().locator(".session-tool-label")).toHaveText("Run tests");
    await expect(tools.first().locator(".session-tool-status")).toHaveText("pending");
    // Active tools also show in the Tool progress card.
    await expect(cards.getByRole("heading", { name: "Tool progress" })).toBeVisible();
    await expect(cards).toContainText("Run tests");

    await turn.toolCall({ id: "t1", title: "Run tests", kind: "execute", status: "in_progress" });
    await expect(tools.first().locator(".session-tool-status")).toHaveText("running");
    await turn.toolCall({ id: "t2", title: "Fetch docs", kind: "fetch", status: "in_progress" });
    await turn.toolCall({ id: "t1", title: "Run tests", kind: "execute", status: "completed" });
    await turn.toolCall({ id: "t3", title: "Delete tmp", kind: "delete", status: "failed" });
    await expect(tools).toHaveCount(3);
    await expect(tools.locator(".session-tool-status")).toHaveText(["done", "running", "failed"]);
    await expect(tools.nth(2)).toHaveClass(/session-stream-tool-failed/);

    // A finished turn completes the tools still in flight; the card keeps the last calls.
    await turn.reply("All done.");
    await expect(tools.locator(".session-tool-status")).toHaveText(["done", "done", "failed"]);
    await expect(cards.locator(".session-card", { hasText: "Tool progress" }).locator("li .hint")).toHaveText([
      "completed",
      "completed",
      "failed",
    ]);
  });

  test("a failed turn marks tools still running as cancelled", async ({ app, page }) => {
    const turn = await started(app);
    await turn.toolCall({ id: "t1", title: "Long build", kind: "execute", status: "in_progress" });
    const tool = log(page).locator("[data-segment-id] > .session-stream-tool");
    await expect(tool.locator(".session-tool-status")).toHaveText("running");
    await turn.fail("agent crashed");
    await expect(tool.locator(".session-tool-status")).toHaveText("cancelled");
  });

  test("plan entries and to-dos show as session cards", async ({ app, page }) => {
    const turn = await started(app);
    const cards = page.locator(".session-cards");
    await turn.update(
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the code", status: "completed", priority: "high" },
          { content: "Write the fix", status: "in_progress", priority: "high" },
          { content: "Add a test", status: "pending", priority: "medium" },
        ],
      },
      null,
    );
    const plan = cards.locator(".session-card", { has: page.getByRole("heading", { name: "Plan" }) });
    await expect(plan.locator("li")).toHaveCount(3);
    await expect(plan.locator("li").nth(1)).toContainText("Write the fix");
    await expect(plan.locator("li").nth(1).locator(".hint")).toHaveText("in_progress");
    await expect(plan.locator("li").nth(1).locator(".status-dot")).toHaveClass(/status-dot-in_progress/);

    // A later plan update replaces the list.
    await turn.update(
      {
        sessionUpdate: "plan",
        entries: [
          { content: "Read the code", status: "completed" },
          { content: "Write the fix", status: "completed" },
          { content: "Add a test", status: "in_progress" },
        ],
      },
      null,
    );
    await expect(plan.locator("li .hint")).toHaveText(["completed", "completed", "in_progress"]);

    await turn.update(
      {
        sessionUpdate: "todo_update",
        todos: [
          { id: "a", content: "Ship it", status: "pending" },
          { id: "b", content: "Tell the team", status: "completed" },
        ],
      },
      null,
    );
    const todos = cards.locator(".session-card", { has: page.getByRole("heading", { name: "To-dos" }) });
    await expect(todos.locator("li")).toHaveCount(2);
    await expect(todos.locator("li").first()).toContainText("Ship it");
    await expect(todos.locator("li").last().locator(".hint")).toHaveText("completed");
    // Card updates are not chat messages.
    await expect(log(page)).not.toContainText("Write the fix");
    await turn.reply("Working on it.");
  });

  // tauri-plugin-opener 2.x (src-tauri/src/lib.rs `.plugin(tauri_plugin_opener::init())`) only opens
  // links in the browser when they have target="_blank" (or Ctrl/Shift-click). Markdown links in
  // the chat render as plain <a href> (no `a` renderer in SessionTerminal markdownComponents),
  // so a click navigates the app's own webview away from DCTerminal.
  test("a link in the chat opens in the system browser", async ({ app, page }) => {
    // Same click hook the opener plugin injects into the real webview (init-iife.js, v2.7.0).
    await page.addInitScript(() => {
      window.addEventListener("click", (e) => {
        if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.altKey) return;
        const a = e.composedPath().find((n) => n instanceof Node && n.nodeName.toUpperCase() === "A") as
          | HTMLAnchorElement
          | undefined;
        if (!a || !a.href || (a.target !== "_blank" && !e.ctrlKey && !e.shiftKey)) return;
        const url = new URL(a.href);
        if (["http:", "https:", "mailto:", "tel:"].every((p) => url.protocol !== p)) return;
        e.preventDefault();
        void (window as any).__TAURI_INTERNALS__.invoke("plugin:opener|open_url", { url: url.toString() });
      });
    });
    await page.route("https://docs.example.com/**", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>external</title>left the app" }),
    );
    const turn = await started(app);
    await turn.reply("See [the docs](https://docs.example.com/guide) for details.");
    const appUrl = page.url();
    await log(page).getByRole("link", { name: "the docs" }).click();
    await expect(page).toHaveURL(appUrl, { timeout: 2000 });
    const opened = await app.waitForCall("plugin:opener|open_url");
    expect(opened.args.url).toBe("https://docs.example.com/guide");
  });
});

test.describe("find in chat", () => {
  async function chatWithApples(app: TauriApp, page: Page) {
    const turn = await started(app);
    await turn.reply("An apple a day.");
    await page.getByRole("textbox", { name: "Follow-up message" }).fill("More about apple pie?");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send");
    await turn.reply("Apple pie needs apples and cinnamon.");
    await expect(status(page)).toHaveText("Ready");
    return turn;
  }

  test("Mod+F opens the find bar; Enter and Shift+Enter step through matches; Esc closes", async ({
    app,
    page,
  }) => {
    await chatWithApples(app, page);
    const composer = page.getByRole("textbox", { name: "Follow-up message" });
    await composer.press("ControlOrMeta+f");
    const find = page.getByRole("searchbox", { name: "Find in chat" });
    await expect(find).toBeFocused();
    const count = page.locator(".chat-find .search-status");
    await expect(count).toHaveText("");

    await find.fill("apple");
    // "apple" in the first reply, "apple" in the question, "Apple" and "apples" in the second reply.
    await expect(count).toHaveText("1 of 4");
    const current = log(page).locator(".session-find-current");
    await expect(current).toHaveCount(1);
    await expect(current).toContainText("An apple a day.");

    await find.press("Enter");
    await expect(count).toHaveText("2 of 4");
    await expect(current).toContainText("More about apple pie?");
    await find.press("Enter");
    await expect(count).toHaveText("3 of 4");
    await expect(current).toContainText("Apple pie needs apples");
    await find.press("Shift+Enter");
    await expect(count).toHaveText("2 of 4");
    await page.getByRole("button", { name: "Previous match" }).click();
    await page.getByRole("button", { name: "Previous match" }).click();
    // Wraps around.
    await expect(count).toHaveText("4 of 4");

    await find.fill("banana");
    await expect(count).toHaveText("No results");
    await expect(page.getByRole("button", { name: "Next match" })).toBeDisabled();
    await expect(current).toHaveCount(0);

    await find.press("Escape");
    await expect(find).toBeHidden();
    await expect(composer).toBeFocused();
  });

  test("Search all chats lists live and saved hits, previews a saved transcript, and jumps to a live hit", async ({
    app,
    page,
  }) => {
    const savedHits: HistoryHit[] = [
      {
        source: "archived",
        tabId: "old-tab",
        label: "Old research",
        cwd: CWD,
        updatedAt: "2026-09-01T12:00:00Z",
        occurrence: 1,
        totalInSource: 2,
        before: "we compared ",
        matched: "apple",
        after: " and pear",
      },
      {
        // The open tab's saved copy loses to its live messages.
        source: "open",
        tabId: "tab-1",
        label: "General",
        cwd: CWD,
        updatedAt: null,
        occurrence: 0,
        totalInSource: 1,
        before: "",
        matched: "apple",
        after: "",
      },
    ];
    await page.addInitScript((hits) => {
      (window as any).__panelsHits = hits;
    }, savedHits);
    await app.open({
      handlers: {
        history_search: () => (window as any).__panelsHits,
        transcript_load: (args: any) => ({
          text:
            args.tabId === "old-tab"
              ? "You › first apple note\nAgent › we compared apple and pear\nAgent › done"
              : "",
          cwd: "/Users/e2e/Projects/demo",
          readOnly: true,
          recoveredFromCorrupt: false,
        }),
      },
    });
    const turn = await app.start("tab-1");
    await turn.reply("An apple a day.");
    await page.getByRole("textbox", { name: "Follow-up message" }).fill("More about apple pie?");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send");
    await turn.reply("Apple pie needs cinnamon.");
    await expect(status(page)).toHaveText("Ready");

    await page.getByRole("textbox", { name: "Follow-up message" }).press("ControlOrMeta+f");
    const find = page.getByRole("searchbox", { name: "Find in chat" });
    await find.fill("apple");
    await page.getByRole("button", { name: "Search all chats" }).click();

    const dialog = page.getByRole("dialog", { name: "Search chats" });
    const input = dialog.getByRole("searchbox", { name: "Search chats" });
    await expect(input).toHaveValue("apple");
    const search = await app.waitForCall("history_search");
    expect(search.args).toEqual({ query: "apple" });
    const results = dialog.getByRole("listbox", { name: "Search results" }).getByRole("option");
    // Three live hits from the open chat, then the archived one (the open tab's saved copy is dropped).
    await expect(results).toHaveCount(4);
    await expect(dialog.locator(".chat-search-status")).toHaveText("4 matches");
    await expect(results.nth(0)).toContainText("Open chat");
    await expect(results.nth(3)).toContainText("Saved transcript");
    await expect(results.nth(3)).toContainText("Old research");
    await expect(results.nth(3).locator("mark")).toHaveText("apple");

    // An archived transcript opens as a preview on its second match.
    await results.nth(3).click();
    const preview = dialog.getByLabel("Transcript preview");
    await expect(preview).toBeVisible();
    expect((await app.waitForCall("transcript_load")).args).toEqual({ tabId: "old-tab" });
    await expect(preview.locator("mark")).toHaveCount(2);
    await expect(preview.locator("mark.search-hit-current")).toHaveCount(1);
    await expect(preview.locator("mark").nth(1)).toHaveClass(/search-hit-current/);
    await dialog.getByRole("button", { name: "Close preview" }).click();
    await expect(preview).toBeHidden();

    // Hover picks a hit; then the keyboard moves down to the question and Enter jumps there.
    await results.nth(0).hover();
    await expect(results.nth(0)).toHaveAttribute("aria-selected", "true");
    await input.press("ArrowDown");
    await expect(results.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(results.nth(1)).toContainText("More about apple pie?");
    await input.press("Enter");
    await expect(dialog).toBeHidden();
    await expect(find).toHaveValue("apple");
    await expect(page.locator(".chat-find .search-status")).toHaveText("2 of 3");
    await expect(log(page).locator(".session-find-current")).toContainText("More about apple pie?");
  });

  test("Search all chats with no matches anywhere", async ({ app, page }) => {
    await app.open({ responses: { history_search: [] } });
    const turn = await app.start("tab-1");
    await turn.reply("Nothing relevant.");
    await page.getByRole("textbox", { name: "Follow-up message" }).press("ControlOrMeta+Shift+f");
    const dialog = page.getByRole("dialog", { name: "Search chats" });
    const input = dialog.getByRole("searchbox", { name: "Search chats" });
    await expect(input).toBeFocused();
    await expect(dialog.locator(".chat-search-status")).toHaveText(
      "Type to search. Enter opens the chat at the match.",
    );
    await input.fill("zebra");
    await app.waitForCall("history_search", (args) => args.query === "zebra");
    await expect(dialog.locator(".chat-search-status")).toHaveText("No matches.");
    await input.press("Escape");
    await expect(dialog).toBeHidden();
  });
});

test.describe("resumed session", () => {
  const ENTRY: CursorHistoryEntry = {
    id: "claude-sess-77",
    source: "claude",
    cwd: CWD,
    title: "Fix the login bug",
    updatedAt: "2026-10-09T15:00:00Z",
    roleName: "General",
    userText: "Fix the login bug",
  };

  function replayEvent(tabId: string, update: Record<string, unknown>, textDelta: string | null): SessionUpdateEvent {
    return {
      tabId,
      sessionId: ENTRY.id,
      kind: String(update.sessionUpdate),
      textDelta,
      rawJson: JSON.stringify({ sessionId: ENTRY.id, update }),
    };
  }

  test("Resume from the folder's history replays the earlier transcript", async ({ app, page }) => {
    const replay = [
      replayEvent("tab-2", { sessionUpdate: "user_message_chunk", content: { type: "text", text: "Fix the login bug" } }, "Fix the login bug"),
      replayEvent(
        "tab-2",
        {
          sessionUpdate: "tool_call_update",
          toolCallId: "old-1",
          title: "Read src/login.ts",
          kind: "read",
          status: "completed",
        },
        "Read src/login.ts (completed)",
      ),
      replayEvent(
        "tab-2",
        { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "## Cause\n\nThe token **expired**." } },
        "## Cause\n\nThe token **expired**.",
      ),
    ];
    await page.addInitScript(
      (d) => {
        (window as any).__panelsResume = d;
      },
      { entry: ENTRY, replay },
    );
    await app.open({
      handlers: {
        list_claude_history: () => ({
          entries: [(window as any).__panelsResume.entry],
          configDir: "/Users/e2e/.claude",
          configDisplay: "~/.claude",
          exists: true,
        }),
        role_session_start: (args: any, state: any) => {
          const tab = state.tabs.find((t: any) => t.id === args.tabId);
          tab.phase = "running";
          tab.startupPromptSent = true;
          tab.acpSessionId = args.resumeSessionId;
          return {
            errors: [],
            session: {
              sessionId: args.resumeSessionId,
              modeId: "default",
              cwd: tab.cwd,
              model: "default",
              effort: null,
              effortOptions: [],
              supportsImages: true,
            },
            mergedChars: 0,
            injectionStrategy: "send_on_start",
            startupInjected: true,
            injectionInFlight: false,
            tabId: tab.id,
            resumedSession: true,
            skippedStartupInjection: true,
            folderWarning: null,
            loadedViaSessionLoad: true,
            replayMessageCount: 2,
            replayTruncated: true,
            replay: (window as any).__panelsResume.replay,
            modelVia: "unchanged",
          };
        },
      },
    });

    const history = page.locator(".start-history");
    await expect(history.locator(".history-title")).toHaveText("General · Fix the login bug");
    await history.getByRole("button", { name: "Resume" }).click();

    const draft = await app.waitForCall("new_draft_tab");
    expect(draft.args).toMatchObject({ cwd: CWD });
    const start = await app.waitForCall("role_session_start");
    expect(start.args).toMatchObject({ tabId: "tab-2", resumeSessionId: "claude-sess-77" });

    const screen = log(page);
    await expect(screen.locator(".session-user-body")).toHaveText("Fix the login bug");
    await expect(screen.locator(".session-tool-label")).toHaveText("Read src/login.ts");
    await expect(screen.locator(".session-tool-status")).toHaveText("done");
    await expect(screen.getByRole("heading", { level: 2, name: "Cause" })).toBeVisible();
    await expect(screen.locator("strong")).toHaveText("expired");
    await expect(screen).toContainText("The CLI replayed more history than this tab kept.");
    // Resuming does not send the startup prompt again or leave a "connecting" line.
    await expect(screen).not.toContainText("Connecting to agent");
    await expect(screen).not.toContainText("Continuing this session");
    await expect(status(page)).toHaveText("Ready");
    expect(await app.calls("dev_session_send")).toHaveLength(0);

    // The replayed transcript is searchable like a live one.
    await page.getByRole("textbox", { name: "Follow-up message" }).press("ControlOrMeta+f");
    await page.getByRole("searchbox", { name: "Find in chat" }).fill("token");
    await expect(page.locator(".chat-find .search-status")).toHaveText("1 of 1");
  });
});
