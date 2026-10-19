import type { TabSummary } from "../bridge";

/** What a pane's crash fallback and the log drawer call the view a tab shows. */
export function viewLabel(tab: Pick<TabSummary, "kind"> | null | undefined): string {
  switch (tab?.kind) {
    case "terminal":
      return "Terminal view";
    case "pipeline_overview":
      return "Overview";
    case "github":
      return "GitHub view";
    case "preview":
      return "Preview";
    default:
      return tab ? "Chat view" : "This view";
  }
}
