import { describe, expect, it } from "vitest";
import { minFanOutLanes, reposFoundIn, workspaceLine } from "./workspace";

const repo = (name: string, folder: string) => ({ name, folder });

describe("workspace folders (W1)", () => {
  const found = {
    workspace: true,
    repos: [
      repo("koneksi-backend", "/Users/jt/Documents/Koneksi/koneksi-backend"),
      repo("koneksi-engine", "/Users/jt/Documents/Koneksi/koneksi-engine"),
      repo("koneksi-desktop", "/Users/jt/Documents/Koneksi/koneksi-desktop"),
      repo("koneksi-web", "/Users/jt/Documents/Koneksi/koneksi-web"),
      // A Settings entry outside the folder is kept in the run's list, not counted as found.
      repo("gateway", "/src/gateway"),
    ],
  };

  it("names the repos found in the folder, three then an ellipsis", () => {
    expect(workspaceLine(found, "/Users/jt/Documents/Koneksi")).toBe(
      "Workspace: 4 repos found (koneksi-backend, koneksi-engine, koneksi-desktop, …)",
    );
    expect(workspaceLine(found, "/Users/jt/Documents/Koneksi/")).toBe(
      "Workspace: 4 repos found (koneksi-backend, koneksi-engine, koneksi-desktop, …)",
    );
    const two = { workspace: true, repos: found.repos.slice(0, 2) };
    expect(workspaceLine(two, "/Users/jt/Documents/Koneksi")).toBe("Workspace: 2 repos found (koneksi-backend, koneksi-engine)");
    const one = { workspace: true, repos: [repo("app", "C:\\work\\app")] };
    expect(workspaceLine(one, "C:\\work")).toBe("Workspace: 1 repo found (app)");
    expect(reposFoundIn(found, "/Users/jt/Documents/Koneksi").map((r) => r.name)).not.toContain("gateway");
  });

  it("shows nothing for a repo folder, a plain folder, or before the list is read", () => {
    expect(workspaceLine({ workspace: false, repos: found.repos }, "/Users/jt/Documents/Koneksi")).toBeNull();
    expect(workspaceLine({ workspace: false, repos: [] }, "/tmp/plain")).toBeNull();
    expect(workspaceLine(null, "/Users/jt/Documents/Koneksi")).toBeNull();
    // A sibling folder that only starts with the same name is not inside it.
    expect(workspaceLine({ workspace: true, repos: [repo("x", "/ws-other/x")] }, "/ws")).toBeNull();
  });

  it("fans out one pull request only in a workspace", () => {
    expect(minFanOutLanes(true)).toBe(1);
    expect(minFanOutLanes(false)).toBe(2);
  });
});
