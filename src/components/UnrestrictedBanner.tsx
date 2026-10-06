type Props = {
  visible: boolean;
  onDismiss: () => void;
};

const MESSAGE =
  "Cursor CLI is set to Run Everything, so DCTerminal's role permission rules are off. Change it in Cursor CLI settings to enable them.";

export function UnrestrictedBanner({ visible, onDismiss }: Props) {
  if (!visible) return null;
  return (
    <div className="unrestricted-banner" role="status">
      <p className="unrestricted-banner-text">{MESSAGE}</p>
      <button type="button" className="secondary-button" onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}

export const UNRESTRICTED_BANNER_MESSAGE = MESSAGE;
