// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { TabBar, tabTooltip } from "./TabBar";
import type { TabSummary } from "./bridge";

const tab = (partial: Partial<TabSummary>): TabSummary => ({
  id: "tab_1",
  label: "Developer · Encryptor",
  roleId: "role_developer",
  cwd: "C:\\Projects\\Encryptor",
  phase: "draft",
  mergedPromptChars: 0,
  startupPromptSent: false,
  hasTranscript: false,
  folderStatus: "ok",
  color: "#3fb950",
  kind: "role",
  terminalLaunch: "",
  acpSessionId: null,
  ...partial,
});

describe("TabBar", () => {
  it("shows each tab's own label and closes only the clicked tab", () => {
    const onClose = vi.fn();
    const onSelect = vi.fn();
    const onNew = vi.fn();
    render(
      <TabBar
        tabs={[
          tab({ id: "tab_1", label: "Planner · UI Overhaul" }),
          tab({ id: "tab_2", label: "Developer · Encryptor" }),
        ]}
        activeTabId="tab_2"
        onSelect={onSelect}
        onClose={onClose}
        onNew={onNew}
      />,
    );
    expect(screen.getByRole("tab", { name: /Planner · UI Overhaul/ })).toBeTruthy();
    expect(screen.getByRole("tab", { name: /Developer · Encryptor/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Close Developer · Encryptor" }));
    expect(onClose).toHaveBeenCalledWith("tab_2");
    fireEvent.click(screen.getByRole("button", { name: "New tab" }));
    expect(onNew).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("tab", { name: /Planner · UI Overhaul/ }));
    expect(onSelect).toHaveBeenCalledWith("tab_1");
  });

  it("marks a terminal role tab", () => {
    render(
      <TabBar
        tabs={[tab({ terminalLaunch: "role", label: "Developer · Encryptor" })]}
        activeTabId="tab_1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByLabelText("Role terminal")).toBeTruthy();
    expect(screen.queryByText("Terminal")).toBeNull();
  });
});

describe("TabBar density (U1/U4)", () => {
  it("puts the role, folder, model, and status in the chip's hover text", () => {
    render(
      <TabBar
        tabs={[tab({ id: "tab_1", label: "Login fix", model: null, worktreeBranch: "feat/login" })]}
        activeTabId="tab_1"
        roleNames={{ role_developer: "Developer" }}
        modelFor={() => "composer-2.5"}
        statuses={{ tab_1: { busy: true, unseen: false, needsYou: null } }}
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        onRenameStart={() => {}}
      />,
    );
    const title = screen.getByRole("tab", { name: /Login fix/ }).getAttribute("title") ?? "";
    expect(title.split("\n")).toEqual([
      "Login fix",
      "Role: Developer",
      "Folder: C:\\Projects\\Encryptor",
      "Branch: feat/login",
      "Model: composer-2.5",
      "Status: Working",
      "Double-click to rename",
    ]);
  });

  it("shows a warn icon with a tooltip instead of the long rules-off badge", () => {
    render(
      <TabBar
        tabs={[tab({ id: "tab_1", label: "Login fix" }), tab({ id: "t", label: "zsh", kind: "terminal" })]}
        activeTabId="tab_1"
        roleRulesOff
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.queryByText(/role permission rules are off/)).toBeNull();
    const icons = screen.getAllByLabelText(/Role permission rules are off/);
    expect(icons).toHaveLength(1);
    expect(icons[0].textContent).toBe("⚠");
    expect(icons[0].getAttribute("title")).toMatch(/Run Everything/);
  });

  it("uses compact icon buttons for new, worktree, and reopen", () => {
    const onReopen = vi.fn();
    render(
      <TabBar
        tabs={[tab({})]}
        activeTabId="tab_1"
        canReopen
        onReopen={onReopen}
        onNewWorktree={() => {}}
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "New tab" }).textContent).toBe("+");
    expect(screen.getByRole("button", { name: "New tab in worktree…" }).textContent).toBe("⎇");
    fireEvent.click(screen.getByRole("button", { name: "Reopen closed tab" }));
    expect(onReopen).toHaveBeenCalledOnce();
  });
});

describe("TabBar status", () => {
  const tabs = [
    tab({ id: "busy", label: "Busy tab" }),
    tab({ id: "seen", label: "Unseen tab" }),
    tab({ id: "needs", label: "Needs tab" }),
    tab({ id: "idle", label: "Idle tab" }),
  ];

  it("shows busy, unseen, and needs-you on the chips", () => {
    render(
      <TabBar
        tabs={tabs}
        activeTabId="idle"
        statuses={{
          busy: { busy: true, unseen: false, needsYou: null },
          seen: { busy: false, unseen: true, needsYou: null },
          needs: { busy: true, unseen: false, needsYou: "permission" },
        }}
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
      />,
    );
    const chip = (name: RegExp) => screen.getByRole("tab", { name }).closest(".tab-chip")!;
    expect(chip(/Busy tab/).className).toContain("tab-chip-busy");
    expect(screen.getByRole("tab", { name: /Busy tab/ }).textContent).toContain("Working");
    expect(chip(/Unseen tab/).className).toContain("tab-chip-unseen");
    expect(screen.getByRole("tab", { name: /Unseen tab/ }).textContent).toContain(
      "Finished, not viewed yet",
    );
    const needs = chip(/Needs tab/);
    expect(needs.className).toContain("tab-chip-needs");
    // Needs-you wins over the busy pulse.
    expect(needs.className).not.toContain("tab-chip-busy");
    expect(screen.getByRole("tab", { name: /Needs tab/ }).textContent).toContain(
      "Needs you: permission request",
    );
    expect(chip(/Idle tab/).className).not.toMatch(/tab-chip-(busy|unseen|needs)/);
  });
});

describe("TabBar rename", () => {
  it("starts a rename on double-click", () => {
    const onRenameStart = vi.fn();
    render(
      <TabBar
        tabs={[tab({ id: "tab_1", label: "Planner · UI" })]}
        activeTabId="tab_1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        onRenameStart={onRenameStart}
      />,
    );
    fireEvent.doubleClick(screen.getByRole("tab", { name: /Planner · UI/ }));
    expect(onRenameStart).toHaveBeenCalledWith("tab_1");
  });

  it("commits on Enter, cancels on Escape, and ignores a blank name", () => {
    const onRename = vi.fn();
    const onRenameEnd = vi.fn();
    const props = {
      tabs: [tab({ id: "tab_1", label: "Planner · UI" })],
      activeTabId: "tab_1",
      onSelect: () => {},
      onClose: () => {},
      onNew: () => {},
      renamingTabId: "tab_1",
      onRename,
      onRenameEnd,
    };
    const { rerender } = render(<TabBar {...props} />);
    const input = screen.getByLabelText("Rename Planner · UI") as HTMLInputElement;
    expect(input.value).toBe("Planner · UI");
    fireEvent.change(input, { target: { value: "  Auth bug " } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onRename).toHaveBeenCalledWith("tab_1", "Auth bug");
    expect(onRenameEnd).toHaveBeenCalledTimes(1);

    rerender(<TabBar {...props} renamingTabId={null} />);
    rerender(<TabBar {...props} />);
    const again = screen.getByLabelText("Rename Planner · UI");
    fireEvent.change(again, { target: { value: "Other" } });
    fireEvent.keyDown(again, { key: "Escape" });
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRenameEnd).toHaveBeenCalledTimes(2);

    rerender(<TabBar {...props} renamingTabId={null} />);
    rerender(<TabBar {...props} />);
    const blank = screen.getByLabelText("Rename Planner · UI");
    fireEvent.change(blank, { target: { value: "   " } });
    fireEvent.blur(blank);
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRenameEnd).toHaveBeenCalledTimes(3);
  });

  it("commits on blur", () => {
    const onRename = vi.fn();
    render(
      <TabBar
        tabs={[tab({ id: "tab_1", label: "Planner · UI" })]}
        activeTabId="tab_1"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        renamingTabId="tab_1"
        onRename={onRename}
        onRenameEnd={() => {}}
      />,
    );
    const input = screen.getByLabelText("Rename Planner · UI");
    fireEvent.change(input, { target: { value: "Renamed" } });
    fireEvent.blur(input);
    expect(onRename).toHaveBeenCalledWith("tab_1", "Renamed");
  });
});

