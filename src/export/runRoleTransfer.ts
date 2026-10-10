import { open, save } from "@tauri-apps/plugin-dialog";
import { exportRole, importRole, type Role } from "../bridge";
import { nativeDialogPath } from "../projectsView";

export type RoleExportResult =
  | { ok: true; path: string }
  | { ok: false; reason: "cancelled" | "error"; message: string };

export type RoleImportResult =
  | { ok: true; role: Role }
  | { ok: false; reason: "cancelled" | "error"; message: string };

const ROLE_FILE_FILTERS = [{ name: "DCTerminal role", extensions: ["json"] }];

export function roleFileName(name: string): string {
  const base = name
    .replace(/[^\w\s-]+/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .slice(0, 60);
  return `${base || "role"}.role.json`;
}

/** Pick a path, then write one role as JSON (`kind: dcterminal-role`). */
export async function runRoleExport(role: { id: string; name: string }): Promise<RoleExportResult> {
  try {
    const path = await save({
      defaultPath: roleFileName(role.name),
      filters: ROLE_FILE_FILTERS,
      title: "Export role",
    });
    if (!path) return { ok: false, reason: "cancelled", message: "Export cancelled." };
    await exportRole(role.id, path);
    return { ok: true, path };
  } catch (err: unknown) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  }
}

/** Pick a role file. The backend checks it and adds it as a new custom role. */
export async function runRoleImport(): Promise<RoleImportResult> {
  try {
    const picked = await open({
      multiple: false,
      directory: false,
      filters: ROLE_FILE_FILTERS,
      title: "Import role",
    });
    const path = nativeDialogPath(picked);
    if (!path) return { ok: false, reason: "cancelled", message: "Import cancelled." };
    return { ok: true, role: await importRole(path) };
  } catch (err: unknown) {
    return { ok: false, reason: "error", message: err instanceof Error ? err.message : String(err) };
  }
}
