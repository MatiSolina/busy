"use client";

import { ExternalLink, LoaderCircle, X } from "lucide-react";
import Image from "next/image";
import { useCallback, useId } from "react";
import {
  type AiConnectionContextValue,
  useAiConnectionOptional,
} from "@/components/ai-connection-provider";
import { Button } from "@/components/ui/button";
import type { AiProviderOption } from "@/lib/ai/types";
import { cn } from "@/lib/utils";

const ignorePromise = () => undefined;
const providerOrder = ["chatgpt", "grok", "gateway", "token-pass"] as const;
type SelectableProvider = Exclude<
  AiConnectionContextValue["selectedProvider"],
  null
>;

interface Props {
  compact?: boolean;
}

export function AiConnectionSettings({ compact = false }: Props) {
  const connection = useAiConnectionOptional();
  if (!connection) {
    return null;
  }
  return (
    <AiConnectionPicker
      actionLabel="Save connection"
      compact={compact}
      connection={connection}
      presentation="settings"
    />
  );
}

export function AiProviderPicker({
  connection,
  actionLabel,
  compact = false,
  presentation = "settings",
}: {
  connection: AiConnectionContextValue;
  actionLabel: string;
  compact?: boolean;
  presentation?: "settings" | "onboarding";
}) {
  return (
    <AiConnectionPicker
      actionLabel={actionLabel}
      compact={compact}
      connection={connection}
      presentation={presentation}
    />
  );
}

function AiConnectionPicker({
  connection,
  actionLabel,
  compact,
  presentation,
}: {
  connection: AiConnectionContextValue;
  actionLabel: string;
  compact: boolean;
  presentation: "settings" | "onboarding";
}) {
  const groupId = useId();
  const selected = connection.selectedProvider;
  const options = connection.snapshot?.providers ?? [];
  const selectedOption = options.find((option) => option.id === selected);
  const onboarding = presentation === "onboarding";

  return (
    <section
      aria-labelledby={`${groupId}-heading`}
      className={compact && !onboarding ? "p-3" : undefined}
    >
      <h3
        className={onboarding ? "sr-only" : "text-sm font-medium"}
        id={`${groupId}-heading`}
      >
        AI connection
      </h3>
      <AiConnectionBody
        actionLabel={actionLabel}
        connection={connection}
        groupId={groupId}
        options={options}
        selected={selected}
        selectedOption={selectedOption}
      />
    </section>
  );
}

function AiConnectionBody({
  actionLabel,
  connection,
  groupId,
  options,
  selected,
  selectedOption,
}: {
  actionLabel: string;
  connection: AiConnectionContextValue;
  groupId: string;
  options: AiProviderOption[];
  selected: AiConnectionContextValue["selectedProvider"];
  selectedOption: AiProviderOption | undefined;
}) {
  if (connection.loading) {
    return (
      <div
        className="border-border text-muted-foreground mt-4 flex items-center gap-2 rounded-lg border border-dashed p-3 text-xs"
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        Loading AI connection…
      </div>
    );
  }

  if (connection.error && !connection.snapshot) {
    return <AiConnectionError connection={connection} />;
  }

  return (
    <AiProviderChoices
      actionLabel={actionLabel}
      connection={connection}
      groupId={groupId}
      options={options}
      selected={selected}
      selectedOption={selectedOption}
    />
  );
}

function AiConnectionError({
  connection,
}: {
  connection: AiConnectionContextValue;
}) {
  const retry = useCallback(() => {
    connection.refresh().catch(ignorePromise);
  }, [connection]);
  return (
    <div
      className="border-destructive/30 bg-destructive/5 mt-4 rounded-lg border p-3"
      role="alert"
    >
      <p className="text-destructive text-xs">{connection.error}</p>
      <Button className="mt-3" onClick={retry} size="sm" variant="outline">
        Try again
      </Button>
    </div>
  );
}

