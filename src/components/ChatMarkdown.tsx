import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { highlightCode } from "../files/highlight";

/** Plain text of rendered markdown children (a code block's source). */
function textOf(node: ReactNode): string {
  if (node == null || typeof node === "boolean") return "";
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (typeof node === "object" && "props" in node) {
    return textOf((node as { props: { children?: ReactNode } }).props.children);
  }
  return "";
}

export function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [state, setState] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<number | undefined>(undefined);
  useEffect(() => () => window.clearTimeout(timer.current), []);
  return (
    <button
      type="button"
      className="ghost-button chat-copy-button"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
          setState("copied");
        } catch {
          setState("failed");
        }
        window.clearTimeout(timer.current);
        timer.current = window.setTimeout(() => setState("idle"), 1500);
      }}
      aria-label={label}
    >
      {state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label}
    </button>
  );
}

/** A fenced code block: highlighted when the language is known, with a copy button. */
export function CodeBlock({ children }: { children?: ReactNode }) {
  const text = textOf(children).replace(/\n$/, "");
  const className =
    (children as { props?: { className?: string } } | undefined)?.props?.className ?? "";
  const lang = /language-([\w+-]+)/.exec(className)?.[1] ?? "";
  const html = useMemo(
    () => (lang ? highlightCode(text, `code.${lang.toLowerCase()}`) : null),
    [lang, text],
  );
  return (
    <div className="chat-code-block">
      <CopyButton text={text} label="Copy code" />
      {html?.language ? (
        <pre>
          <code className={`hljs language-${html.language}`} dangerouslySetInnerHTML={{ __html: html.html }} />
        </pre>
      ) : (
        <pre>
          <code>{text}</code>
        </pre>
      )}
    </div>
  );
}

export const chatMarkdownComponents: Components = {
  // target=_blank lets the opener plugin open links in the system browser
  // instead of navigating the app's own webview.
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener">
      {children}
    </a>
  ),
  table: ({ children }) => (
    <div className="session-markdown-table-wrap">
      <table>{children}</table>
    </div>
  ),
  pre: ({ children }) => <CodeBlock>{children}</CodeBlock>,
};

const remarkPlugins = [remarkGfm];

export function ChatMarkdown({ children }: { children: string }) {
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={chatMarkdownComponents}>
      {children}
    </ReactMarkdown>
  );
}
