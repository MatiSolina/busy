import { AlertTriangle, Check, Circle, Clock3, Pause, X } from "lucide-react";
import {
  type PlanStep,
  planStatus,
  type TaskPlan,
} from "../../../templates/bot/agent/lib/task-plan";

const states = {
  blocked: { icon: Pause, label: "Blocked" },
  cancelled: { icon: X, label: "Cancelled" },
  completed: { icon: Check, label: "Completed" },
  failed: { icon: AlertTriangle, label: "Failed" },
  in_progress: { icon: Clock3, label: "In progress" },
  pending: { icon: Circle, label: "Pending" },
};

function PlanStepRow({ step, paused }: { step: PlanStep; paused?: boolean }) {
  const { icon: Icon, label } = states[step.status];
  const stateLabel = paused && step.status === "in_progress" ? "Paused" : label;
  return (
    <li className="flex gap-2.5">
      <Icon
        aria-hidden="true"
        className="text-muted-foreground mt-1 size-3.5 shrink-0"
      />
      <div className="min-w-0 space-y-1">
        <p className="text-sm font-medium break-words">{step.title}</p>
        <p className="text-muted-foreground text-xs break-words">
          {stateLabel} · {step.assignee === "self" ? "This bot" : step.assignee}
        </p>
        <p className="text-muted-foreground text-sm break-words">
          {step.note ?? step.expectedResult}
        </p>
      </div>
    </li>
  );
}

export function PlanCard({
  plan,
  paused,
}: {
  plan: TaskPlan;
  paused?: boolean;
}) {
  const completed = plan.steps.filter(
    (step) => step.status === "completed"
  ).length;
  const status = planStatus(plan);
  const failed = plan.steps.some((step) => step.status === "failed");
  return (
    <details
      className="border-border w-full max-w-xl rounded-lg border px-4 py-3"
      open
    >
      <summary className="cursor-pointer text-sm font-medium break-words">
        {plan.title}
        <span className="text-muted-foreground ml-2 text-xs font-normal">
          {completed}/{plan.steps.length} completed
          {status === "cancelled" ? " · Cancelled" : ""}
          {failed ? " · Needs attention" : ""}
          {paused && status === "active" ? " · Paused" : ""}
        </span>
      </summary>
      <ol aria-label="Plan steps" className="mt-4 space-y-4">
        {plan.steps.map((step) => (
          <PlanStepRow key={step.id} paused={paused} step={step} />
        ))}
      </ol>
    </details>
  );
}
