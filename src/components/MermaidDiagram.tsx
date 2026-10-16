import { useEffect, useState, type ReactNode } from "react";
import { currentDiagramTheme, renderMermaid, type DiagramTheme } from "../files/mermaid";

/** The app's light/dark palette, following theme switches while mounted. */
export function useDiagramTheme(): DiagramTheme {
  const [theme, setTheme] = useState<DiagramTheme>(currentDiagramTheme);
  useEffect(() => {
    if (typeof MutationObserver === "undefined") return;
    const observer = new MutationObserver(() => setTheme(currentDiagramTheme()));
    observer.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["data-theme"],
    });
    return () => observer.disconnect();
  }, []);
  return theme;
}

type State =
  | { state: "loading" }
  | { state: "ok"; svg: string }
  | { state: "error"; message: string };

/**
 * A ```mermaid fence drawn as a diagram. While it renders, and when Mermaid
 * cannot parse it, `fallback` (the plain code block) shows instead.
 */
export function MermaidDiagram({ source, fallback }: { source: string; fallback: ReactNode }) {
  const theme = useDiagramTheme();
  const [result, setResult] = useState<State>({ state: "loading" });

  useEffect(() => {
    let alive = true;
    setResult({ state: "loading" });
    renderMermaid(source, theme).then(
      (svg) => alive && setResult({ state: "ok", svg }),
      (err: unknown) => {
        if (!alive) return;
        const message = err instanceof Error ? err.message : String(err);
        setResult({ state: "error", message: message.split("\n")[0] || "unknown error" });
      },
    );
    return () => {
      alive = false;
    };
  }, [source, theme]);

  if (result.state === "ok") {
    return (
      <div
        className="mermaid-diagram"
        role="img"
        aria-label="Diagram"
        // Sanitized by renderMermaid (DOMPurify, SVG profile).
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    );
  }
  return (
    <div className="mermaid-fallback">
      {result.state === "error" && (
        <p className="hint mermaid-error">Couldn’t draw this diagram: {result.message}</p>
      )}
      {fallback}
    </div>
  );
}
