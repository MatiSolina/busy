"use client";

import {
  Check,
  CircleAlert,
  Loader2,
  MessageCircleQuestion,
  ShieldCheck,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  type FormEvent,
  type MouseEvent,
  useCallback,
  useState,
} from "react";
import { useStore } from "@/components/chat-app";
import { CodeRepositorySetupCard } from "@/components/code-repository-setup-card";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import type { ChatItem } from "@/lib/chat/items";
import { cn } from "@/lib/utils";

/**
 * The small, transport-neutral shape emitted by the eve stream projection.
 * `interaction-card` deliberately owns no event parsing: the stream remains the
 * source of truth, while this component only handles the optimistic UI between
 * an answer request and its settled interaction event.
 */
export type InteractionCardItem = Extract<ChatItem, { kind: "interaction" }>;

interface Props {
  item: InteractionCardItem;
  onAnswer?: (
    id: string,
    answer: { optionId?: string; text?: string }
  ) => Promise<boolean>;
  slug: string;
}

const settled = new Set([
  "accepted",
  "answered",
  "declined",
  "rejected",
  "invalid",
  "failed",
  "withdrawn",
  "interrupted",
  "abandoned",
  "expired",
  "closed",
]);
const safeHttpUrl = (value: string | undefined): string | undefined => {
  if (!value) {
    return undefined;
  }
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:"
      ? url.toString()
      : undefined;
  } catch {
    return undefined;
  }
};

function buttonVariant(style: "primary" | "danger" | "secondary" | undefined) {
  if (style === "danger") {
    return "destructive" as const;
  }
  if (style === "secondary") {
    return "secondary" as const;
  }
  return "default" as const;
}

/**
 * A question or approval from eve. The user only sees a human label and the
 * answer controls; interaction IDs never appear in the UI. The API request is
 * retried from the same card if transport fails, while eve's settled stream
 * event remains the authority for the final state.
 */
export function InteractionCard({ slug, item, onAnswer }: Props) {
  const store = useStore();
  const {
    allowFreeform,
    error,
    interactionId,
    link: itemLink,
    options,
    prompt,
    state: itemState,
    type,
  } = item;
  const state = itemState ?? "open";
  const done = settled.has(state);
  const kind = type;
  const repositorySetup =
    kind === "question" &&
    (item.setup === "code-repository" ||
      item.origin?.callName === "prepare_code_repository");
  const link = safeHttpUrl(itemLink?.url);
  const linkLabel = itemLink?.label;
  const answer = useCallback(
    (value: { optionId?: string; text?: string }) =>
      onAnswer
        ? onAnswer(interactionId, value)
        : store.answer(slug, interactionId, value),
    [interactionId, slug, store, onAnswer]
  );

  return (
    <div
      className={cn(
        "border-border flex w-full max-w-md flex-col gap-3 rounded-lg border px-4 py-3",
        kind === "approval" && !done && "border-signal/70",
        done && "bg-muted/20"
      )}
      data-interaction-id={interactionId}
    >
      <p className="flex items-start gap-2.5 text-[15px] leading-6">
        {kind === "approval" ? (
          <ShieldCheck
            aria-hidden="true"
            className={cn(
              "mt-1 size-4 shrink-0",
              done ? "text-muted-foreground" : "text-signal"
            )}
          />
        ) : (
          <MessageCircleQuestion
            aria-hidden="true"
            className="text-muted-foreground mt-1 size-4 shrink-0"
          />
        )}
        <span className="flex min-w-0 flex-col gap-1">
          <span>{prompt}</span>
        </span>
      </p>
      {link ? (
        <a
          className="text-muted-foreground hover:text-foreground text-sm underline underline-offset-2"
          href={link}
          rel="noreferrer"
          target="_blank"
        >
          {linkLabel ?? "Open related page"}
        </a>
      ) : null}

      {done ? (
        <SettledState
          outcome={settledOutcome(repositorySetup, state, item.outcome)}
          state={state}
        />
      ) : null}

      {done ? null : (
        <InteractionControls
          allowFreeform={allowFreeform}
          answer={answer}
          interactionId={interactionId}
          item={item}
          itemError={error}
          kind={kind}
          options={options}
          pending={item.pending === true}
          repositorySetup={repositorySetup}
          slug={slug}
          state={state}
        />
      )}
    </div>
  );
}

function settledOutcome(
  repositorySetup: boolean,
  state: string,
  outcome?: string
): string | undefined {
  if (!repositorySetup) {
    return outcome;
  }
  if (state === "closed" || state === "withdrawn") {
    return "Repository setup cancelled.";
  }
  if (state === "failed") {
    return "Repository setup failed.";
  }
  return "Repository selected.";
}

