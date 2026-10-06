import type { ReactNode } from "react";
import type { PlanEntry, SessionCards as Cards, TaskUpdate, TodoItem } from "../sessionCards";
import { activeToolProgress } from "../sessionCards";
import type { StreamSegment } from "../transcript";

type PlanRequest = {
  jsonRpcId: number;
  title: string;
  entries: PlanEntry[];
};

type Props = {
  cards: Cards;
  segments: StreamSegment[];
  planRequest: PlanRequest | null;
  busy: boolean;
  onAcceptPlan?: () => void;
  onRejectPlan?: () => void;
};

export function SessionCards({
  cards,
  segments,
  planRequest,
  busy,
  onAcceptPlan,
  onRejectPlan,
}: Props) {
  const plan = cards.plan.length > 0 ? cards.plan : (planRequest?.entries ?? []);
  const tools = activeToolProgress(segments);
  const hasTools = tools.length > 0;
  if (plan.length === 0 && cards.todos.length === 0 && cards.tasks.length === 0 && !hasTools) {
    return null;
  }
  return (
    <div className="session-cards">
      {plan.length > 0 && (
        <Card title={planRequest?.title || "Plan"}>
          <StatusList items={plan.map((entry) => ({
            key: entry.content,
            label: entry.content,
            status: entry.status,
          }))} />
          {planRequest && onAcceptPlan && onRejectPlan && (
            <div className="button-row">
              <button type="button" className="primary-button" disabled={busy} onClick={onAcceptPlan}>
                Accept plan
              </button>
              <button type="button" className="secondary-button" disabled={busy} onClick={onRejectPlan}>
                Reject plan
              </button>
            </div>
          )}
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
        </Card>
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
