"use client";

import { Loader2, Lock, MousePointer2 } from "lucide-react";
import { type FormEvent, useCallback, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { FormField, FormFieldKind } from "@/lib/chat/items";

type InputProps = Pick<
  React.ComponentProps<"input">,
  "autoComplete" | "inputMode" | "placeholder" | "type"
>;
const INPUTS: Record<FormFieldKind, InputProps> = {
  address: { autoComplete: "street-address", type: "text" },
  "card-cvc": {
    autoComplete: "cc-csc",
    inputMode: "numeric",
    type: "password",
  },
  "card-expiry": {
    autoComplete: "cc-exp",
    inputMode: "numeric",
    placeholder: "MM/YY",
    type: "text",
  },
  "card-number": {
    autoComplete: "cc-number",
    inputMode: "numeric",
    type: "text",
  },
  email: { autoComplete: "username", type: "email" },
  otp: { autoComplete: "one-time-code", inputMode: "numeric", type: "text" },
  password: { autoComplete: "current-password", type: "password" },
  tel: { autoComplete: "tel", type: "tel" },
  text: { autoComplete: "on", type: "text" },
};

/**
 * request_form's card: the user types values only they should know, and the hub types them into the
 * bot's screen (app/api/bots/[slug]/form). The values stay in this form's inputs until Submit and are
 * never put in the chat, the store or the bot's context.
 */
export function FormCard({
  slug,
  interactionId,
  fields,
  onTakeControl,
}: {
  slug: string;
  interactionId: string;
  fields: readonly FormField[];
  onTakeControl?: () => void;
}) {
  const formId = useId();
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = useCallback(
    async (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const form = event.currentTarget;
      const data = new FormData(form);
      setSending(true);
      setError(null);
      const res = await fetch(`/api/bots/${encodeURIComponent(slug)}/form`, {
        body: JSON.stringify({
          fields: fields.map((f) => ({
            id: f.id,
            target: f.target,
            value: String(data.get(f.id) ?? ""),
          })),
          interactionId,
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => null);
      form.reset();
      const body = (await res?.json().catch(() => null)) as {
        failed?: string[];
      } | null;
      // Filled or not, the bot's question is answered: the card closes when it settles.
      if (!res?.ok) {
        setSending(false);
        setError("Couldn't send it. Try again, or type it yourself.");
      } else if (body?.failed?.length) {
        setError(
          `Couldn't fill ${fields
            .filter((f) => body.failed?.includes(f.id))
            .map((f) => f.label)
            .join(", ")}. It will ask you to type it on the screen.`
        );
      }
    },
    [fields, interactionId, slug]
  );
  return (
    <form
      aria-label="Secure form"
      className="flex flex-col gap-3"
      onSubmit={submit}
    >
      {fields.map((field) => (
        <div className="flex flex-col gap-1.5" key={field.id}>
          <Label htmlFor={`${formId}-${field.id}`}>{field.label}</Label>
          <Input
            {...INPUTS[field.kind]}
            disabled={sending}
            id={`${formId}-${field.id}`}
            name={field.id}
            required
          />
        </div>
      ))}
      <p className="text-muted-foreground flex items-center gap-1.5 text-[13px]">
        <Lock aria-hidden="true" className="size-3.5" />
        Typed straight into its screen. It never sees what you type.
      </p>
      <div className="flex flex-wrap gap-2">
        <Button disabled={sending} type="submit">
          {sending ? (
            <Loader2 aria-hidden="true" className="animate-spin" />
          ) : null}
          Submit
        </Button>
        <Button onClick={onTakeControl} type="button" variant="outline">
          <MousePointer2 aria-hidden="true" />
          I&apos;ll type it myself
        </Button>
      </div>
      {error ? (
        <p className="text-destructive text-[13px]" role="alert">
          {error}
        </p>
      ) : null}
    </form>
  );
}
