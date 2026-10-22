/**
 * F3: run sizes. A size picks one of the built-in Eagle-Eye pipelines; it
 * adds no engine logic of its own:
 *
 * - **S**: Eagle-Eye 2 (Implementer → PR Reviewer), for a fix or a small change.
 * - **M**: Eagle-Eye 1 (Planner → Plan Reviewer → Implementer → PR Reviewer).
 * - **L**: Eagle-Eye L (Analyst → PM → Architect, then Eagle-Eye 1), for a big new feature.
 *
 * The start screen suggests a size from the task text and the ClickUp
 * tickets taken in (`suggestSize`), and you can pick another. Pure and tested.
 */
import { pipelineDef } from "./defs";

export type RunSize = "S" | "M" | "L";

export const RUN_SIZES: readonly RunSize[] = ["S", "M", "L"];

/** The built-in pipeline each size starts (as `SIZES` in `pipelines/sizes.rs`). */
export const SIZE_PIPELINE: Readonly<Record<RunSize, "eagle2" | "eagle1" | "eagle-eye-l">> = {
  S: "eagle2",
  M: "eagle1",
  L: "eagle-eye-l",
};

/** What each size means, for the picker. */
export const SIZE_LABEL: Readonly<Record<RunSize, string>> = {
  S: "Implement, then review",
  M: "Plan, review the plan, implement, review",
  L: "Brief, PRD and architecture first, then M",
};

/** The size a pipeline (chain kind or run kind) is, or null for any other pipeline. */
export function sizeOfPipeline(kind: string | null | undefined): RunSize | null {
  const def = pipelineDef(kind);
  if (!def) return null;
  return RUN_SIZES.find((size) => SIZE_PIPELINE[size] === def.id) ?? null;
}

/** The role a size's run starts with: its pipeline's first stage. */
export function firstRoleOfSize(size: RunSize): string | null {
  return pipelineDef(SIZE_PIPELINE[size])?.stages[0]?.roleId ?? null;
}

/** A size read back from a run (`run.size`), or null when it is not one. */
export function parseRunSize(value: unknown): RunSize | null {
  return value === "S" || value === "M" || value === "L" ? value : null;
}

export type SizeInput = {
  /** The task as typed or dictated: title, request, expected behaviour, … */
  text: string;
  /** Tickets ticked in the ClickUp box (C2); 0 when none. */
  tickets: number;
};

export type SizeSuggestion = { size: RunSize; why: string };

/** Words that mean new work big enough for a brief and a PRD. */
const LARGE_WORDS = [
  "new feature",
  "new tab",
  "new page",
  "new screen",
  "new view",
  "new module",
  "new service",
  "new app",
  "new integration",
  "from scratch",
  "redesign",
  "epic",
  "prd",
  "architecture",
];

/** Words that mean a fix or a small change. */
const SMALL_WORDS = ["fix", "bug", "typo", "crash", "regression", "hotfix", "rename", "bump", "broken", "small change", "tweak"];

/** Text this long reads as a large request even with no telling word. */
export const LONG_TEXT_CHARS = 3000;
/** Text this short with a fix word is a small change. */
export const SHORT_TEXT_CHARS = 600;
/** This many tickets need a plan that splits them. */
export const PLAN_TICKETS = 3;

function firstWord(text: string, words: readonly string[]): string | null {
  return (
    words.find((word) => {
      const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return new RegExp(`(^|[^a-z0-9])${escaped}(e[sd]|s|ed|ing)?($|[^a-z0-9])`).test(text);
    }) ?? null
  );
}

/**
 * The size the start screen suggests, and why, in order:
 * a new-feature word (or a very long request) is L; several tickets are M,
 * since a plan has to split them; a short request with a fix word (or one
 * or two tickets with one) is S; anything else is M.
 */
export function suggestSize(input: SizeInput): SizeSuggestion {
  const text = input.text.trim().toLowerCase();
  const tickets = Math.max(0, Math.floor(input.tickets));
  const large = firstWord(text, LARGE_WORDS);
  const small = firstWord(text, SMALL_WORDS);
  if (large) return { size: "L", why: `it mentions "${large}"` };
  if (text.length >= LONG_TEXT_CHARS) return { size: "L", why: "the request is long" };
  if (tickets >= PLAN_TICKETS) return { size: "M", why: `${tickets} tickets need a plan that splits them` };
  if (small && text.length <= SHORT_TEXT_CHARS) {
    return { size: "S", why: tickets > 0 ? `${tickets === 1 ? "one ticket" : "two tickets"} and it mentions "${small}"` : `it mentions "${small}"` };
  }
  return { size: "M", why: text ? "a change that needs a plan" : "the default" };
}

/** What the start screen shows for the size picker (null: no picker). */
export type StartSizeView = {
  /** The pipeline the start begins with this role. */
  chain: string;
  /** Its size: the picker's selection. */
  value: RunSize | null;
  suggestion: SizeSuggestion;
};

/**
 * The size picker for a start of `chain` (the Eagle-Eye chain the role
 * begins, `eagleStartChain`), with Eagle-Eye ticked; null otherwise. The
 * picked size is the chain's, so the picker never disagrees with what
 * Start begins.
 */
export function startSizeView(
  chain: string | null,
  eagleOn: boolean,
  values: Readonly<Record<string, string>>,
  tickets: number,
): StartSizeView | null {
  if (!eagleOn || !chain) return null;
  return { chain, value: sizeOfPipeline(chain), suggestion: suggestSize({ text: sizeText(values), tickets }) };
}

/** The role to switch the start form to for `size`, or null when `roleId` already starts it. */
export function roleForSize(size: RunSize, roleId: string): string | null {
  const role = firstRoleOfSize(size);
  return role && role !== roleId ? role : null;
}

/** The size a start records on its new run: the size of the chain it begins, if it has one. */
export function startRunSize(startChain: string | null | undefined): RunSize | null {
  return startChain ? sizeOfPipeline(startChain) : null;
}

/** The overview's size line (`Size L: Brief, PRD and architecture first, then M`), or null for a run with no size. */
export function sizeMeta(run: { size?: string | null }): string | null {
  const size = parseRunSize(run.size);
  return size ? `Size ${size}: ${SIZE_LABEL[size]}` : null;
}

/** The text a size is suggested from: the start form's task fields. */
export function sizeText(values: Readonly<Record<string, string>>): string {
  return ["title", "request", "description", "expectedBehavior", "currentBehavior"]
    .map((key) => values[key] ?? "")
    .filter((part) => part.trim())
    .join("\n");
}
