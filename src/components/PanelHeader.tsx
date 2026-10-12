import type { ReactNode } from "react";

type Props = {
  /** "Activity", "Changes", "Files". */
  title: string;
  /** Tab label or folder name, shown dimmed after the title. */
  subtitle?: string;
  subtitleTitle?: string;
  /** Controls placed before the right-aligned actions (filters, toggles). */
  children?: ReactNode;
  /** Right-aligned buttons, before the close button. */
  actions?: ReactNode;
  closeLabel: string;
  onClose: () => void;
};

/** The one header shared by the Activity, Changes and Files side panels. */
export function PanelHeader({
  title,
  subtitle,
  subtitleTitle,
  children,
  actions,
  closeLabel,
  onClose,
}: Props) {
  return (
    <div className="panel-header">
      <h3 className="panel-header-title">{title}</h3>
      {subtitle && (
        <span className="hint panel-header-subtitle" title={subtitleTitle ?? subtitle}>
          {subtitle}
        </span>
      )}
      {children}
      <span className="panel-header-spacer" />
      {actions}
      <button type="button" className="icon-button" aria-label={closeLabel} onClick={onClose}>
        ×
      </button>
    </div>
  );
}
