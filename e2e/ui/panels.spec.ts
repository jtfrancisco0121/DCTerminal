// Side panels: Changes (F4) and the parts of Activity that activity.spec.ts does not cover.
import type { Page } from "@playwright/test";
import type { ActivityEntry, ChangedFile, ChangeSet, FileDiff } from "../../src/bridge";
import { CWD } from "./fixtures/data";
import { expect, roleTab, test, type TauriApp } from "./fixtures/tauri";

const ACCEPTED_KEY = "dct.changes.accepted";

const APP_TS: ChangedFile = {
  path: "src/app.ts",
  cwdPath: "src/app.ts",
  status: "modified",
  oldBlob: "old-app",
  newBlob: "new-app",
  additions: 2,
  deletions: 1,
  binary: false,
};
const LOGO: ChangedFile = {
  path: "assets/logo.png",
  cwdPath: "assets/logo.png",
  status: "added",
  oldBlob: "0000000",
  newBlob: "new-logo",
  additions: null,
  deletions: null,
  binary: true,
};
const README: ChangedFile = {
  path: "README.md",
  cwdPath: "README.md",
  status: "deleted",
  oldBlob: "old-readme",
  newBlob: "0000000",
  additions: 0,
  deletions: 3,
  binary: false,
};

const APP_DIFF = [
  "diff --git a/src/app.ts b/src/app.ts",
  "--- a/src/app.ts",
  "+++ b/src/app.ts",
  "@@ -1,3 +1,4 @@",
  ' import x from "x";',
  "-const a = 1;",
  "+const a = 2;",
  "+const b = 3;",
  " export {};",
  "",
].join("\n");

function changeSet(scope: "turn" | "tab", files: ChangedFile[]): ChangeSet {
  return {
    state: "ok",
    scope,
    repoRoot: CWD,
    baseTree: `base-${scope}`,
    nowTree: "now-1",
    baselineAt: "2026-10-10T09:30:00Z",
    files,
  };
}

type ChangesData = {
  turn: ChangeSet;
  tab: ChangeSet;
  diffs: Record<string, FileDiff>;
};

/** Puts the Changes data on `window` so in-page handlers can read it. */
async function seedChanges(page: Page, data: ChangesData) {
  await page.addInitScript((d) => {
    (window as any).__panelsChanges = d;
  }, data);
}

const changesHandlers = {
  changes_list: (args: any) => (window as any).__panelsChanges[args.scope],
  changes_file_diff: (args: any) => {
    const diff = (window as any).__panelsChanges.diffs[args.path];
    if (!diff) throw new Error(`no diff for ${args.path}`);
    return diff;
  },
};

const defaultData = (): ChangesData => ({
  turn: changeSet("turn", [APP_TS, LOGO]),
  tab: changeSet("tab", [APP_TS, LOGO, README]),
  diffs: {
    "src/app.ts": { path: "src/app.ts", binary: false, text: APP_DIFF, truncated: false },
    "assets/logo.png": { path: "assets/logo.png", binary: true, text: "", truncated: false },
    "README.md": {
      path: "README.md",
      binary: false,
      text: "@@ -1,3 +0,0 @@\n-# Demo\n-\n-Hello\n",
      truncated: false,
    },
  },
});

async function readyChat(app: TauriApp, page: Page) {
  const turn = await app.start("tab-1");
  await turn.reply("Edited the app.");
  await expect(page.locator(".status-bar-status")).toHaveText("Ready");
  return turn;
}

function changesDialog(page: Page) {
  return page.getByRole("dialog", { name: "Changes in General" });
}

