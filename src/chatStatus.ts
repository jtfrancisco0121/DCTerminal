import type { StatusTone } from "./components/StatusBar";

/** What the status bar says about a running chat. A failed turn is never "Ready". */
export function chatSessionStatus(input: {
  activity: string | null;
  waitingPermission: boolean;
  promptError: string | null;
  agentExited: boolean;
  accepting: boolean;
  hasSession: boolean;
}): { tone: StatusTone; text: string } {
  if (input.activity) {
    return { tone: input.waitingPermission ? "needs" : "busy", text: input.activity };
  }
  if (input.agentExited) return { tone: "error", text: "Agent exited" };
  if (input.promptError) return { tone: "error", text: "Last turn failed" };
  if (!input.hasSession && input.accepting) return { tone: "busy", text: "Starting…" };
  return { tone: "ok", text: "Ready" };
}

const STOP_REASONS: Record<string, string> = {
  end_turn: "Last turn finished",
  max_tokens: "Last turn stopped: reply length limit reached",
  max_turn_requests: "Last turn stopped: too many steps in one turn",
  refusal: "Last turn stopped: the agent declined",
  cancelled: "Last turn cancelled",
};

/** Plain words for the stop reason the agent reported. */
export function stopReasonText(stopReason: string | null | undefined): string {
  if (!stopReason) return "Last turn finished";
  return STOP_REASONS[stopReason] ?? `Last turn ended (${humanizeStatus(stopReason).toLowerCase()})`;
}

/** "in_progress" -> "In progress". */
export function humanizeStatus(value: string): string {
  const text = value.replace(/[_-]+/g, " ").trim();
  return text ? text.charAt(0).toUpperCase() + text.slice(1) : text;
}
