import type { ToolStatus } from "./transcript";

export type PlanEntry = {
  content: string;
  status: string;
  priority?: string;
};

export type TodoItem = {
  id: string;
  content: string;
  status: string;
};

export type TaskUpdate = {
  agentId: string;
  description: string;
  status: string;
  model?: string;
  durationMs?: number;
};

export type SessionCards = {
  plan: PlanEntry[];
  todos: TodoItem[];
  tasks: TaskUpdate[];
  /** Permission mode the agent last reported (`current_mode_update` or the
   * `mode` entry of a `config_option_update`). */
  mode?: string;
};

export function emptySessionCards(): SessionCards {
  return { plan: [], todos: [], tasks: [] };
}

type Raw = Record<string, unknown>;

function asRecord(value: unknown): Raw | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return value as Raw;
}

function textOf(value: unknown): string {
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return "";
}

function normalizePlan(value: unknown): PlanEntry | null {
  const row = asRecord(value);
  if (!row) {
    const content = textOf(value);
    return content ? { content, status: "pending" } : null;
  }
  const content =
    textOf(row.content) || textOf(row.title) || textOf(row.text) || textOf(row.description);
  if (!content) return null;
  return {
    content,
    status: textOf(row.status) || "pending",
    priority: textOf(row.priority) || undefined,
  };
}

function normalizeTodo(value: unknown, index: number): TodoItem | null {
  const row = asRecord(value);
  if (!row) {
    const content = textOf(value);
    return content ? { id: `todo_${index}`, content, status: "pending" } : null;
  }
  const content = textOf(row.content) || textOf(row.title) || textOf(row.text);
  if (!content) return null;
  const id = textOf(row.id) || textOf(row.todoId) || `todo_${index}`;
  return { id, content, status: textOf(row.status) || "pending" };
}

function normalizeTask(value: Raw): TaskUpdate | null {
  const agentId =
    textOf(value.agentId) || textOf(value.agent_id) || textOf(value.id);
  const description =
    textOf(value.description) || textOf(value.title) || textOf(value.task);
  if (!agentId && !description) return null;
  const duration = value.durationMs ?? value.duration_ms;
  return {
    agentId: agentId || description,
    description: description || agentId,
    status: textOf(value.status) || textOf(value.type) || "running",
    model: textOf(value.model) || undefined,
    durationMs: typeof duration === "number" ? duration : undefined,
  };
}

function entriesFrom(raw: Raw): unknown[] | null {
  const update = asRecord(raw.update) ?? raw;
  const plan = asRecord(update.plan);
  const candidates = [update.entries, plan?.entries, raw.entries, asRecord(raw.params)?.entries];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

function modeFrom(update: Raw): string | null {
  const kind = textOf(update.sessionUpdate);
  if (kind === "current_mode_update") {
    const id = textOf(update.currentModeId ?? update.modeId);
    return id || null;
  }
  if (kind === "config_option_update" && Array.isArray(update.configOptions)) {
    for (const option of update.configOptions) {
      const rec = asRecord(option);
      if (rec && (rec.id === "mode" || rec.category === "mode")) {
        const value = textOf(rec.currentValue);
        if (value) return value;
      }
    }
  }
  return null;
}

/** Short label for an agent permission mode id. */
export function modeLabel(mode: string): string {
  switch (mode) {
    case "default":
      return "Manual";
    case "acceptEdits":
      return "Accept edits";
    case "plan":
      return "Plan";
    case "auto":
      return "Auto";
    case "bypassPermissions":
      return "Full access";
    default:
      return mode;
  }
}

function todosFrom(raw: Raw): unknown[] | null {
  const update = asRecord(raw.update) ?? raw;
  const params = asRecord(raw.params);
  const candidates = [update.todos, raw.todos, params?.todos];
  for (const candidate of candidates) {
    if (Array.isArray(candidate)) return candidate;
  }
  return null;
}

export function reduceSessionCards(
  cards: SessionCards,
  evt: { kind: string; rawJson: string },
): SessionCards {
  let raw: Raw;
  try {
    raw = JSON.parse(evt.rawJson) as Raw;
  } catch {
    return cards;
  }
  const update = asRecord(raw.update) ?? asRecord(raw.params) ?? raw;
  const kind = `${evt.kind} ${textOf(update.sessionUpdate)} ${textOf(update.type)}`.toLowerCase();

  const mode = modeFrom(update);
  if (mode) return { ...cards, mode };

  if (kind.includes("plan")) {
    const entries = entriesFrom(raw);
    if (entries) {
      return {
        ...cards,
        plan: entries
          .map(normalizePlan)
          .filter((entry): entry is PlanEntry => entry !== null),
      };
    }
  }

  if (kind.includes("todo")) {
    const todos = todosFrom(raw);
    if (todos) {
      return {
        ...cards,
        todos: todos
          .map(normalizeTodo)
          .filter((item): item is TodoItem => item !== null),
      };
    }
  }

  if (kind.includes("task") || kind.includes("subagent")) {
    const task = normalizeTask(update);
    if (!task) return cards;
    const idx = cards.tasks.findIndex((item) => item.agentId === task.agentId);
    const tasks = [...cards.tasks];
    if (idx >= 0) tasks[idx] = { ...tasks[idx], ...task };
    else tasks.push(task);
    return { ...cards, tasks };
  }

  return cards;
}

export type ToolProgress = {
  text: string;
  status: ToolStatus | "unknown";
};

export function activeToolProgress(
  segments: { kind: string; text: string; toolStatus?: ToolStatus }[],
): ToolProgress[] {
  return segments
    .filter((seg) => seg.kind === "tool" && seg.text.trim())
    .slice(-8)
    .map((seg) => ({
      text: seg.text,
      status: seg.toolStatus ?? "unknown",
    }));
}

/** The last agent message with text. Chat shows the hand-off buttons under
 * it, so the session cards do not repeat them while it exists. */
export function lastAgentSegmentId(
  segments: readonly { id: string; kind: string; text: string }[],
): string | null {
  for (let i = segments.length - 1; i >= 0; i -= 1) {
    if (segments[i].kind === "agent" && segments[i].text.trim()) return segments[i].id;
  }
  return null;
}
