import { describe, expect, it } from "vitest";
import { createSwitchTickets } from "./tabSwitch";

describe("createSwitchTickets", () => {
  it("applies only the second of two overlapping switches", async () => {
    const tickets = createSwitchTickets();
    const shown: string[] = [];
    let answerB!: () => void;
    const switchTo = async (id: string, answer: Promise<void>) => {
      const ticket = tickets.begin();
      await answer;
      if (ticket.isCurrent()) shown.push(id);
    };
    const b = switchTo("B", new Promise<void>((resolve) => (answerB = resolve)));
    const c = switchTo("C", Promise.resolve());
    await c;
    answerB();
    await b;
    expect(shown).toEqual(["C"]);
  });

  it("keeps a lone switch current", () => {
    const ticket = createSwitchTickets().begin();
    expect(ticket.isCurrent()).toBe(true);
  });

  it("a watcher goes stale once a switch begins, and does not end one itself", () => {
    const tickets = createSwitchTickets();
    const running = tickets.begin();
    const watcher = tickets.watch();
    expect(running.isCurrent()).toBe(true);
    expect(watcher.isCurrent()).toBe(true);
    tickets.begin();
    expect(watcher.isCurrent()).toBe(false);
    expect(running.isCurrent()).toBe(false);
  });
});
