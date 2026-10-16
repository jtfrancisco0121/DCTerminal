/**
 * Mermaid diagrams for rendered markdown (chat, the file panel, the plan
 * pane). Mermaid is large, so it loads on the first diagram only.
 *
 * Markdown from any repo or agent ends up here, and this webview can reach
 * Tauri IPC, so two layers keep a diagram inert:
 * - securityLevel "strict": Mermaid escapes labels and drops click handlers.
 * - DOMPurify (SVG profile) on the SVG before it touches the DOM: no script,
 *   no event-handler attributes, no javascript: links, no foreignObject HTML.
 * Labels are drawn as SVG text (htmlLabels off), so the SVG-only profile
 * keeps them.
 *
 * Mermaid config follows better-agentic-ide's src/lib/mermaidConfig.ts and
 * src/lib/sanitizeHtml.ts (MIT, © Alvin Reyes).
 */
import DOMPurify from "dompurify";

export type DiagramTheme = "dark" | "light";

type MermaidApi = typeof import("mermaid").default;

let loading: Promise<MermaidApi> | null = null;
let configured: DiagramTheme | null = null;
/** Mermaid's config is global, so renders run one at a time. */
let queue: Promise<unknown> = Promise.resolve();
let counter = 0;

function loadMermaid(): Promise<MermaidApi> {
  loading ??= import("mermaid").then((mod) => mod.default);
  return loading;
}

function configure(mermaid: MermaidApi, theme: DiagramTheme) {
  if (configured === theme) return;
  mermaid.initialize({
    startOnLoad: false,
    securityLevel: "strict",
    theme: theme === "light" ? "default" : "dark",
    htmlLabels: false,
    flowchart: { htmlLabels: false },
    fontFamily: "inherit",
  });
  configured = theme;
}

/** Strip anything executable from Mermaid's SVG. */
export function sanitizeSvg(svg: string): string {
  return DOMPurify.sanitize(svg, {
    USE_PROFILES: { svg: true, svgFilters: true },
    // Mermaid scopes its colours in a <style> inside the SVG; CSS cannot run
    // script, and the CSP blocks remote loads from it.
    ADD_TAGS: ["style"],
    FORBID_TAGS: ["foreignObject", "script", "iframe", "object", "embed"],
  });
}

/** The app's palette right now: light only for the light theme. */
export function currentDiagramTheme(): DiagramTheme {
  if (typeof document === "undefined") return "dark";
  return document.documentElement.dataset.theme === "github-light" ? "light" : "dark";
}

/** Render Mermaid source to sanitized SVG markup. Rejects with Mermaid's message. */
export function renderMermaid(source: string, theme: DiagramTheme): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await loadMermaid();
    configure(mermaid, theme);
    const id = `dct-mermaid-${++counter}`;
    try {
      const { svg } = await mermaid.render(id, source);
      return sanitizeSvg(svg);
    } finally {
      // A failed render can leave its scratch node in the body.
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
