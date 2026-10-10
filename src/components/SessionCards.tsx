import type { ReactNode } from "react";
import type { PlanEntry, SessionCards as Cards, TaskUpdate, TodoItem } from "../sessionCards";
import { activeToolProgress } from "../sessionCards";
import type { StreamSegment } from "../transcript";
import { HandoffActions } from "./HandoffDialog";
import type { HandoffTargetId } from "../handoff/map";

type PlanRequest = {
  jsonRpcId: number;
  title: string;
  entries: PlanEntry[];
  markdown?: string | null;
  keepOptionId?: string | null;
};

type HandoffOffer = {
  enabled: boolean;
  reason: string | null;
  targets?: HandoffTargetId[];
  primaryTarget?: string | null;
  onSend: (target: HandoffTargetId) => void;
};

type Props = {
  cards: Cards;
  segments: StreamSegment[];
  planRequest: PlanRequest | null;
  busy: boolean;
  onAcceptPlan?: () => void;
  onRejectPlan?: () => void;
  handoff?: HandoffOffer | null;
};

export function SessionCards({
  cards,
  segments,
  planRequest,
  busy,
  onAcceptPlan,
  onRejectPlan,
  handoff,
}: Props) {
  const plan = cards.plan.length > 0 ? cards.plan : (planRequest?.entries ?? []);
  const markdown = planRequest?.markdown?.trim() ?? "";
  // Claude ExitPlanMode. Never offer Accept / "Yes" — implementation is a hand-off.
  const claudeExit = markdown.length > 0 || !!planRequest?.keepOptionId;
  const tools = activeToolProgress(segments);
  const hasTools = tools.length > 0;
  const handoffActions = handoff ? (
    <HandoffActions
      enabled={handoff.enabled}
      reason={handoff.reason}
      targets={handoff.targets}
      primaryTarget={handoff.primaryTarget}
      busy={busy}
      onSend={handoff.onSend}
    />
  ) : null;
  if (
    plan.length === 0 &&
    !markdown &&
    cards.todos.length === 0 &&
    cards.tasks.length === 0 &&
    !hasTools &&
    !handoffActions
  ) {
    return null;
  }
  return (
    <div className="session-cards">
      {(plan.length > 0 || markdown) && (
        <Card title={planRequest?.title || "Plan"}>
          {markdown && <pre className="plan-markdown">{markdown}</pre>}
          {plan.length > 0 && (
            <StatusList items={plan.map((entry) => ({
              key: entry.content,
              label: entry.content,
              status: entry.status,
            }))} />
          )}
          {planRequest && claudeExit && (
            <div className="button-row">
              {handoffActions}
              {onRejectPlan && (
                <button type="button" className="secondary-button" disabled={busy} onClick={onRejectPlan}>
                  Keep planning
                </button>
              )}
            </div>
          )}
          {planRequest && !claudeExit && onAcceptPlan && onRejectPlan && (
            <div className="button-row">
              <button type="button" className="primary-button" disabled={busy} onClick={onAcceptPlan}>
                Accept plan
              </button>
              <button type="button" className="secondary-button" disabled={busy} onClick={onRejectPlan}>
                Reject plan
              </button>
            </div>
          )}
          {!claudeExit && handoffActions}
        </Card>
      )}
      {cards.todos.length > 0 && (
        <Card title="To-dos">
          <StatusList
            items={cards.todos.map((todo: TodoItem) => ({
              key: todo.id,
              label: todo.content,
              status: todo.status,
            }))}
          />
          {plan.length === 0 && !markdown ? handoffActions : null}
        </Card>
      )}
      {plan.length === 0 && !markdown && cards.todos.length === 0 && handoffActions && (
        <Card title="Hand-off">{handoffActions}</Card>
      )}
      {cards.tasks.length > 0 && (
        <Card title="Sub-agents">
          <ul className="session-card-list">
            {cards.tasks.map((task: TaskUpdate) => (
              <li key={task.agentId}>
                <span>{task.description}</span>
                <span className="hint">
                  {task.status}
                  {task.model ? ` · ${task.model}` : ""}
                  {task.durationMs != null ? ` · ${task.durationMs} ms` : ""}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}
      {hasTools && (
        <Card title="Tool progress">
          <StatusList
            items={tools.map((tool, index) => ({
              key: `${tool.text}-${index}`,
              label: tool.text,
              status: tool.status,
            }))}
          />
        </Card>
      )}
    </div>
  );
}

function Card({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="session-card">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function StatusList({
  items,
}: {
  items: { key: string; label: string; status: string }[];
}) {
  return (
    <ul className="session-card-list">
      {items.map((item) => (
        <li key={item.key}>
          <span className={`status-dot status-dot-${item.status}`} aria-hidden />
          <span>{item.label}</span>
          <span className="hint">{item.status}</span>
        </li>
      ))}
    </ul>
  );
}
