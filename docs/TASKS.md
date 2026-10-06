# DCTerminal — implementation task list

Checklist aligned with [DCTerminal-Project-Blueprint.md](./DCTerminal-Project-Blueprint.md) §23. Update checkboxes as work lands; mirror status in [PROGRESS.md](./PROGRESS.md).

**Legend:** `[ ]` todo · `[~]` in progress · `[x]` done · `[-]` skipped/deferred

---

## Phase 0 — Spikes & decisions (2–3 days)

| ID | Task | Output | Status |
|----|------|--------|--------|
| T0.0 | Repo scaffold: Tauri 2, React+TS, folders per §30, CI stub | Runnable `npm run build`; `src-tauri/` layout | [x] |
| T0.1 | Spawn `agent acp` with piped stdio (Win shim, macOS PATH) | Notes in `docs/acp-observed.md` | [x] |
| T0.2 | Measure RAM/startup per `agent acp` process | Metrics for ADR-003 | [ ] |
| T0.3 | Protocol probe: record JSON-RPC transcripts | `docs/acp-observed.md` + `fixtures/acp/*.ndjson` | [x] |
| T0.4 | Evaluate Rust `agent-client-protocol` crate vs hand-rolled; React vs Svelte | ADR updates in `docs/adr/` | [ ] |
| T0.5 | Placeholder grammar on five real templates | Confirmed schemas in `seed/roles.seed.json` | [x] |

**Prerequisites:** Rust toolchain, Cursor CLI (`agent login`), WebView2 (Windows).

---

## Phase 1 — Core plumbing (week 1)

| ID | Task | FR / ref | Status |
|----|------|----------|--------|
| T1.1 | CLI detector | FR-001 | [x] |
| T1.2 | Agent process supervisor (cwd, pipes, stderr ring, kill) | FR-002, FR-034, NFR-03 | [~] |
| T1.3 | ACP client (NDJSON, ids, timeouts, unknown-method -32601) | FR-003–008, FR-011 | [~] |
| T1.4 | `Store` trait + JSON (atomic, `.bak`, migrations, `forms.json`) | §17 | [~] (`state.json` slice) |
| T1.5 | Template engine (extract, validate, merge, guard) + golden tests | FR-090–095, NFR-10 | [~] |
| T1.6 | Repo lint + CI matrix (Win/macOS/Linux) | §25 | [ ] |

---

## Phase 2 — Single-tab vertical slice (week 2)

| ID | Task | FR / ref | Status |
|----|------|----------|--------|
| T2.1 | Orchestrator FSM incl. `AwaitingInput` | FR-033 | [~] |
| T2.2 | Tauri commands/events bridge | §16.3 | [~] |
| T2.3 | Seed five roles; snapshot; `send_on_start` injection | FR-020, FR-022, FR-025 | [~] |
| T2.4 | Input box + Send | FR-052, FR-054 | [ ] |
| T2.5 | Scratch pad + Transfer | FR-050, FR-053 | [ ] |
| T2.6 | Transcript renderer (MD, tools, plan, startup prompt) | FR-006 | [~] |
| T2.7 | Permission card; error/empty/loading; auth guidance | FR-007, FR-081 | [~] |
| T2.8 | Schema-driven startup form | FR-092, FR-093, FR-101 | [~] |

---

## Phase 3 — Multi-tab, roles, forms (weeks 3–4)

| ID | Task | FR / ref | Status |
|----|------|----------|--------|
| T3.1 | Role picker (digits 1–5, folder-only compact) | FR-030, FR-101 | [ ] |
| T3.2 | Role editor + schema confirmation UI | FR-021, FR-091 | [ ] |
| T3.3 | Mode setting + header switcher | FR-009 | [ ] |
| T3.4 | Tab manager (badges, restore `AwaitingInput`, restart) | FR-031–038, FR-100 | [~] |
| T3.5 | Cursor extension UIs (plan, question, todos, task) | FR-010 | [ ] |
| T3.6 | Form extras (conditional, preview, recall, drafts) | FR-094–098, FR-102 | [~] |

---

## Phase 4 — Polish & hardening (week 5)

| ID | Task | FR / ref | Status |
|----|------|----------|--------|
| T4.1 | Keymap service + §18 hotkeys | FR-061 | [ ] |
| T4.2 | Global scratch + settings screen | FR-051, FR-060 | [ ] |
| T4.3 | Log drawer + rolling logs + redacted trace | FR-080 | [ ] |
| T4.4 | Edge cases E1–E32 | §20 | [ ] |
| T4.5 | Performance (virtualization, large fields) | NFR-01 | [ ] |

---

## Phase 5 — Package & verify (weeks 6–7)

| ID | Task | Ref | Status |
|----|------|-----|--------|
| T5.1 | Installers via CI + install docs | §25 | [ ] |
| T5.2 | Acceptance run §21 per OS | §24 | [ ] |
| T5.3 | README (prereqs, `agent login`, data dir, troubleshooting) | — | [ ] |

---

## Phase 6+ — P2 backlog (after MVP)

- [x] `session/load` resume (Continue). Live probe on CLI 2026.10.01: load works; `agent --resume` does not open ACP ids — [cursor-cli-history.md](./cursor-cli-history.md)
- [ ] Plan hand-off (Planner → Implementer / PR Reviewer)
- [ ] Custom roles, keymap UI, notifications, transcript export, input history

---

## Testing milestones (from §24)

| Milestone | Status |
|-----------|--------|
| Template engine golden + proptest (P0) | [ ] |
| Fake ACP agent scenarios (P0) | [ ] |
| Orchestrator FSM tests (P0) | [ ] |
| Store corruption/migration tests (P0) | [ ] |
| Vitest form/transfer/keymap (P1) | [ ] |
| WebdriverIO + tauri-driver E2E (P1) | [ ] |
| Live smoke per OS before release (P0) | [ ] |

---

## Content still needed from JT

- [ ] Five role template texts committed verbatim to `seed/roles.seed.json`
- [ ] Confirm extracted fields after T0.5 (blueprint Q2–Q4)
