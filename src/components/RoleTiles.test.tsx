// @vitest-environment jsdom
import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { RoleSummary } from "../bridge";
import { groupRoleTiles, RoleTiles } from "./RoleTiles";

function role(id: string, name: string): RoleSummary {
  return { id, name, defaultMode: "agent", color: "#58a6ff", fieldCount: 0 };
}

// Seed order is not chain order on purpose.
const roles: RoleSummary[] = [
  role("role_developer", "Developer"),
  role("role_pr_reviewer", "PR Reviewer"),
  role("role_planner", "Planner"),
  role("role_general", "General"),
  role("role_implementer", "Implementer"),
  role("role_plan_reviewer", "Plan Reviewer"),
  role("role_recommendation", "Recommendation"),
  role("role_codebase_audit", "Codebase Audit"),
  role("role_custom_1", "My Custom"),
];

function names(group: HTMLElement): string[] {
  return within(group)
    .getAllByRole("radio")
    .map((button) => button.textContent ?? "");
}

describe("RoleTiles", () => {
  it("groups pipeline roles in chain order and keeps the rest in order", () => {
    const { pipeline, other } = groupRoleTiles(roles);
    expect(pipeline.map((r) => r.name)).toEqual([
      "Planner",
      "Plan Reviewer",
      "Implementer",
      "PR Reviewer",
    ]);
    expect(other.map((r) => r.name)).toEqual([
      "Developer",
      "General",
      "Recommendation",
      "Codebase Audit",
      "My Custom",
    ]);
  });

  it("renders labelled Pipeline, Other roles and Terminals rows with the same tile names", () => {
    const onChooseRole = vi.fn();
    const onLaunchClaudeCli = vi.fn();
    render(
      <RoleTiles
        roles={roles}
        pickedRoleId="role_planner"
        launchChoice={null}
        busy={false}
        onChooseRole={onChooseRole}
        onLaunchShell={() => {}}
        onLaunchCursorCli={() => {}}
        onLaunchClaudeCli={onLaunchClaudeCli}
      />,
    );
    const all = screen.getByRole("group", { name: "Role" });
    const pipeline = within(all).getByRole("radiogroup", { name: "Pipeline" });
    expect(names(pipeline)).toEqual(["Planner", "Plan Reviewer", "Implementer", "PR Reviewer"]);
    expect(pipeline.querySelectorAll(".role-tile-arrow")).toHaveLength(3);
    expect(names(within(all).getByRole("radiogroup", { name: "Other roles" }))).toEqual([
      "Developer",
      "General",
      "Recommendation",
      "Codebase Audit",
      "My Custom",
    ]);
    const terminals = within(all).getByRole("radiogroup", { name: "Terminals" });
    expect(names(terminals)).toEqual(["Terminal", "Claude Code", "Cursor CLI"]);

    expect(
      within(all).getByRole("radio", { name: "Planner" }).getAttribute("aria-checked"),
    ).toBe("true");
    fireEvent.click(within(all).getByRole("radio", { name: "Implementer" }));
    expect(onChooseRole).toHaveBeenCalledWith("role_implementer");
    fireEvent.click(within(all).getByRole("radio", { name: "Claude Code" }));
    expect(onLaunchClaudeCli).toHaveBeenCalled();
  });

  it("hides an empty group", () => {
    render(
      <RoleTiles
        roles={[role("role_general", "General")]}
        pickedRoleId={null}
        launchChoice={null}
        busy={false}
        onChooseRole={() => {}}
        onLaunchShell={() => {}}
        onLaunchCursorCli={() => {}}
      />,
    );
    expect(screen.queryByRole("radiogroup", { name: "Pipeline" })).toBeNull();
    expect(names(screen.getByRole("radiogroup", { name: "Terminals" }))).toEqual([
      "Terminal",
      "Cursor CLI",
    ]);
  });

  it("is one tab stop per row and moves the choice with the arrow keys", () => {
    const onChooseRole = vi.fn();
    render(
      <RoleTiles
        roles={roles}
        pickedRoleId="role_plan_reviewer"
        launchChoice={null}
        busy={false}
        onChooseRole={onChooseRole}
        onLaunchShell={() => {}}
        onLaunchCursorCli={() => {}}
      />,
    );
    const pipeline = screen.getByRole("radiogroup", { name: "Pipeline" });
    const stops = within(pipeline)
      .getAllByRole("radio")
      .map((radio) => radio.getAttribute("tabindex"));
    expect(stops).toEqual(["-1", "0", "-1", "-1"]);
    // A row with nothing chosen still has one way in.
    const terminals = screen.getByRole("radiogroup", { name: "Terminals" });
    expect(
      within(terminals)
        .getAllByRole("radio")
        .map((radio) => radio.getAttribute("tabindex")),
    ).toEqual(["0", "-1"]);

    const current = within(pipeline).getByRole("radio", { name: "Plan Reviewer" });
    current.focus();
    fireEvent.keyDown(current, { key: "ArrowRight" });
    expect(onChooseRole).toHaveBeenLastCalledWith("role_implementer");
    fireEvent.keyDown(current, { key: "ArrowLeft" });
    expect(onChooseRole).toHaveBeenLastCalledWith("role_plan_reviewer");
  });
});
