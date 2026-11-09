"use client";

import { ExternalLink, Gauge, Sparkles } from "lucide-react";
import Image from "next/image";
import { useCallback } from "react";
import { preload } from "react-dom";
import { useAccount } from "@/components/account-provider";
import { useAiConnectionOptional } from "@/components/ai-connection-provider";
import { Button } from "@/components/ui/button";
import type { AiProviderId, AiProviderOption } from "@/lib/ai/types";
import { cn } from "@/lib/utils";

const GROK_LOGO = "/ai-providers/grok.png";
// The account menu mounts its content on open; fetch the logo up front so it
// does not pop in after the menu appears.
preload(GROK_LOGO, { as: "image" });

const CHATGPT_USAGE_URL = "https://chatgpt.com/settings/usage";
const AI_GATEWAY_DOCS_URL = "https://vercel.com/docs/ai-gateway";
let usageFormat: Intl.NumberFormat | undefined;
let creditFormat: Intl.NumberFormat | undefined;

function formatUsage(value: number) {
  usageFormat ??= new Intl.NumberFormat(undefined, {
    maximumFractionDigits: 1,
  });
  return usageFormat.format(value);
}

function formatCredit(value: number) {
  creditFormat ??= new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  });
  return creditFormat.format(value);
}

type ConnectionState =
  | { kind: "legacy" }
  | { kind: "loading" }
  | { kind: "error" }
  | { kind: "choose" }
  | {
      kind: "provider";
      model: string | null;
      option: AiProviderOption;
      provider: AiProviderId;
    };

/** Content for the account menu item. The parent owns the Menu.Item wrapper. */
export function AccountAiMenuContent() {
  const connection = useAiConnectionOptional();
  const account = useAccount();
  const state = connectionState(connection);

  if (state.kind === "legacy") {
    return (
      <>
        <Gauge aria-hidden="true" />
        <span className="flex-1">Token Pass usage</span>
        <span className="text-muted-foreground text-xs">
          <TokenPassUsageLabel account={account} compact />
        </span>
      </>
    );
  }

  if (state.kind === "loading") {
    return <MenuConnectionContent label="AI connection" status="Checking…" />;
  }
  if (state.kind === "error") {
    return <MenuConnectionContent label="AI connection" status="Unavailable" />;
  }
  if (state.kind === "choose") {
    return <MenuConnectionContent label="AI connection" status="Choose" />;
  }

  if (
    state.kind === "provider" &&
    state.provider === "token-pass" &&
    state.option.status === "available"
  ) {
    return (
      <>
        <Gauge aria-hidden="true" />
        <span className="flex-1">Token Pass usage</span>
        <span className="text-muted-foreground text-xs">
          <TokenPassUsageLabel account={account} compact />
        </span>
      </>
    );
  }

  const label = menuProviderLabel(
    state.provider,
    state.option.status === "available"
  );
  const status = providerStatus(state.option);
  return (
    <>
      <ProviderLogo provider={state.provider} />
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="text-muted-foreground text-xs">{status}</span>
    </>
  );
}

/** Settings card that follows the saved AI connection, not an unsaved draft. */
export function AccountAiConnectionCard({
  variant = "card",
}: {
  variant?: "card" | "plain";
} = {}) {
  const connection = useAiConnectionOptional();
  const account = useAccount();
  const state = connectionState(connection);

  if (
    state.kind === "legacy" ||
    (state.kind === "provider" &&
      state.provider === "token-pass" &&
      state.option.status === "available")
  ) {
    return (
      <TokenPassUsageCard
        account={account}
        connection={connection}
        variant={variant}
      />
    );
  }

  return (
    <section
      aria-labelledby="account-ai-connection-heading"
      className={
        variant === "card" ? "border-border rounded-xl border p-4" : undefined
      }
    >
      <div className="flex items-start gap-3">
        {state.kind === "provider" ? (
          <ProviderLogo provider={state.provider} />
        ) : (
          <span
            aria-hidden="true"
            className="bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center"
          >
            <Sparkles className="size-4" />
          </span>
        )}
        <div className="min-w-0 flex-1">
          <div className="flex items-start justify-between gap-3">
            <h3
              className="text-sm font-medium"
              id="account-ai-connection-heading"
            >
              {cardTitle(state)}
            </h3>
            <span className="text-muted-foreground shrink-0 text-xs">
              {cardStatus(state)}
            </span>
          </div>
          <ConnectionCardBody connection={connection} state={state} />
        </div>
      </div>
    </section>
  );
}