function AiProviderChoices({
  actionLabel,
  connection,
  groupId,
  options,
  selected,
  selectedOption,
}: {
  actionLabel: string;
  connection: AiConnectionContextValue;
  groupId: string;
  options: AiProviderOption[];
  selected: AiConnectionContextValue["selectedProvider"];
  selectedOption: AiProviderOption | undefined;
}) {
  const save = useCallback(() => {
    connection.saveProvider().catch(ignorePromise);
  }, [connection]);
  const modelRequired = isSubscription(selectedOption);
  const modelValid =
    !modelRequired ||
    Boolean(
      selectedOption?.models?.some(
        (model) => model.id === connection.selectedModel
      )
    );
  const buttonDisabled =
    connection.saving || selectedOption?.status !== "available" || !modelValid;
  const saveLabel = connection.saving ? "Saving…" : actionLabel;
  const status = selectionStatus(
    connection.saving,
    selectedOption,
    connection.snapshot?.provider ?? null,
    selected,
    modelValid
  );
  return (
    <>
      {connection.error ? (
        <div
          className="border-destructive/30 bg-destructive/5 mt-4 rounded-lg border p-3"
          role="alert"
        >
          <p className="text-destructive text-xs">{connection.error}</p>
          <p className="text-muted-foreground mt-1 text-xs">
            Your current selection is still here. Try saving it again after
            fixing the connection issue.
          </p>
        </div>
      ) : null}
      {connection.connectionError ? (
        <div
          className="border-destructive/30 bg-destructive/5 mt-4 rounded-lg border p-3"
          role="alert"
        >
          <p className="text-destructive text-xs">
            {connection.connectionError}
          </p>
          <p className="text-muted-foreground mt-1 text-xs">
            You can reopen the provider authorization or choose another
            connection.
          </p>
        </div>
      ) : null}
      <fieldset
        aria-describedby={`${groupId}-hint`}
        className="border-border mt-3 min-w-0 border-y"
      >
        <legend className="sr-only">AI provider</legend>
        <ul className="divide-border divide-y">
          {providerOrder
            .flatMap((id) => options.filter((option) => option.id === id))
            .map((option) => (
              <ProviderOption
                connection={connection}
                groupId={groupId}
                key={option.id}
                option={option}
                selected={selected === option.id}
              />
            ))}
        </ul>
      </fieldset>
      <ModelPicker connection={connection} option={selectedOption} />
      <SubscriptionFlow
        connection={connection}
        key={connection.activeAttempt?.attemptId ?? "idle"}
      />
      <p className="text-muted-foreground mt-2 text-xs" id={`${groupId}-hint`}>
        New bots start on the default. Each bot can switch in its settings.
        {options.some(
          (option) => isSubscription(option) && option.status === "available"
        )
          ? " Disconnecting a provider pauses bots using it."
          : null}
      </p>
      {selectedOption && selectedOption.status !== "available" ? (
        <p className="text-destructive mt-3 text-xs" role="alert">
          {unavailableProviderMessage(selectedOption)}
        </p>
      ) : null}
      <div className="border-border mt-3 flex items-center justify-between gap-3 border-t pt-3">
        <span aria-live="polite" className="text-muted-foreground text-xs">
          {status}
        </span>
        <Button disabled={buttonDisabled} onClick={save} size="sm">
          {connection.saving ? (
            <LoaderCircle aria-hidden="true" className="animate-spin" />
          ) : null}
          {saveLabel}
        </Button>
      </div>
    </>
  );
}

