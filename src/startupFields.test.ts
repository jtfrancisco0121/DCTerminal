import { describe, expect, it } from "vitest";
import type { RoleField } from "./bridge";
import { answersForRole, fieldsForForm } from "./startupFields";

const title: RoleField = {
  key: "title",
  label: "Title",
  type: "text",
  required: true,
};

describe("startup fields", () => {
  it("gives Developer a title and a task when the schema has no fields", () => {
    const fields = fieldsForForm({ fields: [] });
    expect(fields.map((field) => field.key)).toEqual(["title", "request"]);
    expect(fields.every((field) => !field.required)).toBe(true);
  });

  it("keeps a role's own fields", () => {
    expect(fieldsForForm({ fields: [title] }).map((field) => field.label)).toEqual(["Title"]);
  });

  it("drops another role's task type and keeps the folder", () => {
    const next = answersForRole(
      {
        cwd: "C:\\Projects\\Encryptor",
        taskType: "Feature",
        title: "Login",
      },
      [{ key: "title" }],
    );
    expect(next).toEqual({ cwd: "C:\\Projects\\Encryptor", title: "Login" });
  });
});
