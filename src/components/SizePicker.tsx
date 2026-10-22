import { RUN_SIZES, SIZE_LABEL, SIZE_PIPELINE, type RunSize, type SizeSuggestion } from "../pipeline/sizes";
import { pipelineDef } from "../pipeline/defs";

type Props = {
  /** The size picked now (the pipeline the start begins), or null. */
  value: RunSize | null;
  suggestion: SizeSuggestion;
  onPick: (size: RunSize) => void;
  disabled?: boolean;
};

/**
 * F3: the S / M / L picker on the start screen, shown with Eagle-Eye
 * ticked. Each size starts one built-in pipeline (S: Eagle-Eye 2, M:
 * Eagle-Eye 1, L: Eagle-Eye L); the suggestion comes from the task and the
 * ClickUp tickets, and your pick wins.
 */
export function SizePicker({ value, suggestion, onPick, disabled = false }: Props) {
  return (
    <div className="size-picker" role="radiogroup" aria-label="Run size">
      {RUN_SIZES.map((size) => {
        const name = pipelineDef(SIZE_PIPELINE[size])?.name ?? SIZE_PIPELINE[size];
        return (
          <button
            key={size}
            type="button"
            role="radio"
            aria-checked={value === size}
            className={`role-choice size-choice${value === size ? " selected" : ""}`}
            disabled={disabled}
            title={`${name}: ${SIZE_LABEL[size]}`}
            onClick={() => onPick(size)}
          >
            {size}
            {suggestion.size === size && <span className="hint"> (suggested)</span>}
          </button>
        );
      })}
      <span className="hint size-why">
        Suggested {suggestion.size}: {suggestion.why}.
        {value && ` ${value} starts ${pipelineDef(SIZE_PIPELINE[value])?.name ?? SIZE_PIPELINE[value]}.`}
      </span>
    </div>
  );
}