function ProviderOption({
  connection,
  groupId,
  option,
  selected,
}: {
  connection: AiConnectionContextValue;
  groupId: string;
  option: AiProviderOption;
  selected: boolean;
}) {
  const available = option.status === "available";
  const subscription = isSubscription(option);
  const connectable = subscription && option.status === "not-connected";
  const inputId = `${groupId}-${option.id}`;
  const handleChange = useCallback(() => {
    if (available) {
      connection.selectProvider(option.id as SelectableProvider);
    }
  }, [available, connection, option.id]);
  const connect = useCallback(() => {
    if (connectable) {
      connection
        .startSubscription(option.id as "chatgpt" | "grok")
        .catch(ignorePromise);
    }
  }, [connectable, connection, option.id]);
  const disconnect = useCallback(() => {
    if (subscription && available) {
      connection
        .disconnect(option.id as "chatgpt" | "grok")
        .catch(ignorePromise);
    }
  }, [available, connection, option.id, subscription]);
  return (
    <li
      className={cn(
        "flex min-h-12 min-w-0 items-center gap-2 px-2 py-1 text-left transition-colors",
        available ? "hover:bg-accent/40" : "bg-muted/10",
        selected && "bg-accent/60"
      )}
    >
      <label
        className={cn(
          "flex min-h-10 min-w-0 flex-1 items-center gap-2 text-left",
          available && "cursor-pointer"
        )}
        htmlFor={inputId}
      >
        <input
          aria-describedby={`${inputId}-description`}
          aria-label={option.label}
          checked={selected}
          className="sr-only"
          disabled={!available || connection.saving || connection.connecting}
          id={inputId}
          name={`${groupId}-provider`}
          onChange={handleChange}
          type="radio"
          value={option.id}
        />
        <ProviderMark provider={option.id} />
        <span className="min-w-0 flex-1">
          <span className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
            <span
              className="truncate text-sm font-medium"
              title={option.accountLabel ?? undefined}
            >
              {providerTitle(option)}
            </span>
            <span
              className={cn(
                "text-muted-foreground text-xs",
                available && "sr-only sm:not-sr-only"
              )}
            >
              {statusLabel(option)}
            </span>
          </span>
          <span className="sr-only" id={`${inputId}-description`}>
            {providerDescription(option)}
            {option.accountLabel ? ` ${option.accountLabel}` : null}
          </span>
        </span>
        {available ? (
          <span
            aria-hidden="true"
            className={cn(
              "border-foreground/20 text-muted-foreground shrink-0 border px-2 py-0.5 text-xs",
              selected && "border-foreground bg-foreground text-background"
            )}
          >
            Default
          </span>
        ) : null}
      </label>
      <div className="flex shrink-0 items-center justify-end gap-1">
        {connectable ? (
          <SubscriptionConnectButton
            connecting={
              connection.connecting &&
              connection.activeAttempt?.provider === option.id
            }
            disabled={connection.connecting}
            onConnect={connect}
            provider={option.id as "chatgpt" | "grok"}
          />
        ) : null}
        {subscription && available ? (
          <Button
            className="text-muted-foreground"
            disabled={connection.saving || connection.connecting}
            onClick={disconnect}
            size="sm"
            title="Bots using this connection will pause until you reconnect."
            variant="ghost"
          >
            <X aria-hidden="true" />
            Disconnect
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function SubscriptionConnectButton({
  connecting,
  disabled,
  onConnect,
  provider,
}: {
  connecting: boolean;
  disabled: boolean;
  onConnect: () => void;
  provider: "chatgpt" | "grok";
}) {
  return (
    <Button
      aria-label={`Connect ${provider === "chatgpt" ? "ChatGPT" : "Grok"}`}
      disabled={disabled}
      onClick={onConnect}
      size="sm"
      variant="outline"
    >
      {connecting ? (
        <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
      ) : null}
      Connect
    </Button>
  );
}

function ModelPicker({
  connection,
  option,
}: {
  connection: AiConnectionContextValue;
  option: AiProviderOption | undefined;
}) {
  const handleChange = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      connection.selectModel(event.currentTarget.value);
    },
    [connection]
  );
  if (
    !isSubscription(option) ||
    option.status !== "available" ||
    !option.models?.length
  ) {
    return null;
  }
  const modelValue = option.models.some(
    (model) => model.id === connection.selectedModel
  )
    ? (connection.selectedModel ?? "")
    : "";
  const staleModel = Boolean(connection.selectedModel) && !modelValue;
  return (
    <label className="mt-3 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 gap-y-2 text-xs">
      <span className="font-medium">Model</span>
      <select
        aria-label={`${option.label} model`}
        className="border-input bg-background h-8 min-w-0 border px-2 text-sm"
        onChange={handleChange}
        required
        value={modelValue}
      >
        <option value="">Choose a model</option>
        {option.models.map((model) => (
          <option key={model.id} value={model.id}>
            {model.label}
          </option>
        ))}
      </select>
      {modelHint(option, staleModel, modelValue)}
    </label>
  );
}

function SubscriptionFlow({
  connection,
}: {
  connection: AiConnectionContextValue;
}) {
  const attempt = connection.activeAttempt;
  if (!attempt) {
    return null;
  }
  const label = attempt.provider === "chatgpt" ? "ChatGPT" : "Grok";
  return (
    <section
      aria-label={`${label} connection progress`}
      className="border-border bg-muted/20 mt-4 rounded-lg border p-3"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <h4 className="text-sm font-medium">Connecting to {label}</h4>
          <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
            Approve the connection in the browser. Busy will connect
            automatically; keep this tab open until it finishes.
          </p>
        </div>
        <Button
          onClick={connection.cancelSubscription}
          size="xs"
          variant="ghost"
        >
          Cancel
        </Button>
      </div>
      <a
        className="mt-3 inline-flex items-center gap-1 text-xs font-medium underline-offset-4 hover:underline"
        href={attempt.url}
        rel="noopener noreferrer"
        target="_blank"
      >
        Reopen {label} authorization{" "}
        <ExternalLink aria-hidden="true" className="size-3" />
      </a>
      {attempt.userCode ? (
        <p className="mt-3 text-xs">
          Code{" "}
          <code className="bg-background rounded px-1.5 py-1 font-mono font-medium">
            {attempt.userCode}
          </code>
        </p>
      ) : null}
      <p
        className="text-muted-foreground mt-3 flex items-center gap-2 text-xs"
        role="status"
      >
        <LoaderCircle aria-hidden="true" className="size-3.5 animate-spin" />
        Waiting for approval…
      </p>
    </section>
  );
}

function unavailableProviderMessage(option: AiProviderOption) {
  if (option.id === "token-pass") {
    return "Token Pass is not configured for this Busy account. Choose AI Gateway or ask the account owner to configure Token Pass.";
  }
  if (isSubscription(option)) {
    return `Connect your ${option.label} before saving it as the default connection.`;
  }
  return `${option.label} is unavailable. Choose another connection.`;
}

function selectionStatus(
  saving: boolean,
  option: AiProviderOption | undefined,
  saved: AiConnectionContextValue["selectedProvider"],
  selected: AiConnectionContextValue["selectedProvider"],
  modelValid: boolean
) {
  if (saving) {
    return "Saving your choice…";
  }
  if (selected && saved !== selected) {
    return "Unsaved changes";
  }
  if (isSubscription(option) && option.status === "available" && !modelValid) {
    return `Choose an available ${option.label} model`;
  }
  if (option?.status !== "available") {
    return "Not connected";
  }
  return `Using ${option.label}`;
}

function modelHint(
  option: AiProviderOption,
  staleModel: boolean,
  modelValue: string
) {
  if (staleModel) {
    return (
      <span className="text-destructive col-span-2" role="alert">
        This model is no longer available for your {option.label}. Choose
        another model before saving.
      </span>
    );
  }
  if (!modelValue) {
    return (
      <span className="text-muted-foreground col-span-2">
        Choose a model before saving this connection.
      </span>
    );
  }
  return null;
}

function isSubscription(
  option: AiProviderOption | undefined
): option is AiProviderOption & { id: "chatgpt" | "grok" } {
  return option?.id === "chatgpt" || option?.id === "grok";
}

function providerTitle(option: AiProviderOption) {
  if (option.id === "chatgpt") {
    return "ChatGPT";
  }
  if (option.id === "grok") {
    return "Grok";
  }
  if (option.id === "token-pass") {
    return "Token Pass";
  }
  return option.label;
}

function providerDescription(option: AiProviderOption) {
  if (option.status === "unconfigured") {
    return option.detail;
  }
  if (option.id === "chatgpt") {
    return "Use the models and usage included in your ChatGPT plan.";
  }
  if (option.id === "grok") {
    return "Use your Grok or SuperGrok subscription in Busy.";
  }
  if (option.id === "token-pass") {
    return "Use your Vercel team's Token Pass allowance.";
  }
  return "Access models through Vercel. Pay for what you use.";
}

function ProviderMark({ provider }: { provider: AiProviderOption["id"] }) {
  if (provider === "grok") {
    return (
      <Image
        alt=""
        className="size-5 shrink-0"
        height={20}
        src="/ai-providers/grok.png"
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

function statusLabel(option: AiProviderOption) {
  if (option.status === "not-connected") {
    return "Not connected";
  }
  if (option.status === "unconfigured") {
    return "Not connected";
  }
  return isSubscription(option) ? "Connected" : "Available";
}
