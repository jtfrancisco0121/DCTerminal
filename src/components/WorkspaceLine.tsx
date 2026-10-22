import { reposFoundIn, workspaceLine } from "../pipeline/workspace";
import { useWorkspaceRepos } from "../pipeline/useWorkspaceRepos";

/**
 * W1: on the start screen, one line when the chosen folder is a workspace
 * of repos: "Workspace: 3 repos found (koneksi-backend, koneksi-engine, …)".
 * Nothing for a repo folder or a plain folder.
 */
export function WorkspaceLine({ folder }: { folder: string }) {
  const info = useWorkspaceRepos(folder);
  const line = workspaceLine(info, folder);
  if (!line || !info) return null;
  const names = reposFoundIn(info, folder)
    .map((repo) => repo.name)
    .join(", ");
  return (
    <p className="hint start-workspace-line" role="status" title={names}>
      {line}
    </p>
  );
}
