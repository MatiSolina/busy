"use client";

import { Combobox } from "@base-ui/react/combobox";
import { ArrowLeft, ChevronDown, LayoutTemplate, Plus } from "lucide-react";
import {
  Activity,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";
import { useAiConnectionOptional } from "@/components/ai-connection-provider";
import { AiIssueNotice } from "@/components/ai-issue-notice";
import { BotIdentityPicker } from "@/components/bot-identity-picker";
import { BotMarketplace } from "@/components/bot-marketplace";
import { useSelectBot, useStore } from "@/components/chat-app";
import { useSections } from "@/components/sections-provider";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Textarea } from "@/components/ui/textarea";
import { type AiIssue, aiIssue, aiIssueFromResponse } from "@/lib/ai/errors";
import type { AiProviderOption } from "@/lib/ai/types";
import { pixFor } from "@/lib/avatar";
import type { BotTemplate } from "@/lib/bots/marketplace";
import {
  type Billing,
  isSubscriptionBilling,
  type MODELS,
  modelsFor,
} from "@/lib/bots/models";
import type { BotLite } from "@/lib/chat/client-store";
import { cn } from "@/lib/utils";

function connectionModels(billing: Billing, providers: AiProviderOption[]) {
  const gateway = providers.find((provider) => provider.id === "gateway");
  if (billing === "gateway" && gateway?.models?.length) {
    return gateway.models.map((model) => ({
      ...model,
      fast: Boolean(model.fast),
      tokenPass: false,
    }));
  }
  if (!isSubscriptionBilling(billing)) {
    return modelsFor(billing);
  }
  return (
    providers.find((provider) => provider.id === billing)?.models ?? []
  ).map((model) => ({ ...model, fast: false, tokenPass: false }));
}

function unavailableSubscriptionModel(
  provider: AiProviderOption | undefined,
  model: string
) {
  return (
    provider?.status === "available" &&
    isSubscriptionBilling(provider.id) &&
    !provider.models?.some((entry) => entry.id === model)
  );
}

const DEFAULT_MODEL = modelsFor("token-pass")[0]?.id ?? "moonshotai/kimi-k3";
const NO_PROVIDERS: AiProviderOption[] = [];

interface BotFormFields {
  avatar: string;
  billing?: Billing;
  description: FormDataEntryValue | null;
  fast?: boolean;
  instructions?: FormDataEntryValue | null;
  model?: string;
  name: FormDataEntryValue | null;
  templateId?: string;
}

function fieldsFromForm(
  form: FormData,
  bot: BotLite | undefined,
  initialTemplate: BotTemplate | undefined,
  avatar: string,
  billing: Billing,
  fast: boolean,
  model: string
): BotFormFields {
  const identity = {
    avatar,
    description: form.get("description"),
    name: form.get("name"),
  };
  if (bot) {
    return {
      ...identity,
      billing,
      fast,
      // Missing while the stored instructions are still loading: leave them as they are.
      ...(form.has("instructions")
        ? { instructions: form.get("instructions") }
        : {}),
      model,
    };
  }
  return {
    ...identity,
    ...(initialTemplate ? { templateId: initialTemplate.id } : {}),
  };
}

function changedFields(
  fields: BotFormFields,
  bot: BotLite | undefined,
  startAvatar: string,
  instructions: Instructions
) {
  if (!bot) {
    return fields;
  }
  const before = {
    ...bot,
    avatar: startAvatar,
    instructions:
      instructions.state === "ready" ? instructions.value : undefined,
  };
  return Object.fromEntries(
    Object.entries(fields).filter(
      ([key, value]) => value !== before[key as keyof typeof before]
    )
  );
}

type Instructions =
  | { state: "loading" }
  | { state: "error" }
  | { state: "ready"; value: string };