function ConnectionCardBody({
  connection,
  state,
}: {
  connection: ReturnType<typeof useAiConnectionOptional>;
  state: Exclude<ConnectionState, { kind: "legacy" }>;
}) {
  const retry = useCallback(() => {
    connection?.refresh().catch(() => undefined);
  }, [connection]);
  if (state.kind === "loading") {
    return (
      <p className="text-muted-foreground mt-3 text-xs">
        Checking AI connection…
      </p>
    );
  }
  if (state.kind === "error") {
    return (
      <div className="mt-3">
        <p className="text-muted-foreground text-xs">
          AI connection is unavailable. Retry to load its current status.
        </p>
        {connection ? (
          <Button
            className="mt-3 h-8 px-3"
            onClick={retry}
            size="sm"
            variant="outline"
          >
            Try again
          </Button>
        ) : null}
      </div>
    );
  }
  if (state.kind === "choose") {
    return (
      <p className="text-muted-foreground mt-3 text-xs">
        Choose an AI connection in Settings.
      </p>
    );
  }
  if (state.provider === "token-pass" && state.option.status !== "available") {
    return (
      <p className="text-destructive mt-3 text-xs" role="alert">
        Token Pass is not configured for this Busy account. Choose AI Gateway or
        ask the account owner to configure Token Pass.
      </p>
    );
  }
  if (state.provider === "token-pass") {
    return (
      <>
        <ConnectionIssueStatus connection={connection} retry={retry} />
        <p className="text-muted-foreground mt-3 text-xs">
          Use your Vercel team&apos;s Token Pass allowance.
        </p>
      </>
    );
  }
  if (state.provider === "gateway") {
    return (
      <>
        <ConnectionIssueStatus connection={connection} retry={retry} />
        <p className="text-muted-foreground mt-3 text-xs">
          Use Vercel AI Gateway for model calls. Usage is billed by model and
          provider.
        </p>
        <a
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
          href={AI_GATEWAY_DOCS_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          View AI Gateway billing docs{" "}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      </>
    );
  }

  if (state.option.status !== "available") {
    return (
      <p className="text-muted-foreground mt-3 text-xs">
        Reconnect your {state.provider === "chatgpt" ? "ChatGPT" : "Grok"}{" "}
        subscription to use it in Busy. Existing bot settings stay unchanged,
        but bots using this connection cannot run until you reconnect it.
      </p>
    );
  }

  const modelAvailable = state.option.models?.some(
    (model) => model.id === state.model
  );

  return (
    <>
      {connection?.error || connection?.connectionError ? (
        <ConnectionIssueStatus connection={connection} retry={retry} />
      ) : null}
      <p className="text-muted-foreground mt-3 text-xs">
        Using your {state.provider === "chatgpt" ? "ChatGPT" : "Grok"}{" "}
        subscription.
      </p>
      {state.model ? (
        <p className="mt-2 text-xs">
          Model:{" "}
          {state.option.models?.find((model) => model.id === state.model)
            ?.label ?? state.model}
          {modelAvailable ? null : (
            <span className="text-destructive ml-1">
              (no longer available; choose another in Settings)
            </span>
          )}
        </p>
      ) : null}
      {state.provider === "chatgpt" ? (
        <a
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
          href={CHATGPT_USAGE_URL}
          rel="noopener noreferrer"
          target="_blank"
        >
          Manage usage <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : (
        <a
          className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
          href="https://grok.com/dashboard"
          rel="noopener noreferrer"
          target="_blank"
        >
          View usage in Grok{" "}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      )}
    </>
  );
}

function ConnectionIssueStatus({
  connection,
  retry,
}: {
  connection: ReturnType<typeof useAiConnectionOptional>;
  retry: () => void;
}) {
  if (!(connection?.error || connection?.connectionError)) {
    return null;
  }
  return (
    <div
      className="border-destructive/30 bg-destructive/5 mt-3 rounded-lg border p-3"
      role="alert"
    >
      <p className="text-destructive text-xs">
        {connection.error ?? connection.connectionError}
      </p>
      <Button
        className="mt-3 h-8 px-3"
        onClick={retry}
        size="sm"
        variant="outline"
      >
        Refresh status
      </Button>
    </div>
  );
}

function connectionState(
  connection: ReturnType<typeof useAiConnectionOptional>
): ConnectionState {
  if (!connection) {
    return { kind: "legacy" };
  }
  if (connection.loading && !connection.snapshot) {
    return { kind: "loading" };
  }
  if (connection.error && !connection.snapshot) {
    return { kind: "error" };
  }
  if (!connection.snapshot) {
    return { kind: "loading" };
  }
  if (!connection.snapshot.provider) {
    return { kind: "choose" };
  }
  const { model, provider, providers } = connection.snapshot;
  const option = providers.find((item) => item.id === provider);
  if (!option) {
    return { kind: "error" };
  }
  return {
    kind: "provider",
    model: model ?? null,
    option,
    provider,
  };
}

function providerLabel(provider: AiProviderId) {
  if (provider === "chatgpt") {
    return "ChatGPT subscription";
  }
  if (provider === "grok") {
    return "Grok subscription";
  }
  if (provider === "gateway") {
    return "AI Gateway";
  }
  return "Token Pass";
}

function menuProviderLabel(provider: AiProviderId, active: boolean) {
  if (provider === "chatgpt") {
    return active ? "Using ChatGPT" : "ChatGPT";
  }
  if (provider === "grok") {
    return active ? "Using Grok" : "Grok";
  }
  return providerLabel(provider);
}

function providerStatus(option: AiProviderOption) {
  return option.status === "available" ? "Active" : "Reconnect";
}

function cardTitle(state: Exclude<ConnectionState, { kind: "legacy" }>) {
  return state.kind === "provider"
    ? providerLabel(state.provider)
    : "AI connection";
}

function cardStatus(state: Exclude<ConnectionState, { kind: "legacy" }>) {
  if (state.kind === "loading") {
    return "Checking…";
  }
  if (state.kind === "error") {
    return "Unavailable";
  }
  if (state.kind === "choose") {
    return "Choose";
  }
  return providerStatus(state.option);
}

function MenuConnectionContent({
  label,
  status,
}: {
  label: string;
  status: string;
}) {
  return (
    <>
      <Sparkles aria-hidden="true" />
      <span className="flex-1">{label}</span>
      <span className="text-muted-foreground text-xs">{status}</span>
    </>
  );
}

function ProviderLogo({ provider }: { provider: AiProviderId }) {
  if (provider === "grok") {
    return (
      <Image
        alt=""
        className="size-5 shrink-0"
        height={20}
        loading="eager"
        src={GROK_LOGO}
        unoptimized
        width={20}
      />
    );
  }
  const name = provider === "chatgpt" ? "chatgpt" : "vercel-mark";
  return (
    <span
      aria-hidden="true"
      className="grid size-5 shrink-0 place-items-center"
    >
      <Image
        alt=""
        className="dark:hidden"
        height={20}
        src={`/ai-providers/${name}-black.svg`}
        width={20}
      />
      <Image
        alt=""
        className="hidden dark:block"
        height={20}
        src={`/ai-providers/${name}-white.svg`}
        width={20}
      />
    </span>
  );
}

function TokenPassUsageLabel({
  account,
  compact = false,
}: {
  account: ReturnType<typeof useAccount>;
  compact?: boolean;
}) {
  const percent = account.error ? null : account.data?.tokenPass.percentUsed;
  if (account.loading) {
    return <span className="text-muted-foreground">Checking…</span>;
  }
  if (percent === null || percent === undefined) {
    return (
      <span className="text-muted-foreground">
        {compact ? "—" : "Unavailable"}
      </span>
    );
  }
  return (
    <span className="tabular-nums">
      {formatUsage(percent)}%{compact ? "" : " used"}
    </span>
  );
}

function TokenPassUsageCard({
  account,
  connection,
  variant,
}: {
  account: ReturnType<typeof useAccount>;
  connection: ReturnType<typeof useAiConnectionOptional>;
  variant: "card" | "plain";
}) {
  const retry = useCallback(() => {
    connection?.refresh().catch(() => undefined);
  }, [connection]);
  const percent = account.error ? null : account.data?.tokenPass.percentUsed;
  const value =
    percent === null || percent === undefined
      ? undefined
      : Math.min(100, Math.max(0, percent));
  const valueText = usageValueText(account, percent);
  const description = tokenPassDescription(account);
  return (
    <section
      aria-labelledby="subscription-heading"
      className={
        variant === "card" ? "border-border rounded-xl border p-4" : undefined
      }
    >
      <ConnectionIssueStatus connection={connection} retry={retry} />
      <div className="mb-3 flex items-center justify-between gap-3">
        <h3 className="text-sm font-medium" id="subscription-heading">
          Token Pass
        </h3>
        <span className="text-sm">
          <TokenPassUsageLabel account={account} />
        </span>
      </div>
      <span
        aria-label="Token Pass subscription usage"
        aria-valuemax={100}
        aria-valuemin={0}
        aria-valuenow={value}
        aria-valuetext={valueText}
        className="bg-foreground/10 block h-1 w-full overflow-hidden"
        role="progressbar"
      >
        <span
          className={cn(
            "bg-foreground/70 block h-full transition-[width]",
            percent !== null &&
              percent !== undefined &&
              percent >= 90 &&
              "bg-amber-400"
          )}
          style={{ width: `${value ?? 0}%` }}
        />
      </span>
      <p className="text-muted-foreground mt-3 text-xs leading-relaxed">
        {description}
      </p>
      {!account.error &&
      account.data?.tokenPass.usedUsd !== null &&
      account.data?.tokenPass.usedUsd !== undefined &&
      account.data?.tokenPass.limitUsd !== null &&
      account.data?.tokenPass.limitUsd !== undefined ? (
        <p className="text-muted-foreground mt-1 text-xs tabular-nums">
          {formatCredit(account.data.tokenPass.usedUsd)} of{" "}
          {formatCredit(account.data.tokenPass.limitUsd)} in credits used
        </p>
      ) : null}
      {account.data?.tokenPass.resetsAt ? (
        <p className="text-muted-foreground mt-1 text-xs">
          Resets{" "}
          {new Date(account.data.tokenPass.resetsAt).toLocaleDateString(
            undefined,
            { day: "numeric", month: "short" }
          )}
        </p>
      ) : null}
      {account.data?.tokenPass.dashboardUrl ? (
        <a
          className="mt-4 inline-flex items-center gap-1.5 text-xs font-medium underline-offset-4 hover:underline"
          href={account.data.tokenPass.dashboardUrl}
          rel="noopener noreferrer"
          target="_blank"
        >
          Manage subscription{" "}
          <ExternalLink aria-hidden="true" className="size-3" />
        </a>
      ) : null}
    </section>
  );
}

function tokenPassDescription(account: ReturnType<typeof useAccount>) {
  if (account.loading) {
    return "Checking your subscription usage…";
  }
  if (account.error) {
    return "Couldn't refresh usage. Busy will try again automatically.";
  }
  if (
    account.data?.tokenPass.percentUsed === null ||
    account.data?.tokenPass.percentUsed === undefined
  ) {
    return "Usage is currently unavailable. Check your subscription in Vercel.";
  }
  return "Current billing period, shared across your Vercel team.";
}

function usageValueText(
  { loading }: ReturnType<typeof useAccount>,
  percent: number | null | undefined
) {
  if (percent !== null && percent !== undefined) {
    return `${percent}% used`;
  }
  return loading ? "Loading usage" : "Usage unavailable";
}
