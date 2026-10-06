import { describe, expect, it } from "vitest";
import { worktreeDestination, worktreeFolderName, worktreeFormError } from "./worktreeForm";

describe("worktreeFolderName (matches the Rust side)", () => {
  it("makes one safe folder segment", () => {
    expect(worktreeFolderName("feat/login")).toBe("feat-login");
    expect(worktreeFolderName("fix//a b")).toBe("fix-a-b");
    expect(worktreeFolderName("../../etc")).toBe("etc");
    expect(worktreeFolderName("///")).toBe("worktree");
    expect(worktreeFolderName("v1.2_rc-1")).toBe("v1.2_rc-1");
  });
});

describe("worktreeDestination", () => {
  it("joins with the separator the folder already uses", () => {
    expect(worktreeDestination("/Users/jt/Koneksi-worktrees", "feat/x")).toBe(
      "/Users/jt/Koneksi-worktrees/feat-x",
    );
    expect(worktreeDestination("C:\\Work\\App-worktrees", "feat/x")).toBe(
      "C:\\Work\\App-worktrees\\feat-x",
    );
  });
});

describe("worktreeFormError", () => {
  const info = { branches: ["main", "feat/old", "feat/busy"], checkedOut: ["main", "feat/busy"] };

  it("needs a branch name", () => {
    expect(worktreeFormError({ mode: "new", branch: " " }, info)).toBe("Enter a branch name.");
    expect(worktreeFormError({ mode: "existing", branch: "" }, info)).toBe("Pick a branch.");
  });

  it("rejects names git would read as options or that already exist", () => {
    expect(worktreeFormError({ mode: "new", branch: "-x" }, info)).toMatch(/cannot start/);
    expect(worktreeFormError({ mode: "new", branch: "feat/old" }, info)).toMatch(/already exists/);
    expect(worktreeFormError({ mode: "new", branch: "has space" }, info)).toMatch(/spaces/);
  });

  it("rejects an existing branch that is already checked out", () => {
    expect(worktreeFormError({ mode: "existing", branch: "feat/busy" }, info)).toMatch(
      /already checked out/,
    );
    expect(worktreeFormError({ mode: "existing", branch: "feat/old" }, info)).toBeNull();
    expect(worktreeFormError({ mode: "new", branch: "feat/new" }, info)).toBeNull();
  });
});
