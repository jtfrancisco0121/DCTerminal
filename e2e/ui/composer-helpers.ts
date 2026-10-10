// Shared setup for the composer-*.spec.ts files (chat composer, scratch pad,
// prompt library). Not a spec itself.
import type { Locator, Page } from "@playwright/test";
import { expect, type OpenOptions, type TauriApp, type Turn } from "./fixtures/tauri";

export const PNG_1X1 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

export type Chat = {
  turn: Turn;
  composer: Locator;
  composerSend: Locator;
  pad: Locator;
  editor: Locator;
  padSend: Locator;
  status: Locator;
  log: Locator;
};

/** Opens the app, starts tab-1 and lets the startup turn finish. */
export async function readyChat(
  app: TauriApp,
  page: Page,
  options: OpenOptions = {},
  tabId = "tab-1",
): Promise<Chat> {
  await app.open(options);
  const turn = await app.start(tabId);
  await turn.reply("Ready.");
  const status = page.locator(".status-bar-status");
  await expect(status).toHaveText("Ready");
  return chatLocators(page, turn);
}

export function chatLocators(page: Page, turn: Turn): Chat {
  const pad = page.getByRole("region", { name: "Scratch pad" });
  return {
    turn,
    composer: page.getByRole("textbox", { name: "Follow-up message" }),
    composerSend: page.locator(".session-terminal-send"),
    pad,
    editor: pad.getByRole("textbox", { name: "Scratch pad editor" }),
    padSend: pad.getByRole("button", { name: /^Send( steps)?$/ }),
    status: page.locator(".status-bar-status"),
    log: page.getByRole("log"),
  };
}

/** Prompts from `dev_session_send`, in order. */
export async function sentPrompts(app: TauriApp): Promise<string[]> {
  return (await app.calls("dev_session_send")).map((c) => String(c.args.prompt));
}

/** Selects `text` (first occurrence) inside a textarea. */
export async function selectText(field: Locator, text: string): Promise<void> {
  await field.evaluate((el, t) => {
    const area = el as HTMLTextAreaElement;
    const start = area.value.indexOf(t);
    if (start < 0) throw new Error(`"${t}" not in the field`);
    area.focus();
    area.setSelectionRange(start, start + t.length);
    area.dispatchEvent(new Event("select", { bubbles: true }));
  }, text);
}

/** Focuses a textarea with the caret after its last character (End is not reliable in WebKit). */
export async function caretToEnd(field: Locator): Promise<void> {
  await field.evaluate((el) => {
    const area = el as HTMLTextAreaElement;
    area.focus();
    area.setSelectionRange(area.value.length, area.value.length);
  });
}

/** Drops files on `target` with an HTML5 drag-and-drop (Tauri's dragDropEnabled is false). */
export async function dropFiles(
  target: Locator,
  files: { name: string; mime: string; base64: string }[],
): Promise<void> {
  await target.evaluate((el, list) => {
    const data = new DataTransfer();
    for (const f of list) {
      const bytes = Uint8Array.from(atob(f.base64), (c) => c.charCodeAt(0));
      data.items.add(new File([bytes], f.name, { type: f.mime }));
    }
    for (const type of ["dragenter", "dragover", "drop"]) {
      el.dispatchEvent(new DragEvent(type, { dataTransfer: data, bubbles: true, cancelable: true }));
    }
  }, files);
}

/**
 * `role_session_start` for a session that starts with no startup turn (as when
 * the startup prompt was already sent and the session is resumed), so no
 * `prompt-finished` has been seen yet. A Cursor tab (or `state.noImages`) gets
 * `supportsImages: false`, as Rust reports for agents without image prompts.
 */
