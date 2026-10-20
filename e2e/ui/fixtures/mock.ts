/**
 * In-page stand-in for the Tauri IPC layer. Runs via page.addInitScript before
 * any app code, so it must be self-contained: no imports, no outer variables.
 * Types are only for the Node side; the function body is serialized as-is.
 */
import type { MockConfig } from "./types";

export function installTauriMock(config: MockConfig): void {
  type Json = any;
  type Handler = (args: Json, state: Json) => Json;

  const clone = <T>(value: T): T =>
    value === undefined ? value : (JSON.parse(JSON.stringify(value)) as T);
  const now = () => new Date().toISOString();

  const callbacks = new Map<number, { fn: (payload: Json) => void; once: boolean }>();
  let nextCallback = 1;
  const listeners: Record<string, { eventId: number; handler: number }[]> = {};
  let nextEventId = 1;
  const calls: { cmd: string; args: Json }[] = [];

  const roleSummary = (role: Json) => ({
    id: role.id,
    name: role.name,
    defaultMode: role.defaultMode,
    color: role.color,
    fieldCount: role.fields.length,
    isBuiltIn: role.isBuiltIn,
    ...(role.handoffTargets ? { handoffTargets: role.handoffTargets } : {}),
  });

  const state: Json = {
    cwd: config.cwd,
    roles: clone(config.roles),
    tabs: clone(config.tabs),
    activeTabId: config.activeTabId,
    answers: clone(config.answers ?? {}) as Record<string, Record<string, string>>,
    ptys: [] as string[],
    activity: {} as Record<string, Json[]>,
    layout: {
      splitMode: "single",
      secondaryTabId: null,
      primarySize: 50,
      filePanelOpen: false,
      filePanelWidth: 280,
    },
    handoffs: [] as Json[],
    /** One PipelineRun per Eagle-Eye chain (run id = chain id), like store/chain_runs.rs. */
    pipelineRuns: [] as Json[],
    recent: [] as Json[],
    pads: [] as Json[],
    attachments: 0,
    tabCounter: config.tabs.length,
    /** GitHub monitor: saved filters, and the notification ids already claimed. */
    githubFilters: clone(config.github.status.filters),
    githubClaimed: null as string[] | null,
  };

  const findRole = (id: string) => state.roles.find((r: Json) => r.id === id);
  const findTab = (id: string) => state.tabs.find((t: Json) => t.id === id);
  const snapshot = () => ({
    activeTabId: state.activeTabId,
    tabs: clone(state.tabs),
    closedTabs: [],
  });
  const record = (tab: Json) => {
    const role = findRole(tab.roleId);
    return {
      tab: {
        id: tab.id,
        label: tab.label,
        roleId: tab.roleId,
        roleSnapshot: {
          name: role?.name ?? "",
          templateVersion: role?.templateVersion ?? 1,
          mode: role?.defaultMode ?? "agent",
          injection: role?.injection ?? "send_on_start",
        },
        cwd: tab.cwd,
        answers: { cwd: tab.cwd, ...(state.answers[tab.id] ?? {}) },
        mergedPrompt: "",
        mergedPromptHash: "",
        phase: tab.phase,
        order: state.tabs.indexOf(tab),
        createdAt: now(),
        transcript: null,
        startupPromptSent: tab.startupPromptSent,
        kind: tab.kind ?? "role",
        terminalLaunch: tab.terminalLaunch ?? "",
      },
    };
  };
  const addTab = (roleId: string, cwd: string) => {
    state.tabCounter += 1;
    const role = findRole(roleId);
    const tab = {
      id: `tab-${state.tabCounter}`,
      label: role?.name ?? roleId,
      roleId,
      cwd,
      phase: "draft",
      mergedPromptChars: 0,
      startupPromptSent: false,
      hasTranscript: false,
      folderStatus: cwd ? "ok" : "empty",
      color: "",
      kind: "role",
      terminalLaunch: "",
      acpSessionId: null,
      model: null,
      provider: "claude",
      chain: null,
    };
    state.tabs.push(tab);
    state.activeTabId = tab.id;
    return tab;
  };
  const sessionIdFor = (tabId: string) => `sess-${tabId}`;
  const fullRole = (role: Json) => clone(role);

  // Eagle-Eye chain runs: a port of src-tauri/src/store/chain_runs.rs.
  const PIPELINE_STAGES: Record<string, [string, string][]> = {
    full: [
      ["planner", "role_planner"],
      ["plan_reviewer", "role_plan_reviewer"],
      ["implementer", "role_implementer"],
      ["pr_reviewer", "role_pr_reviewer"],
    ],
    execute: [
      ["implementer", "role_implementer"],
      ["pr_reviewer", "role_pr_reviewer"],
    ],
  };
  const runKindForChain = (kind: string) =>
    kind === "eagle1" ? "full" : kind === "eagle2" ? "execute" : null;
  const findRun = (chainId: string) =>
    state.pipelineRuns.find((r: Json) => r.id === chainId || r.chainId === chainId);
  const chainOriginalRequest = (run: Json): string | null => {
    if (run.originalRequest) return run.originalRequest;
    const first = PIPELINE_STAGES[run.kind]?.[0]?.[1];
    const tabId = first ? run.tabIds[first] : null;
    if (!tabId) return null;
    const answers = state.answers[tabId] ?? {};
    const pick = (key: string) => String(answers[key] ?? "").trim() || null;
    const title = pick("title");
    const body = pick("request") ?? pick("description");
    if (title && body) return `${title}\n\n${body}`;
    return body ?? title;
  };
  const recordChainStep = (tabId: string, chain: Json, handoffText: string | null) => {
    const kind = runKindForChain(chain.kind);
    if (!kind) return;
    const stages = PIPELINE_STAGES[kind];
    const index = chain.step - 1;
    const stage = stages[index];
    if (!stage) return;
    const [stageId, roleId] = stage;
    let run = findRun(chain.chainId);
    if (!run) {
      run = {
        id: chain.chainId,
        kind,
        cwd: findTab(tabId)?.cwd ?? "",
        stage: stageId,
        overviewTabId: "",
        tabIds: {},
        candidatePlan: null,
        approvedPlan: null,
        originalRequest: null,
        createdAt: now(),
        chainId: chain.chainId,
        handoffs: {},
        updatedAt: null,
      };
      state.pipelineRuns.push(run);
    }
    run.tabIds[roleId] = tabId;
    const current = stages.findIndex(([id]) => id === run.stage);
    if (current < 0 || index >= current) run.stage = stageId;
    const text = (handoffText ?? "").trim();
    if (text) run.handoffs[roleId] = { text, at: now() };
    run.updatedAt = now();
    if (!run.originalRequest) run.originalRequest = chainOriginalRequest(run);
  };

  const configDir = {
    path: "/Users/e2e/.claude",
    display: "~/.claude",
    source: "default",
    exists: true,
  };
  const loggedIn = {
    state: "loggedIn",
    account: "e2e@example.com",
    detail: null,
    apiKeyEnv: false,
    method: "claude.ai · team",
    organization: "Example Org",
  };

  const defaults: Record<string, Handler> = {
    reopen_closed_window: () => null,
    window_context: () => ({
      id: "main",
      accountId: "default",
      accountName: "Claude",
      title: "DCTerminal",
      config: configDir,
    }),
    detect_cli: () => ({ found: true, path: "/usr/local/bin/agent", version: "2026.10.01", error: null }),
    cli_login_status: () => loggedIn,
    first_run_status: () => ({ needed: false, completed: true }),
    get_provider_settings: () => ({
      settings: { default: "claude", roleProvider: {}, claude: {}, cursor: {} },
      claudeConfigDir: configDir,
      claudeConfigDirEnv: null,
      claudeAccounts: [{ id: "default", name: "Claude", config: configDir, envOverride: false }],
    }),
    provider_status: (a) => ({
      status: {
        id: a?.provider ?? "claude",
        found: true,
        path: "/usr/local/bin/claude",
        version: "2.1.287",
        adapterFound: true,
        adapterPath: "/usr/local/bin/claude-agent-acp",
        error: null,
      },
      login: loggedIn,
      configDir,
      adapterInstall: null,
    }),
    claude_account_logins: () => [
      { id: "default", name: "Claude", config: configDir, login: loggedIn },
    ],
    get_terminal_settings: () => ({
      shell: "/bin/zsh",
      fontSize: 13,
      roleSurface: clone(config.roleSurface),
      roleRunMode: {},
      // "start" keeps Ctrl+T on the start screen for the older specs.
      newTabOpens: config.newTabOpens ?? "start",
    }),
    set_terminal_settings: (a) => a.terminal,
    get_notification_settings: () => ({ enabled: true, system: false, toastWhenFocused: false }),
    set_notification_settings: (a) => a.notifications,
    get_ui_settings: () => ({
      theme: "github-dark",
      shortcutBar: false,
      tipsSeen: ["welcome", "first-use"],
      padHeight: 0,
      padHidden: false,
      customColors: {},
    }),
    set_ui_settings: (a) => a.ui,
    get_model_settings: () => ({
      cursor: { defaultModel: "auto", roleModels: {} },
      claude: { defaultModel: "default", roleModels: {} },
    }),
    set_model_settings: (a) => a.models,
    list_models: (a) => ({
      models:
        a?.provider === "claude"
          ? [
              { id: "default", label: "Default (Opus)", fast: false },
              { id: "sonnet", label: "Sonnet", fast: false },
              { id: "haiku", label: "Haiku", fast: true },
            ]
          : [{ id: "auto", label: "Auto", fast: false }],
      source: "cache",
      fetchedAtMs: Date.now(),
      error: null,
    }),
    cursor_approval_mode: () => ({
      kind: "unknown",
      approvalMode: null,
      configPath: null,
      roleRulesOff: false,
      note: null,
    }),
    diagnostics_status: () => ({
      capturePermissionPayloads: false,
      appDataDir: "/tmp/dct-e2e",
      transcriptsDir: "/tmp/dct-e2e/transcripts",
      logPath: "/tmp/dct-e2e/app.log",
      crashLogPath: "/tmp/dct-e2e/logs/crash.log",
      lastError: null,
    }),
    get_claude_usage: () => ({ configDir: configDir.path, windows: [], contextByTab: {} }),

    list_roles: () => state.roles.map(roleSummary),
    get_role: (a) => {
      const role = findRole(a.roleId);
      if (!role) throw new Error(`role not found: ${a.roleId}`);
      return fullRole(role);
    },
    validate_and_preview: (a) => {
      const role = findRole(a.roleId);
      const text = `${role?.name ?? a.roleId} startup prompt`;
      return { errors: [], merged: { text, chars: text.length, unresolved: [] } };
    },
    preview_role_template: (a) => ({ fields: clone(findRole(a.roleId)?.fields ?? []), error: null }),
    create_role: (a) => {
      const slug = String(a.name).toLowerCase().replace(/[^a-z0-9]+/g, "_");
      const role = {
        id: `role_custom_${slug}`,
        name: a.name,
        templateText: "You are {{name}}.",
        templateVersion: 1,
        templateHash: "h",
        schemaTemplateHash: "h",
        defaultMode: "agent",
        injection: "send_on_start",
        color: "#8b5cf6",
        isBuiltIn: false,
        fields: [],
        updatedAt: now(),
      };
      state.roles.push(role);
      return fullRole(role);
    },
    save_role: (a) => {
      const role = findRole(a.input.roleId);
      if (!role) throw new Error(`role not found: ${a.input.roleId}`);
      const { roleId: _id, ...rest } = a.input;
      Object.assign(role, rest, { updatedAt: now() });
      return fullRole(role);
    },
    duplicate_role: (a) => {
      const source = findRole(a.roleId);
      const role = {
        ...clone(source),
        id: `${source.id}_copy`,
        name: `${source.name} copy`,
        isBuiltIn: false,
        handoffTargets: a.handoffTargets ?? source.handoffTargets,
      };
      state.roles.push(role);
      return fullRole(role);
    },
    delete_role: (a) => {
      state.roles = state.roles.filter((r: Json) => r.id !== a.roleId);
      return null;
    },

    get_app_state: () => snapshot(),
    // Localhost preview tabs (src-tauri/src/store/preview_tabs.rs).
    open_preview_tab: (a) => {
      const url = String(a.url ?? "").trim();
      if (!/^http:\/\/(localhost|127\.0\.0\.1)(:\d{1,5})?([/?#]|$)/i.test(url)) {
        throw new Error("Preview tabs open http://localhost and http://127.0.0.1 addresses only.");
      }
      state.tabCounter += 1;
      const tab = {
        id: `tab-${state.tabCounter}`,
        label: `Preview · ${url.replace(/^http:\/\//i, "").split(/[/?#]/)[0]}`,
        roleId: "",
        cwd: "",
        phase: "draft",
        mergedPromptChars: 0,
        startupPromptSent: false,
        hasTranscript: false,
        folderStatus: "empty",
        color: "",
        kind: "preview",
        terminalLaunch: "",
        acpSessionId: null,
        model: null,
        provider: "claude",
        chain: null,
        previewUrl: url,
      };
      state.tabs.push(tab);
      state.activeTabId = tab.id;
      return snapshot();
    },
    set_preview_url: (a) => {
      const tab = findTab(String(a.tabId));
      if (!tab || tab.kind !== "preview") throw new Error(`unknown preview tab: ${a.tabId}`);
      tab.previewUrl = String(a.url);
      tab.label = `Preview · ${tab.previewUrl.replace(/^http:\/\//i, "").split(/[/?#]/)[0]}`;
      return null;
    },
    // The GitHub tab and monitor (src-tauri/src/store/github_tabs.rs,
    // src-tauri/src/commands/github.rs), answering from config.github.
    open_github_tab: () => {
      const existing = state.tabs.find((t: Json) => t.kind === "github");
      if (existing) {
        state.activeTabId = existing.id;
        return snapshot();
      }
      state.tabCounter += 1;
      const tab = {
        id: `tab-${state.tabCounter}`,
        label: "GitHub",
        roleId: "",
        cwd: "",
        phase: "draft",
        mergedPromptChars: 0,
        startupPromptSent: false,
        hasTranscript: false,
        folderStatus: "empty",
        color: "",
        kind: "github",
        terminalLaunch: "",
        acpSessionId: null,
        model: null,
        provider: "claude",
        chain: null,
      };
      state.tabs.push(tab);
      state.activeTabId = tab.id;
      return snapshot();
    },
    github_status: () => ({ ...config.github.status, filters: state.githubFilters }),
    github_feed: () => config.github.feed,
    github_push_commits: (a) =>
      config.github.commits[`${a.repo}@${a.head}`] ?? { commits: [], total: 0 },
    github_save_filters: (a) => {
      state.githubFilters = clone(a.filters);
      return state.githubFilters;
    },
    // The first call sets the baseline and returns nothing; later calls return
    // the ids not claimed before. All are marked claimed.
    github_claim_notifications: (a) => {
      const ids: string[] = a.ids ?? [];
      const before: string[] | null = state.githubClaimed;
      state.githubClaimed = [...new Set([...(before ?? []), ...ids])];
      return before ? ids.filter((id) => !before.includes(id)) : [];
    },
    get_tab: (a) => record(findTab(a.tabId)),
    select_active_tab: (a) => {
      state.activeTabId = a.tabId;
      return record(findTab(a.tabId));
    },
    new_draft_tab: (a) => record(addTab(a.roleId, a.cwd ?? "")),
    close_tab: (a) => {
      state.tabs = state.tabs.filter((t: Json) => t.id !== a.tabId);
      if (state.activeTabId === a.tabId) state.activeTabId = state.tabs.at(-1)?.id ?? null;
      return snapshot();
    },
    get_form_recall: () => ({ cwd: state.cwd, values: {} }),
    save_form_draft: () => null,
    sync_active_tab_form: (a) => {
      const tab = findTab(a.tabId);
      if (tab) {
        tab.roleId = a.roleId;
        tab.cwd = a.cwd;
        state.answers[a.tabId] = clone(a.values);
      }
      return null;
    },
    role_session_start: (a) => {
      const tab = (a.tabId && findTab(a.tabId)) || addTab(a.roleId, a.values.cwd ?? state.cwd);
      const role = findRole(a.roleId);
      tab.roleId = a.roleId;
      tab.cwd = a.values.cwd || tab.cwd || state.cwd;
      tab.phase = "running";
      tab.startupPromptSent = true;
      tab.acpSessionId = sessionIdFor(tab.id);
      state.answers[tab.id] = clone(a.values);
      return {
        errors: [],
        session: {
          sessionId: sessionIdFor(tab.id),
          modeId: role?.defaultMode ?? "agent",
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
        folderWarning: null,
        loadedViaSessionLoad: false,
        replayMessageCount: 0,
        replayTruncated: false,
        replay: [],
        modelVia: "unchanged",
      };
    },
    dev_session_send: () => ({ dispatched: true }),
    dev_session_cancel: () => null,
    dev_session_stop: () => null,
    // The Rust registry's view of a running tab (dev_session_live).
    dev_session_live: (a) => {
      const tab = findTab(a.tabId);
      if (!tab || tab.phase !== "running" || !tab.acpSessionId) return null;
      const role = findRole(tab.roleId);
      return {
        sessionId: tab.acpSessionId,
        modeId: role?.defaultMode ?? "agent",
        cwd: tab.cwd,
        supportsImages: true,
        roleId: tab.roleId,
        promptInFlight: true,
        exited: false,
      };
    },
    respond_plan_request: () => null,
    respond_permission_request: () => null,
    respond_question_request: () => null,
    attachment_add: (a) => {
      state.attachments += 1;
      return { id: `att-${state.attachments}`, mime: a.mime, bytes: Math.floor((a.data.length * 3) / 4) };
    },
    attachment_remove: () => null,
    pty_open: (a) => {
      state.ptys.push(a.input.id);
      return 4242;
    },
    pty_write: (a) => {
      if (!state.ptys.includes(a.id)) throw new Error(`no pty ${a.id}`);
      return null;
    },
    pty_resize: () => null,
    pty_kill: (a) => {
      state.ptys = state.ptys.filter((id: string) => id !== a.id);
      return null;
    },

    get_layout: () => clone(state.layout),
    set_layout: (a) => {
      state.layout = clone(a.layout);
      return clone(state.layout);
    },

    scratch_load: () => ({ pads: clone(state.pads), knownTabIds: state.tabs.map((t: Json) => t.id) }),
    scratch_save: (a) => {
      state.pads = state.pads.filter((p: Json) => p.tabId !== a.tabId);
      const pad = { tabId: a.tabId, content: a.content, history: a.history, updatedAt: a.updatedAt ?? now() };
      state.pads.push(pad);
      return { applied: true, pad: clone(pad) };
    },
    prompt_library_get: () => ({ prompts: [], recent: clone(state.recent), path: "/tmp/dct-e2e/prompts.json" }),
    prompt_record_send: (a) => {
      state.recent.unshift({ text: a.text, sentAt: now(), source: a.source });
      return null;
    },

    // Pipelines (commands/pipeline.rs). Built-ins are bundled in the UI.
    pipeline_defs_list: () => clone(state.pipelineDefs ?? []),
    pipeline_defs_save: (a) => {
      state.pipelineDefs = clone(a.pipelines);
      return clone(state.pipelineDefs);
    },
    pipeline_set_autopilot: (a) => {
      const run = findRun(a.runId);
      if (!run) throw new Error(`unknown pipeline run: ${a.runId}`);
      run.autopilot = { ...(run.autopilot ?? {}), enabled: a.enabled, waiting: null };
      if (run.status !== "complete") {
        run.status = a.enabled ? "running" : "stopped";
        run.stopReason = a.enabled ? null : "paused_by_you";
      }
      return null;
    },
    pipeline_continue: (a) => {
      const run = findRun(a.runId);
      if (!run) throw new Error(`unknown pipeline run: ${a.runId}`);
      if (run.status !== "waiting" || run.stopReason !== "app_restarted") {
        throw new Error("This run is not waiting after a restart.");
      }
      run.status = "running";
      run.stopReason = null;
      run.autopilot = { ...(run.autopilot ?? {}), waiting: null };
      return Object.values(run.tabIds ?? {});
    },
    autopilot_pending_stops: () => [],
    pipeline_run_gates: (a) => {
      const run = findRun(a.runId);
      if (!run) throw new Error(`unknown pipeline run: ${a.runId}`);
      const results = clone(state.gateResults?.[a.stageId] ?? []);
      run.gates = { ...(run.gates ?? {}), [a.stageId]: { round: run.round ?? 1, at: now(), results } };
      return results;
    },
    pipeline_decide: () => ({ action: "stop", reason: "e2e mock: no autopilot decision" }),
    pipeline_fan_out: (a) => {
      const run = findRun(a.runId);
      if (!run) throw new Error(`unknown pipeline run: ${a.runId}`);
      run.lanes = a.lanes.map((lane: Json) => ({
        ...lane,
        status: lane.dependsOn.length ? "waiting" : "active",
        stage: a.stageId,
        round: 1,
        tabIds: {},
      }));
      run.fanOutStage = a.stageId;
      return null;
    },
    pipeline_lane_status: (a) => {
      const lane = findRun(a.runId)?.lanes?.find((l: Json) => l.id === a.lane);
      if (!lane) throw new Error(`unknown lane: ${a.lane}`);
      lane.status = a.status;
      return null;
    },
    pipeline_approve: (a) => {
      const run = findRun(a.runId);
      if (!run) throw new Error(`unknown pipeline run: ${a.runId}`);
      const lanes: Json[] = run.lanes ?? [];
      const log = (kind: string, summary: string) => {
        run.events = [...(run.events ?? []), { at: now(), kind, round: run.round ?? 1, summary }];
      };
      if (a.lane) {
        const lane = lanes.find((l) => l.id === a.lane);
        if (!lane) throw new Error(`unknown lane: ${a.lane}`);
        if (lane.status === "approved") return { complete: false, unblocked: [] };
        lane.status = "approved";
        log("note", `${lane.title}: approved by you`);
      } else {
        if (lanes.length) throw new Error("This run has pull requests: mark each one approved instead.");
        const stages = PIPELINE_STAGES[run.kind];
        const last = stages?.[stages.length - 1]?.[0];
        if (stages && run.stage !== last) {
          throw new Error(`Mark complete is for the last stage; this run is at ${run.stage}.`);
        }
        log("note", "Approved by you");
      }
      if (run.autopilot) run.autopilot.waiting = null;
      const approved = (id: string) => lanes.find((l) => l.id === id)?.status === "approved";
      const complete = lanes.every((l) => l.status === "approved");
      if (complete) {
        run.status = "complete";
        run.stopReason = null;
        log("complete", "Complete: approved by you.");
      } else if (run.status === "waiting") {
        run.status = "running";
        run.stopReason = null;
      }
      const unblocked = complete
        ? []
        : lanes.filter((l) => l.status === "waiting" && (l.dependsOn ?? []).every(approved)).map((l) => l.id);
      return { complete, unblocked };
    },
    pipeline_turn_finished: (a) => {
      const run = findRun(a.runId);
      if (run) {
        run.events = [
          ...(run.events ?? []),
          {
            at: now(),
            kind: "turn",
            stageId: a.stageId,
            roleId: a.roleId,
            round: run.round ?? 1,
            summary: "Turn finished",
            outcome: a.verdict ?? null,
          },
        ];
      }
      return null;
    },
    // No run state for claims here: every hand-off is a first one.
    pipeline_claim_handoff: () => null,
    pipeline_release_handoff: () => null,
    pipeline_note: (a) => {
      const run = findRun(a.runId);
      // Only autopilot waits for you: with it off a stop note just logs (PipelineRun::set_waiting).
      if (run && a.stop && run.status !== "complete" && run.autopilot?.enabled) {
        run.status = "waiting";
        run.stopReason = a.reason ?? "carry_out_failed";
      }
      if (run) {
        run.events = [
          ...(run.events ?? []),
          { at: now(), kind: a.stop ? "stop" : "note", stageId: a.stageId, round: run.round ?? 1, summary: a.summary },
        ];
      }
      return null;
    },

    handoff_list: () => clone(state.handoffs),
    handoff_save: (a) => {
      const rec = {
        ...clone(a.input),
        id: `handoff-${state.handoffs.length + 1}`,
        createdAt: now(),
        targetTabId: null,
        planFile: null,
      };
      state.handoffs.push(rec);
      return clone(rec);
    },
    handoff_bind_tab: (a) => {
      const rec = state.handoffs.find((h: Json) => h.id === a.id);
      if (rec) rec.targetTabId = a.tabId;
      return clone(rec);
    },
    handoff_get: (a) => clone(state.handoffs.find((h: Json) => h.id === a.id)),

    set_tab_chain: (a) => {
      const tab = findTab(a.tabId);
      if (!tab) throw new Error(`unknown tab: ${a.tabId}`);
      tab.chain = clone(a.chain);
      if (a.chain) recordChainStep(a.tabId, a.chain, a.handoffText);
      return null;
    },
    // Eagle-Eye routing: a reviewer sends its round back (store/chain_runs.rs chain_loop_back).
    chain_loop_back: (a) => {
      const target = findTab(a.tabId);
      if (!target) throw new Error(`unknown tab: ${a.tabId}`);
      const chainId = String(a.chainId).trim();
      if (!findRun(chainId)) {
        const tagged = state.tabs
          .filter((t: Json) => t.chain?.chainId === chainId)
          .sort((x: Json, y: Json) => x.chain.step - y.chain.step);
        for (const t of tagged) recordChainStep(t.id, t.chain, null);
      }
      const run = findRun(chainId);
      if (!run) throw new Error("No open tab is on this Eagle-Eye chain.");
      const stages = PIPELINE_STAGES[run.kind] ?? PIPELINE_STAGES.full;
      const at = stages.findIndex(([, role]) => role === target.roleId);
      const reviewer = stages.findIndex(([, role]) => role === a.reviewerRoleId);
      if (at < 0 || reviewer < 0 || at >= reviewer) {
        throw new Error("That hand-off is not a loop-back on this chain.");
      }
      const ending = Math.max(1, run.round ?? 1);
      run.verdicts = [
        ...(run.verdicts ?? []),
        { roleId: a.reviewerRoleId, round: ending, verdict: a.verdict ?? null, at: now() },
      ];
      run.round = ending + 1;
      run.stage = stages[at][0];
      // Your send-back puts a complete run back in play (PipelineRun::reopen_after_you).
      if (run.status === "complete") {
        run.status = run.autopilot?.enabled ? "running" : "stopped";
        run.stopReason = null;
      }
      const chain = {
        chainId,
        kind: run.kind === "execute" ? "eagle2" : "eagle1",
        step: at + 1,
        total: run.kind === "execute" ? 2 : 4,
        round: run.round,
      };
      for (const t of state.tabs) if (t.chain?.chainId === chainId) t.chain.round = run.round;
      target.chain = clone(chain);
      recordChainStep(target.id, chain, a.handoffText);
      return clone(chain);
    },
    open_chain_overview: (a) => {
      const chainId = String(a.chainId).trim();
      if (!findRun(chainId)) {
        const tagged = state.tabs
          .filter((t: Json) => t.chain?.chainId === chainId)
          .sort((x: Json, y: Json) => x.chain.step - y.chain.step);
        for (const t of tagged) recordChainStep(t.id, t.chain, null);
      }
      const run = findRun(chainId);
      if (!run) throw new Error("No open tab is on this Eagle-Eye chain.");
      if (findTab(run.overviewTabId)) {
        state.activeTabId = run.overviewTabId;
        return { tabId: run.overviewTabId, state: snapshot() };
      }
      state.tabCounter += 1;
      const tab = {
        id: `tab-${state.tabCounter}`,
        label: run.kind === "execute" ? "Eagle-Eye 2 · overview" : "Eagle-Eye 1 · overview",
        roleId: "pipeline_overview",
        cwd: run.cwd,
        phase: "draft",
        mergedPromptChars: 0,
        startupPromptSent: false,
        hasTranscript: false,
        folderStatus: run.cwd ? "ok" : "empty",
        color: "#F0B429",
        kind: "pipeline_overview",
        terminalLaunch: "",
        acpSessionId: null,
        model: null,
        provider: "claude",
        chain: null,
        pipelineRunId: run.id,
      };
      state.tabs.push(tab);
      state.activeTabId = tab.id;
      run.overviewTabId = tab.id;
      return { tabId: tab.id, state: snapshot() };
    },
    get_pipeline_run: (a) => {
      const run = findRun(String(a.runId).trim());
      if (!run) throw new Error(`unknown pipeline run: ${a.runId}`);
      return { run: { ...clone(run), originalRequest: chainOriginalRequest(run) } };
    },

    projects_list: () => ({
      favorites: [],
      recent: [{ path: state.cwd, available: true, favorite: false }],
    }),
    projects_remember: () => null,
    // Terminal file links: every asked path "exists" unless a spec overrides it.
    files_resolve: (a) => (Array.isArray(a.paths) ? a.paths : []),
    // Rendered Markdown images: a 1×1 transparent GIF for any image path.
    files_markdown_image: () => "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==",
    check_working_folder: (a) => a.path,
    workspaces_list: () => ({ workspaces: [], path: "/tmp/dct-e2e/workspaces.json" }),
    transcript_load: () => ({ text: "", cwd: state.cwd, readOnly: false, recoveredFromCorrupt: false }),
    transcript_save: () => null,
    changes_list: (a) => ({
      state: "noRepo",
      scope: a.scope,
      repoRoot: null,
      baseTree: null,
      nowTree: null,
      baselineAt: null,
      files: [],
    }),
    activity_list: (a) => clone(state.activity[a.tabId] ?? []),
    activity_clear: (a) => {
      delete state.activity[a.tabId];
      return null;
    },
    list_claude_history: () => ({
      entries: [],
      configDir: configDir.path,
      configDisplay: configDir.display,
      exists: true,
    }),
    list_cursor_cli_history: () => [],
    git_repo_info: () => {
      throw new Error("not a git repository");
    },
    session_agent_logs: () => ({ stderr: "" }),
    diagnostics_read_log: () => ({ text: "", path: "/tmp/dct-e2e/app.log" }),
    storage_status: () => ({ appDataDir: "/tmp/dct-e2e", bytes: 0 }),
    startup_notices: () => [],
  };

  // ---- Terminal tabs (e2e/ui/terminal*.spec.ts) -------------------------
  // Mirrors src-tauri/src/pty/mod.rs. shell_terminal_start and
  // role_terminal_start save a terminal tab (reusing a non-running preferred
  // tab), open its PTY and remember the folder (remember_folder). PTY output
  // goes to the Channel passed as `onOutput`; __E2E.ptySend delivers packets.
  const ptyChannels: Record<string, number> = {};
  const channelIndex: Record<number, number> = {};
  const rememberPty = (id: string, channel: Json) => {
    if (!state.ptys.includes(id)) state.ptys.push(id);
    if (channel && typeof channel.id === "number") ptyChannels[id] = channel.id;
  };
  const saveTerminalTab = (preferred: string | null, draft: Json) => {
    let tab = preferred ? findTab(preferred) : null;
    if (!tab || tab.phase === "running") {
      state.tabCounter += 1;
      tab = { id: `tab-${state.tabCounter}` };
      state.tabs.push(tab);
    }
    Object.assign(tab, {
      label: draft.label,
      roleId: draft.roleId,
      cwd: draft.cwd,
      phase: "terminal",
      mergedPromptChars: 0,
      startupPromptSent: draft.startupPromptSent,
      hasTranscript: false,
      folderStatus: "ok",
      color: draft.color,
      kind: "terminal",
      terminalLaunch: draft.launch,
      acpSessionId: null,
      resumeSessionId: draft.resumeSessionId ?? null,
      model: null,
      provider: draft.provider,
      chain: null,
    });
    state.answers[tab.id] = clone(draft.answers);
    state.activeTabId = tab.id;
    if (!state.recentFolders.includes(draft.cwd)) state.recentFolders.push(draft.cwd);
    return tab;
  };
  const folderName = (path: string) => path.split(/[\\/]/).filter(Boolean).at(-1) ?? path;
  state.recentFolders = [] as string[];
  defaults.shell_terminal_start = (a) => {
    const input = a.input;
    const launch = input.launch === "cursor-cli" || input.launch === "claude-cli" ? input.launch : "shell";
    const name = { "cursor-cli": "Cursor CLI", "claude-cli": "Claude Code", shell: "Terminal" }[launch as string];
    const resume = String(input.resumeSessionId ?? "").trim() || null;
    if (resume && launch === "shell") throw new Error("Resume is only used for a Cursor CLI or Claude Code terminal.");
    const tab = saveTerminalTab(input.tabId, {
      launch,
      cwd: input.cwd,
      label: `${name} · ${folderName(input.cwd)}`,
      roleId: launch === "shell" ? "terminal" : launch,
      color: "#2dd4bf",
      answers: resume ? { cwd: input.cwd, resumeSessionId: resume } : { cwd: input.cwd },
      resumeSessionId: resume,
      startupPromptSent: false,
      provider: launch === "cursor-cli" ? "cursor" : launch === "claude-cli" ? "claude" : undefined,
    });
    rememberPty(tab.id, a.onOutput);
    return { errors: [], tabId: tab.id, pid: 4242, usedPromptFile: false };
  };
  defaults.role_terminal_start = (a) => {
    const input = a.input;
    const role = findRole(input.roleId);
    if (!role) throw new Error(`unknown role: ${input.roleId}`);
    const cwd = String(input.values.cwd ?? "").trim();
    if (!cwd) throw new Error("cwd is required");
    const title = String(input.values.title ?? "").trim();
    const tab = saveTerminalTab(input.tabId, {
      launch: "role",
      cwd,
      label: title ? `${role.name} · ${title}` : role.name,
      roleId: role.id,
      color: role.color,
      answers: input.values,
      startupPromptSent: true,
      // A hand-off names its source's provider; otherwise the window's default.
      provider: input.provider ?? "claude",
    });
    rememberPty(tab.id, a.onOutput);
    return { errors: [], tabId: tab.id, pid: 4243, usedPromptFile: false };
  };
  const ptyOpenDefault = defaults.pty_open;
  defaults.pty_open = (a, s) => {
    rememberPty(a.input.id, a.onOutput);
    return ptyOpenDefault(a, s);
  };
  defaults.terminal_plan_file = () => null;
  const ptySend = (ptyId: string, packet: Json): boolean => {
    const channel = ptyChannels[ptyId];
    const entry = channel === undefined ? undefined : callbacks.get(channel);
    if (!entry) return false;
    const index = channelIndex[channel] ?? 0;
    channelIndex[channel] = index + 1;
    entry.fn({ index, message: packet });
    return true;
  };
  // ---- end Terminal tabs ------------------------------------------------

  // ---- Terminal chat view (e2e/ui/terminal-chat-view.spec.ts) -----------
  // Mirrors commands/session_log.rs: terminal_chat_entries answers from
  // state.chatLogs[tabId] (null until set); terminal_chat_watch keeps the
  // Channel passed as `onUpdate` and sends the whole list at once when there
  // is one. __E2E.chatSet replaces a tab's entries and sends a reset update.
  state.chatLogs = {} as Record<string, Json[]>;
  state.chatRevision = 0;
  const chatChannels: Record<string, number> = {};
  const chatUpdate = (tabId: string) => ({
    sessionId: `claude-${tabId}`,
    revision: state.chatRevision,
    reset: true,
    firstSeq: state.chatLogs[tabId]?.[0]?.seq ?? 0,
    entries: clone(state.chatLogs[tabId] ?? []),
  });
  const chatSend = (tabId: string): boolean => {
    const channel = chatChannels[tabId];
    const entry = channel === undefined ? undefined : callbacks.get(channel);
    if (!entry) return false;
    const index = channelIndex[channel] ?? 0;
    channelIndex[channel] = index + 1;
    entry.fn({ index, message: chatUpdate(tabId) });
    return true;
  };
  defaults.terminal_chat_entries = (a) => (state.chatLogs[a.tabId] ? chatUpdate(a.tabId) : null);
  defaults.terminal_chat_watch = (a) => {
    if (a.onUpdate && typeof a.onUpdate.id === "number") chatChannels[a.tabId] = a.onUpdate.id;
    if (state.chatLogs[a.tabId]) queueMicrotask(() => chatSend(a.tabId));
    return null;
  };
  defaults.terminal_chat_unwatch = (a) => {
    delete chatChannels[a.tabId];
    return null;
  };
  const chatSet = (tabId: string, entries: Json[]): boolean => {
    state.chatRevision += 1;
    state.chatLogs[tabId] = clone(entries);
    return chatSend(tabId);
  };
  // ---- end Terminal chat view -------------------------------------------

  // ---- Pipeline terminal (e2e/ui/pipeline-terminal.spec.ts) -------------
  // state_store.rs apply_terminal_draft keeps a reused tab's chain tag.
  const roleTerminalStartDefault = defaults.role_terminal_start;
  defaults.role_terminal_start = (a, s) => {
    const before = a.input.tabId ? findTab(a.input.tabId) : null;
    const chain = before && before.phase !== "running" ? clone(before.chain ?? null) : null;
    const out = roleTerminalStartDefault(a, s);
    const tab = findTab(out.tabId);
    if (tab && chain) tab.chain = chain;
    return out;
  };
  // ---- end Pipeline terminal --------------------------------------------

  // ---- Eagle-Eye data ---------------------------------------------------
  // Mirrors commands/chain_events.rs: `chain-run-updated` after the same
  // commands, and get_pipeline_run's step-1 `taskType`.
  const chainRunUpdated = (chainId: string | null | undefined) => {
    if (chainId) queueMicrotask(() => deliver("chain-run-updated", { chainId }));
  };
  const overviewRunForTab = (tabId: string): string | null =>
    findTab(tabId)?.chain?.chainId ??
    state.pipelineRuns.find((r: Json) => Object.values(r.tabIds).includes(tabId))?.id ??
    null;
  const afterCall = (cmd: string, notify: (args: Json, out: Json) => void) => {
    const base = defaults[cmd];
    defaults[cmd] = (a, s) => {
      const out = base(a, s);
      notify(a, out);
      return out;
    };
  };
  const setTabChainDefault = defaults.set_tab_chain;
  defaults.set_tab_chain = (a, s) => {
    const before = findTab(a.tabId) ? overviewRunForTab(a.tabId) : null;
    const out = setTabChainDefault(a, s);
    const after = overviewRunForTab(a.tabId);
    if (before && before !== after) chainRunUpdated(before);
    chainRunUpdated(after);
    return out;
  };
  afterCall("handoff_save", (_a, rec) => chainRunUpdated(rec?.chain?.chainId));
  afterCall("handoff_bind_tab", (_a, rec) => chainRunUpdated(rec?.chain?.chainId));
  afterCall("chain_loop_back", (_a, chain) => chainRunUpdated(chain?.chainId));
  afterCall("sync_active_tab_form", (a) => {
    if (findTab(a.tabId)?.chain?.step === 1) chainRunUpdated(overviewRunForTab(a.tabId));
  });
  afterCall("role_session_start", (_a, out) => chainRunUpdated(overviewRunForTab(out.tabId)));
  afterCall("role_terminal_start", (_a, out) => chainRunUpdated(overviewRunForTab(out.tabId)));
  afterCall("dev_session_stop", (a) => {
    if (a.tabId) chainRunUpdated(overviewRunForTab(a.tabId));
  });
  // commands/handoff.rs handoff_attach: the chain step (or loop-back) and the
  // hand-off binding in one call. It records each step under the command the
  // app used to call for it, so specs keep asserting the same data.
  defaults.handoff_attach = (a, s) => {
    const input = a.input as Json;
    if (!state.handoffs.some((h: Json) => h.id === input.id)) {
      throw new Error(`unknown hand-off: ${input.id}`);
    }
    if (!findTab(input.tabId)) throw new Error(`unknown tab: ${input.tabId}`);
    const step = (cmd: string, args: Json) => {
      calls.push({ cmd, args: clone(args) });
      return defaults[cmd](args, s);
    };
    let chain: Json = null;
    if (input.loopBack) {
      chain = step("chain_loop_back", {
        chainId: input.loopBack.chainId,
        reviewerRoleId: input.loopBack.reviewerRoleId,
        tabId: input.tabId,
        verdict: input.loopBack.verdict ?? null,
        handoffText: input.handoffText ?? null,
      });
    } else if (input.chain) {
      step("set_tab_chain", {
        tabId: input.tabId,
        chain: input.chain,
        handoffText: input.handoffText ?? null,
      });
      chain = clone(input.chain);
    }
    const record = step("handoff_bind_tab", { id: input.id, tabId: input.tabId });
    return { record, chain };
  };
  afterCall("get_pipeline_run", (_a, out) => {
    const first = PIPELINE_STAGES[out.run.kind]?.[0]?.[1];
    const tabId = first ? out.run.tabIds[first] : null;
    const taskType = String((tabId && state.answers[tabId]?.taskType) ?? "").trim();
    if (taskType) out.taskType = taskType;
  });
  // ---- end Eagle-Eye data -----------------------------------------------

  const overrides: Record<string, Handler> = {};
  const compile = (source: string): Handler =>
    new Function(`return (${source});`)() as Handler;
  for (const [cmd, value] of Object.entries(config.responses ?? {})) {
    overrides[cmd] = () => clone(value);
  }
  for (const [cmd, source] of Object.entries(config.handlers ?? {})) {
    overrides[cmd] = compile(source);
  }

  const ACTIVITY_KIND: Record<string, string> = {
    execute: "shell",
    edit: "edit",
    delete: "delete",
    fetch: "fetch",
    read: "read",
  };
  // The Rust side logs every tool call it relays (permissions/activity.rs).
  const recordActivity = (payload: Json) => {
    if (!String(payload?.kind).startsWith("tool_call")) return;
    const update = JSON.parse(payload.rawJson)?.update ?? {};
    const id = update.toolCallId;
    if (!id) return;
    const rows = (state.activity[payload.tabId] ??= []);
    let row = rows.find((r: Json) => r.id === id);
    if (!row) {
      const input = update.rawInput ?? {};
      row = {
        id,
        tabId: payload.tabId,
        time: now(),
        updatedAt: now(),
        kind: ACTIVITY_KIND[update.kind] ?? "other",
        title: update.title ?? "",
        summary: input.command ?? input.file_path ?? input.url ?? update.title ?? "",
        decision: "auto_allow",
        network: !!input.url,
        status: update.status ?? "pending",
      };
      rows.push(row);
    } else {
      row.status = update.status ?? row.status;
      row.updatedAt = now();
    }
  };

  const deliver = (event: string, payload: Json) => {
    if (event === "acp/session-update") recordActivity(payload);
    for (const { eventId, handler } of [...(listeners[event] ?? [])]) {
      const entry = callbacks.get(handler);
      if (!entry) continue;
      if (entry.once) callbacks.delete(handler);
      entry.fn({ event, id: eventId, payload });
    }
  };
  const unlisten = (event: string, eventId: number) => {
    listeners[event] = (listeners[event] ?? []).filter((l) => l.eventId !== eventId);
  };

  async function invoke(cmd: string, args: Json = {}): Promise<Json> {
    const plain: Json = {};
    for (const [k, v] of Object.entries(args ?? {})) {
      // Channels are objects with an id; record the id only.
      plain[k] = v && typeof v === "object" && "id" in (v as object) && "onmessage" in (v as object)
        ? { channel: (v as Json).id }
        : v;
    }
    calls.push({ cmd, args: clone(plain) });
    if (cmd === "plugin:event|listen") {
      const eventId = nextEventId++;
      (listeners[args.event] ??= []).push({ eventId, handler: args.handler });
      return eventId;
    }
    if (cmd === "plugin:event|unlisten") {
      unlisten(args.event, args.eventId);
      return null;
    }
    if (cmd === "plugin:event|emit" || cmd === "plugin:event|emit_to") {
      deliver(args.event, args.payload);
      return null;
    }
    const handler = overrides[cmd] ?? defaults[cmd];
    if (handler) {
      try {
        return clone(await handler(args, state));
      } catch (err) {
        throw err instanceof Error ? err.message : String(err);
      }
    }
    // homeDir() from @tauri-apps/api/path (the new-tab folder fallback).
    if (cmd === "plugin:path|resolve_directory") return "/tmp/dct-e2e/home";
    if (cmd.startsWith("plugin:")) return null;
    if (config.strict) throw `e2e mock: no handler for ${cmd}`;
    return null;
  }

  (window as Json).__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: unlisten };
  (window as Json).__TAURI_INTERNALS__ = {
    invoke,
    transformCallback(fn: (payload: Json) => void, once = false) {
      const id = nextCallback++;
      callbacks.set(id, { fn, once });
      return id;
    },
    unregisterCallback(id: number) {
      callbacks.delete(id);
    },
    convertFileSrc: (path: string) => path,
    metadata: {
      currentWindow: { label: "main" },
      currentWebview: { label: "main", windowLabel: "main" },
    },
  };
  (window as Json).__E2E = {
    state,
    calls,
    emit: deliver,
    listenerCount: (event: string) => (listeners[event] ?? []).length,
    respond(cmd: string, value: Json) {
      overrides[cmd] = () => clone(value);
    },
    handle(cmd: string, source: string) {
      overrides[cmd] = compile(source);
    },
    // Terminal tabs: one PtyPacket to the channel of PTY `ptyId`.
    ptySend,
    // Terminal chat view: replace a tab's chat entries and send them to its watch.
    chatSet,
  };
}
