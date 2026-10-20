/**
 * Stop reason codes (Track H2/H5): every autopilot stop carries one, sent by
 * the Rust core as `stopReason` on the run and the decision, and as the
 * `outcome` of the ledger's stop line. Each has one plain-English line, shown
 * on the pipeline overview, in the stop notification and in the timeline.
 */
import type { StopReason } from "../bridge";

const LINES: Record<StopReason, string> = {
  checkpoint: "Checkpoint: autopilot waits for you to check the work and hand it on.",
  gate_failed: "A check kept failing after its retries.",
  no_check_found: "A check found nothing to run.",
  no_result: "The stage's reply had no result, even after it was asked again.",
  no_verdict: "No verdict could be read from the review.",
  blocking_findings: "The review found problems that need your decision.",
  round_cap: "The review reached its round cap.",
  usage_limit: "Claude's usage limit was reached.",
  stalled: "The stage stopped making progress.",
  app_restarted: "A turn finished while DCTerminal was closed.",
  carry_out_failed: "Autopilot could not carry out its decision.",
  taken_over: "You took over the stage.",
  paused_by_you: "You turned autopilot off.",
};

/** Every code, in the plan's order. */
export const STOP_REASONS = Object.keys(LINES) as StopReason[];

export function isStopReason(code: string | null | undefined): code is StopReason {
  return !!code && Object.prototype.hasOwnProperty.call(LINES, code);
}

/** The code's plain-English line; null for none, or a code from a newer build. */
export function stopReasonText(code: string | null | undefined): string | null {
  return isStopReason(code) ? LINES[code] : null;
}

/** The stop notification: the code's line, then the reason itself. */
export function stopNotice(code: string | null | undefined, why: string): string {
  const line = stopReasonText(code);
  return line ? `${line} ${why}` : why;
}