/** The chat's bot list omits instructions; the edit form reads them when it opens. */
function useBotInstructions(bot: BotLite | undefined): Instructions {
  const slug = bot?.slug;
  const known = bot?.instructions;
  const [loaded, setLoaded] = useState<Instructions>({ state: "loading" });
  useEffect(() => {
    if (!slug || known !== undefined) {
      return;
    }
    let current = true;
    fetch(`/api/bots/${encodeURIComponent(slug)}`)
      .then((res) => (res.ok ? res.json() : null))
      .then(
        (data: { instructions?: unknown } | null) =>
          typeof data?.instructions === "string"
            ? { state: "ready" as const, value: data.instructions }
            : { state: "error" as const },
        () => ({ state: "error" as const })
      )
      .then((next) => {
        if (current) {
          setLoaded(next);
        }
      });
    return () => {
      current = false;
    };
  }, [slug, known]);
  return known === undefined ? loaded : { state: "ready", value: known };
}

function saveLabel(pending: boolean, bot: BotLite | undefined) {
  if (pending) {
    return bot ? "Saving…" : "Creating…";
  }
  return bot ? "Save changes" : "Create bot";
}

function deleteLabel(
  deleting: "ask" | "busy" | null,
  name: string | undefined
) {
  if (deleting === "busy") {
    return "Deleting…";
  }
  if (deleting) {
    return `Delete ${name} for good?`;
  }
  return "Delete bot";
}

export function BotDialog({
  open,
  onOpenChange,
  bot,
}: {
  open: boolean;
  onOpenChange: (o: boolean) => void;
  bot?: BotLite;
}) {
  const close = useCallback(() => onOpenChange(false), [onOpenChange]);
  const [session, setSession] = useState(0);
  const resetSession = useCallback((nextOpen: boolean) => {
    if (!nextOpen) {
      setSession((value) => value + 1);
    }
  }, []);
  return (
    <Sheet
      onOpenChange={onOpenChange}
      onOpenChangeComplete={resetSession}
      open={open}
    >
      <BotDialogContent bot={bot} key={session} onDone={close} />
    </Sheet>
  );
}

function BotDialogContent({
  bot,
  onDone,
}: {
  bot?: BotLite;
  onDone: () => void;
}) {
  const [browsing, setBrowsing] = useState(true);
  const [choosing, setChoosing] = useState(true);
  const [draft, setDraft] = useState<{
    revision: number;
    template: BotTemplate | null;
  } | null>(null);
  const showingMarketplace = !(bot || choosing) && browsing;
  const showingForm = Boolean(bot) || !(choosing || browsing);

  const choose = useCallback((template: BotTemplate | null) => {
    setDraft((previous) => ({
      revision: (previous?.revision ?? 0) + 1,
      template,
    }));
    setChoosing(false);
    setBrowsing(false);
  }, []);

  const scratch = useCallback(() => choose(null), [choose]);

  const browse = useCallback(() => {
    setChoosing(false);
    setBrowsing(true);
  }, []);

  const backToChoice = useCallback(() => {
    setChoosing(true);
  }, []);

  const resume = useCallback(() => {
    setBrowsing(false);
  }, []);

  return (
    <SheetContent
      className={cn(
        "min-h-0 gap-0 overflow-hidden data-[side=right]:h-dvh data-[side=right]:w-full",
        showingMarketplace
          ? "data-[side=right]:sm:max-w-[1000px]"
          : "data-[side=right]:sm:max-w-md"
      )}
    >
      {!bot && choosing ? (
        <>
          <SheetHeader className="border-border border-b pr-12">
            <SheetTitle>Create bot</SheetTitle>
            <SheetDescription>
              Start with your own idea or use a template.
            </SheetDescription>
          </SheetHeader>
          <div className="flex flex-col gap-3 p-4">
            <button
              className="border-border hover:bg-accent flex items-start gap-4 border p-5 text-left transition-colors"
              onClick={scratch}
              type="button"
            >
              <Plus aria-hidden className="mt-0.5 size-5 shrink-0" />
              <span>
                <span className="block text-sm font-medium">
                  Create from scratch
                </span>
                <span className="text-muted-foreground mt-1 block text-sm">
                  Give your bot a name and tell it what to do.
                </span>
              </span>
            </button>
            <button
              className="border-border hover:bg-accent flex items-start gap-4 border p-5 text-left transition-colors"
              onClick={browse}
              type="button"
            >
              <LayoutTemplate aria-hidden className="mt-0.5 size-5 shrink-0" />
              <span>
                <span className="block text-sm font-medium">
                  Choose a template
                </span>
                <span className="text-muted-foreground mt-1 block text-sm">
                  Pick a role and make it yours.
                </span>
              </span>
            </button>
          </div>
        </>
      ) : null}
      {bot ? null : (
        <Activity mode={showingMarketplace ? "visible" : "hidden"}>
          <div className="flex min-h-0 flex-1 flex-col">
            <BotMarketplace
              onBack={backToChoice}
              onChoose={choose}
              onResume={draft ? resume : undefined}
            />
          </div>
        </Activity>
      )}
      {bot || draft ? (
        <BotFormStage
          bot={bot}
          draft={draft}
          onBack={backToChoice}
          onDone={onDone}
          showing={showingForm}
        />
      ) : null}
    </SheetContent>
  );
}

