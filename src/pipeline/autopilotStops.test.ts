import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AutopilotStoppedEvent } from "../bridge";

let handler: ((event: AutopilotStoppedEvent) => void) | null = null;
let attach: () => void = () => {};
const unlisten = vi.fn();

vi.mock("../bridge", () => ({
  listenAutopilotStopped: vi.fn(
    (h: (event: AutopilotStoppedEvent) => void) =>
      new Promise<() => void>((resolve) => {
        attach = () => {
          handler = h;
          resolve(() => unlisten());
        };
      }),
  ),
  autopilotPendingStops: vi.fn(async () => [] as AutopilotStoppedEvent[]),
}));

import { autopilotPendingStops } from "../bridge";
import { subscribeAutopilotStops } from "./autopilotStops";

const restarted: AutopilotStoppedEvent = {
  runId: "ee_1",
  tabId: "impl",
  reason: "app_restarted",
  summary: "Implementer finished while the app was closed",
};

describe("subscribeAutopilotStops", () => {
  beforeEach(() => {
    handler = null;
    unlisten.mockReset();
    vi.mocked(autopilotPendingStops).mockReset().mockResolvedValue([]);
  });

  it("asks for held stops only once the listener is attached and this window's tabs are known, naming them", async () => {
    vi.mocked(autopilotPendingStops).mockResolvedValue([restarted]);
    const onStop = vi.fn();
    let tabsKnown: (ids: string[]) => void = () => {};
    subscribeAutopilotStops(onStop, new Promise((resolve) => (tabsKnown = resolve)));
    await Promise.resolve();
    attach();
    await new Promise((r) => setTimeout(r, 0));
    expect(autopilotPendingStops).not.toHaveBeenCalled();
    tabsKnown(["impl", "review"]);
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledWith(restarted));
    expect(autopilotPendingStops).toHaveBeenCalledTimes(1);
    expect(autopilotPendingStops).toHaveBeenCalledWith(["impl", "review"]);
    // A live event still arrives through the listener.
    handler?.({ ...restarted, runId: "ee_2", reason: "stalled" });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("waits for the listener even when the tabs are known first", async () => {
    const onStop = vi.fn();
    subscribeAutopilotStops(onStop, Promise.resolve(["impl"]));
    await new Promise((r) => setTimeout(r, 0));
    expect(autopilotPendingStops).not.toHaveBeenCalled();
    attach();
    await vi.waitFor(() => expect(autopilotPendingStops).toHaveBeenCalledWith(["impl"]));
  });

  it("stops listening and drops held stops when disposed before they arrive", async () => {
    vi.mocked(autopilotPendingStops).mockResolvedValue([restarted]);
    const onStop = vi.fn();
    const dispose = subscribeAutopilotStops(onStop, Promise.resolve(["impl"]));
    dispose();
    attach();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
    expect(autopilotPendingStops).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });
});
