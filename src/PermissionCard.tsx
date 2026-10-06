import type { PermissionRequestEvent } from "./bridge";

type Props = {
  request: PermissionRequestEvent;
  busy: boolean;
  onSelect: (optionId: string) => void;
  onCancel: () => void;
};

export function PermissionCard({ request, busy, onSelect, onCancel }: Props) {
  return (
    <div className="permission-card" role="dialog" aria-labelledby="perm-title">
      <p id="perm-title" className="permission-card-title">
        {request.title}
      </p>
      {request.message && (
        <p className="permission-card-message">{request.message}</p>
      )}
      <div className="permission-card-actions">
        {request.options.map((opt) => (
          <button
            key={opt.id}
            type="button"
            className={
              opt.id.includes("reject")
                ? "secondary-button"
                : "primary-button"
            }
            disabled={busy}
            onClick={() => onSelect(opt.id)}
          >
            {opt.label}
          </button>
        ))}
        <button
          type="button"
          className="secondary-button"
          disabled={busy}
          onClick={onCancel}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}
