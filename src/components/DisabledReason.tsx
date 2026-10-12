import type { ReactNode } from "react";

/**
 * The reason a nearby button is off, shown beside it. Renders nothing when
 * there is no reason (the button is enabled, or only busy).
 */
export function DisabledReason({
  children,
  className = "",
}: {
  children?: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return (
    <span className={`dialog-footer-note ${className}`.trim()} role="note">
      {children}
    </span>
  );
}
