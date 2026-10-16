// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { RoleSummary } from "../bridge";
import { filterRoles, launchProviders, roleBlurb, RoleLauncher } from "./RoleLauncher";

afterEach(cleanup);

const roles: RoleSummary[] = [
  { id: "role_planner", name: "Planner", defaultMode: "plan", color: "#58a6ff", fieldCount: 2 },
  { id: "role_implementer", name: "Implementer", defaultMode: "agent", color: "#3fb950", fieldCount: 1 },
  { id: "role_pr_reviewer", name: "PR Reviewer", defaultMode: "agent", color: "#d29922", fieldCount: 1 },
];

const blurbs: Record<string, string> = {
  role_planner: "Investigate, assess, plan",
  role_implementer: "Implements an approved plan",
  role_pr_reviewer: "Reviews the pull request",
};

function launcher(props: Partial<Parameters<typeof RoleLauncher>[0]> = {}) {
  const onLaunch = vi.fn();
  const onClose = vi.fn();
  render(
    <RoleLauncher
      roles={roles}
      providers={["claude", "cursor"]}
      defaultProvider="claude"
      describe={async (id) => blurbs[id] ?? ""}
      onLaunch={onLaunch}
      onClose={onClose}
      {...props}
    />,
  );
  return { onLaunch, onClose, input: screen.getByRole("textbox", { name: "Search roles" }) };
}

describe("roleBlurb", () => {
  it("takes the first heading or prose line, without Markdown marks, kept short", () => {
    expect(roleBlurb("# Senior Software Engineer — Implementation Agent\n\nYou are…")).toBe(
      "Senior Software Engineer — Implementation Agent",
    );
    expect(roleBlurb("\n---\n```\nYou are a **careful** reviewer.")).toBe("You are a careful reviewer.");
    expect(roleBlurb("{{intro}}\n\n> Plan first")).toBe("Plan first");
    const long = roleBlurb(`# ${"word ".repeat(40)}`);
    expect(long.length).toBeLessThanOrEqual(90);
    expect(long.endsWith("…")).toBe(true);
    expect(roleBlurb("  \n")).toBe("");
  });
});

describe("role launcher helpers", () => {
  it("offers only providers not known to be missing", () => {
    const report = (found: boolean) => ({ status: { found } }) as never;
    expect(launchProviders({ claude: report(true), cursor: report(false) })).toEqual(["claude"]);
    expect(launchProviders({ claude: null, cursor: report(true) })).toEqual(["claude", "cursor"]);
  });

  it("filters by name, mode and description", () => {
    expect(filterRoles(roles, "review", blurbs).map((r) => r.id)).toEqual(["role_pr_reviewer"]);
    expect(filterRoles(roles, "plan", blurbs).map((r) => r.id)).toEqual(["role_planner", "role_implementer"]);
    expect(filterRoles(roles, "", blurbs)).toHaveLength(3);
  });
});

describe("RoleLauncher", () => {
  it("lists each role with its colour, name, mode and description, and a footer", async () => {
    launcher();
    const rows = screen.getAllByRole("option");
    expect(rows).toHaveLength(3);
    expect(rows[0].textContent).toContain("Planner");
    expect(rows[0].textContent).toContain("plan");
    await waitFor(() => expect(rows[0].textContent).toContain("Investigate, assess, plan"));
    expect((rows[0].querySelector(".role-launcher-dot") as HTMLElement).style.background).toBeTruthy();
    expect(rows[0].getAttribute("aria-selected")).toBe("true");
    expect(screen.getByText("3 roles · Claude")).toBeTruthy();
    expect(screen.getByText(/open form/)).toBeTruthy();
  });

  it("opens the chosen role as Terminal by default with the keyboard", () => {
    const { input, onLaunch } = launcher();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLaunch).toHaveBeenCalledWith({ roleId: "role_implementer", provider: "claude", surface: "terminal" });
  });

  it("Tab switches to Chat with the Autopilot note; search narrows the rows", () => {
    const { input, onLaunch } = launcher();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(screen.getByRole("radio", { name: "Chat" }).getAttribute("aria-checked")).toBe("true");
    expect(screen.getByText("Autopilot needs Terminal")).toBeTruthy();
    fireEvent.change(input, { target: { value: "reviewer" } });
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.click(screen.getByRole("radio", { name: "Cursor" }));
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLaunch).toHaveBeenCalledWith({ roleId: "role_pr_reviewer", provider: "cursor", surface: "chat" });
  });

  it("shows no provider chips when only one provider is installed", () => {
    launcher({ providers: ["cursor"], defaultProvider: "claude" });
    expect(screen.queryByRole("radiogroup", { name: "Provider" })).toBeNull();
    expect(screen.getByText("3 roles · Cursor")).toBeTruthy();
  });

  it("says so when nothing matches, and Escape closes", () => {
    const { input, onClose, onLaunch } = launcher();
    fireEvent.change(input, { target: { value: "zzz" } });
    expect(screen.getByText("No matching roles")).toBeTruthy();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onLaunch).not.toHaveBeenCalled();
    fireEvent.keyDown(window, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
