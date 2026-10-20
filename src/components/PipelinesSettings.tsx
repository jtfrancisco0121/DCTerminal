import { useEffect, useState } from "react";
import { pipelineDefsList, pipelineDefsSave } from "../bridge";
import {
  BUILT_IN_PIPELINES,
  maxRounds,
  roundLimitText,
  setPipelineDefs,
  type PipelineDef,
} from "../pipeline/defs";
import { errorText } from "./InlineNotice";

/** A starting point for "Add example": implement, check, review. */
const EXAMPLE: PipelineDef = {
  id: "bugfix",
  name: "Bug fix",
  description: "Implement a fix, check it, review the pull request.",
  stages: [
    {
      id: "fix",
      roleId: "role_implementer",
      title: "Implementer",
      gates: [{ kind: "command", run: "auto" }, { kind: "pullRequest" }],
    },
    {
      id: "review",
      roleId: "role_pr_reviewer",
      title: "PR Reviewer",
      // No maxRounds: rounds go back until the reviewer approves.
      loopBack: { to: "fix", minSeverity: "MEDIUM" },
    },
  ],
};

/**
 * Your pipelines as the editor shows them: without the app's own fields,
 * and an entry that could not be read as a pipeline exactly as written.
 */
function ownPipelines(defs: readonly PipelineDef[]): PipelineDef[] {
  return defs
    .filter((def) => !def.builtIn)
    .map(({ builtIn: _builtIn, disabled: _disabled, raw, ...def }) => (raw !== undefined ? (raw as PipelineDef) : def));
}

function asJson(defs: readonly PipelineDef[]): string {
  return JSON.stringify(defs, null, 2);
}

/** One pipeline as "Planner → Plan Reviewer ⟲ → …", with its gates and checkpoints. */
function StageStrip({ def }: { def: PipelineDef }) {
  return (
    <ol className="pipeline-strip" aria-label={`${def.name} stages`}>
      {def.stages.map((stage) => {
        const back = stage.loopBack
          ? def.stages.find((s) => s.id === stage.loopBack?.to)?.title ?? stage.loopBack.to
          : null;
        const notes = [
          stage.checkpoint ? "checkpoint before" : null,
          stage.alsoReviewers?.length ? `with ${stage.alsoReviewers.join(", ")} in parallel` : null,
          stage.gates?.length
            ? `checks: ${stage.gates
                .map((g) => (g.kind === "command" ? `${g.run}${g.optional ? " (optional)" : ""}` : "pull request"))
                .join(", ")}`
            : null,
          back
            ? `loops back to ${back} · ${roundLimitText(maxRounds(stage))}`
            : null,
        ].filter(Boolean);
        return (
          <li key={stage.id}>
            <span className="pipeline-strip-stage">{stage.title}</span>
            {notes.length > 0 && <span className="hint">{notes.join(" · ")}</span>}
          </li>
        );
      })}
    </ol>
  );
}

