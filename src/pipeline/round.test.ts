import { describe, expect, it } from "vitest";
import { mergeOrderLines, roundCountText, roundRows } from "./round";
import { exampleRound, plan } from "./roundFixture";

describe("round summary (R1)", () => {
  it("lists plans by wave, active before parked, and deferred plans last with their reason", () => {
    const rows = roundRows(exampleRound());
    expect(rows.map((r) => r.id)).toEqual(["plan1", "plan5", "plan2", "plan4", "plan6", "plan3", "plan7", "plan8"]);
    expect(rows.find((r) => r.id === "plan8")).toMatchObject({ wave: "—", status: "deferred", reason: "The fix is in the gateway, not our repos." });
    expect(rows.find((r) => r.id === "plan3")).toMatchObject({ wave: "Wave 3", reason: "Waits on the timestamp UI decision." });
    expect(rows[0].reason).toBe("");
  });

  it("counts plans by status, waves, tickets and excluded tickets", () => {
    expect(roundCountText(exampleRound())).toBe("8 plans (6 active, 1 parked, 1 deferred) · 4 waves · 9 tickets · 1 excluded");
    const one = { ...exampleRound(), plans: [plan("plan1", 1)], waves: [{ n: 1, why: "Only" }], excluded: [] };
    expect(roundCountText(one)).toBe("1 plan (1 active) · 1 wave · 1 ticket");
  });

  it("shows each repo's merge order", () => {
    expect(mergeOrderLines(exampleRound())).toEqual([
      { repo: "backend", order: "plan1 → plan2 → plan4 → plan3" },
      { repo: "desktop", order: "plan4 → plan6 → plan7" },
      { repo: "engine", order: "plan5 → plan2 → plan3" },
      { repo: "web", order: "plan4 → plan7" },
    ]);
  });
});