function BotFormStage({
  bot,
  draft,
  showing,
  onBack,
  onDone,
}: {
  bot?: BotLite;
  draft: { revision: number; template: BotTemplate | null } | null;
  showing: boolean;
  onBack: () => void;
  onDone: () => void;
}) {
  return (
    <Activity mode={showing ? "visible" : "hidden"}>
      <div className="flex min-h-0 flex-1 flex-col">
        <BotForm
          bot={bot}
          initialTemplate={draft?.template ?? undefined}
          key={bot?.slug ?? draft?.revision}
          onBack={bot ? undefined : onBack}
          onDone={onDone}
        />
      </div>
    </Activity>
  );
}

export function BotForm({
  bot,
  hideHeader = false,
  initialTemplate,
  onBack,
  onDone,
}: {
  bot?: BotLite;
  initialTemplate?: BotTemplate;
  hideHeader?: boolean;
  onBack?: () => void;
  onDone: () => void;
}) {
  const store = useStore();
  const select = useSelectBot();
  const { forgetBot } = useSections();
  const connection = useAiConnectionOptional();
  const providers = connection?.snapshot?.providers ?? NO_PROVIDERS;
  const [startAvatar] = useState(
    bot ? (bot.avatar ?? pixFor(bot.slug)) : (initialTemplate?.avatar ?? "lime")
  );
  const [avatar, setAvatar] = useState(startAvatar);
  const [billing, setBilling] = useState<Billing>(bot?.billing ?? "token-pass");
  const [model, setModel] = useState(bot?.model ?? DEFAULT_MODEL);
  const [fast, setFast] = useState(bot?.fast ?? false);
  const instructions = useBotInstructions(bot);
  const availableProviders = providers.filter(
    (provider) => provider.status === "available"
  );
  const selectedProvider = availableProviders.find(
    (provider) => provider.id === billing
  );
  const models = selectedProvider ? connectionModels(billing, providers) : [];
  const [error, setError] = useState<string | null>(null);
  const [issue, setIssue] = useState<AiIssue | null>(null);
  const [pending, setPending] = useState(false);
  // Deleting takes two clicks: the first one asks, the second deletes for good.
  const [deleting, setDeleting] = useState<"ask" | "busy" | null>(null);
  const issueProvider = bot ? billing : connection?.snapshot?.provider;

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setPending(true);
      setError(null);
      setIssue(null);
      const fields = fieldsFromForm(
        new FormData(e.currentTarget),
        bot,
        initialTemplate,
        avatar,
        billing,
        fast,
        model
      );
      // An edit sends only what changed: a new prompt, model, billing or Fast redeploys the bot.
      const body = changedFields(fields, bot, startAvatar, instructions);
      const res = await fetch(
        bot ? `/api/bots/${encodeURIComponent(bot.slug)}` : "/api/bots",
        {
          body: JSON.stringify(body),
          headers: { "Content-Type": "application/json" },
          method: bot ? "PATCH" : "POST",
        }
      ).catch(() => null);
      if (!res) {
        setPending(false);
        return setError("Can't reach Busy. Try again.");
      }
      const data = await res.json().catch(() => null);
      setPending(false);
      if (!res.ok) {
        const responseIssue = aiIssueFromResponse(data, {
          provider: issueProvider,
          status: res.status,
        });
        if (responseIssue && responseIssue.code !== "invalid_data") {
          setIssue(responseIssue);
          return;
        }
        return setError(
          res.status === 400
            ? "Check the fields: the name or what it does is missing."
            : "Couldn't save the bot. Try again."
        );
      }
      if (!data?.slug) {
        return setError("Couldn't save the bot. Try again.");
      }
      const saved = data as BotLite;
      store.upsertBot(saved);
      if (!bot) {
        select(saved.slug);
      }
      onDone();
    },
    [
      avatar,
      billing,
      bot,
      issueProvider,
      fast,
      initialTemplate,
      instructions,
      model,
      onDone,
      select,
      startAvatar,
      store,
    ]
  );

  // Only an explicit connection change can move a bot to another provider or model.
  const pickBilling = useCallback(
    (event: React.ChangeEvent<HTMLSelectElement>) => {
      const next = providers.find(
        (provider) =>
          provider.id === event.currentTarget.value &&
          provider.status === "available"
      );
      if (!next) {
        return;
      }
      setBilling(next.id);
      const choices = connectionModels(next.id, providers);
      if (!choices.some((entry) => entry.id === model)) {
        setModel(choices[0]?.id ?? "");
      }
      setFast(false);
    },
    [model, providers]
  );

  const onDelete = useCallback(async () => {
    if (!bot) {
      return;
    }
    if (!deleting) {
      return setDeleting("ask");
    }
    setDeleting("busy");
    setError(null);
    setIssue(null);
    const res = await fetch(`/api/bots/${encodeURIComponent(bot.slug)}`, {
      method: "DELETE",
    }).catch(() => null);
    if (!res || (!res.ok && res.status !== 404)) {
      setDeleting("ask");
      return setError("Couldn't delete it. Try again.");
    }
    onDone();
    forgetBot(bot.slug);
    store.removeBot(bot.slug);
    const [next] = store.getState().order;
    if (next) {
      select(next);
    } else {
      // The route still points at the deleted bot after the final removal. Keep the
      // empty state reachable on reload instead of leaving the user on a 404.
      window.history.replaceState(null, "", "/");
    }
  }, [bot, deleting, forgetBot, onDone, select, store]);

  const onModelPick = useCallback((nextModel: string, nextFast: boolean) => {
    setModel(nextModel);
    setFast(nextFast);
  }, []);
  const disabled = pending || deleting === "busy";
  const activeProvider = providers.find(
    (entry) =>
      entry.id ===
      (bot ? billing : (connection?.snapshot?.provider ?? "token-pass"))
  );
  const availabilityIssue =
    activeProvider && activeProvider.status !== "available"
      ? aiIssue(
          isSubscriptionBilling(activeProvider.id)
            ? "connection_not_connected"
            : "provider_unconfigured",
          activeProvider.id
        )
      : null;

  return (
    <form className="flex min-h-0 flex-1 flex-col" onSubmit={onSubmit}>
      {hideHeader ? null : (
        <BotFormHeader
          bot={bot}
          deleting={deleting}
          initialTemplate={initialTemplate}
          onBack={onBack}
          pending={pending}
        />
      )}
      <div className="divide-border min-h-0 flex-1 divide-y overflow-y-auto">
        {availabilityIssue && !issue ? (
          <div className="px-6 py-4">
            <AiIssueNotice issue={availabilityIssue} />
          </div>
        ) : null}
        <BotIdentityFields
          avatar={avatar}
          bot={bot}
          disabled={disabled}
          initialTemplate={initialTemplate}
          name={bot?.name}
          onAvatarChange={setAvatar}
        />
        {bot ? (
          <BotAdvancedFields
            billing={billing}
            bot={bot}
            connectionError={connection?.error ?? null}
            disabled={disabled}
            fast={fast}
            instructions={instructions}
            loading={connection?.loading ?? false}
            model={model}
            models={models}
            modelUnavailable={unavailableSubscriptionModel(
              activeProvider,
              model
            )}
            onBillingChange={pickBilling}
            onModelPick={onModelPick}
            providers={availableProviders}
          />
        ) : null}
      </div>
      <BotFormFooter
        bot={bot}
        deleting={deleting}
        disabled={disabled}
        error={error}
        issue={issue}
        onDelete={onDelete}
        pending={pending}
      />
    </form>
  );
}

