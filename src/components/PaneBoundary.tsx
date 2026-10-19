import { Component, Fragment, type ErrorInfo, type ReactNode } from "react";
import { recordUiError } from "../uiErrors";
import { clearPaneCrash, DevCrashProbe } from "./devPaneCrash";

type Props = {
  /** Shown in the fallback and the log drawer, e.g. "Second pane". */
  label: string;
  /** The tab (or "settings", "files", ...) the pane shows; the dev crash trigger targets it. */
  paneId?: string | null;
  /** A new value (another tab in the pane) clears a crash. */
  resetKey?: unknown;
  /** A dialog (Changes) also offers Close in its fallback. */
  onDismiss?: () => void;
  children: ReactNode;
};

type State = {
  error: Error | null;
  /** Bumped by "Reload this pane" to re-mount the subtree. */
  generation: number;
  resetKey: unknown;
};

/**
 * Keeps a render error inside one pane or view: the rest of the window keeps
 * working, the error goes to the log drawer, and "Reload this pane"
 * re-mounts only this subtree. A terminal inside re-attaches to its live PTY
 * (its xterm is parked on unmount, see terminal/park.ts).
 */
export class PaneBoundary extends Component<Props, State> {
  state: State = { error: null, generation: 0, resetKey: this.props.resetKey };

  static getDerivedStateFromError(error: Error): Partial<State> {
    return { error };
  }

  static getDerivedStateFromProps(props: Props, state: State): Partial<State> | null {
    if (Object.is(props.resetKey, state.resetKey)) return null;
    return { resetKey: props.resetKey, error: null };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error(`DCTerminal ${this.props.label} error:`, error, info.componentStack);
    recordUiError(this.props.label, error);
  }

  private reload = () => {
    // Guarded like the probe below, so a production build drops devPaneCrash.
    if (import.meta.env.DEV && this.props.paneId) clearPaneCrash(this.props.paneId);
    this.setState((state) => ({ error: null, generation: state.generation + 1 }));
  };

  render() {
    const { error, generation } = this.state;
    if (error) {
      return (
        <div className="pane-crash" role="alert">
          <p className="pane-crash-title">{this.props.label} hit an error.</p>
          <p className="error pane-crash-message">{error.message || String(error)}</p>
          <p className="hint">The rest of the window keeps working. The error is in Session logs.</p>
          <button type="button" className="secondary-button" onClick={this.reload}>
            Reload this pane
          </button>
          {this.props.onDismiss && (
            <button type="button" className="secondary-button" onClick={this.props.onDismiss}>
              Close
            </button>
          )}
        </div>
      );
    }
    const { paneId, children } = this.props;
    return (
      <Fragment key={generation}>
        {import.meta.env.DEV && paneId ? <DevCrashProbe paneId={paneId} /> : null}
        {children}
      </Fragment>
    );
  }
}