test.describe("Changes panel", () => {
  test("the Changes button counts this turn's files once the turn ends", async ({ app, page }) => {
    await seedChanges(page, defaultData());
    await app.open({ handlers: changesHandlers });
    const turn = await app.start("tab-1");
    const button = page.locator(".changes-button");
    await expect(button).toHaveText("Changes");
    expect(await app.calls("changes_list")).toHaveLength(0);

    await turn.reply("Edited the app.");
    // refreshChangeCount asks for the "turn" scope when the prompt finishes.
    const listed = await app.waitForCall("changes_list");
    expect(listed.args).toEqual({ tabId: "tab-1", scope: "turn" });
    await expect(button).toHaveText("Changes (2)");

    // A folder outside git counts as no changes.
    await app.respond("changes_list", { ...changeSet("turn", []), state: "noRepo", baseTree: null, nowTree: null });
    await page.getByRole("textbox", { name: "Follow-up message" }).fill("again");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send");
    await turn.reply("Nothing this time.");
    await expect(button).toHaveText("Changes");
  });

  test("lists the files, shows unified and side-by-side diffs, and remembers the view", async ({
    app,
    page,
  }) => {
    await seedChanges(page, defaultData());
    await app.open({ handlers: changesHandlers });
    await readyChat(app, page);
    await page.getByRole("button", { name: "Changes (2)" }).click();

    const dialog = changesDialog(page);
    await expect(dialog.getByRole("radio", { name: "This turn" })).toBeChecked();
    await expect(dialog.getByText(/^Since .*, the start of the last turn\.$/)).toBeVisible();
    const files = dialog.getByRole("listbox", { name: "Changed files" }).getByRole("option");
    await expect(files).toHaveCount(2);
    await expect(files.nth(0)).toHaveAttribute("aria-selected", "true");
    await expect(files.nth(0)).toContainText("M");
    await expect(files.nth(0)).toContainText("src/app.ts");
    await expect(files.nth(0)).toContainText("+2");
    await expect(files.nth(0)).toContainText("−1");
    await expect(files.nth(1)).toContainText("A");
    await expect(files.nth(1)).toContainText("bin");

    const diffCall = await app.waitForCall("changes_file_diff");
    expect(diffCall.args).toEqual({ tabId: "tab-1", base: "base-turn", now: "now-1", path: "src/app.ts" });

    const table = dialog.getByRole("table", { name: "Diff of src/app.ts" });
    await expect(table).toHaveAttribute("data-view", "unified");
    await expect(table.locator("tr.diff-hunk")).toHaveText("@@ -1,3 +1,4 @@");
    await expect(table.locator("td.diff-del")).toHaveText(["−const a = 1;"]);
    await expect(table.locator("td.diff-add")).toHaveText(["+const a = 2;", "+const b = 3;"]);
    // Old and new line numbers on the removed and added rows.
    const del = table.locator("tr", { has: page.locator("td.diff-del") });
    await expect(del.locator("td.diff-no")).toHaveText(["2", ""]);
    const firstAdd = table.locator("tr", { has: page.locator("td.diff-add") }).first();
    await expect(firstAdd.locator("td.diff-no")).toHaveText(["", "2"]);

    await dialog.getByText("Side by side").click();
    await expect(table).toHaveAttribute("data-view", "split");
    // The removal pairs with the first addition on one row.
    const paired = table.locator("tr", { has: page.locator("td.diff-del") });
    await expect(paired.locator("td.diff-text")).toHaveText(["const a = 1;", "const a = 2;"]);
    const lone = table.locator("tr", { hasText: "const b = 3;" });
    await expect(lone.locator("td.diff-empty")).toHaveCount(1);
    expect(await page.evaluate(() => localStorage.getItem("dcterminal.diffView"))).toBe("split");

    await files.nth(1).click();
    await expect(files.nth(1)).toHaveAttribute("aria-selected", "true");
    await expect(dialog.getByText("Binary file. No text diff.")).toBeVisible();
    await expect(dialog.getByRole("table")).toHaveCount(0);

    await dialog.getByRole("button", { name: "Close changes" }).click();
    await expect(dialog).toBeHidden();
    await page.getByRole("button", { name: "Changes (2)" }).click();
    // The diff view choice survives closing the panel.
    await expect(changesDialog(page).getByRole("radio", { name: "Side by side" })).toBeChecked();
    await page.keyboard.press("Escape");
    await expect(changesDialog(page)).toBeHidden();
  });

  test('"Whole tab" lists everything since the tab\'s first snapshot', async ({ app, page }) => {
    await seedChanges(page, defaultData());
    await app.open({ handlers: changesHandlers });
    await readyChat(app, page);
    await page.getByRole("button", { name: "Changes (2)" }).click();
    const dialog = changesDialog(page);
    const files = dialog.getByRole("listbox", { name: "Changed files" }).getByRole("option");
    await expect(files).toHaveCount(2);

    await dialog.getByText("Whole tab").click();
    await app.waitForCall("changes_list", (args) => args.scope === "tab");
    await expect(files).toHaveCount(3);
    await expect(dialog.getByText(/^Since .*, the first snapshot in this tab\.$/)).toBeVisible();

    await files.filter({ hasText: "README.md" }).click();
    await expect(dialog.getByText("Deleted", { exact: true })).toBeVisible();
    await expect(dialog.getByRole("table", { name: "Diff of README.md" }).locator("td.diff-del")).toHaveCount(3);
    // A deleted file cannot open in the file panel.
    await expect(dialog.getByRole("button", { name: "Open in file panel" })).toBeDisabled();
    const diff = await app.waitForCall("changes_file_diff", (args) => args.path === "README.md");
    expect(diff.args.base).toBe("base-tab");

    await dialog.getByText("This turn").click();
    await expect(files).toHaveCount(2);
  });

  test("empty states: no repository, no snapshot yet (Snapshot now), and no changes", async ({
    app,
    page,
  }) => {
    await app.open({
      responses: {
        changes_list: {
          state: "noBaseline",
          scope: "turn",
          repoRoot: CWD,
          baseTree: null,
          nowTree: null,
          baselineAt: null,
          files: [],
        },
        changes_snapshot: changeSet("turn", []),
      },
    });
    await readyChat(app, page);
    await page.locator(".changes-button").click();
    const dialog = changesDialog(page);
    await expect(dialog.getByText(/^No snapshot yet\./)).toBeVisible();
    await dialog.getByRole("button", { name: "Snapshot now" }).click();
    const snap = await app.waitForCall("changes_snapshot");
    expect(snap.args).toEqual({ tabId: "tab-1" });
    await expect(dialog.getByText(/^No changes since .* \(start of the last turn\)\.$/)).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Revert all…" })).toBeDisabled();

    await app.respond("changes_list", {
      state: "noRepo",
      scope: "turn",
      repoRoot: null,
      baseTree: null,
      nowTree: null,
      baselineAt: null,
      files: [],
    });
    await dialog.getByRole("button", { name: "Refresh" }).click();
    await expect(dialog.getByText(/not in a git repository/)).toBeVisible();

    await app.handle("changes_list", () => {
      throw new Error("git exited with status 128");
    });
    await dialog.getByRole("button", { name: "Refresh" }).click();
    await expect(dialog.getByText("git exited with status 128")).toBeVisible();
  });

  test("Accept marks a file reviewed; the mark survives a reload and resets when the file changes", async ({
    app,
    page,
  }) => {
    await seedChanges(page, defaultData());
    await app.open({ handlers: changesHandlers });
    await readyChat(app, page);
    await page.getByRole("button", { name: "Changes (2)" }).click();
    let dialog = changesDialog(page);
    const files = () => changesDialog(page).getByRole("listbox", { name: "Changed files" }).getByRole("option");
    await expect(files().nth(0)).toHaveAttribute("aria-selected", "true");

    const accept = dialog.getByRole("button", { name: "Accept", exact: true });
    await accept.click();
    await expect(files().nth(0)).toContainText("✓ Accepted");
    await expect(accept).toBeDisabled();
    await expect(files().nth(1)).not.toContainText("Accepted");
    await expect
      .poll(() => page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}"), ACCEPTED_KEY))
      .toEqual({ "tab-1": ["src/app.ts\u0000new-app"] });

    // Revert all leaves accepted files alone.
    let confirmText = "";
    page.once("dialog", (d) => {
      confirmText = d.message();
      void d.dismiss();
    });
    await dialog.getByRole("button", { name: "Revert all…" }).click();
    await expect.poll(() => confirmText).toContain("Revert assets/logo.png to the snapshot?");
    expect(confirmText).toContain("1 accepted file is kept.");
    expect(await app.calls("changes_revert")).toHaveLength(0);

    await page.reload();
    await expect
      .poll(() => page.evaluate(() => window.__E2E?.listenerCount("acp/session-update") ?? 0))
      .toBeGreaterThan(0);
    await readyChat(app, page);
    await page.getByRole("button", { name: "Changes (2)" }).click();
    dialog = changesDialog(page);
    await expect(files().nth(0)).toContainText("✓ Accepted");
    await expect(dialog.getByRole("button", { name: "Accept", exact: true })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close changes" }).click();

    // The agent edits the file again: new content, so it needs review again.
    await page.evaluate(() => {
      const data = (window as any).__panelsChanges;
      data.turn.files[0].newBlob = "newer-app";
    });
    await page.getByRole("button", { name: "Changes (2)" }).click();
    await expect(files().nth(0)).toContainText("src/app.ts");
    await expect(files().nth(0)).not.toContainText("Accepted");
    await expect(changesDialog(page).getByRole("button", { name: "Accept", exact: true })).toBeEnabled();
  });

  test("the accepted store keeps 500 keys per tab and 100 tabs", async ({ app, page }) => {
    // Seed a full store once (not again on reload).
    await page.addInitScript((key) => {
      if (localStorage.getItem(key)) return;
      const store: Record<string, string[]> = {};
      for (let t = 0; t < 100; t += 1) store[`old-tab-${t}`] = [`file-${t}\u0000blob`];
      store["tab-1"] = Array.from({ length: 500 }, (_, i) => `seed-${i}\u0000blob`);
      localStorage.setItem(key, JSON.stringify(store));
    }, ACCEPTED_KEY);
    await seedChanges(page, defaultData());
    await app.open({ handlers: changesHandlers });
    await readyChat(app, page);
    await page.getByRole("button", { name: "Changes (2)" }).click();
    await changesDialog(page).getByRole("button", { name: "Accept", exact: true }).click();
    await expect(changesDialog(page).getByRole("option").first()).toContainText("✓ Accepted");

    const read = () =>
      page.evaluate((k) => JSON.parse(localStorage.getItem(k) ?? "{}") as Record<string, string[]>, ACCEPTED_KEY);
    await expect.poll(async () => (await read())["tab-1"]?.at(-1)).toBe("src/app.ts\u0000new-app");
    const store = await read();
    expect(store["tab-1"]).toHaveLength(500);
    expect(store["tab-1"][0]).toBe("seed-1\u0000blob");
    expect(Object.keys(store)).toHaveLength(100);
    // tab-1 is the most recently used; the least recently used tab went.
    expect(Object.keys(store).at(-1)).toBe("tab-1");
    expect(store["old-tab-0"]).toBeUndefined();
    expect(store["old-tab-1"]).toEqual(["file-1\u0000blob"]);
  });

  test("Revert file asks first, reverts, and is blocked while the agent works", async ({ app, page }) => {
    await seedChanges(page, defaultData());
    await app.open({
      handlers: {
        ...changesHandlers,
        changes_revert: (args: any) => {
          (window as any).__panelsChanges.turn.files.shift();
          return { reverted: args.files.map((f: any) => f.path), skipped: [] };
        },
      },
    });
    const turn = await readyChat(app, page);
    await page.getByRole("button", { name: "Changes (2)" }).click();
    const dialog = changesDialog(page);

    let confirmText = "";
    page.once("dialog", (d) => {
      confirmText = d.message();
      void d.accept();
    });
    await dialog.getByRole("button", { name: "Revert file" }).click();
    await expect(dialog.getByRole("status").filter({ hasText: "Reverted 1 file." })).toBeVisible();
    expect(confirmText).toBe(
      "Revert src/app.ts to the snapshot?\n\nThe current contents of src/app.ts are replaced.",
    );
    const revert = await app.waitForCall("changes_revert");
    expect(revert.args).toEqual({
      tabId: "tab-1",
      base: "base-turn",
      files: [{ path: "src/app.ts", newBlob: "new-app" }],
      confirmed: true,
    });
    await expect(dialog.getByRole("option")).toHaveCount(1);
    await expect(dialog.getByRole("option").first()).toContainText("assets/logo.png");
    await dialog.getByRole("button", { name: "Close changes" }).click();
    // Closing the panel refreshes the count.
    await expect(page.getByRole("button", { name: "Changes (1)" })).toBeVisible();

    // While a turn runs, Revert is off.
    await page.getByRole("textbox", { name: "Follow-up message" }).fill("keep going");
    await page.getByRole("button", { name: "Send", exact: true }).first().click();
    await app.waitForCall("dev_session_send");
    await expect(page.locator(".status-bar-status")).toHaveText("Agent working…");
    await page.getByRole("button", { name: "Changes (1)" }).click();
    await expect(dialog.getByText("The agent is still working in this tab. Revert is off until it finishes.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Revert file" })).toBeDisabled();
    await expect(dialog.getByRole("button", { name: "Revert all…" })).toBeDisabled();
    await dialog.getByRole("button", { name: "Close changes" }).click();
    await turn.reply("Done.");
  });

  test("Open in file panel opens the changed file in the Files panel", async ({ app, page }) => {
    await seedChanges(page, defaultData());
    await app.open({
      handlers: {
        ...changesHandlers,
        files_list: (args: any) => ({
          root: "/Users/e2e/Projects/demo",
          path: args.path,
          entries:
            args.path === ""
              ? [{ name: "src", path: "src", isDir: true, size: 0 }]
              : [{ name: "app.ts", path: "src/app.ts", isDir: false, size: 40 }],
          truncated: false,
        }),
        files_read: (args: any) => ({
          path: args.path,
          absPath: `/Users/e2e/Projects/demo/${args.path}`,
          size: 40,
          mtimeMs: 1,
          kind: "text",
          text: "const a = 2;\nconst b = 3;\n",
          dataBase64: null,
          mime: null,
        }),
      },
    });
    await readyChat(app, page);
    await page.getByRole("button", { name: "Changes (2)" }).click();
    await changesDialog(page).getByRole("button", { name: "Open in file panel" }).click();
    await expect(changesDialog(page)).toBeHidden();

    const panel = page.getByRole("complementary", { name: "Files" });
    await expect(panel).toBeVisible();
    const read = await app.waitForCall("files_read");
    expect(read.args).toEqual({ tabId: "tab-1", path: "src/app.ts" });
    await expect(panel.locator(".file-preview-name")).toHaveText("src/app.ts");
    await expect(panel.locator("pre.file-code")).toContainText("const b = 3;");
    // The folders on the way are expanded and the file is focused.
    await expect(panel.getByRole("treeitem", { name: /src/ }).first()).toHaveAttribute("aria-expanded", "true");
    await expect(panel.locator('[data-path="src/app.ts"]')).toBeFocused();
  });
});

