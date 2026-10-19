import { describe, expect, it } from "vitest";
import { createSwitchTickets } from "./tabSwitch";

describe("createSwitchTickets", () => {
  it("applies only the second of two overlapping switches", async () => {
    const tickets = createSwitchTickets();
    const shown: string[] = [];
    let answerB!: () => void;
    const switchTo = async (id: string, answer: Promise<void>) => {
      const ticket = tickets.begin(id);
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
    const ticket = createSwitchTickets().begin("B");
    expect(ticket.isCurrent()).toBe(true);
    expect(ticket.finish()).toBe(true);
  });

  it("a watcher goes stale once a switch begins, and does not end one itself", () => {
    const tickets = createSwitchTickets();
    const running = tickets.begin("B");
    const watcher = tickets.watch();
    expect(running.isCurrent()).toBe(true);
    expect(watcher.isCurrent()).toBe(true);
    tickets.begin("C");
    expect(watcher.isCurrent()).toBe(false);
    expect(running.isCurrent()).toBe(false);
  });

  it("only the newest switch ends the busy state", () => {
    const tickets = createSwitchTickets();
    const b = tickets.begin("B");
    const c = tickets.begin("C");
    expect(b.finish()).toBe(false);
    expect(c.finish()).toBe(true);
  });

  it("staying on the shown tab drops a switch to another tab that is still loading", () => {
    const tickets = createSwitchTickets();
    const b = tickets.begin("B");
    expect(tickets.stayOn("A")).toBe(true);
    expect(b.isCurrent()).toBe(false);
    expect(b.finish()).toBe(false);
    // Nothing is loading any more.
    expect(tickets.stayOn("A")).toBe(false);
  });

  it("staying on the tab a switch is loading keeps that switch", () => {
    const tickets = createSwitchTickets();
    const t = tickets.begin("T");
    expect(tickets.stayOn("T")).toBe(false);
    expect(t.isCurrent()).toBe(true);
  });

  it("staying on a tab with no switch loading changes nothing", () => {
    const tickets = createSwitchTickets();
    const done = tickets.begin("B");
    done.finish();
    const watcher = tickets.watch();
    expect(tickets.stayOn("B")).toBe(false);
    expect(watcher.isCurrent()).toBe(true);
  });
});
