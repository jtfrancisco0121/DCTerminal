/**
 * Eagle-Eye 1: Planner → Plan Reviewer → Implementer → PR Reviewer, the
 * review verdicts, verdict routing and loop-backs, and the chain overview tab
 * (handoff/chains.ts, handoff/routing.ts, handoff/verdict.ts,
 * components/PipelineOverview.tsx).
 *
 * handoff.spec.ts covers the single Planner → Plan Reviewer step during plan
 * approval; this file follows a chain end to end with each turn finished.
 */
import type { Page } from "@playwright/test";
import type { ChangeSet, PipelineRun, RepoInfo } from "../../src/bridge";
import type { ChainRef } from "../../src/handoff/chains";
import { CWD } from "./fixtures/data";
import { expect, roleTab, test, type TauriApp, type Turn } from "./fixtures/tauri";

const TITLE = "Effort controls";
const REQUEST = "Let users pick reasoning effort";
const EXPECTED = "An effort picker in the chat header";
const CURRENT = "Effort is fixed per model";
/**
 * What every reviewer receives as the original request. Current Behavior is
 * answered but hidden for a Feature, so it does not travel.
 */
const ORIGINAL = `Title: ${TITLE}\n\nTask type: Feature\n\nRequest:\n${REQUEST}\n\nExpected behavior:\n${EXPECTED}`;
/** The Implementer's description: the request as asked; Title and Task Type have their own fields. */
const DESCRIPTION = `${REQUEST}\n\nExpected behavior:\n${EXPECTED}`;

const PLAN = [
  "### Effort picker",
  "1. Add an effort picker to the chat header",
  "2. Send it with session/set_config_option",
].join("\n");

const REVIEWED_PLAN = [
  "### Effort picker",
  "1. Add an effort picker next to the model picker",
  "2. Send it with session/set_config_option",
  "3. Hide it when the agent reports no effort options",
].join("\n");

const REVIEW_NOTES = "Step 3 was missing: some models have no effort levels.";

const planReview = (verdict: string) =>
  [
    "## Verdict",
    verdict,
    "",
    "## Reviewed plan",
    REVIEWED_PLAN,
    "",
    "## Review notes",
    REVIEW_NOTES,
  ].join("\n");

const IMPLEMENTATION =
  "Implemented the effort picker and opened https://github.com/acme/demo/pull/42 for review.";

const PR_APPROVED = "## Verdict\nAPPROVED\n\nNo blocking findings. The picker hides correctly.";
const PR_CHANGES = [
  "## Findings",
  "- src/EffortPicker.tsx: the picker stays visible while a turn is running.",
  "- No test covers the hidden state.",
  "",
  "## Verdict",
  "REQUEST CHANGES",
].join("\n");

const CHANGES: ChangeSet = {
  state: "ok",
  scope: "tab",
  repoRoot: CWD,
  baseTree: "tree-base",
  nowTree: "tree-now",
  baselineAt: "2026-10-10T09:00:00Z",
  files: [
    {
      path: "src/EffortPicker.tsx",
      cwdPath: "src/EffortPicker.tsx",
      status: "added",
      oldBlob: "",
      newBlob: "blob-1",
      additions: 48,
      deletions: 0,
      binary: false,
    },
    {
      path: "src/bridge.ts",
      cwdPath: "src/bridge.ts",
      status: "modified",
      oldBlob: "blob-2",
      newBlob: "blob-3",
      additions: 6,
      deletions: 1,
      binary: false,
    },
  ],
};

const REPO: RepoInfo = {
  mainRoot: CWD,
  currentBranch: "feat/effort-picker",
  branches: ["main", "feat/effort-picker"],
  checkedOut: ["main"],
  worktreesDir: `${CWD}.worktrees`,
};

const CHAIN_ID = /^ee_\d+$/;

// Loop-backs (handoff/routing.ts loopBackMessage): the follow-up a reviewer sends back.
const PLANNER_ASK = "Revise the plan to address these findings, then reply with the full revised plan.";
const IMPLEMENTER_ASK = "Address these findings, then summarize what changed.";
const followUp = (from: string, round: number, findings: string, ask: string) =>
  `Review findings from the ${from} (round ${round}):\n\n${findings.trim()}\n\n${ask}`;

const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

/** The tab button; its tooltip carries the chain label. */
const tabButton = (page: Page, name: string) => page.getByRole("tab", { name, exact: true });

