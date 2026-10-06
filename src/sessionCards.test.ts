import { describe, expect, it } from "vitest";
import {
  activeToolProgress,
  emptySessionCards,
  reduceSessionCards,
} from "./sessionCards";

describe("session view cards", () => {
  it("replaces the plan from an ACP plan update", () => {
    const cards = reduceSessionCards(emptySessionCards(), {
      kind: "plan",
      rawJson: JSON.stringify({
        update: {
          sessionUpdate: "plan",
          entries: [
            { content: "Read auth.ts", status: "completed", priority: "high" },
            { content: "Add a test", status: "pending" },
          ],
        },
      }),
    });
    expect(cards.plan).toEqual([
      { content: "Read auth.ts", status: "completed", priority: "high" },
      { content: "Add a test", status: "pending", priority: undefined },
    ]);
  });

  it("replaces todos from cursor/update_todos", () => {
    const cards = reduceSessionCards(emptySessionCards(), {
      kind: "cursor/update_todos",
      rawJson: JSON.stringify({
        todos: [
          { id: "1", content: "Write the store", status: "in_progress" },
          { id: "2", content: "Run tests", status: "pending" },
        ],
      }),
    });
    expect(cards.todos.map((t) => t.content)).toEqual(["Write the store", "Run tests"]);
  });

  it("upserts sub-agent task updates by agent id", () => {
    const spawned = reduceSessionCards(emptySessionCards(), {
      kind: "cursor/task",
      rawJson: JSON.stringify({
        agentId: "agent_1",
        description: "Explore tests",
        status: "running",
        model: "composer",
      }),
    });
    const done = reduceSessionCards(spawned, {
      kind: "cursor/task",
      rawJson: JSON.stringify({
        agentId: "agent_1",
        description: "Explore tests",
        status: "completed",
        durationMs: 1200,
      }),
    });
    expect(done.tasks).toHaveLength(1);
    expect(done.tasks[0].status).toBe("completed");
    expect(done.tasks[0].durationMs).toBe(1200);
  });

  it("lists recent tool progress", () => {
    const tools = activeToolProgress([
      { kind: "tool", text: "Read auth.ts", toolStatus: "completed" },
      { kind: "agent", text: "hello" },
      { kind: "tool", text: "npm test", toolStatus: "in_progress" },
    ]);
    expect(tools).toEqual([
      { text: "Read auth.ts", status: "completed" },
      { text: "npm test", status: "in_progress" },
    ]);
  });
});
