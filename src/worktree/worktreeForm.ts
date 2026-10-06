/** F3 dialog helpers. Folder naming mirrors `worktree_folder_name` in Rust. */

export function worktreeFolderName(branch: string): string {
  let name = branch.replace(/[^A-Za-z0-9._-]/g, "-");
  while (name.includes("--")) name = name.replace(/--/g, "-");
  name = name.replace(/^[-.]+|[-.]+$/g, "");
  return name || "worktree";
}

export function worktreeDestination(worktreesDir: string, branch: string): string {
  const sep = worktreesDir.includes("\\") && !worktreesDir.includes("/") ? "\\" : "/";
  const base = worktreesDir.replace(/[\\/]+$/, "");
  return `${base}${sep}${worktreeFolderName(branch)}`;
}

export type WorktreeMode = "new" | "existing";

/** Quick checks before git's own (`git check-ref-format`) on the Rust side. */
export function worktreeFormError(
  form: { mode: WorktreeMode; branch: string },
  info: { branches: string[]; checkedOut: string[] },
): string | null {
  const branch = form.branch.trim();
  if (form.mode === "existing") {
    if (!branch) return "Pick a branch.";
    if (info.checkedOut.includes(branch)) {
      return `${branch} is already checked out in another worktree.`;
    }
    return null;
  }
  if (!branch) return "Enter a branch name.";
  if (branch.startsWith("-")) return "A branch name cannot start with '-'.";
  if (/\s/.test(branch)) return "A branch name cannot contain spaces.";
  if (info.branches.includes(branch)) {
    return `${branch} already exists. Choose Existing branch to use it.`;
  }
  return null;
}
