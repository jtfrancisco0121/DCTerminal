import { useEffect, useMemo, useState } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { filesMarkdownImage } from "../bridge";
import { chatMarkdownComponents } from "./ChatMarkdown";

const REMOTE = /^https?:\/\//i;
const remarkPlugins = [remarkGfm];

type ImageState = { url: string | null; error: string | null };

/**
 * An image of a rendered Markdown file. The app's CSP blocks remote images
 * and a relative `src` would resolve against the app itself, so: a path
 * inside the tab's folder loads through the backend as a `data:` URL; a
 * remote image is a placeholder with a link that opens it in the browser.
 */
export function MarkdownImage({
  tabId,
  docPath,
  src,
  alt,
  title,
}: {
  tabId: string;
  docPath: string;
  src: string;
  alt: string;
  title?: string;
}) {
  const remote = REMOTE.test(src.trim());
  const [state, setState] = useState<ImageState>({ url: null, error: null });

  useEffect(() => {
    if (remote || !src.trim()) return;
    let live = true;
    setState({ url: null, error: null });
    void filesMarkdownImage(tabId, docPath, src)
      .then((url) => live && setState({ url, error: null }))
      .catch((err: unknown) => live && setState({ url: null, error: err instanceof Error ? err.message : String(err) }));
    return () => {
      live = false;
    };
  }, [tabId, docPath, src, remote]);

  const label = alt.trim() || "Image";
  if (remote) {
    return (
      <span className="file-markdown-image-placeholder" title={src}>
        <span>{label}</span>
        {/* target=_blank: the opener plugin opens it in the system browser. */}
        <a href={src} target="_blank" rel="noreferrer noopener">
          Open image
        </a>
      </span>
    );
  }
  const url = state.url;
  if (url) return <img src={url} alt={alt} title={title} />;
  if (state.error || !src.trim()) {
    return (
      <span className="file-markdown-image-placeholder" title={state.error ?? undefined}>
        {label} (image not shown)
      </span>
    );
  }
  return <span className="file-markdown-image-placeholder">{label}</span>;
}

/** A Markdown file of the Files panel, rendered like a chat reply but with its images. */
export function FileMarkdown({ tabId, path, children }: { tabId: string; path: string; children: string }) {
  const components = useMemo<Components>(
    () => ({
      ...chatMarkdownComponents,
      img: ({ src, alt, title }) => (
        <MarkdownImage
          tabId={tabId}
          docPath={path}
          src={typeof src === "string" ? src : ""}
          alt={alt ?? ""}
          title={title ?? undefined}
        />
      ),
    }),
    [tabId, path],
  );
  return (
    <ReactMarkdown remarkPlugins={remarkPlugins} components={components}>
      {children}
    </ReactMarkdown>
  );
}
