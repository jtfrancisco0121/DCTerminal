import type { RoleField } from "./bridge";

const LIGHTWEIGHT_FIELDS: RoleField[] = [
  {
    key: "title",
    label: "Title",
    type: "text",
    required: false,
    remember: true,
  },
  {
    key: "request",
    label: "What to work on",
    type: "multiline",
    required: false,
    remember: true,
  },
];

/** Role schema fields, or Title and a task for a folder-only role. */
export function fieldsForForm(role: { fields: RoleField[] }): RoleField[] {
  const own = role.fields.filter((field) => field.type !== "folder" && field.key !== "cwd");
  if (own.length > 0) return own;
  return LIGHTWEIGHT_FIELDS;
}

/** Drop answers that belong to a different role. The folder stays. */
export function answersForRole(
  values: Record<string, string>,
  fields: { key: string }[],
): Record<string, string> {
  const allowed = new Set(fields.map((field) => field.key));
  allowed.add("cwd");
  const next: Record<string, string> = {};
  for (const [key, value] of Object.entries(values)) {
    if (allowed.has(key)) next[key] = value;
  }
  return next;
}
