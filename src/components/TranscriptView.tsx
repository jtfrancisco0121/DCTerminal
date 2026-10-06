import { useEffect, useMemo, useRef } from "react";
import { highlightParts } from "../search/textSearch";

type Props = {
  text: string;
  query: string;
  /** Which match to scroll to and mark as current. */
  occurrence: number;
  className?: string;
  label?: string;
};

/** Read-only transcript with every match marked; scrolls to `occurrence`. */
export function TranscriptView({ text, query, occurrence, className, label }: Props) {
  const parts = useMemo(() => highlightParts(text, query), [text, query]);
  const hitCount = parts.reduce((n, part) => (part.hit === null ? n : n + 1), 0);
  const current = hitCount === 0 ? -1 : Math.min(Math.max(occurrence, 0), hitCount - 1);
  const currentRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    currentRef.current?.scrollIntoView?.({ block: "center" });
  }, [current, text, query]);

  return (
    <pre className={className ?? "mono-snippet transcript-preview"} aria-label={label}>
      {parts.map((part, index) =>
        part.hit === null ? (
          <span key={index}>{part.text}</span>
        ) : (
          <mark
            key={index}
            ref={part.hit === current ? currentRef : undefined}
            className={part.hit === current ? "search-hit search-hit-current" : "search-hit"}
          >
            {part.text}
          </mark>
        ),
      )}
    </pre>
  );
}
