/**
 * W1: the repos of `folder` as a run would see them (`workspaceReposFor`),
 * read again when the folder changes; null until read, for a blank folder,
 * or when it could not be read.
 */
import { useEffect, useState } from "react";
import { workspaceReposFor, type WorkspaceRepos } from "../bridge";

export function useWorkspaceRepos(folder: string): WorkspaceRepos | null {
  const [info, setInfo] = useState<{ folder: string; repos: WorkspaceRepos } | null>(null);
  useEffect(() => {
    const wanted = folder.trim();
    if (!wanted) return;
    let live = true;
    void (async () => {
      try {
        const repos = await workspaceReposFor(wanted);
        if (live) setInfo({ folder: wanted, repos });
      } catch {
        // intentionally silent: without the list the folder simply shows no workspace line.
      }
    })();
    return () => {
      live = false;
    };
  }, [folder]);
  return info && info.folder === folder.trim() ? info.repos : null;
}
