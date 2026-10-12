import type { ReactNode } from "react";

type Props = {
  /**
   * "Files". Leave out inside a Dialog (Activity, Changes): the Dialog header
   * already shows the title and Close, so PanelHeader is only the toolbar.
   */
  title?: string;
  /** Tab label or folder name, shown dimmed after the title. */
  subtitle?: string;
  subtitleTitle?: string;
  /** Controls placed before the right-aligned actions (filters, toggles). */
  children?: ReactNode;
  /** Right-aligned buttons, before the close button. */
  actions?: ReactNode;
  /** Both or neither: the close button shows only when onClose is given. */
  closeLabel?: string;
  onClose?: () => void;
};

/** The one header/toolbar shared by the Activity, Changes and Files side panels. */
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
      {title && <h3 className="panel-header-title">{title}</h3>}
      {subtitle && (
        <span className="hint panel-header-subtitle" title={subtitleTitle ?? subtitle}>
          {subtitle}
        </span>
      )}
      {children}
      <span className="panel-header-spacer" />
      {actions}
      {onClose && (
        <button type="button" className="icon-button" aria-label={closeLabel ?? "Close"} onClick={onClose}>
          ×
        </button>
      )}
    </div>
  );
}
