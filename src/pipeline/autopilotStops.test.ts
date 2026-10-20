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

  it("delivers a stop the core made before the listener attached, once the listener is attached", async () => {
    vi.mocked(autopilotPendingStops).mockResolvedValue([restarted]);
    const onStop = vi.fn();
    subscribeAutopilotStops(onStop);
    await Promise.resolve();
    expect(autopilotPendingStops).not.toHaveBeenCalled();
    attach();
    await vi.waitFor(() => expect(onStop).toHaveBeenCalledWith(restarted));
    expect(autopilotPendingStops).toHaveBeenCalledTimes(1);
    // A live event still arrives through the listener.
    handler?.({ ...restarted, runId: "ee_2", reason: "stalled" });
    expect(onStop).toHaveBeenCalledTimes(2);
  });

  it("stops listening and drops held stops when disposed before they arrive", async () => {
    vi.mocked(autopilotPendingStops).mockResolvedValue([restarted]);
    const onStop = vi.fn();
    const dispose = subscribeAutopilotStops(onStop);
    dispose();
    attach();
    await vi.waitFor(() => expect(unlisten).toHaveBeenCalled());
    expect(autopilotPendingStops).not.toHaveBeenCalled();
    expect(onStop).not.toHaveBeenCalled();
  });
});
