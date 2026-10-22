// @vitest-environment jsdom
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../bridge", () => ({
  pipelineDefsList: vi.fn(async () => []),
  pipelineDefsSave: vi.fn(async (defs: unknown[]) => defs),
}));

import { pipelineDefsList, pipelineDefsSave } from "../bridge";
import { allPipelineDefs, setPipelineDefs } from "../pipeline/defs";
import { PipelinesSettings } from "./PipelinesSettings";

describe("Settings › Pipelines", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setPipelineDefs([]);
  });

  it("shows the built-ins, refuses bad JSON, and saves your own", async () => {
    const onSaved = vi.fn();
    render(<PipelinesSettings onSaved={onSaved} />);
    expect(screen.getByText("Eagle-Eye 1")).toBeTruthy();
    expect(screen.getByRole("list", { name: "Eagle-Eye 1 stages" }).textContent).toContain(
      "loops back to Implementer",
    );
    const editor = screen.getByLabelText("Your pipelines (JSON)") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("[]"));

    fireEvent.change(editor, { target: { value: "{oops" } });
    fireEvent.click(screen.getByRole("button", { name: "Save pipelines" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Not valid JSON");
    expect(pipelineDefsSave).not.toHaveBeenCalled();

    fireEvent.change(editor, { target: { value: "[]" } });
    fireEvent.click(screen.getByRole("button", { name: "Add example" }));
    expect(editor.value).toContain('"id": "bugfix"');
    fireEvent.click(screen.getByRole("button", { name: "Save pipelines" }));
    await waitFor(() => expect(onSaved).toHaveBeenCalled());
    expect(allPipelineDefs().map((def) => def.id)).toEqual(["eagle1", "eagle2", "round", "bugfix"]);
    expect(screen.getByText("Saved 1 pipeline.")).toBeTruthy();
  });

  it("reports dirty while the JSON differs from what is saved, and clean after discard, save and unmount", async () => {
    const onDirtyChange = vi.fn();
    const { unmount } = render(<PipelinesSettings onDirtyChange={onDirtyChange} />);
    const editor = screen.getByLabelText("Your pipelines (JSON)") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toBe("[]"));
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(editor, { target: { value: "[ ]x" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
    expect(editor.value).toBe("[]");
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.click(screen.getByRole("button", { name: "Add example" }));
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    fireEvent.click(screen.getByRole("button", { name: "Save pipelines" }));
    await waitFor(() => expect(screen.getByText("Saved 1 pipeline.")).toBeTruthy());
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);

    fireEvent.change(editor, { target: { value: "[]" } });
    expect(onDirtyChange).toHaveBeenLastCalledWith(true);
    unmount();
    expect(onDirtyChange).toHaveBeenLastCalledWith(false);
  });

  it("lists a pipeline that does not validate as disabled with the reason, and keeps an unreadable entry as written", async () => {
    vi.mocked(pipelineDefsList).mockResolvedValueOnce([
      {
        id: "lost",
        name: "Lost role",
        stages: [{ id: "a", roleId: "role_gone", title: "A" }],
        disabled: 'stage "a" uses the role "role_gone", which does not exist (deleted or renamed?).',
      },
      {
        id: "odd",
        name: "Odd",
        stages: [],
        disabled: "It could not be read: unknown variant `lint`.",
        raw: { id: "odd", name: "Odd", stages: [{ id: "a", roleId: "role_x", title: "A", gates: [{ kind: "lint" }] }] },
      },
    ]);
    render(<PipelinesSettings />);
    const editor = screen.getByLabelText("Your pipelines (JSON)") as HTMLTextAreaElement;
    await waitFor(() => expect(editor.value).toContain('"lint"'));
    const notes = screen.getAllByRole("note").map((note) => note.textContent);
    expect(notes[0]).toContain('Disabled: stage "a" uses the role "role_gone"');
    expect(notes[1]).toContain("could not be read");
    // The editor holds what you wrote, never the app's own fields.
    expect(editor.value).not.toContain("disabled");
    expect(JSON.parse(editor.value)[1].stages[0].gates).toEqual([{ kind: "lint" }]);
  });
});
