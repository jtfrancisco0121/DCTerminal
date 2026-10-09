// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { StatusBar } from "./StatusBar";

describe("StatusBar (U3)", () => {
  it("carries status, model, folder, and full permissions in one strip", () => {
    render(
      <StatusBar
        status={{ tone: "busy", text: "Agent working — 2 active tools" }}
        model="composer-2.5"
        folder="/Users/jt/Koneksi"
        branch="feat/login"
        permissions={{ fallback: null }}
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
    const perms = within(bar).getByTestId("status-permissions");
    expect(perms.textContent).toBe("Full permissions");
    expect(perms.getAttribute("title")).toMatch(/allow-once/);
    expect(screen.queryByText(/Run Everything/)).toBeNull();
    expect(bar.querySelectorAll(".status-bar-item").length).toBe(4);
  });

  it("shows the Claude fallback when the wanted mode was not offered", () => {
    render(
      <StatusBar
        status={{ tone: "ok", text: "Ready" }}
        permissions={{ fallback: "the adapter did not offer bypassPermissions (using default)" }}
        usage={{ text: "Claude 5h 82% · resets 3:10 PM", tone: "warn", title: "limits" }}
      />,
    );
    expect(screen.getByTestId("status-permissions").textContent).toBe(
      "Full permissions unavailable for Claude — the adapter did not offer bypassPermissions (using default)",
    );
    expect(screen.getByTestId("status-usage").textContent).toContain("Claude 5h 82%");
    expect(screen.queryByText(/role permission rules are off/i)).toBeNull();
  });

  it("leaves out what the tab does not have", () => {
    render(<StatusBar status={{ tone: "idle", text: "Not started" }} />);
    const bar = screen.getByRole("contentinfo", { name: "Status bar" });
    expect(bar.querySelectorAll(".status-bar-item").length).toBe(1);
    expect(screen.queryByText(/Run Everything/)).toBeNull();
    expect(screen.queryByText(/Full permissions/)).toBeNull();
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

  it("shows the provider with the Claude config folder and account", () => {
    render(
      <StatusBar
        status={{ tone: "idle", text: "Ready" }}
        provider={{
          text: "Claude · ~/.claude-account2 · jt@…",
          title: "Provider: Claude Code\nConfig folder: /Users/jt/.claude-account2\nAccount: jt@example.com",
        }}
      />,
    );
    const item = screen.getByTestId("status-provider");
    expect(item.textContent).toBe("Claude · ~/.claude-account2 · jt@…");
    expect(item.getAttribute("title")).toContain("/Users/jt/.claude-account2");
    expect(item.getAttribute("title")).toContain("jt@example.com");
  });
});
