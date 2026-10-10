import type { Role, TabSummary } from "../../../src/bridge";

export type MockConfig = {
  cwd: string;
  roles: Role[];
  tabs: TabSummary[];
  activeTabId: string | null;
  /** Saved form answers per tab id (`get_tab` → `answers`). */
  answers?: Record<string, Record<string, string>>;
  /** Command → fixed response (deep-cloned per call). */
  responses?: Record<string, unknown>;
  /** Command → handler source `(args, state) => value`, compiled in the page. */
  handlers?: Record<string, string>;
  /** Reject commands that have no handler instead of resolving null. */
  strict?: boolean;
};

export type InvokeCall = { cmd: string; args: Record<string, unknown> };