function BotFormHeader({
  bot,
  initialTemplate,
  onBack,
  pending,
  deleting,
}: {
  bot?: BotLite;
  initialTemplate?: BotTemplate;
  onBack?: () => void;
  pending: boolean;
  deleting: "ask" | "busy" | null;
}) {
  return (
    <SheetHeader className="border-border border-b pr-12">
      {onBack ? (
        <Button
          aria-label="Back to bot creation"
          className="text-muted-foreground mb-1 -ml-2.5 self-start"
          disabled={pending || deleting === "busy"}
          onClick={onBack}
          size="sm"
          type="button"
          variant="ghost"
        >
          <ArrowLeft aria-hidden />
          Back
        </Button>
      ) : null}
      <SheetTitle>{bot ? `Edit ${bot.name}` : "Create bot"}</SheetTitle>
      {bot ? null : (
        <SheetDescription>
          Give it a name and a job. You can change everything in settings later.
        </SheetDescription>
      )}
      {initialTemplate ? (
        <p className="text-muted-foreground text-xs">
          Based on {initialTemplate.name}. Make it yours before creating.
        </p>
      ) : null}
    </SheetHeader>
  );
}

function BotIdentityFields({
  avatar,
  disabled,
  initialTemplate,
  name,
  onAvatarChange,
  bot,
}: {
  avatar: string;
  disabled: boolean;
  initialTemplate?: BotTemplate;
  name?: string;
  onAvatarChange: (avatar: string) => void;
  bot?: BotLite;
}) {
  return (
    <div className="flex flex-col gap-4 p-4">
      <BotIdentityPicker
        avatar={avatar}
        disabled={disabled}
        onChange={onAvatarChange}
        slug={bot?.slug}
      >
        <div className="flex w-full flex-col gap-2">
          <Label className="sr-only" htmlFor="name">
            Name
          </Label>
          <Input
            autoFocus={!bot}
            defaultValue={name ?? initialTemplate?.name}
            disabled={disabled}
            id="name"
            maxLength={60}
            name="name"
            placeholder="Lawyer"
            required
          />
        </div>
      </BotIdentityPicker>
      {bot ? null : (
        <BotDescriptionField
          description={initialTemplate?.description}
          disabled={disabled}
        />
      )}
    </div>
  );
}