describe("TabBar worktree", () => {
  it("shows a worktree tab's branch and offers New tab in worktree", () => {
    const onNewWorktree = vi.fn();
    render(
      <TabBar
        tabs={[
          tab({ id: "wt", label: "Developer · feat-login", worktreeBranch: "feat/login" }),
          tab({ id: "plain", label: "Planner · UI" }),
        ]}
        activeTabId="wt"
        onSelect={() => {}}
        onClose={() => {}}
        onNew={() => {}}
        onNewWorktree={onNewWorktree}
      />,
    );
    expect(screen.getByRole("tab", { name: /Developer · feat-login/ }).textContent).toContain(
      "feat/login",
    );
    expect(screen.getByRole("tab", { name: /Planner · UI/ }).querySelector(".tab-branch")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "New tab in worktree…" }));
    expect(onNewWorktree).toHaveBeenCalledOnce();
  });
});

describe("tabTooltip provider line", () => {
  it("adds the provider line after the role", () => {
    const text = tabTooltip(
      {
        id: "t1",
        label: "Planner · API",
        roleId: "role_planner",
        cwd: "/Users/jt/api",
        phase: "draft",
        mergedPromptChars: 0,
        startupPromptSent: false,
        hasTranscript: false,
        folderStatus: "ok",
        color: "#a371f7",
        acpSessionId: null,
        provider: "claude",
      },
      {
        roleName: "Planner",
        provider: "Claude · /Users/jt/.claude-account2 · jt@example.com",
      },
    );
    expect(text.split("\n").slice(0, 3)).toEqual([
      "Planner · API",
      "Role: Planner",
      "Provider: Claude · /Users/jt/.claude-account2 · jt@example.com",
    ]);
  });
});
