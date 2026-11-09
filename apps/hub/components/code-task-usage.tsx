"use client";

import { ExternalLink } from "lucide-react";
import {
  type CodeTaskCostStatus,
  type PublicCodeTask,
  publicCodeTaskUsage,
} from "@/lib/code-tasks/types";

const tokenFormat = new Intl.NumberFormat("en-US");
const costFormat = new Intl.NumberFormat("en-US", {
  currency: "USD",
  maximumFractionDigits: 4,
  minimumFractionDigits: 2,
  style: "currency",
});

function tokens(value: number | null) {
  return value === null ? "Not reported" : tokenFormat.format(value);
}

export function CodeTaskUsage({ task }: { task: PublicCodeTask }) {
  const usage = task.usage ?? publicCodeTaskUsage(null, task.billing);
  const subscription = task.billing === "chatgpt" ? "ChatGPT" : "Grok";
  const costLabels: Record<CodeTaskCostStatus, string> = {
    included: "Subscription",
    partial: "Pending",
    pending: "Pending",
    reported: "Unavailable",
    unavailable: "Unavailable",
  };
  const unavailableCost = costLabels[usage.costStatus];
  const cost =
    usage.costUsd === null ? unavailableCost : costFormat.format(usage.costUsd);
  const costDescriptions: Record<CodeTaskCostStatus, string> = {
    included: `Billed through your ${subscription} subscription. A separate USD cost per task is not reported.`,
    partial: "Partial cost: some requests are still awaiting billing details.",
    pending: "Waiting for the provider to report the cost of this task.",
    reported:
      "Total provider-reported cost for this coding task, including follow-up instructions.",
    unavailable: "A USD amount has not been reported for this task.",
  };
  const billing = {
    chatgpt: "ChatGPT subscription",
    gateway: "AI Gateway",
    grok: "Grok subscription",
    "token-pass": "Token Pass",
  }[task.billing];
  return (
    <div className="mx-auto max-w-3xl space-y-6">
      <div className="space-y-2">
        <h3 className="text-sm font-medium">Task usage</h3>
        <p className="text-muted-foreground text-xs leading-relaxed">
          Includes the agent&apos;s work and follow-up instructions for this
          task.
        </p>
        {task.prUrl ? (
          <a
            className="text-muted-foreground hover:text-foreground inline-flex items-center gap-1.5 text-xs hover:underline"
            href={task.prUrl}
            rel="noreferrer"
            target="_blank"
          >
            {task.repository.fullName} · Pull request
            <ExternalLink aria-hidden="true" className="size-3" />
          </a>
        ) : null}
      </div>
      <dl className="grid grid-cols-2 border-y sm:grid-cols-3">
        <div className="border-r p-4">
          <dt className="text-muted-foreground text-xs">Input tokens</dt>
          <dd className="mt-2 font-mono text-lg tabular-nums">
            {tokens(usage.inputTokens)}
          </dd>
        </div>
        <div className="p-4 sm:border-r">
          <dt className="text-muted-foreground text-xs">Output tokens</dt>
          <dd className="mt-2 font-mono text-lg tabular-nums">
            {tokens(usage.outputTokens)}
          </dd>
        </div>
        <div className="col-span-2 border-t p-4 sm:col-span-1 sm:border-t-0">
          <dt className="text-muted-foreground text-xs">Cost (USD)</dt>
          <dd className="mt-2 font-mono text-lg tabular-nums">{cost}</dd>
          {usage.costStatus === "partial" ? (
            <p className="text-muted-foreground mt-1 text-[11px]">
              Partial cost
            </p>
          ) : null}
        </div>
      </dl>
      <dl className="divide-y text-xs">
        {(
          [
            ["Cached input tokens", tokens(usage.cacheReadTokens)],
            ["Cache write tokens", tokens(usage.cacheWriteTokens)],
            ["Reasoning tokens", tokens(usage.reasoningTokens)],
            ["Reported turns", tokenFormat.format(usage.requests)],
            ["Model", task.model],
            ["Billing", billing],
          ] as const
        ).map(([label, value]) => (
          <div
            className="flex items-start justify-between gap-4 py-3"
            key={label}
          >
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="text-right font-mono break-all tabular-nums">
              {value}
            </dd>
          </div>
        ))}
      </dl>
      <p className="text-muted-foreground text-xs leading-relaxed">
        {costDescriptions[usage.costStatus]}
      </p>
    </div>
  );
}