function BotDescriptionField({
  description,
  disabled,
}: {
  description?: string;
  disabled: boolean;
}) {
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor="description">What it does</Label>
      <Textarea
        className="max-h-24 min-h-0 resize-none"
        defaultValue={description}
        disabled={disabled}
        id="description"
        maxLength={140}
        name="description"
        placeholder="Drafts and reviews contracts"
        required
        rows={1}
      />
    </div>
  );
}

function BotAdvancedFields({
  billing,
  connectionError,
  disabled,
  fast,
  instructions,
  loading,
  model,
  models,
  modelUnavailable,
  onBillingChange,
  onModelPick,
  providers,
  bot,
}: {
  billing: Billing;
  connectionError: string | null;
  disabled: boolean;
  fast: boolean;
  instructions: Instructions;
  loading: boolean;
  model: string;
  models: typeof MODELS;
  modelUnavailable: boolean;
  onBillingChange: (event: React.ChangeEvent<HTMLSelectElement>) => void;
  onModelPick: (model: string, fast: boolean) => void;
  providers: AiProviderOption[];
  bot: BotLite;
}) {
  const providerId = useId();
  const providerValue = providers.some((entry) => entry.id === billing)
    ? billing
    : "";
  const emptyProviderLabel = providers.length
    ? "Choose an active connection"
    : "No active connections";
  const providerPlaceholder = loading
    ? "Loading connections…"
    : emptyProviderLabel;
  const modelOptions =
    providerValue === "gateway" &&
    model &&
    !models.some((entry) => entry.id === model)
      ? [{ fast: false, id: model, label: model }, ...models]
      : models;
  return (
    <>
      <details className="group p-4">
        <summary className="text-muted-foreground hover:text-foreground focus-visible:outline-ring flex cursor-pointer list-none items-center justify-between gap-2 text-sm font-medium focus-visible:outline-2 [&::-webkit-details-marker]:hidden">
          Advanced instructions
          <ChevronDown
            aria-hidden
            className="size-4 transition-transform group-open:rotate-180 motion-reduce:transition-none"
          />
        </summary>
        <div className="mt-3 flex flex-col gap-4">
          <BotDescriptionField
            description={bot.description}
            disabled={disabled}
          />
          <div className="flex flex-col gap-2">
            <Label htmlFor="instructions">Instructions</Label>
            {instructions.state === "ready" ? (
              <Textarea
                className="max-h-72 min-h-28"
                defaultValue={instructions.value}
                disabled={disabled}
                id="instructions"
                key="ready"
                maxLength={8000}
                name="instructions"
                placeholder="How it works, what tone it uses, what it needs to know"
              />
            ) : (
              // Unnamed and disabled: a save before it loads leaves the stored text alone.
              <Textarea
                aria-busy={instructions.state === "loading"}
                className="max-h-72 min-h-28"
                disabled
                id="instructions"
                key="pending"
                placeholder={
                  instructions.state === "loading"
                    ? "Loading instructions…"
                    : "Couldn't load the instructions. Close this and try again."
                }
              />
            )}
          </div>
        </div>
      </details>
      <Section
        hint="Choose an active connection and one of its models."
        title="AI model"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor={providerId}>Provider</Label>
          <select
            className={MODEL_SELECT_CLASS}
            disabled={disabled || loading || !providers.length}
            id={providerId}
            onChange={onBillingChange}
            value={providerValue}
          >
            <option disabled value="">
              {providerPlaceholder}
            </option>
            {providers.map((entry) => (
              <option key={entry.id} value={entry.id}>
                {entry.label}
              </option>
            ))}
          </select>
        </div>
        <ModelPicker
          disabled={disabled || loading || !providerValue}
          fast={fast}
          model={model}
          onPick={onModelPick}
          options={modelOptions}
        />
        {loading || providers.length ? null : (
          <p className="text-muted-foreground text-sm" role="status">
            {connectionError
              ? "Couldn't load AI connections. Try again in Settings."
              : "Connect an AI provider in Settings to choose a model."}
          </p>
        )}
        {modelUnavailable ? (
          <p className="text-destructive text-sm" role="status">
            This model is no longer available for this connection. Choose
            another model above.
          </p>
        ) : null}
      </Section>
    </>
  );
}

