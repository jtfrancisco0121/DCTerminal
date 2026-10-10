import type { Locator, Page } from "@playwright/test";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

// The scratch pad as a terminal input: a terminal tab's pad (Send, Paste to
// terminal, Mod+Shift+., bracketed paste) and a chat tab's "To terminal"
// into its side pane (`<tab>::pane`). scratchpad.spec.ts covers the basic
// one-line Mod+Shift+. into the pane.

const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

const shellTab = () =>
  roleTab("tab-1", "terminal", "Terminal · demo", { kind: "terminal", terminalLaunch: "shell", phase: "terminal" });

/** pty_write payloads for PTY `id`, one entry per call. */
async function writes(app: TauriApp, id: string): Promise<string[]> {
  return (await app.calls("pty_write")).filter((c) => c.args.id === id).map((c) => String(c.args.data));
}

async function openShell(app: TauriApp, page: Page) {
  await app.open({ tabs: [shellTab()] });
  await app.waitForCall("pty_open");
  const pad = page.getByRole("region", { name: "Scratch pad" });
  return { pad, editor: pad.getByRole("textbox", { name: "Scratch pad editor" }) };
}

/** Selects `part` inside a textarea the way a mouse drag would. */
async function selectIn(editor: Locator, part: string) {
  await editor.evaluate((el, text) => {
    const field = el as HTMLTextAreaElement;
    const start = field.value.indexOf(text);
    field.focus();
    field.setSelectionRange(start, start + text.length);
    field.dispatchEvent(new Event("select", { bubbles: true }));
  }, part);
}

test("terminal tab pad: Send writes the multi-line prompt plus one Enter", async ({ app, page }) => {
  const { pad, editor } = await openShell(app, page);
  await editor.fill("echo one\necho two");
  await pad.getByRole("button", { name: "Send", exact: true }).click();

  await expect.poll(() => writes(app, "tab-1")).toEqual(["echo one\necho two\r"]);
  await expect(editor).toHaveValue("");
  const recorded = await app.waitForCall("prompt_record_send");
  expect(recorded.args).toEqual({ text: "echo one\necho two", source: "terminal" });
  expect(await app.calls("dev_session_send")).toHaveLength(0);
});

test("terminal tab pad: Paste to terminal inserts without Enter; Mod+Shift+. submits", async ({ app, page }) => {
  const { pad, editor } = await openShell(app, page);
  await editor.fill("git log --oneline");
  await pad.getByRole("button", { name: "Paste to terminal" }).click();
  await expect.poll(() => writes(app, "tab-1")).toEqual(["git log --oneline"]);
  await expect(editor).toHaveValue("");

  await editor.fill("make test");
  await editor.press("ControlOrMeta+Shift+Period");
  await expect.poll(() => writes(app, "tab-1")).toEqual(["git log --oneline", "make test\r"]);
  await expect(editor).toHaveValue("");
});

test("terminal tab pad: only the selection is sent and the rest stays", async ({ app, page }) => {
  const { pad, editor } = await openShell(app, page);
  await editor.fill("first line\nsecond line\nthird line");
  await selectIn(editor, "second line");
  await pad.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => writes(app, "tab-1")).toEqual(["second line\r"]);
  await expect(editor).toHaveValue(/first line/);
  await expect(editor).toHaveValue(/third line/);
  await expect(editor).not.toHaveValue(/second line/);
});

test("terminal tab pad: bracketed paste once the program turns it on, plain after it turns it off", async ({
  app,
  page,
}) => {
  const { pad, editor } = await openShell(app, page);
  // A TUI (Claude Code, Cursor CLI) enables bracketed paste with CSI ? 2004 h.
  await app.ptyOutput("tab-1", "\x1b[?2004htui-ready> ");
  await expect(page.locator(".terminal-screen .xterm-rows")).toContainText("tui-ready>");
  await editor.fill("Plan:\n1. read\n2. write");
  await pad.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => writes(app, "tab-1")).toEqual([`${PASTE_START}Plan:\n1. read\n2. write${PASTE_END}\r`]);

  await editor.fill("a\nb");
  await pad.getByRole("button", { name: "Paste to terminal" }).click();
  await expect.poll(async () => (await writes(app, "tab-1")).at(-1)).toBe(`${PASTE_START}a\nb${PASTE_END}`);

  await app.ptyOutput("tab-1", "\x1b[?2004lshell-back$ ");
  await expect(page.locator(".terminal-screen .xterm-rows")).toContainText("shell-back$");
  await editor.fill("ls");
  await pad.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(async () => (await writes(app, "tab-1")).at(-1)).toBe("ls\r");
});