/** Chain label in the chat header ("Eagle-Eye 1 · step 2 of 4"). */
const chainButton = (page: Page) => page.getByTitle("Open chain overview");

const statusBar = (page: Page) => page.locator(".status-bar-status");

type HandoffInput = { sourceRoleId: string; targetRoleId: string };
const input = (args: Record<string, unknown>) => args.input as HandoffInput;

/** The `set_tab_chain` call that tagged `tabId`. */
async function taggedChain(
  app: TauriApp,
  tabId: string,
): Promise<{ chain: ChainRef; handoffText: unknown }> {
  const call = await app.waitForCall("set_tab_chain", (args) => args.tabId === tabId);
  return { chain: call.args.chain as ChainRef, handoffText: call.args.handoffText };
}

/** Clicks a "Send to …" action under the last reply and confirms the dialog as a chat tab. */
async function handOff(page: Page, button: string, target: string) {
  await page.getByRole("button", { name: button, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "Send plan" });
  await expect(dialog.getByRole("radio", { name: target, exact: true })).toBeChecked();
  await expect(dialog.getByRole("radio", { name: "Chat" })).toBeChecked();
  await dialog.getByRole("button", { name: `Open ${target} tab` }).click();
  await expect(dialog).toBeHidden();
}

/** Planner with Eagle-Eye 1 ticked, its plan reply finished. Returns the chain id. */
async function plannerStep(app: TauriApp, page: Page): Promise<string> {
  await app.open({
    tabs: [roleTab("tab-1", "role_planner", "Planner")],
    answers: {
      "tab-1": {
        taskType: "Feature",
        title: TITLE,
        request: REQUEST,
        expectedBehavior: EXPECTED,
        currentBehavior: CURRENT,
      },
    },
  });
  await page.getByRole("checkbox", { name: "Eagle-Eye 1" }).check();
  const turn = await app.start("tab-1");
  const { chain } = await taggedChain(app, "tab-1");
  expect(chain).toMatchObject({ kind: "eagle1", step: 1, total: 4 });
  expect(chain.chainId).toMatch(CHAIN_ID);
  await turn.reply(PLAN);
  await expect(statusBar(page)).toHaveText("Ready");
  await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 1 of 4");
  await expect(tabButton(page, "Planner")).toHaveAttribute("title", /Eagle-Eye 1 · step 1 of 4/);
  return chain.chainId;
}

/** Planner → Plan Reviewer (tab-2), started, its review reply finished. */
async function planReviewerStep(app: TauriApp, page: Page, chainId: string, verdict: string) {
  await handOff(page, "Next: Send to Plan Reviewer", "Plan Reviewer");
  await expect(tabButton(page, "Plan Reviewer")).toHaveAttribute("aria-selected", "true");
  await expect(tabButton(page, "Plan Reviewer")).toHaveAttribute(
    "title",
    /Eagle-Eye 1 · step 2 of 4/,
  );
  await expect(page.getByRole("textbox", { name: /Original Task/ })).toHaveValue(ORIGINAL);
  await expect(page.getByRole("textbox", { name: /Proposed Implementation Plan/ })).toHaveValue(
    PLAN,
  );

  const saved = await app.waitForCall(
    "handoff_save",
    (a) => input(a).targetRoleId === "role_plan_reviewer",
  );
  expect(saved.args.input).toMatchObject({
    sourceTabId: "tab-1",
    sourceRoleId: "role_planner",
    scope: "plan_and_todos",
    planText: PLAN,
    chain: { chainId, kind: "eagle1", step: 2, total: 4 },
  });
  expect((await app.waitForCall("handoff_bind_tab", (a) => a.tabId === "tab-2")).args).toEqual({
    id: "handoff-1",
    tabId: "tab-2",
  });
  expect(await taggedChain(app, "tab-2")).toEqual({
    chain: { chainId, kind: "eagle1", step: 2, total: 4 },
    handoffText: PLAN,
  });

  const turn = await app.start("tab-2");
  await turn.reply(planReview(verdict));
  await expect(statusBar(page)).toHaveText("Ready");
  await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 2 of 4");
}

