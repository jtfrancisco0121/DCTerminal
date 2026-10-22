import { pipelineDef, stageBehaviour, type PipelineDef, type RoleBehaviour } from "./defs";

/** The Eagle-mode chains a form start can begin: Planner first, Implementer first, and (F2) Analyst first. */
const EAGLE_CHAINS = ["eagle1", "eagle2", "eagle-eye-l"] as const;
export type EagleChain = (typeof EAGLE_CHAINS)[number];

const OPENS_WITH: Readonly<Record<EagleChain, RoleBehaviour>> = {
  eagle1: "planner",
  eagle2: "implementer",
  "eagle-eye-l": "artifact",
};

/**
 * The Eagle-mode chain a form start of `roleId` begins (V2b), else null:
 * the chain whose first stage holds `roleId` and is a Planner (Eagle-Eye 1)
 * or Implementer (Eagle-Eye 2) stage by its kind, so a copied role begins
 * it exactly like the built-in one. The core plans that first stage as the
 * engine-2 run it is about to make (`startChain`).
 */
export function eagleStartChain(
  roleId: string,
  defs: readonly (PipelineDef | null)[] = EAGLE_CHAINS.map((kind) => pipelineDef(kind)),
): EagleChain | null {
  for (const def of defs) {
    const kind = EAGLE_CHAINS.find((k) => k === def?.id);
    const first = def?.stages[0];
    if (!def || !kind || !first || first.roleId !== roleId) continue;
    if (stageBehaviour(def, first) === OPENS_WITH[kind]) return kind;
  }
  return null;
}
