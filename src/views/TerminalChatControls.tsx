import {
  forwardRef,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
  useSyncExternalStore,
  type KeyboardEvent,
} from "react";
import { errorText } from "../components/InlineNotice";
import { shortcutLabel, type Platform } from "../keymap";
import { historyNavigate } from "../scratch/pad";
import { dialogDetector, type DialogOption } from "../terminal/permissionDialog";
import { answerPermission, sendComposerText, stopTurn } from "../terminal/ptyAnswers";

/** Drafts by tab id, for this run: switching views or tabs keeps the text. */
const drafts = new Map<string, string>();

export function composerDraft(tabId: string): string {
  return drafts.get(tabId) ?? "";
}

export function forgetComposerDraft(tabId: string): void {
  drafts.delete(tabId);
}

export type TerminalComposerHandle = {
  focus: () => void;
  /** Mod+Enter: send (or queue) the draft. */
  send: () => void;
};

export type TerminalComposerProps = {
  tabId: string;
  platform: Platform;
  /** Claude is working: sending queues the message, and Stop shows. */
  working: boolean;
  /** Claude Code exited: nothing can be sent until the terminal restarts it. */
  exited: boolean;
  /**
   * Claude waits on a dialog (Needs you, a permission prompt, an open plan or
   * question). Enter would pick its highlighted option, so nothing is sent
   * until it clears; the draft stays.
   */
  blocked?: boolean;
  /** Earlier sends of this tab, newest first (ArrowUp walks them). */
  history?: string[];
  /** Runs before the write, e.g. the "This turn" snapshot. Must not reject. */
  beforeSend?: (tabId: string) => Promise<void>;
  /** The text reached the terminal. */
  onSent?: (text: string) => void;
  onShowTerminal: () => void;
};

/** The chat view's composer: one bracketed paste and Enter into the tab's PTY. */
export const TerminalComposer = forwardRef<TerminalComposerHandle, TerminalComposerProps>(
  function TerminalComposer(
    { tabId, platform, working, exited, blocked = false, history = [], beforeSend, onSent, onShowTerminal },
    ref,
  ) {
    const fieldRef = useRef<HTMLTextAreaElement>(null);
    const [text, setTextState] = useState(() => composerDraft(tabId));
    const [cursor, setCursor] = useState(-1);
    const [error, setError] = useState<string | null>(null);
    const [sending, setSending] = useState(false);

    useEffect(() => {
      setTextState(composerDraft(tabId));
      setCursor(-1);
      setError(null);
      // Shown (a tab or view switch): take the keys unless something else holds them.
      const active = document.activeElement;
      if (!active || active === document.body || active.closest("#terminal-park, .xterm")) {
        fieldRef.current?.focus();
      }
    }, [tabId]);

    const setText = (value: string) => {
      if (value) drafts.set(tabId, value);
      else drafts.delete(tabId);
      setTextState(value);
    };

    const send = () => {
      if (exited || blocked || sending || !text.trim()) return;
      const sent = text;
      setSending(true);
      setError(null);
      void (beforeSend ? beforeSend(tabId).catch(() => {}) : Promise.resolve())
        .then(() => sendComposerText(tabId, sent))
        .then(() => {
          // The text left for the terminal; keep anything typed meanwhile.
          if (composerDraft(tabId) === sent) setText("");
          setCursor(-1);
          onSent?.(sent.trim());
        })
        .catch((err: unknown) => setError(errorText(err)))
        .finally(() => setSending(false));
    };

    const stop = () => {
      void stopTurn(tabId).catch((err: unknown) => setError(errorText(err)));
    };

    useImperativeHandle(ref, () => ({
      focus: () => fieldRef.current?.focus(),
      send,
    }));

    const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
      if ((event.key === "ArrowUp" || event.key === "ArrowDown") && !event.altKey && !event.shiftKey) {
        const step = historyNavigate({
          history,
          cursor,
          direction: event.key === "ArrowUp" ? "older" : "newer",
          draft: text,
          caretAtStart: event.currentTarget.selectionStart === 0,
        });
        if (step.handled) {
          event.preventDefault();
          setCursor(step.cursor);
          setText(step.text);
        }
        return;
      }
      // The app shortcut handles Mod+Enter first; this covers a field outside its reach.
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey) && !event.shiftKey) {
        event.preventDefault();
        send();
      }
    };

    const sendKeys = shortcutLabel("send", platform);
    return (
      <div className="terminal-chat-composer">
        {error && (
          <p className="error terminal-chat-composer-error" role="alert">
            {error}
          </p>
        )}
        {exited ? (
          <div className="terminal-chat-composer-exited">
            <span>Claude Code exited. Open the terminal to resume or start again.</span>
            <button type="button" className="secondary-button" onClick={onShowTerminal}>
              Show terminal
            </button>
          </div>
        ) : (
          <>
            <textarea
              ref={fieldRef}
              className="text-input terminal-chat-composer-input"
              aria-label="Message Claude"
              placeholder={working ? "Queue a message for Claude" : "Message Claude"}
              rows={3}
              value={text}
              onChange={(event) => {
                setText(event.target.value);
                setCursor(-1);
              }}
              onKeyDown={onKeyDown}
            />
            <div className="terminal-chat-composer-bar">
              {blocked ? (
                <span className="hint terminal-chat-composer-hint" role="status">
                  Answer the question above, or in the terminal, first.
                </span>
              ) : (
                <span className="hint terminal-chat-composer-hint">
                  {sendKeys && <kbd>{sendKeys}</kbd>} to {working ? "queue" : "send"} · Enter adds a line
                </span>
              )}
              {working && (
                <button type="button" className="secondary-button" onClick={stop} title="Sends Esc to Claude Code">
                  Stop
                </button>
              )}
              <button
                type="button"
                className="primary-button"
                disabled={blocked || sending || !text.trim()}
                onClick={send}
                title={working ? "Claude Code runs it after the current turn" : undefined}
              >
                {working ? "Queue" : "Send"}
              </button>
            </div>
          </>
        )}
      </div>
    );
  },
);