test.describe("Activity panel (beyond activity.spec.ts)", () => {
  const ROWS: ActivityEntry[] = [
    {
      id: "toolu_a",
      tabId: "tab-1",
      time: "2026-10-10T09:00:00Z",
      updatedAt: "2026-10-10T09:00:01Z",
      kind: "shell",
      title: "Deploy",
      summary: "curl -H 'Authorization: Bearer [redacted]' https://api.example.com/deploy",
      decision: "user_allow",
      network: true,
      status: "completed",
    },
    {
      id: "toolu_b",
      tabId: "tab-1",
      time: "2026-10-10T09:01:00Z",
      updatedAt: "2026-10-10T09:01:00Z",
      kind: "delete",
      title: "Remove build",
      summary: "rm -rf build",
      decision: "user_reject",
      network: false,
      status: "failed",
    },
    {
      id: "toolu_c",
      tabId: "tab-1",
      time: "2026-10-10T09:02:00Z",
      updatedAt: "2026-10-10T09:02:00Z",
      kind: "write",
      title: "Write notes",
      summary: "notes.md",
      decision: "cancelled",
      network: false,
      status: null,
    },
    {
      id: "toolu_d",
      tabId: "tab-1",
      time: "2026-10-10T09:03:00Z",
      updatedAt: "2026-10-10T09:03:00Z",
      kind: "read",
      title: "Read config",
      summary: "",
      decision: "none",
      network: false,
      status: "completed",
    },
  ];

  test("shows permission decisions, redacted summaries, the rejected filter, and Clear", async ({
    app,
    page,
  }) => {
    await page.addInitScript((rows) => {
      (window as any).__panelsActivity = rows;
    }, ROWS);
    await app.open({
      handlers: {
        activity_list: () => (window as any).__panelsActivity,
        activity_clear: () => {
          (window as any).__panelsActivity = [];
          return null;
        },
      },
    });
    await readyChat(app, page);
    await page.getByRole("button", { name: "Activity (4)" }).click();
    const panel = page.getByRole("dialog", { name: "Activity in General" });
    const rows = panel.getByRole("table", { name: "Agent activity" }).locator("tbody tr");
    await expect(rows).toHaveCount(4);

    // Newest first.
    await expect(rows.nth(0)).toContainText("no ask");
    // No summary: the title stands in.
    await expect(rows.nth(0).locator("code")).toHaveText("Read config");
    await expect(rows.nth(1)).toContainText("cancelled");
    await expect(rows.nth(2)).toContainText("you rejected");
    await expect(rows.nth(3)).toContainText("you allowed");
    await expect(rows.nth(3).locator(".activity-decision")).toHaveAttribute("title", "Permission: you allowed");
    // The backend's redacted text is shown as-is; the secret never reaches the UI.
    await expect(rows.nth(3).locator("code")).toHaveText(
      "curl -H 'Authorization: Bearer [redacted]' https://api.example.com/deploy",
    );
    await expect(rows.nth(3).getByLabel("network")).toBeVisible();

    await panel.getByRole("button", { name: /^rejected 2/ }).click();
    await expect(rows).toHaveCount(2);
    await expect(rows.nth(0)).toContainText("notes.md");
    await expect(rows.nth(1)).toContainText("rm -rf build");
    await panel.getByRole("button", { name: /^network 1/ }).click();
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("api.example.com");

    // Clear asks first; dismissing keeps the log.
    page.once("dialog", (d) => void d.dismiss());
    await panel.getByRole("button", { name: "Clear…" }).click();
    expect(await app.calls("activity_clear")).toHaveLength(0);
    page.once("dialog", (d) => void d.accept());
    await panel.getByRole("button", { name: "Clear…" }).click();
    const cleared = await app.waitForCall("activity_clear");
    expect(cleared.args).toEqual({ tabId: "tab-1" });
    await expect(panel.getByText(/^No tool calls yet\./)).toBeVisible();
    await expect(panel.getByRole("button", { name: "Clear…" })).toBeDisabled();
    await panel.getByRole("button", { name: "Close activity" }).click();
    await expect(page.getByRole("button", { name: "Activity", exact: true })).toBeVisible();
  });
});

