import { describe, expect, it } from "vitest";

describe("StartupForm uses useBridgeNeeds at every point", () => {
  it("feeds it log reads, screen dialogs and the terminal states", async () => {
    // @ts-expect-error type error without @types/node package
    const { readFileSync } = await import("node:fs");
    const source: string = readFileSync(new URL("../StartupForm.tsx", import.meta.url), "utf8");
    expect(source).toContain("useBridgeNeeds(");
    expect(source).toMatch(/afterRead: bridgeNeedsAfterLogRead, afterDialog: bridgeNeedsAfterScreen/);
    expect(source).toMatch(/bridgeNeedsAfterLogRead\(tabId, log, readAt\)/);
    expect(source).toMatch(/dialogDetector\.subscribe\([\s\S]*bridgeNeedsAfterScreen\(id, visible\)/);
    expect(source).toMatch(/bridgeNeeds: bridgeNeeds\.markOf\(tab\.id\)/);
    expect(source).toMatch(/bridgeNeeds\.version/);
  });
});