/** Settings › Pipelines: the built-ins, and your own as JSON (`docs/pipelines/README.md`). */
export function PipelinesSettings({
  onSaved,
  onDirtyChange,
}: {
  onSaved?: () => void;
  /** True while the JSON editor differs from the saved pipelines; false after save, discard or unmount. */
  onDirtyChange?: (dirty: boolean) => void;
}) {
  const [saved, setSaved] = useState<PipelineDef[]>([]);
  /** Your pipelines as the core listed them, with why any is disabled. */
  const [listed, setListed] = useState<PipelineDef[]>([]);
  const [text, setText] = useState("[]");
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    pipelineDefsList()
      .then((defs) => {
        if (cancelled) return;
        const own = ownPipelines(defs ?? []);
        setListed((defs ?? []).filter((def) => !def.builtIn));
        setSaved(own);
        setText(asJson(own));
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(errorText(err));
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const dirty = text.trim() !== asJson(saved).trim();
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);
  useEffect(() => () => onDirtyChange?.(false), [onDirtyChange]);

  const save = async () => {
    setError(null);
    setNotice(null);
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch (err: unknown) {
      setError(`Not valid JSON: ${errorText(err)}`);
      return;
    }
    if (!Array.isArray(parsed)) {
      setError("Write a JSON list of pipelines: [ { … }, … ].");
      return;
    }
    setBusy(true);
    try {
      const all = await pipelineDefsSave(parsed as PipelineDef[]);
      setPipelineDefs(all);
      const own = ownPipelines(all);
      setListed(all.filter((def) => !def.builtIn));
      setSaved(own);
      setText(asJson(own));
      setNotice(own.length === 1 ? "Saved 1 pipeline." : `Saved ${own.length} pipelines.`);
      onSaved?.();
    } catch (err: unknown) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  const addExample = () => {
    let current: PipelineDef[] = [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) current = parsed as PipelineDef[];
    } catch {
      // A broken draft is replaced by the example only after the user saw why.
      setError("Fix the JSON first, or clear it, then add the example.");
      return;
    }
    let id = EXAMPLE.id;
    for (let n = 2; current.some((def) => def.id === id); n += 1) id = `${EXAMPLE.id}${n}`;
    setText(asJson([...current, { ...EXAMPLE, id }]));
  };

  return (
    <section className="settings-section" aria-label="Pipelines">
      <h3>Pipelines</h3>
      <p className="hint">
        A pipeline is a chain of role tabs. Start one from the command palette (Start …). Each
        stage hands its HANDOFF sections to the next. A reviewer stage sends its round back until
        it approves; set <code>maxRounds</code> (1 to 20) on its loop-back for a round cap, or leave it
        out for no limit (the default). Checks run after a stage's turn when you press Run checks or when
        autopilot is on.
      </p>
      <h4>Built in</h4>
      <ul className="pipeline-list">
        {BUILT_IN_PIPELINES.map((def) => (
          <li key={def.id}>
            <strong>{def.name}</strong> <code>{def.id}</code>
            {def.description && <p className="hint">{def.description}</p>}
            <StageStrip def={def} />
          </li>
        ))}
      </ul>
      <h4>Your pipelines</h4>
      {listed.length > 0 && (
        <ul className="pipeline-list">
          {listed.map((def, index) => (
            <li key={`${def.id}-${index}`} className={def.disabled ? "pipeline-disabled" : undefined}>
              <strong>{def.name}</strong> <code>{def.id}</code>
              {def.disabled && (
                <p className="error" role="note">
                  Disabled: {def.disabled} Fix it in the JSON below and save.
                </p>
              )}
              <StageStrip def={def} />
            </li>
          ))}
        </ul>
      )}
      <label className="field-label" htmlFor="pipelines-json">
        Your pipelines (JSON)
      </label>
      <textarea
        id="pipelines-json"
        className="text-input pipeline-json"
        spellCheck={false}
        rows={16}
        value={text}
        onChange={(event) => {
          setText(event.target.value);
          setNotice(null);
        }}
      />
      <p className="hint">
        Fields: <code>id</code>, <code>name</code>, <code>stages</code> (<code>id</code>,{" "}
        <code>roleId</code>, <code>title</code>, optional <code>kind</code>, <code>loopBack</code>,{" "}
        <code>gates</code>, <code>checkpoint</code>). Set <code>kind</code> (<code>planner</code>,{" "}
        <code>reviewer</code>, <code>implementer</code>, <code>generic</code>) on a stage whose role is a
        copy, so it works like the original. The full format is in{" "}
        <code>docs/pipelines/README.md</code>.
      </p>
      {error && (
        <p className="error" role="alert">
          {error}
        </p>
      )}
      {notice && <p className="hint">{notice}</p>}
      <div className="button-row">
        <button type="button" className="secondary-button" onClick={addExample} disabled={busy}>
          Add example
        </button>
        <button
          type="button"
          className="secondary-button"
          disabled={busy || !dirty}
          onClick={() => {
            setText(asJson(saved));
            setError(null);
          }}
        >
          Discard changes
        </button>
        <button
          type="button"
          className="primary-button"
          disabled={busy || !dirty}
          onClick={() => void save()}
        >
          {busy ? "Saving…" : "Save pipelines"}
        </button>
      </div>
    </section>
  );
}
