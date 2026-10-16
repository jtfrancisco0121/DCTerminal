export type MarkdownView = "rendered" | "source";

/** "Rendered · Source" for a markdown document (file panel, plan pane). */
export function MarkdownViewSwitch({
  name,
  view,
  onChange,
}: {
  /** Unique radio group name. */
  name: string;
  view: MarkdownView;
  onChange: (view: MarkdownView) => void;
}) {
  return (
    <div className="segmented markdown-view-switch" role="radiogroup" aria-label="Show markdown as">
      {(["rendered", "source"] as const).map((value) => (
        <label key={value} className="segmented-option">
          <input
            type="radio"
            name={name}
            checked={view === value}
            onChange={() => onChange(value)}
          />
          {value === "rendered" ? "Rendered" : "Source"}
        </label>
      ))}
    </div>
  );
}

/** True for paths the file panel can show rendered. */
export function isMarkdownPath(path: string): boolean {
  return /\.(md|markdown|mdx)$/i.test(path);
}
