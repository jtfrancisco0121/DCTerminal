import { setPipelineDefs, type PipelineDef } from "./defs";

export type RolesRefreshDeps<R> = {
  listRoles: () => Promise<R[]>;
  setRoles: (roles: R[]) => void;
  /** Every pipeline, as the core has checked them (`pipelineDefsList`). */
  listPipelines: () => Promise<PipelineDef[]>;
  /** Re-render whatever shows pipelines (palette, chain labels). */
  pipelinesChanged: () => void;
};

/**
 * After a role is added, copied, imported, saved or deleted. The core
 * re-checks your pipelines whenever the roles change (a deleted role
 * disables a pipeline that uses it; a role that comes back enables it), so
 * the pipeline list is reloaded too and the "(disabled)" tags stay right.
 */
export async function refreshRolesAndPipelines<R>(deps: RolesRefreshDeps<R>): Promise<void> {
  deps.setRoles(await deps.listRoles());
  try {
    setPipelineDefs(await deps.listPipelines());
    deps.pipelinesChanged();
  } catch {
    // intentionally silent: the list loaded at start stays; starting a
    // disabled pipeline is still refused by the core with the reason.
  }
}