function InteractionControls({
  allowFreeform,
  answer,
  interactionId,
  item,
  itemError,
  kind,
  options,
  pending,
  repositorySetup,
  slug,
  state,
}: {
  allowFreeform: boolean;
  answer: (value: { optionId?: string; text?: string }) => Promise<boolean>;
  interactionId: string;
  item: InteractionCardItem;
  itemError?: string;
  kind: string;
  options: NonNullable<InteractionCardItem["options"]>;
  pending: boolean;
  repositorySetup: boolean;
  slug: string;
  onAnswer?: (
    id: string,
    answer: { optionId?: string; text?: string }
  ) => Promise<boolean>;
  state: string;
}) {
  if (repositorySetup) {
    return (
      <CodeRepositorySetupCard
        answer={answer}
        botSlug={slug}
        item={item}
        pending={pending}
        state={state}
      />
    );
  }
  return (
    <InteractionResponse
      allowFreeform={allowFreeform}
      answer={answer}
      interactionId={interactionId}
      itemError={itemError}
      key={`${interactionId}:${pending ? "pending" : (itemError ?? state)}`}
      kind={kind}
      options={options}
      pending={pending}
    />
  );
}

function InteractionResponse({
  interactionId,
  kind,
  options,
  allowFreeform,
  pending,
  itemError,
  answer,
}: {
  interactionId: string;
  kind: string;
  options: NonNullable<InteractionCardItem["options"]>;
  allowFreeform: boolean;
  pending: boolean;
  itemError?: string;
  answer: (value: { optionId?: string; text?: string }) => Promise<boolean>;
}) {
  const [sending, setSending] = useState(false);
  const [locked, setLocked] = useState(false);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(itemError ?? null);

  const submit = useCallback(
    async (value: { optionId?: string; text?: string }) => {
      const submitted = value.optionId ?? value.text ?? "";
      if (!submitted.trim() || sending || locked || pending) {
        return;
      }
      setSending(true);
      setError(null);
      let accepted = false;
      try {
        accepted = await answer(value);
        if (accepted) {
          setLocked(true);
        } else {
          setError("Couldn't send that answer. Try again.");
        }
      } catch {
        setError("Couldn't send that answer. Try again.");
      } finally {
        setSending(false);
      }
    },
    [answer, locked, pending, sending]
  );

  return (
    <>
      {options.length ? (
        <OptionButtons
          disabled={sending || locked || pending}
          kind={kind}
          onSubmit={submit}
          options={options}
        />
      ) : null}
      {allowFreeform ? (
        <FreeformAnswer
          disabled={sending || locked || pending}
          draft={draft}
          interactionId={interactionId}
          onChange={setDraft}
          onSubmit={submit}
        />
      ) : null}
      {options.length || allowFreeform ? null : (
        <p className="text-muted-foreground text-[13px]">
          Waiting for the bot to continue.
        </p>
      )}
      {sending || locked || pending ? (
        <p className="text-muted-foreground text-[13px]" role="status">
          Sending…
        </p>
      ) : null}
      {error ? (
        <p
          className="text-destructive flex items-center gap-1.5 text-[13px]"
          role="alert"
        >
          <CircleAlert aria-hidden="true" className="size-3.5" />
          {error}
        </p>
      ) : null}
    </>
  );
}

function OptionButtons({
  options,
  kind,
  disabled,
  onSubmit,
}: {
  options: NonNullable<InteractionCardItem["options"]>;
  kind: string;
  disabled: boolean;
  onSubmit: (value: { optionId: string }) => void;
}) {
  const handleClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { optionId } = event.currentTarget.dataset;
      if (optionId) {
        onSubmit({ optionId });
      }
    },
    [onSubmit]
  );
  return (
    <fieldset
      aria-label={kind === "approval" ? "Approval options" : "Answer options"}
      className="m-0 flex flex-wrap gap-2 border-0 p-0"
    >
      {options.map((option) => (
        <Button
          data-option-id={option.id}
          disabled={disabled}
          key={option.id}
          onClick={handleClick}
          type="button"
          variant={
            kind === "approval" && (option.style ?? "primary") === "primary"
              ? "signal"
              : buttonVariant(option.style)
          }
        >
          {disabled ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : null}
          {option.label}
        </Button>
      ))}
    </fieldset>
  );
}

function FreeformAnswer({
  interactionId,
  draft,
  disabled,
  onChange,
  onSubmit,
}: {
  interactionId: string;
  draft: string;
  disabled: boolean;
  onChange: (value: string) => void;
  onSubmit: (value: { text: string }) => void;
}) {
  const handleChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      onChange(event.target.value);
    },
    [onChange]
  );
  const handleSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      onSubmit({ text: draft });
    },
    [draft, onSubmit]
  );
  return (
    <form className="flex flex-col gap-2" onSubmit={handleSubmit}>
      <label className="sr-only" htmlFor={`interaction-${interactionId}`}>
        Your answer
      </label>
      <Textarea
        disabled={disabled}
        id={`interaction-${interactionId}`}
        maxLength={2000}
        onChange={handleChange}
        placeholder="Write an answer…"
        rows={2}
        value={draft}
      />
      <div className="flex justify-end">
        <Button disabled={disabled || !draft.trim()} type="submit">
          {disabled ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : null}
          Send answer
        </Button>
      </div>
    </form>
  );
}

function SettledState({ state, outcome }: { state: string; outcome?: string }) {
  if (state === "accepted") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
        <Check aria-hidden="true" className="size-3.5" />
        Answer sent.
      </p>
    );
  }
  if (state === "declined" || state === "rejected") {
    return (
      <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
        <X aria-hidden="true" className="size-3.5" />
        Approval declined.
      </p>
    );
  }
  return (
    <p className="text-muted-foreground text-[13px]">
      {outcome ?? "No longer needed."}
    </p>
  );
}
