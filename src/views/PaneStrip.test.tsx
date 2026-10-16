// @vitest-environment jsdom
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { folderTail, PaneStrip } from "./PaneStrip";

describe("PaneStrip", () => {
  it("shows the pane number, role, folder tail, branch and state pill", () => {
    render(
      <PaneStrip
        number={2}
        roleName="Implementer"
        cwd="/Users/jt/Projects/app"
        branch="feat/login"
        state={{ tone: "working", text: "Working", timed: true }}
        focused
      />,
    );
    const strip = screen.getByRole("group", {
      name: "Pane 2: Implementer, Projects/app on feat/login, Working, focused",
    });
    expect(strip.className).toContain("pane-strip-focused");
    expect(strip.textContent).toBe("2ImplementerProjects/appfeat/loginWorking");
    expect(strip.querySelector(".pane-strip-pill-working")).toBeTruthy();
    // The terminal header owns the live region; the strip's pill is not one.
    expect(strip.querySelector("[role=status]")).toBeNull();
  });

  it("an unfocused pane without a folder or branch shows less and no accent", () => {
    render(
      <PaneStrip number={3} roleName="Terminal" cwd="" state={{ tone: "idle", text: "Idle", timed: false }} focused={false} />,
    );
    const strip = screen.getByRole("group", { name: "Pane 3: Terminal, Idle" });
    expect(strip.className).not.toContain("pane-strip-focused");
    expect(strip.querySelectorAll(".pane-strip-meta")).toHaveLength(0);
  });

  it("keeps the last folder segments", () => {
    expect(folderTail("C:\\Projects\\app\\")).toBe("Projects/app");
    expect(folderTail("/app")).toBe("app");
    expect(folderTail("/a/b/c", 1)).toBe("c");
    expect(folderTail(null)).toBeNull();
  });
});
