// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import { HandoffDialog } from "./HandoffDialog";
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
});
