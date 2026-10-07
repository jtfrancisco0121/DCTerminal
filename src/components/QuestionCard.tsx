import type { QuestionRequestEvent } from "../bridge";

type Props = {
  request: QuestionRequestEvent;
  busy: boolean;
  onAnswer: (choiceId: string) => void;
  onSkip: () => void;
  onCancel: () => void;
};

export function QuestionCard({ request, busy, onAnswer, onSkip, onCancel }: Props) {
  return (
    <div className="permission-card question-card" role="dialog" aria-labelledby="question-title">
      <p id="question-title" className="permission-card-title">
        {request.title}
      </p>
      {request.prompt && <p className="permission-card-message">{request.prompt}</p>}
      <p className="permission-card-hint">The agent is paused until you pick an option.</p>
      <div className="permission-card-actions">
        {request.choices.map((choice) => (
          <button
            key={choice.id}
            type="button"
            className="primary-button"
            disabled={busy}
            onClick={() => onAnswer(choice.id)}
          >
            {choice.label}
          </button>
        ))}
        <button type="button" className="secondary-button" disabled={busy} onClick={onSkip}>
          Skip
        </button>
        <button type="button" className="secondary-button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}
