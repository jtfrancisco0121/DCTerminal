// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HandoffActions, HandoffDialog } from "./HandoffDialog";
import type { HandoffSource, HandoffTargetId } from "../handoff/map";

const source: HandoffSource = {
  sourceRoleId: "role_planner",
  sourceTabId: "tab_plan",
  sourceLabel: "Planner · Login",
  cwd: "C:\\Projects\\Encryptor",
  answers: { title: "Login" },
  latestMessage: "Use a plan.",
  plan: [{ content: "Add the form", status: "pending" }],
  todos: [],
  selection: "",
  turnInFlight: false,
};

describe("HandoffDialog", () => {
  it("can send a plan to Developer as a terminal tab", () => {
    const onConfirm = vi.fn();
    function Harness() {
      const [target, setTarget] = useState<HandoffTargetId>("role_implementer");
      return (
        <HandoffDialog
          source={source}
          targetRoleId={target}
          targetFields={[]}
          folderWarning={null}
          busy={false}
          error={null}
          preferredSurface="chat"
          onTarget={setTarget}
          onConfirm={onConfirm}
          onClose={() => {}}
        />
      );
    }
    render(<Harness />);
    fireEvent.click(screen.getByRole("radio", { name: "Developer" }));
    fireEvent.click(screen.getByRole("radio", { name: "Terminal" }));
    fireEvent.click(screen.getByRole("button", { name: "Start Developer terminal" }));
    expect(onConfirm).toHaveBeenCalled();
    const surface = onConfirm.mock.calls[0]?.[1];
    expect(surface).toBe("terminal");
  });

  it("does not send while a turn is still running", () => {
    render(
      <HandoffDialog
        source={{ ...source, turnInFlight: true }}
        targetRoleId="role_implementer"
        targetFields={[{ key: "approvedPlan" }]}
        folderWarning={null}
        busy={false}
        error={null}
        preferredSurface="chat"
        onTarget={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    const send = screen.getByRole("button", { name: "Open Implementer tab" });
    expect(send.hasAttribute("disabled")).toBe(true);
  });

  it("lists the Planner's targets with Plan Reviewer first and no PR Reviewer", () => {
    render(
      <HandoffDialog
        source={source}
        targetRoleId="role_plan_reviewer"
        targetFields={[{ key: "originalTask" }, { key: "plan" }]}
        folderWarning={null}
        busy={false}
        error={null}
        preferredSurface="chat"
        onTarget={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    const names = screen
      .getAllByRole("radio")
      .filter((el) => el.getAttribute("name") === "handoff-target")
      .map((el) => el.parentElement?.textContent);
    expect(names).toEqual(["Plan Reviewer", "Implementer", "Developer"]);
    expect(screen.getByRole("button", { name: "Open Plan Reviewer tab" })).toBeTruthy();
  });

  it("lists a Plan Reviewer's targets using loaded role names", () => {
    render(
      <HandoffDialog
        source={{ ...source, sourceRoleId: "role_plan_reviewer" }}
        targetRoleId="role_implementer"
        targetFields={[{ key: "approvedPlan" }]}
        folderWarning={null}
        busy={false}
        error={null}
        preferredSurface="chat"
        roleNames={[{ id: "role_planner", name: "Architect" }]}
        onTarget={() => {}}
        onConfirm={() => {}}
        onClose={() => {}}
      />,
    );
    const names = screen
      .getAllByRole("radio")
      .filter((el) => el.getAttribute("name") === "handoff-target")
      .map((el) => el.parentElement?.textContent);
    expect(names).toEqual(["Implementer", "Developer", "Architect"]);
  });
});

describe("HandoffActions", () => {
  it("shows Send to Plan Reviewer first for a Planner", () => {
    const onSend = vi.fn();
    render(
      <HandoffActions enabled reason={null} sourceRoleId="role_planner" onSend={onSend} />,
    );
    const labels = screen.getAllByRole("button").map((b) => b.textContent);
    expect(labels).toEqual([
      "Send to Plan Reviewer",
      "Send to Implementer",
      "Send to Developer",
    ]);
    fireEvent.click(screen.getByRole("button", { name: "Send to Plan Reviewer" }));
    expect(onSend).toHaveBeenCalledWith("role_plan_reviewer");
  });

  it("shows only Send to PR Reviewer for an Implementer", () => {
    render(<HandoffActions enabled reason={null} sourceRoleId="role_implementer" onSend={() => {}} />);
    expect(screen.getAllByRole("button").map((b) => b.textContent)).toEqual([
      "Send to PR Reviewer",
    ]);
  });
});