function BotFormFooter({
  bot,
  deleting,
  disabled,
  error,
  issue,
  onDelete,
  pending,
}: {
  bot?: BotLite;
  deleting: "ask" | "busy" | null;
  disabled: boolean;
  error: string | null;
  issue: AiIssue | null;
  onDelete: () => void;
  pending: boolean;
}) {
  return (
    <SheetFooter className="border-border border-t">
      {issue ? (
        <AiIssueNotice issue={issue} modelSettings={bot ? "bot" : "account"} />
      ) : null}
      {error ? (
        <p className="text-destructive text-sm" role="alert">
          {error}
        </p>
      ) : null}
      <div className="flex items-center gap-2">
        {bot ? (
          <Button
            className="text-destructive"
            disabled={disabled}
            onClick={onDelete}
            type="button"
            variant={deleting ? "destructive" : "ghost"}
          >
            {deleteLabel(deleting, bot.name)}
          </Button>
        ) : null}
        <Button className="ml-auto" disabled={disabled} type="submit">
          {saveLabel(pending, bot)}
        </Button>
      </div>
    </SheetFooter>
  );
}

const FAST = "#fast";
const MODEL_SELECT_CLASS =
  "border-input bg-background focus-visible:border-ring focus-visible:ring-ring/50 h-9 w-full min-w-0 border px-3 text-sm outline-none focus-visible:ring-3 disabled:cursor-not-allowed disabled:opacity-50";

