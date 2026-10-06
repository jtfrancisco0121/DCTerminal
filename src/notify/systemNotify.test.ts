import { beforeEach, describe, expect, it, vi } from "vitest";

const plugin = vi.hoisted(() => ({
  isPermissionGranted: vi.fn(async () => false),
  requestPermission: vi.fn(async () => "granted" as string),
  sendNotification: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-notification", () => plugin);

import { resetSystemNotifyForTests, showSystemNotification } from "./systemNotify";

beforeEach(() => {
  resetSystemNotifyForTests();
  plugin.isPermissionGranted.mockReset().mockResolvedValue(false);
  plugin.requestPermission.mockReset().mockResolvedValue("granted");
  plugin.sendNotification.mockReset();
});

describe("showSystemNotification", () => {
  it("sends when permission is already granted", async () => {
    plugin.isPermissionGranted.mockResolvedValue(true);
    await expect(showSystemNotification("T", "B")).resolves.toBe(true);
    expect(plugin.requestPermission).not.toHaveBeenCalled();
    expect(plugin.sendNotification).toHaveBeenCalledWith({ title: "T", body: "B" });
  });

  it("asks once, then stops asking after a denial", async () => {
    plugin.requestPermission.mockResolvedValue("denied");
    await expect(showSystemNotification("T", "B")).resolves.toBe(false);
    await expect(showSystemNotification("T", "B")).resolves.toBe(false);
    expect(plugin.requestPermission).toHaveBeenCalledTimes(1);
    expect(plugin.sendNotification).not.toHaveBeenCalled();
  });

  it("asks again when the user explicitly requests it", async () => {
    plugin.requestPermission.mockResolvedValueOnce("denied").mockResolvedValueOnce("granted");
    await showSystemNotification("T", "B");
    await expect(showSystemNotification("T", "B", { askAgain: true })).resolves.toBe(true);
    expect(plugin.sendNotification).toHaveBeenCalledOnce();
  });

  it("returns false instead of throwing outside the app shell", async () => {
    plugin.isPermissionGranted.mockRejectedValue(new Error("no tauri"));
    await expect(showSystemNotification("T", "B")).resolves.toBe(false);
  });
});
