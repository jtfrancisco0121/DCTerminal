// @vitest-environment jsdom
import { act, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { clearUiErrors, recordUiError } from "../uiErrors";
import { LogDrawer } from "./LogDrawer";

const props = { stderr: "", appLog: "", logPath: null, busy: false, onRefresh: () => {}, onClose: () => {} };

describe("LogDrawer interface errors", () => {
  beforeEach(() => clearUiErrors());

  it("lists pane and view crashes, newest included while open", () => {
    recordUiError("Second pane", new Error("boom one"));
    render(<LogDrawer {...props} />);
    const section = screen.getByRole("region", { name: "Interface errors" });
    expect(section.textContent).toContain("Second pane: boom one");
    act(() => recordUiError("Settings", new Error("boom two")));
    expect(section.textContent).toContain("Settings: boom two");
  });

  it("says when there are none", () => {
    render(<LogDrawer {...props} />);
    expect(screen.getByRole("region", { name: "Interface errors" }).textContent).toContain(
      "(no interface errors)",
    );
  });
});
