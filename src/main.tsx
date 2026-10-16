import React from "react";
import ReactDOM from "react-dom/client";
// Bundled fonts: UI (--font-ui) and code/terminal (--font-mono, xterm).
import "@fontsource-variable/inter";
import "@fontsource-variable/jetbrains-mono";
import App from "./App";
import { ErrorBoundary } from "./ErrorBoundary";
import { applyCustomColors, applyTheme, cachedCustomColors, cachedTheme } from "./theme";

// Paint the last theme and custom colours before settings.json loads (U8).
// Both read storage inside try/catch and fall back to the defaults.
applyTheme(cachedTheme());
applyCustomColors(cachedCustomColors());

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  </React.StrictMode>,
);