/** Plan Reviewer → Implementer (tab-3), then Start. */
async function implementerStep(app: TauriApp, page: Page, chainId: string): Promise<Turn> {
  await expect(page.getByRole("button", { name: "Send to Planner", exact: true })).toBeVisible();
  await handOff(page, "Next: Send to Implementer", "Implementer");
  await expect(tabButton(page, "Implementer")).toHaveAttribute("aria-selected", "true");
  await expect(tabButton(page, "Implementer")).toHaveAttribute(
    "title",
    /Eagle-Eye 1 · step 3 of 4/,
  );
  // Task and approved plan come from the earlier steps; the review notes ride along.
  await expect(page.getByRole("textbox", { name: /^Title/ })).toHaveValue(TITLE);
  await expect(page.getByRole("textbox", { name: /^Description/ })).toHaveValue(DESCRIPTION);
  await expect(page.getByRole("textbox", { name: /Approved Implementation Plan/ })).toHaveValue(
    REVIEWED_PLAN,
  );
  const context = page.getByRole("textbox", { name: "Additional Context" });
  await expect(context).toHaveValue(new RegExp(`^Review notes:\\n${escape(REVIEW_NOTES)}`));
  // The Plan Reviewer form has no task type; the Planner's "Feature" rides in the request block.
  await expect(page.getByRole("combobox", { name: /Task Type/ })).toHaveValue("Feature");

  const saved = await app.waitForCall(
    "handoff_save",
    (a) => input(a).targetRoleId === "role_implementer",
  );
  expect(saved.args.input).toMatchObject({
    sourceTabId: "tab-2",
    sourceRoleId: "role_plan_reviewer",
    planText: REVIEWED_PLAN,
    planField: "approvedPlan",
    chain: { chainId, kind: "eagle1", step: 3, total: 4 },
  });
  expect(await taggedChain(app, "tab-3")).toEqual({
    chain: { chainId, kind: "eagle1", step: 3, total: 4 },
    handoffText: REVIEWED_PLAN,
  });

  await expect(page.getByRole("checkbox", { name: "Eagle-Eye 2" })).toHaveCount(0);
  const turn = await app.start("tab-3");
  const started = await app.waitForCall("role_session_start", (a) => a.tabId === "tab-3");
  expect(started.args.values).toMatchObject({
    taskType: "Feature",
    description: DESCRIPTION,
    approvedPlan: REVIEWED_PLAN,
  });
  await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 3 of 4");
  return turn;
}

/** Implementer → PR Reviewer (tab-4) with scripted repo changes; the draft is open. */
async function prReviewerHandoff(app: TauriApp, page: Page, chainId: string) {
  await app.respond("changes_list", CHANGES);
  await app.respond("git_repo_info", REPO);
  await handOff(page, "Next: Send to PR Reviewer", "PR Reviewer");
  expect((await app.waitForCall("changes_list", (a) => a.scope === "tab")).args).toEqual({
    tabId: "tab-3",
    scope: "tab",
  });
  expect((await app.waitForCall("git_repo_info")).args).toEqual({ path: CWD });

  await expect(tabButton(page, "PR Reviewer")).toHaveAttribute("aria-selected", "true");
  await expect(tabButton(page, "PR Reviewer")).toHaveAttribute(
    "title",
    /Eagle-Eye 1 · step 4 of 4/,
  );
  await expect(page.getByRole("textbox", { name: /Original Task/ })).toHaveValue(ORIGINAL);
  await expect(page.getByRole("textbox", { name: /Approved Implementation Plan/ })).toHaveValue(
    REVIEWED_PLAN,
  );
  const context = page.getByRole("textbox", { name: "Additional Context" });
  await expect(context).toHaveValue(
    new RegExp(`Implementation summary:\\n${escape(IMPLEMENTATION)}`),
  );
  await expect(context).toHaveValue(
    /Changed files:\n- src\/EffortPicker\.tsx \+48 -0\n- src\/bridge\.ts \+6 -1/,
  );
  await expect(context).toHaveValue(/Branch: feat\/effort-picker/);
  await expect(context).toHaveValue(/Pull request: https:\/\/github\.com\/acme\/demo\/pull\/42/);

  const saved = await app.waitForCall(
    "handoff_save",
    (a) => input(a).targetRoleId === "role_pr_reviewer",
  );
  expect(saved.args.input).toMatchObject({
    sourceTabId: "tab-3",
    sourceRoleId: "role_implementer",
    planText: REVIEWED_PLAN,
    chain: { chainId, kind: "eagle1", step: 4, total: 4 },
  });
  expect(await taggedChain(app, "tab-4")).toEqual({
    chain: { chainId, kind: "eagle1", step: 4, total: 4 },
    handoffText: REVIEWED_PLAN,
  });
}