export const startWithoutStartupTurn = (a: any, state: any) => {
  const tab = a.tabId && state.tabs.find((t: any) => t.id === a.tabId);
  if (!tab) throw new Error("e2e: start an existing tab");
  tab.roleId = a.roleId;
  tab.phase = "running";
  tab.startupPromptSent = true;
  tab.acpSessionId = `sess-${tab.id}`;
  state.answers[tab.id] = JSON.parse(JSON.stringify(a.values));
  return {
    errors: [],
    session: {
      sessionId: `sess-${tab.id}`,
      modeId: "agent",
      cwd: tab.cwd,
      model: "default",
      effort: null,
      effortOptions: [],
      supportsImages: tab.provider !== "cursor" && !state.noImages,
    },
    mergedChars: 24,
    injectionStrategy: "send_on_start",
    startupInjected: true,
    injectionInFlight: false,
    tabId: tab.id,
    resumedSession: true,
    skippedStartupInjection: true,
    folderWarning: null,
    loadedViaSessionLoad: false,
    replayMessageCount: 0,
    replayTruncated: false,
    replay: [],
    modelVia: "unchanged",
  };
};

/** A started chat on tab-1 with no turn run yet (see startWithoutStartupTurn). */
export async function quietChat(app: TauriApp, page: Page, options: OpenOptions = {}): Promise<Chat> {
  await app.open({
    ...options,
    handlers: { role_session_start: startWithoutStartupTurn, ...options.handlers },
  });
  return quietStart(app, page, "tab-1");
}

/** Presses Start on the open draft tab (opened with startWithoutStartupTurn). */
export async function quietStart(app: TauriApp, page: Page, tabId: string): Promise<Chat> {
  const before = (await app.calls("role_session_start")).length;
  await page.getByRole("button", { name: "Start", exact: true }).click();
  await expect.poll(async () => (await app.calls("role_session_start")).length).toBe(before + 1);
  const chat = chatLocators(page, app.turn(tabId));
  await expect(chat.composer).toBeVisible();
  await expect(chat.status).toHaveText("Ready");
  return chat;
}

/** Reloads the page and waits for the app's backend listeners again. */
export async function reload(page: Page): Promise<void> {
  await page.reload();
  await expect
    .poll(() => page.evaluate(() => window.__E2E.listenerCount("acp/session-update")))
    .toBeGreaterThan(0);
}

/**
 * In-page prompt library (prompts.json) for `app.open({ handlers })`, shaped like
 * `PromptLibrary` in src/bridge.ts and the rules in src-tauri/src/store/prompt_store.rs.
 * Handlers are serialized, so each one is self-contained.
 */
export const promptLibraryHandlers = {
  prompt_library_get: (_a: any, state: any) => ({
    prompts: state.prompts ?? [],
    recent: state.recent,
    path: "/tmp/dct-e2e/prompts.json",
  }),
  prompt_save: (a: any, state: any) => {
    state.prompts ??= [];
    const name = String(a.name).trim();
    if (!name) throw new Error("Give the prompt a name.");
    if (!String(a.body).trim()) throw new Error("The prompt is empty.");
    const clash = state.prompts.find(
      (p: any) => p.name.toLowerCase() === name.toLowerCase() && p.id !== a.id,
    );
    if (clash) throw new Error(`A prompt named "${clash.name}" already exists.`);
    const at = new Date().toISOString();
    const existing = a.id && state.prompts.find((p: any) => p.id === a.id);
    if (existing) Object.assign(existing, { name, body: a.body, updatedAt: at });
    else {
      state.promptCounter = (state.promptCounter ?? 0) + 1;
      state.prompts.push({
        id: `p${state.promptCounter}`,
        name,
        body: a.body,
        createdAt: at,
        updatedAt: at,
        lastUsedAt: null,
      });
    }
    return { prompts: state.prompts, recent: state.recent, path: "/tmp/dct-e2e/prompts.json" };
  },
  prompt_delete: (a: any, state: any) => {
    state.prompts = (state.prompts ?? []).filter((p: any) => p.id !== a.id);
    return { prompts: state.prompts, recent: state.recent, path: "/tmp/dct-e2e/prompts.json" };
  },
  prompt_mark_used: (a: any, state: any) => {
    const p = (state.prompts ?? []).find((x: any) => x.id === a.id);
    if (p) p.lastUsedAt = new Date().toISOString();
    return { prompts: state.prompts ?? [], recent: state.recent, path: "/tmp/dct-e2e/prompts.json" };
  },
  prompt_clear_recent: (_a: any, state: any) => {
    state.recent = [];
    return { prompts: state.prompts ?? [], recent: [], path: "/tmp/dct-e2e/prompts.json" };
  },
};