interface ModelChoice {
  fast: boolean;
  id: string;
  label: string;
}

const choiceLabel = (choice: ModelChoice) =>
  choice.fast ? `${choice.label} (Fast)` : choice.label;

const sameChoice = (a: ModelChoice, b: ModelChoice) =>
  a.id === b.id && a.fast === b.fast;

const MODEL_ITEM_CLASS =
  "flex cursor-default items-center px-3 py-2 text-sm outline-none select-none data-highlighted:bg-accent";

function ModelPicker({
  disabled,
  options,
  model,
  fast,
  onPick,
}: {
  disabled: boolean;
  options: Pick<(typeof MODELS)[number], "id" | "label" | "fast">[];
  model: string;
  fast: boolean;
  onPick: (model: string, fast: boolean) => void;
}) {
  const modelId = useId();
  const choices = useMemo(
    () =>
      options.flatMap(({ id, label, fast: hasFast }) => [
        { fast: false, id, label },
        ...(hasFast ? [{ fast: true, id, label }] : []),
      ]),
    [options]
  );
  const value =
    choices.find((choice) => choice.id === model && choice.fast === fast) ??
    null;
  const emptyModelLabel = options.length
    ? "Choose a model"
    : "No models available";
  const placeholder = disabled ? "Choose a provider first" : emptyModelLabel;
  const onValueChange = useCallback(
    (choice: ModelChoice | null) => {
      if (choice) {
        onPick(choice.id, choice.fast);
      }
    },
    [onPick]
  );
  return (
    <div className="flex flex-col gap-2">
      <Label htmlFor={modelId}>Model</Label>
      <Combobox.Root
        disabled={disabled || !options.length}
        isItemEqualToValue={sameChoice}
        items={choices}
        itemToStringLabel={choiceLabel}
        onValueChange={onValueChange}
        value={value}
      >
        <div className="relative">
          <Combobox.Input
            className={cn(MODEL_SELECT_CLASS, "pr-9")}
            id={modelId}
            placeholder={placeholder}
          />
          <Combobox.Trigger
            aria-label="Show models"
            className="text-muted-foreground absolute inset-y-0 right-0 flex w-9 items-center justify-center disabled:opacity-50"
          >
            <ChevronDown aria-hidden className="size-4" />
          </Combobox.Trigger>
        </div>
        <Combobox.Portal>
          <Combobox.Positioner className="z-50" sideOffset={4}>
            <Combobox.Popup className="border-border bg-popover text-popover-foreground max-h-[min(var(--available-height),20rem)] w-(--anchor-width) overflow-y-auto border p-1 shadow-xl outline-none">
              <Combobox.Empty className="text-muted-foreground px-3 py-2 text-sm empty:hidden">
                No models found.
              </Combobox.Empty>
              <Combobox.List>
                {(choice: ModelChoice) => (
                  <Combobox.Item
                    className={MODEL_ITEM_CLASS}
                    key={choice.id + (choice.fast ? FAST : "")}
                    value={choice}
                  >
                    {choiceLabel(choice)}
                  </Combobox.Item>
                )}
              </Combobox.List>
            </Combobox.Popup>
          </Combobox.Positioner>
        </Combobox.Portal>
      </Combobox.Root>
      {fast && value ? (
        <p className="text-muted-foreground text-[13px]">
          Fast answers sooner at about twice the price.
        </p>
      ) : null}
    </div>
  );
}

function Section({
  title,
  hint,
  children,
}: {
  title: string;
  hint: string;
  children: React.ReactNode;
}) {
  return (
    <section className="flex flex-col gap-4 p-4">
      <div>
        <h3 className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          {title}
        </h3>
        <p className="text-muted-foreground/70 text-[13px]">{hint}</p>
      </div>
      {children}
    </section>
  );
}