/** Runs the chain up to an open, not yet started PR Reviewer draft (tab-4). */
async function chainToPrReviewer(app: TauriApp, page: Page): Promise<string> {
  const chainId = await plannerStep(app, page);
  await planReviewerStep(app, page, chainId, "APPROVED");
  const implementer = await implementerStep(app, page, chainId);
  await implementer.reply(IMPLEMENTATION);
  await expect(statusBar(page)).toHaveText("Ready");
  await prReviewerHandoff(app, page, chainId);
  return chainId;
}

test.describe("Eagle-Eye 1 chain", () => {
  test.slow();

  test("happy path: Planner → Plan Reviewer → Implementer → PR Reviewer, both approve", async ({
    app,
    page,
  }) => {
    const chainId = await chainToPrReviewer(app, page);

    const review = await app.start("tab-4");
    await review.reply(PR_APPROVED);
    await expect(statusBar(page)).toHaveText("Ready");
    await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 4 of 4");
    // Approved on the last step: the chain is complete. The fix-up edge stays secondary.
    await expect(page.getByText("Chain complete: the PR Reviewer approved.")).toBeVisible();
    await expect(page.getByRole("button", { name: /^Next: |^Send back/ })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Send to Implementer", exact: true }),
    ).toHaveClass(/secondary-button/);

    // Every hand-off along the edge carried the same chain id; nothing started by itself.
    const chains = (await app.calls("set_tab_chain")).map((c) => c.args.chain as ChainRef);
    expect(chains.map((c) => [c.chainId, c.step])).toEqual([
      [chainId, 1],
      [chainId, 2],
      [chainId, 3],
      [chainId, 4],
    ]);
    expect((await app.calls("role_session_start")).map((c) => c.args.tabId)).toEqual([
      "tab-1",
      "tab-2",
      "tab-3",
      "tab-4",
    ]);
    await expect(page.getByRole("tab")).toHaveCount(4);
  });

  test("starting the chain's Implementer keeps it in the chain", async ({
    app,
    page,
  }) => {
    // Eagle-Eye 1 ticked on the Planner must not start a new Eagle-Eye 2 chain here.
    const chainId = await plannerStep(app, page);
    await planReviewerStep(app, page, chainId, "APPROVED");
    await handOff(page, "Next: Send to Implementer", "Implementer");
    await expect(tabButton(page, "Implementer")).toHaveAttribute(
      "title",
      /Eagle-Eye 1 · step 3 of 4/,
    );
    await expect(page.getByRole("checkbox", { name: "Eagle-Eye 2" })).toHaveCount(0);
    await expect(page.getByRole("combobox", { name: /Task Type/ })).toHaveValue("Feature");
    await app.start("tab-3");
    // Start ends with a tab refresh; once it has run, the label shows the stored chain.
    await expect
      .poll(async () => {
        const calls = (await app.calls()).map((c) => [c.cmd, c.args.tabId]);
        const start = calls.findIndex(([cmd, tab]) => cmd === "role_session_start" && tab === "tab-3");
        return start >= 0 && calls.slice(start).some(([cmd]) => cmd === "get_app_state");
      })
      .toBe(true);
    await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 3 of 4");
  });

  test("PR Reviewer requests changes: Send back reuses the chain's Implementer tab", async ({
    app,
    page,
  }) => {
    const chainId = await chainToPrReviewer(app, page);
    const review = await app.start("tab-4");
    await review.reply(PR_CHANGES);
    await expect(statusBar(page)).toHaveText("Ready");

    // The verdict makes the loop-back primary; nothing is sent until the user confirms.
    await expect(page.getByRole("button", { name: /^Next: / })).toHaveCount(0);
    const sendBack = page.getByRole("button", { name: "Send back to Implementer", exact: true });
    await expect(sendBack).toHaveClass(/primary-button/);
    expect(await app.calls("dev_session_send")).toHaveLength(0);
    await sendBack.click();

    // The Implementer (tab-3) is live: the dialog shows the follow-up and where it goes.
    const message = followUp("PR Reviewer", 1, PR_CHANGES, IMPLEMENTER_ASK);
    const dialog = page.getByRole("dialog", { name: "Send back to Implementer" });
    await expect(dialog.getByLabel("Target tab")).toHaveText("To tab: Implementer");
    await expect(dialog.getByLabel("Follow-up message")).toHaveText(message);
    await expect(dialog.getByRole("radio", { name: "Chat" })).toHaveCount(0);
    await dialog.getByRole("button", { name: "Send follow-up to Implementer" }).click();
    await expect(dialog).toBeHidden();

    // Same tab, through the normal send path; round 2 starts on every chain tab.
    const sent = await app.waitForCall("dev_session_send");
    expect(sent.args).toMatchObject({ prompt: message, tabId: "tab-3" });
    expect((await app.waitForCall("chain_loop_back")).args).toEqual({
      chainId,
      reviewerRoleId: "role_pr_reviewer",
      tabId: "tab-3",
      verdict: "REQUEST CHANGES",
      handoffText: message,
    });
    await expect(page.getByRole("tab")).toHaveCount(4);
    // Its tab now reads "Implementer , Working".
    await expect(page.getByRole("tab", { name: /^Implementer/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 3 of 4 · round 2");
    await expect(tabButton(page, "PR Reviewer")).toHaveAttribute("title", /step 4 of 4 · round 2/);
    await expect(page.getByRole("log")).toContainText("Review findings from the PR Reviewer (round 1)");
    await app.turn("tab-3").reply("Hid the picker during a turn and added a test.");
    await expect(page.getByRole("log")).toContainText("added a test");
    expect(await app.calls("handoff_save")).toHaveLength(3);
    expect(await app.calls("set_tab_chain")).toHaveLength(4);

    await chainButton(page).click();
    const overview = page.getByRole("region", { name: "Pipeline overview" });
    await expect(overview.getByText("Stage: implementer · round 2")).toBeVisible();
    const lane = (title: string) => overview.getByRole("article", { name: title, exact: true });
    await expect(lane("PR Reviewer").locator(".pipeline-verdict")).toHaveText("REQUEST CHANGES");
    await expect(
      lane("PR Reviewer").getByRole("list", { name: "PR Reviewer verdicts by round" }),
    ).toHaveText("Round 1: REQUEST CHANGES");
    await lane("Implementer").getByText(/^Handed in/).click();
    await expect(lane("Implementer").locator(".pipeline-handed-in pre")).toHaveText(message);
  });

  test("the chain's Implementer tab is gone: Send back opens a new tab on the chain", async ({
    app,
    page,
  }) => {
    const chainId = await chainToPrReviewer(app, page);
    const review = await app.start("tab-4");
    await review.reply(PR_CHANGES);
    await expect(statusBar(page)).toHaveText("Ready");
    await tabButton(page, "Implementer").click();
    await page.getByRole("button", { name: "Stop and close Implementer" }).click();
    await app.waitForCall("close_tab", (a) => a.tabId === "tab-3");
    await expect(tabButton(page, "Implementer")).toHaveCount(0);
    await tabButton(page, "PR Reviewer").click();

    await page.getByRole("button", { name: "Send back to Implementer", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Send plan" });
    await expect(dialog).toContainText(
      "The chain's Implementer tab is closed, so a new tab opens on the chain (round 2).",
    );
    await expect(dialog.getByRole("radio", { name: "Implementer", exact: true })).toBeChecked();
    await dialog.getByRole("button", { name: "Open Implementer tab" }).click();
    await expect(dialog).toBeHidden();

    // A new Implementer draft at the chain's step 3, round 2; nothing starts by itself.
    const fixUp = tabButton(page, "Implementer");
    await expect(fixUp).toHaveAttribute("aria-selected", "true");
    await expect(fixUp).toHaveAttribute("title", /Eagle-Eye 1 · step 3 of 4 · round 2/);
    await expect(page.getByRole("textbox", { name: /Approved Implementation Plan/ })).toHaveValue(
      PR_CHANGES,
    );
    expect((await app.waitForCall("chain_loop_back")).args).toEqual({
      chainId,
      reviewerRoleId: "role_pr_reviewer",
      tabId: "tab-5",
      verdict: "REQUEST CHANGES",
      handoffText: PR_CHANGES,
    });
    const saved = await app.waitForCall(
      "handoff_save",
      (a) => input(a).sourceRoleId === "role_pr_reviewer",
    );
    expect(saved.args.input).toMatchObject({
      sourceTabId: "tab-4",
      targetRoleId: "role_implementer",
      planText: PR_CHANGES,
      chain: { chainId, kind: "eagle1", step: 3, total: 4, round: 2 },
    });
    expect(await app.calls("dev_session_send")).toHaveLength(0);
    expect((await app.calls("role_session_start")).map((c) => c.args.tabId)).not.toContain("tab-5");
  });

  test("Plan Reviewer requires revision: Send back reuses the Planner tab, round 2 is approved", async ({
    app,
    page,
  }) => {
    const chainId = await plannerStep(app, page);
    await planReviewerStep(app, page, chainId, "REQUIRES REVISION");

    // The verdict points back at the Planner; the Implementer stays as a secondary.
    await expect(page.getByRole("button", { name: /^Next: / })).toHaveCount(0);
    await expect(
      page.getByRole("button", { name: "Send to Implementer", exact: true }),
    ).toHaveClass(/secondary-button/);
    await page.getByRole("button", { name: "Send back to Planner", exact: true }).click();

    // The whole review, findings included, goes into the live Planner tab.
    const message = followUp("Plan Reviewer", 1, planReview("REQUIRES REVISION"), PLANNER_ASK);
    const dialog = page.getByRole("dialog", { name: "Send back to Planner" });
    await expect(dialog.getByLabel("Target tab")).toHaveText("To tab: Planner");
    await expect(dialog.getByLabel("Follow-up message")).toHaveText(message);
    await dialog.getByRole("button", { name: "Send follow-up to Planner" }).click();
    await expect(dialog).toBeHidden();

    expect((await app.waitForCall("dev_session_send")).args).toMatchObject({
      prompt: message,
      tabId: "tab-1",
    });
    expect((await app.waitForCall("chain_loop_back")).args).toEqual({
      chainId,
      reviewerRoleId: "role_plan_reviewer",
      tabId: "tab-1",
      verdict: "REQUIRES REVISION",
      handoffText: message,
    });
    await expect(page.getByRole("tab")).toHaveCount(2);
    await expect(page.getByRole("tab", { name: /^Planner/ })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 1 of 4 · round 2");

    // Round 2: the revised plan goes forward to a new Plan Reviewer on the chain.
    await app.turn("tab-1").reply(REVIEWED_PLAN);
    await expect(statusBar(page)).toHaveText("Ready");
    await handOff(page, "Next: Send to Plan Reviewer", "Plan Reviewer");
    expect(await taggedChain(app, "tab-3")).toEqual({
      chain: { chainId, kind: "eagle1", step: 2, total: 4, round: 2 },
      handoffText: REVIEWED_PLAN,
    });
    const second = await app.start("tab-3");
    await second.reply(planReview("APPROVED"));
    await expect(statusBar(page)).toHaveText("Ready");
    await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 2 of 4 · round 2");
    await expect(page.getByRole("button", { name: "Next: Send to Implementer" })).toHaveClass(
      /primary-button/,
    );

    await chainButton(page).click();
    const overview = page.getByRole("region", { name: "Pipeline overview" });
    await expect(overview.getByText("Stage: plan_reviewer · round 2")).toBeVisible();
    const planReviewer = overview.getByRole("article", { name: "Plan Reviewer", exact: true });
    await expect(planReviewer.locator(".pipeline-lane-tab")).toHaveText("Plan Reviewer");
    await expect(planReviewer.locator(".pipeline-verdict")).toHaveText("APPROVED");
    await expect(
      planReviewer.getByRole("list", { name: "Plan Reviewer verdicts by round" }),
    ).toHaveText("Round 1: REQUIRES REVISION");
    expect((await app.calls("set_tab_chain")).map((c) => c.args.tabId)).toEqual([
      "tab-1",
      "tab-2",
      "tab-3",
    ]);
  });

  test("chain overview: request, every stage, hand-offs, verdicts, jump, live update", async ({
    app,
    page,
  }) => {
    const chainId = await chainToPrReviewer(app, page);
    const review = await app.start("tab-4");

    await chainButton(page).click();
    expect((await app.waitForCall("open_chain_overview")).args).toEqual({
      chainId,
      windowId: "main",
    });
    const overviewTab = tabButton(page, "Eagle-Eye 1 · overview");
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");
    const overview = page.getByRole("region", { name: "Pipeline overview" });
    await expect(overview.getByRole("heading", { name: "Eagle-Eye 1 overview" })).toBeVisible();
    await expect(overview.getByText("Stage: pr_reviewer")).toBeVisible();
    await expect(
      overview.getByRole("region", { name: "Original request" }).locator(".pipeline-request-text"),
    ).toHaveText(`${TITLE}\n\n${REQUEST}`);

    const lane = (title: string) => overview.getByRole("article", { name: title, exact: true });
    const planner = lane("Planner");
    const planReviewer = lane("Plan Reviewer");
    const implementer = lane("Implementer");
    const prReviewer = lane("PR Reviewer");
    await expect(overview.getByRole("article")).toHaveCount(4);

    await expect(planner.locator(".pipeline-lane-tab")).toHaveText("Planner");
    await expect(planner.locator(".pipeline-lane-status")).toHaveText("Session open");
    await expect(planner.locator(".pipeline-handed-in")).toHaveCount(0);
    await expect(planner.locator(".pipeline-verdict")).toHaveCount(0);

    await expect(planReviewer.locator(".pipeline-lane-tab")).toHaveText("Plan Reviewer");
    await expect(planReviewer.locator(".pipeline-lane-status")).toHaveText("Session open");
    await expect(planReviewer.locator(".pipeline-verdict")).toHaveText("APPROVED");
    await expect(planReviewer.locator(".pipeline-verdict")).toHaveClass(/pipeline-verdict-ok/);
    await planReviewer.getByText(/^Handed in/).click();
    await expect(planReviewer.locator(".pipeline-handed-in pre")).toHaveText(PLAN);

    await expect(implementer.locator(".pipeline-lane-tab")).toHaveText("Implementer");
    await expect(implementer.locator(".pipeline-lane-status")).toHaveText("Session open");
    await expect(implementer.locator(".pipeline-verdict")).toHaveCount(0);
    await implementer.getByText(/^Handed in/).click();
    await expect(implementer.locator(".pipeline-handed-in pre")).toHaveText(REVIEWED_PLAN);

    // The PR Reviewer's startup turn is still running: no verdict yet.
    await expect(prReviewer).toHaveClass(/pipeline-lane-current/);
    await expect(prReviewer.locator(".pipeline-lane-tab")).toHaveText("PR Reviewer");
    await expect(prReviewer.locator(".pipeline-lane-status")).toHaveText("Working…");
    await expect(prReviewer.locator(".pipeline-verdict")).toHaveCount(0);
    await prReviewer.getByText(/^Handed in/).click();
    await expect(prReviewer.locator(".pipeline-handed-in pre")).toHaveText(REVIEWED_PLAN);

    // It finishes in the background; the open overview picks the verdict up.
    await review.reply(PR_CHANGES);
    await expect(prReviewer.locator(".pipeline-verdict")).toHaveText("REQUEST CHANGES");
    await expect(prReviewer.locator(".pipeline-verdict")).toHaveClass(/pipeline-verdict-bad/);
    await expect(prReviewer.locator(".pipeline-lane-status")).toHaveText("Session open");
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");

    // Jump goes to the stage's tab.
    await planReviewer.getByRole("button", { name: "Jump" }).click();
    await expect(tabButton(page, "Plan Reviewer")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("log")).toContainText(REVIEW_NOTES);
    await expect(chainButton(page)).toHaveText("Eagle-Eye 1 · step 2 of 4");

    // Opening the overview again from another stage reuses the same tab.
    await chainButton(page).click();
    await expect(overviewTab).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("tab")).toHaveCount(5);
    await lane("PR Reviewer").getByRole("button", { name: "Jump" }).click();
    await expect(tabButton(page, "PR Reviewer")).toHaveAttribute("aria-selected", "true");
    await expect(page.getByRole("log")).toContainText("No test covers the hidden state.");
  });
});

test.describe("chain overview in portrait", () => {
  test.use({ viewport: { width: 900, height: 1440 } });

  test("900x1440: every stage fits the width with long hand-offs", async ({ app, page }) => {
    const chain = (step: number): ChainRef => ({ chainId: "ee_1", kind: "eagle1", step, total: 4 });
    const longLine = `src/${"very-long-folder-name/".repeat(12)}EffortPicker.tsx`;
    const handedIn = `${REVIEWED_PLAN}\n4. Touch ${longLine}\n${"Wrap me please. ".repeat(60)}`;
    await app.open({
      tabs: [
        roleTab("tab-1", "role_planner", "Planner", { chain: chain(1) }),
        roleTab("tab-2", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) }),
        roleTab("tab-3", "role_implementer", "Implementer", { chain: chain(3) }),
        roleTab("tab-4", "role_pr_reviewer", "PR Reviewer", { chain: chain(4) }),
      ],
      answers: {
        "tab-1": { title: TITLE, request: `${REQUEST} ${"and more detail ".repeat(40)}` },
      },
    });
    // A chain that already ran: the run store has every stage's hand-off text.
    const run: PipelineRun = {
      id: "ee_1",
      kind: "full",
      cwd: CWD,
      stage: "pr_reviewer",
      overviewTabId: "",
      tabIds: {
        role_planner: "tab-1",
        role_plan_reviewer: "tab-2",
        role_implementer: "tab-3",
        role_pr_reviewer: "tab-4",
      },
      originalRequest: null,
      createdAt: "2026-10-10T09:00:00Z",
      chainId: "ee_1",
      handoffs: {
        role_plan_reviewer: { text: handedIn, at: "2026-10-10T09:01:00Z" },
        role_implementer: { text: handedIn, at: "2026-10-10T09:02:00Z" },
        role_pr_reviewer: { text: handedIn, at: "2026-10-10T09:03:00Z" },
      },
    };
    await page.evaluate((r) => window.__E2E.state.pipelineRuns.push(r), run);

    const turn = await app.start("tab-1");
    await turn.reply(`${PLAN}\n\n${longLine}`);
    await chainButton(page).click();
    const overview = page.getByRole("region", { name: "Pipeline overview" });
    await expect(overview.getByRole("article")).toHaveCount(4);
    for (const summary of await overview.getByText(/^Handed in/).all()) await summary.click();
    await expect(overview.locator(".pipeline-handed-in[open]")).toHaveCount(3);
    await expect(overview.getByRole("region", { name: "Original request" })).toContainText(REQUEST);

    const sizes = await page.evaluate(() => {
      const doc = document.scrollingElement ?? document.documentElement;
      const section = document.querySelector(".pipeline-overview")!;
      return {
        page: [doc.scrollWidth, doc.clientWidth],
        overview: [section.scrollWidth, section.clientWidth],
      };
    });
    expect(sizes.page[0], "page scrolls sideways").toBeLessThanOrEqual(sizes.page[1]);
    expect(sizes.overview[0], "overview scrolls sideways").toBeLessThanOrEqual(sizes.overview[1]);
    for (const lane of await overview.getByRole("article").all()) {
      const box = (await lane.boundingBox())!;
      expect(box.x, "lane left edge").toBeGreaterThanOrEqual(0);
      expect(box.x + box.width, "lane right edge").toBeLessThanOrEqual(900 + 1);
    }
  });
});

test.describe("chain overview live data", () => {
  test("a hand-off made elsewhere shows in the open overview without a poll", async ({
    app,
    page,
  }) => {
    await page.clock.install();
    const chain = (step: number): ChainRef => ({ chainId: "ee_7", kind: "eagle1", step, total: 4 });
    await app.open({
      tabs: [
        roleTab("tab-1", "role_planner", "Planner", { chain: chain(1) }),
        roleTab("tab-2", "role_plan_reviewer", "Plan Reviewer", { chain: chain(2) }),
        roleTab("tab-3", "role_implementer", "Implementer"),
      ],
      answers: { "tab-1": { taskType: "Feature", title: TITLE, request: REQUEST } },
    });
    await app.start("tab-1");
    await chainButton(page).click();
    const overview = page.getByRole("region", { name: "Pipeline overview" });
    const implementer = overview.getByRole("article", { name: "Implementer", exact: true });
    await expect(overview.getByText("Stage: plan_reviewer")).toBeVisible();
    await expect(implementer.locator(".pipeline-lane-status")).toHaveText("Not started");
    await expect
      .poll(() => page.evaluate(() => window.__E2E.listenerCount("chain-run-updated")))
      .toBeGreaterThan(0);

    // Timers stop here, so only the event can bring the new hand-off in.
    await page.clock.pauseAt(Date.now() + 1000);
    const fetches = (await app.calls("get_pipeline_run")).length;
    await page.evaluate(
      ([plan, next]) =>
        (
          window as unknown as {
            __TAURI_INTERNALS__: { invoke: (cmd: string, args: unknown) => Promise<unknown> };
          }
        ).__TAURI_INTERNALS__.invoke("set_tab_chain", {
          tabId: "tab-3",
          chain: next,
          handoffText: plan,
        }),
      [REVIEWED_PLAN, chain(3)] as const,
    );
    await expect(overview.getByText("Stage: implementer")).toBeVisible({ timeout: 1500 });
    await implementer.getByText(/^Handed in/).click({ timeout: 1500 });
    await expect(implementer.locator(".pipeline-handed-in pre")).toHaveText(REVIEWED_PLAN);
    expect((await app.calls("get_pipeline_run")).length).toBe(fetches + 1);
  });
});
