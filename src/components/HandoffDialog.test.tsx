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

  it("labels a verdict's primary and notes a finished chain", () => {
    render(
      <HandoffActions
        enabled
        reason={null}
        sourceRoleId="role_plan_reviewer"
        primaryTarget="role_planner"
        primaryLabel="Send back to Planner"
        completeNote="Chain complete"
        onSend={() => {}}
      />,
    );
    expect(screen.getByRole("button", { name: "Send back to Planner" }).className).toBe(
      "primary-button",
    );
    expect(screen.getByRole("button", { name: "Send to Implementer" }).className).toBe(
      "secondary-button",
    );
    expect(screen.getByText("Chain complete")).toBeTruthy();
  });
});

describe("HandoffDialog loop-back", () => {
  const review: HandoffSource = {
    ...source,
    sourceRoleId: "role_pr_reviewer",
    sourceLabel: "PR Reviewer",
    latestMessage: "## Verdict\nREQUEST CHANGES",
    plan: [],
  };
  const dialog = (live: boolean, blocked: string | null = null) => {
    const onConfirm = vi.fn();
    render(
      <HandoffDialog
        source={review}
        targetRoleId="role_implementer"
        targetFields={[]}
        folderWarning={null}
        busy={false}
        error={null}
        preferredSurface="chat"
        loopBack={{ round: 1, tabLabel: "Implementer · Fix", live, blocked }}
        onTarget={() => {}}
        onConfirm={onConfirm}
        onClose={() => {}}
      />,
    );
    return onConfirm;
  };

  it("shows the follow-up and its target tab before sending", () => {
    const onConfirm = dialog(true);
    expect(screen.getByRole("dialog", { name: "Send back to Implementer" })).toBeTruthy();
    expect(screen.getByLabelText("Target tab").textContent).toBe("To tab: Implementer · Fix");
    expect(screen.getByLabelText("Follow-up message").textContent).toBe(
      "Review findings from the PR Reviewer (round 1):\n\n## Verdict\nREQUEST CHANGES\n\nAddress these findings, then push to the same branch of each pull request they name so the existing pull requests update (do not open new ones). End your reply with the HANDOFF sections: Implementation summary, Files changed, Tests run, Deviations from the plan, and Pull requests (the same URLs).",
    );
    expect(screen.queryByRole("radio", { name: "Terminal" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send follow-up to Implementer · Fix" }));
    expect(onConfirm).toHaveBeenCalled();
  });

  it("waits while the target tab is mid-turn", () => {
    dialog(true, "The Implementer tab is still working.");
    expect(screen.getByText("The Implementer tab is still working.")).toBeTruthy();
    const send = screen.getByRole("button", { name: /^Send follow-up/ }) as HTMLButtonElement;
    expect(send.disabled).toBe(true);
  });

  it("opens a new chain tab when the target is not live", () => {
    dialog(false);
    expect(screen.getByRole("dialog", { name: "Send plan" })).toBeTruthy();
    expect(
      screen.getByText(/tab has no live session, so a new tab opens on the chain \(round 2\)/),
    ).toBeTruthy();
    expect(screen.getByRole("button", { name: "Open Implementer tab" })).toBeTruthy();
  });
});