test("terminal tab pad: a pad drafted before the TUI enabled bracketed paste still sends bracketed", async ({
  app,
  page,
}) => {
  test.fail(
    true,
    "known bug: the pad's bracketedPaste prop is read once per render " +
      "(src/StartupForm.tsx:4735, terminalBracketedPaste), and PTY output does not re-render the form " +
      "(the 1 s activity sweep only does when the busy set changes, src/StartupForm.tsx:978), so a draft " +
      "typed before the TUI sent CSI ? 2004 h is sent without bracketed paste and each line submits",
  );
  const { pad, editor } = await openShell(app, page);
  // The program is printing (the tab shows as working), so the 1 s activity
  // sweep has nothing new to report and does not re-render the form.
  await app.ptyOutput("tab-1", "Starting Claude Code…\r\n");
  await expect(page.locator(".status-bar-status")).toHaveText("Terminal · working");
  await editor.fill("line one\nline two");
  // The TUI comes up after the draft was written and turns bracketed paste on.
  await app.ptyOutput("tab-1", "\x1b[?2004hClaude Code> ");
  await expect(page.locator(".terminal-screen .xterm-rows")).toContainText("Claude Code>");
  await pad.getByRole("button", { name: "Send", exact: true }).click();
  await expect.poll(() => writes(app, "tab-1")).toEqual([`${PASTE_START}line one\nline two${PASTE_END}\r`]);
});

test("terminal tab: Mod+J moves focus to the pad, Esc returns it to the terminal", async ({ app, page }) => {
  const { editor } = await openShell(app, page);
  const terminal = page.getByRole("textbox", { name: "Terminal input" });
  await expect(terminal).toBeFocused();
  await page.keyboard.press("ControlOrMeta+J");
  await expect(editor).toBeFocused();
  await page.keyboard.type("draft");
  await expect(editor).toHaveValue("draft");
  await page.keyboard.press("Escape");
  await expect(terminal).toBeFocused();
  await page.keyboard.type("x");
  await expect.poll(() => writes(app, "tab-1")).toEqual(["x"]);
  await expect(editor).toHaveValue("draft");
});

/**
 * pty_write calls the PTY accepted. The pane opens on the first send, and the
 * frontend retries writes the backend rejects until it is up, so the raw call
 * log can hold rejected attempts.
 */
async function accepted(app: TauriApp, id: string): Promise<string[]> {
  return app.page.evaluate(
    (ptyId) =>
      ((window.__E2E.state.accepted ?? []) as { id: string; data: string }[])
        .filter((w) => w.id === ptyId)
        .map((w) => w.data),
    id,
  );
}

async function readyChat(app: TauriApp, page: Page) {
  await app.open({
    handlers: {
      pty_write: (args, state) => {
        if (!state.ptys.includes(args.id)) throw new Error(`no pty ${args.id}`);
        (state.accepted ??= []).push({ id: args.id, data: args.data });
        return null;
      },
    },
  });
  const turn = await app.start("tab-1");
  await turn.reply("Ready.");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  const pad = page.getByRole("region", { name: "Scratch pad" });
  return { pad, editor: pad.getByRole("textbox", { name: "Scratch pad editor" }) };
}

test("chat pad To terminal: multi-line text goes to the pane PTY, whose output renders there", async ({
  app,
  page,
}) => {
  const { pad, editor } = await readyChat(app, page);
  await editor.fill("cd src\nls -la");
  await pad.getByRole("button", { name: "To terminal" }).click();

  const opened = await app.waitForCall("pty_open");
  expect(opened.args.input).toMatchObject({ id: "tab-1::pane", launch: "shell", prompt: null });
  await expect.poll(() => accepted(app, "tab-1::pane")).toEqual(["cd src\nls -la\n"]);
  await expect(editor).toHaveValue("");
  expect(await app.calls("dev_session_send")).toHaveLength(0);

  await app.ptyOutput("tab-1::pane", "README.md  src  package.json\r\n");
  await expect(page.locator(".xterm-rows").filter({ hasText: "README.md" })).toBeVisible();

  // A second send reuses the open pane.
  await editor.fill("pwd");
  await editor.press("ControlOrMeta+Shift+Period");
  await expect.poll(() => accepted(app, "tab-1::pane")).toEqual(["cd src\nls -la\n", "pwd\n"]);
  expect(await app.calls("pty_open")).toHaveLength(1);
});

test("chat pad with --- steps: To terminal sends only the selected step", async ({ app, page }) => {
  const { pad, editor } = await readyChat(app, page);
  await editor.fill("npm ci\n---\nnpm test\n---\nnpm run build");
  await expect(pad.getByRole("button", { name: "Send steps" })).toBeVisible();
  await selectIn(editor, "npm test");
  await pad.getByRole("button", { name: "To terminal" }).click();
  await expect.poll(() => accepted(app, "tab-1::pane")).toEqual(["npm test\n"]);
  await expect(editor).toHaveValue(/npm ci/);
  await expect(editor).toHaveValue(/npm run build/);
  await expect(editor).not.toHaveValue(/npm test/);
  const recorded = await app.waitForCall("prompt_record_send");
  expect(recorded.args).toEqual({ text: "npm test", source: "terminal" });
  expect(await app.calls("dev_session_send")).toHaveLength(0);
});
