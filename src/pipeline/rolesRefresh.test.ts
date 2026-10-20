import { afterEach, describe, expect, it, vi } from "vitest";
import { allPipelineDefs, setPipelineDefs, type PipelineDef } from "./defs";
import { refreshRolesAndPipelines } from "./rolesRefresh";

const mine = (disabled: string | null): PipelineDef => ({
  id: "mine",
  name: "Mine",
  stages: [{ id: "fix", roleId: "role_custom_1", title: "Fixer" }],
  disabled,
});

const listed = () => allPipelineDefs().find((def) => def.id === "mine");

afterEach(() => setPipelineDefs([]));

describe("refreshRolesAndPipelines", () => {
  it("reloads your pipelines after a role change, so a disabled tag shows at once and clears again", async () => {
    setPipelineDefs([mine(null)]);
    const setRoles = vi.fn();
    const bumped = vi.fn();
    const deps = (disabled: string | null) => ({
      listRoles: async () => [{ id: "role_implementer", name: "Implementer" }],
      setRoles,
      listPipelines: async () => [mine(disabled)],
      pipelinesChanged: bumped,
    });
    // The role was deleted: the core re-checked the pipeline and disabled it.
    await refreshRolesAndPipelines(deps("uses a deleted role"));
    expect(setRoles).toHaveBeenCalledWith([{ id: "role_implementer", name: "Implementer" }]);
    expect(listed()?.disabled).toBe("uses a deleted role");
    expect(bumped).toHaveBeenCalledTimes(1);
    // The role came back.
    await refreshRolesAndPipelines(deps(null));
    expect(listed()?.disabled ?? null).toBeNull();
  });

  it("still sets the roles when the pipelines cannot be listed", async () => {
    setPipelineDefs([mine(null)]);
    const setRoles = vi.fn();
    await refreshRolesAndPipelines({
      listRoles: async () => [],
      setRoles,
      listPipelines: () => Promise.reject(new Error("offline")),
      pipelinesChanged: vi.fn(),
    });
    expect(setRoles).toHaveBeenCalledWith([]);
    expect(listed()?.disabled ?? null).toBeNull();
  });
});
