# End-to-end tests

Two suites live here.

- `e2e/ui/`: Playwright. The real React frontend runs on Vite with the Tauri
  IPC layer faked in the page. Fast (about 15 s for both browsers), needs no
  Rust build, no agent CLI, and touches no app data. Use this for UI flows.
- `e2e/specs/`: WebdriverIO against the built app and the fake ACP agent
  (`npm run e2e`). Tauri WebDriver does not run on macOS.

## Run the UI suite

```sh
npx playwright install webkit chromium   # once
npm run e2e:ui                            # type-check e2e/ui, then run every spec
npx playwright test handoff --project=webkit --headed
E2E_SLOWMO=350 npx playwright test --project=webkit --headed --workers=1   # watch it, slowed down
npx playwright test --ui                  # step through each test; press ▶ to run
npx playwright test -g "slash menu" --debug
```

Playwright starts its own Vite (`e2e/ui/vite.config.ts`, port 1430, HMR off),
so a running `npm run dev` on 1420 is never reused. Failures leave a trace and
a screenshot in `e2e/artifacts/playwright/`
(`npx playwright show-trace <trace.zip>`).

Projects: `webkit` (closest to WKWebView) and `chromium`.

## How the fake backend works

`fixtures/mock.ts` is installed with `page.addInitScript` before any app code.
It defines `window.__TAURI_INTERNALS__` and `__TAURI_EVENT_PLUGIN_INTERNALS__`
the way `@tauri-apps/api` 2.x expects:

- `invoke(cmd, args)` records the call and answers from a handler table that
  keeps a little state (tabs, roles, layout, hand-offs, recent sends, staged
  images, activity rows). Unknown commands resolve `null`; pass
  `strict: true` to `app.open` to make them reject instead.
- `plugin:event|listen` stores `{event, handler}` where `handler` is the id from
  `transformCallback`. `emit(event, payload)` calls those callbacks with
  `{event, id, payload}`, like a Rust `app.emit`.
- Roles come from `seed/roles.seed.json`, the same seed the app ships.

## Script a turn

```ts
import { expect, roleTab, test } from "./fixtures/tauri";

test("my flow", async ({ app, page }) => {
  await app.open({ tabs: [roleTab("tab-1", "role_general", "General")] });
  const turn = await app.start("tab-1");        // presses Start; the startup turn is in flight
  await turn.chunk("Hello ");                   // acp/session-update, agent_message_chunk
  await turn.toolCall({ id: "t1", title: "List files", kind: "execute", input: { command: "ls" } });
  await turn.plan("## Plan\n1. ...");           // acp/plan-request (Claude ExitPlanMode)
  await turn.question("Which?", [{ id: "a", label: "A" }]);
  await turn.permission("Run rm -rf build");
  await turn.finish();                          // role_session/prompt-finished, end_turn
  await turn.reply("Short answer.");            // chunks + finish in one call
  await turn.burst(async (t) => {               // several events inside one frame
    await t.chunk("OK");
    await t.finish();
  });
  await app.emit("acp/session-update", payload); // anything else, raw
});
```

Payload shapes match `src/bridge.ts` (`SessionUpdateEvent`, `PlanRequestEvent`,
...) and the Rust emit sites in `src-tauri/src/commands/`. The session id of a
started tab is `sess-<tabId>`.

## Assert on backend calls

```ts
const send = await app.waitForCall("dev_session_send");          // newest matching call
expect(send.args).toEqual({ prompt: "hi", tabId: "tab-1", attachments: null });
await app.waitForCall("set_layout", (args) => args.layout.splitMode === "grid");
expect(await app.calls("dev_session_send")).toHaveLength(0);
```

## Change what the backend returns

```ts
await app.open({
  responses: { activity_list: [] },                        // fixed value
  handlers: { get_role: (args, state) => state.roles[0] },  // runs in the page
  answers: { "tab-1": { title: "Effort controls" } },      // saved form values
  roles: (roles) => roles.filter((r) => r.id !== "role_developer"),
});
await app.respond("list_models", { models: [], source: "fallback", fetchedAtMs: null, error: null });
```

Handlers are serialized into the page, so they can only use `args` and
`state` (see `mock.ts` for the state shape), not variables from the test file.

## Add a spec

1. Create `e2e/ui/<area>.spec.ts` and import `test`, `expect` from
   `./fixtures/tauri`.
2. Prefer role/label locators (`getByRole`, `getByLabel`) and web-first
   assertions. No `waitForTimeout`.
3. If the flow needs a command the mock does not know, add a default handler
   in `mock.ts` shaped like the bridge type, or override it in the test.
4. The fixture fails a test on any uncaught page error.

Known bugs are kept as `test.fail(...)` tests with a comment, so a fix shows up
as "expected to fail, but passed".