export type PermissionDialogView = { prompt: string; options: DialogOption[] };

const NO_DIALOG: PermissionDialogView = { prompt: "", options: [] };

/** The permission dialog the detector sees in this tab's PTY, or null. */
export function usePermissionDialog(tabId: string): PermissionDialogView | null {
  const cache = useRef<{ key: string; view: PermissionDialogView }>({ key: "", view: NO_DIALOG });
  const view = useSyncExternalStore(
    (notify) => dialogDetector.subscribe((id) => id === tabId && notify()),
    () => {
      const visible = dialogDetector.isVisible(tabId);
      const prompt = visible ? dialogDetector.prompt(tabId) : "";
      const options = visible ? dialogDetector.options(tabId) : [];
      const key = visible ? `${prompt}\n${options.map((o) => `${o.key}.${o.label}`).join("\n")}` : "";
      if (key !== cache.current.key) cache.current = { key, view: visible ? { prompt, options } : NO_DIALOG };
      return cache.current.view;
    },
  );
  return view.options.length > 0 ? view : null;
}

type AnswerState = { kind: "idle" } | { kind: "sending"; key: string } | { kind: "stuck" } | { kind: "failed"; message: string };

/** Claude Code's permission dialog as buttons; each presses the option's number. */
export function PermissionCard({
  tabId,
  dialog,
  onShowTerminal,
}: {
  tabId: string;
  dialog: PermissionDialogView;
  onShowTerminal: () => void;
}) {
  const [state, setState] = useState<AnswerState>({ kind: "idle" });
  const live = useRef(true);
  useEffect(() => {
    live.current = true;
    return () => {
      live.current = false;
    };
  }, []);
  // A new dialog starts fresh.
  useEffect(() => setState({ kind: "idle" }), [dialog.prompt]);

  const answer = (option: DialogOption) => {
    setState({ kind: "sending", key: option.key });
    answerPermission(tabId, option)
      .then((result) => {
        if (live.current) setState(result === "stuck" ? { kind: "stuck" } : { kind: "idle" });
      })
      .catch((err: unknown) => {
        if (live.current) setState({ kind: "failed", message: errorText(err) });
      });
  };

  const lines = dialog.prompt.split("\n");
  const question = lines[lines.length - 1] ?? "";
  const detail = lines.slice(0, -1).join("\n");
  return (
    <section className="session-card terminal-chat-card terminal-chat-permission" aria-label="Permission">
      <header className="terminal-chat-card-head">
        <h3>{question || "Claude asks to continue"}</h3>
      </header>
      {detail && <pre className="terminal-chat-permission-detail">{detail}</pre>}
      <div className="terminal-chat-permission-options">
        {dialog.options.map((option) => (
          <button
            key={option.key}
            type="button"
            className={option.key === "1" ? "primary-button" : "secondary-button"}
            disabled={state.kind === "sending"}
            onClick={() => answer(option)}
          >
            <span className="terminal-chat-option-key" aria-hidden>
              {option.key}
            </span>{" "}
            {option.label}
          </button>
        ))}
      </div>
      {state.kind === "sending" && <p className="hint">Answering…</p>}
      {(state.kind === "stuck" || state.kind === "failed") && (
        <div className="terminal-chat-answer-failed" role="alert">
          <span>
            {state.kind === "stuck" ? "Didn't go through — answer in the terminal." : state.message}
          </span>
          <button type="button" className="secondary-button" onClick={onShowTerminal}>
            Show terminal
          </button>
        </div>
      )}
    </section>
  );
}
