import { Fragment, useEffect, useState, type ReactNode } from "react";
import { Panel, PanelGroup, PanelResizeHandle } from "react-resizable-panels";
import { gridRows } from "../tabChrome";

type Props = {
  /** Tab ids in cell order. */
  ids: string[];
  renderCell: (tabId: string) => ReactNode;
};

const PORTRAIT = "(orientation: portrait)";

/** True while the window is taller than it is wide. */
function portraitQuery(): MediaQueryList | null {
  return typeof window !== "undefined" && window.matchMedia ? window.matchMedia(PORTRAIT) : null;
}

export function usePortrait(): boolean {
  const [portrait, setPortrait] = useState(() => portraitQuery()?.matches ?? false);
  useEffect(() => {
    const query = portraitQuery();
    if (!query) return;
    const onChange = () => setPortrait(query.matches);
    onChange();
    query.addEventListener("change", onChange);
    return () => query.removeEventListener("change", onChange);
  }, []);
  return portrait;
}

/**
 * Every tab in the grid stays on screen in its own cell. Rows and columns
 * follow the window's shape and can be resized; sizes are kept per shape.
 */
export function GridSplit({ ids, renderCell }: Props) {
  const portrait = usePortrait();
  const rows = gridRows(ids.length, portrait);
  const shape = `${portrait ? "p" : "l"}-${rows.join("x")}`;
  let next = 0;
  const rowIds = rows.map((count) => {
    const cells = ids.slice(next, next + count);
    next += count;
    return cells;
  });
  return (
    <PanelGroup
      direction="vertical"
      className="workspace-split grid-split"
      autoSaveId={`dct-grid-${shape}`}
    >
      {rowIds.map((cells, rowIndex) => (
        <Fragment key={`row-${rowIndex}`}>
          {rowIndex > 0 && <PanelResizeHandle className="split-handle split-handle-row" />}
          <Panel id={`grid-row-${rowIndex}`} order={rowIndex + 1} minSize={12}>
            <PanelGroup
              direction="horizontal"
              autoSaveId={`dct-grid-${shape}-r${rowIndex}`}
            >
              {cells.map((tabId, cellIndex) => (
                <Fragment key={tabId}>
                  {cellIndex > 0 && <PanelResizeHandle className="split-handle" />}
                  <Panel id={`grid-cell-${tabId}`} order={cellIndex + 1} minSize={12}>
                    {renderCell(tabId)}
                  </Panel>
                </Fragment>
              ))}
            </PanelGroup>
          </Panel>
        </Fragment>
      ))}
    </PanelGroup>
  );
}
