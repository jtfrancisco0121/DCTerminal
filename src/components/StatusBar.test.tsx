// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";

describe("StatusBar (U3)", () => {
  it("carries status, model, folder, and the Run Everything warning in one strip", () => {
    render(
      <StatusBar
        status={{ tone: "busy", text: "Agent working — 2 active tools" }}
        model="composer-2.5"
        folder="/Users/jt/Koneksi"
        branch="feat/login"
        roleRulesOff
      />,
    );
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    expect(within(bar).getByText("Agent working — 2 active tools")).toBeTruthy();
    expect(within(bar).getByText("composer-2.5")).toBeTruthy();
    const folder = within(bar).getByText("Koneksi");
    expect(folder.closest("[title]")!.getAttribute("title")).toBe(
      "/Users/jt/Koneksi\nBranch: feat/login",
    );
    expect(within(bar).getByText("⎇ feat/login")).toBeTruthy();
    const warn = within(bar).getByLabelText(/Role permission rules are off/);
    expect(warn.textContent).toBe("⚠ Run Everything");
    expect(bar.querySelectorAll(".status-bar-item").length).toBe(4);
  });

  it("leaves out what the tab does not have", () => {
    render(<StatusBar status={{ tone: "idle", text: "Not started" }} />);
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    expect(bar.querySelectorAll(".status-bar-item").length).toBe(1);
    expect(screen.queryByText(/Run Everything/)).toBeNull();
  });

  it("shows notices inline, each dismissable", () => {
    const onDismiss = vi.fn();
    render(
      <StatusBar
        status={{ tone: "ok", text: "Ready" }}
        messages={[
          { id: "model", text: "The new model applies next start.", tone: "info", onDismiss },
          { id: "folder", text: "Folder moved", tone: "warn" },
        ]}
      />,
    );
    expect(screen.getByText("Folder moved").closest(".status-bar-message-warn")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Dismiss: The new model applies next start." }));
    expect(onDismiss).toHaveBeenCalledOnce();
  });
});
