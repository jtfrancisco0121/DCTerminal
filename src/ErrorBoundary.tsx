import { Component, type ErrorInfo, type ReactNode } from "react";

type Props = {
  children: ReactNode;
};

type State = {
  error: Error | null;
};

export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("DCTerminal UI error:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <main className="container">
          <section className="status-card">
            <h2>Something went wrong</h2>
            <p className="error">{this.state.error.message}</p>
            <button
              type="button"
              className="primary-button"
              onClick={() => this.setState({ error: null })}
            >
              Try again
            </button>
          </section>
        </main>
      );
    }
    return this.props.children;
  }
}