test.describe('"This turn" snapshots for terminal tabs (turnSnapshot.ts)', () => {
  test("a scratch-pad Send snapshots first, never waits long on it, and a burst is one turn", async ({
    app,
    page,
  }) => {
    await app.open({
      tabs: [roleTab("tab-1", "role_general", "Shell", { kind: "terminal", terminalLaunch: "shell", phase: "running" })],
      handlers: {
        // A git snapshot that never finishes: the send goes ahead after the short wait.
        changes_snapshot: () => new Promise(() => {}),
      },
    });
    const pad = page.getByRole("region", { name: "Scratch pad" });
    const editor = pad.getByRole("textbox", { name: "Scratch pad editor" });
    await editor.fill("make build");
    await pad.getByRole("button", { name: "Send", exact: true }).click();

    const snap = await app.waitForCall("changes_snapshot");
    expect(snap.args).toEqual({ tabId: "tab-1" });
    const written = await app.waitForCall("pty_write");
    expect(written.args.id).toBe("tab-1");
    expect(written.args.data).toContain("make build");
    await expect(editor).toHaveValue("");
    const calls = await app.calls();
    expect(calls.findIndex((c) => c.cmd === "changes_snapshot")).toBeLessThan(
      calls.findIndex((c) => c.cmd === "pty_write"),
    );

    // A second Send right away belongs to the same turn: no new snapshot.
    await editor.fill("make test");
    await pad.getByRole("button", { name: "Send", exact: true }).click();
    await expect.poll(async () => (await app.calls("pty_write")).length).toBe(2);
    expect((await app.calls("pty_write"))[1].args.data).toContain("make test");
    expect(await app.calls("changes_snapshot")).toHaveLength(1);
  });
});
