"use client";

import { Pencil } from "lucide-react";
import {
  type MouseEvent,
  type ReactNode,
  useCallback,
  useId,
  useState,
} from "react";
import { BotAvatar } from "@/components/bot-avatar";
import {
  avatarFor,
  isPixKey,
  isPixVariant,
  PIX,
  PIX_KEYS,
  PIX_VARIANTS,
  type PixKey,
  pixFor,
  pixGlow,
  variantFor,
} from "@/lib/avatar";
import { cn } from "@/lib/utils";

const COLOR_LABELS: Record<PixKey, string> = {
  brown: "Brown",
  cream: "Cream",
  green: "Green",
  lavender: "Lavender",
  lime: "Lime",
  night: "Night",
  orange: "Orange",
  purple: "Purple",
  red: "Red",
  sand: "Sand",
  violet: "Violet",
  white: "White",
};

// Keep saved Chef identities valid while offering six equally weighted choices.
const PICKER_VARIANTS = PIX_VARIANTS.filter((entry) => entry.id !== "chef");

export function BotIdentityPicker({
  avatar,
  children,
  disabled = false,
  onChange,
  slug = "new-bot",
}: {
  avatar?: string | null;
  children?: ReactNode;
  disabled?: boolean;
  onChange: (value: string) => void;
  slug?: string;
}) {
  const [editing, setEditing] = useState(false);
  const optionsId = useId();
  const selected = pixFor(slug, avatar);
  const variant = variantFor(avatar);
  const toggleEditing = useCallback(() => {
    setEditing((current) => !current);
  }, []);
  const handleColorClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { color } = event.currentTarget.dataset;
      if (isPixKey(color)) {
        onChange(avatarFor(color, variant));
      }
    },
    [onChange, variant]
  );
  const handleVariantClick = useCallback(
    (event: MouseEvent<HTMLButtonElement>) => {
      const { variant: nextVariant } = event.currentTarget.dataset;
      if (!isPixVariant(nextVariant)) {
        return;
      }
      const preset = PIX_VARIANTS.find((entry) => entry.id === nextVariant);
      onChange(
        avatarFor(
          nextVariant === "classic" ? selected : (preset?.color ?? selected),
          nextVariant
        )
      );
    },
    [onChange, selected]
  );

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-center gap-3">
        <button
          aria-controls={optionsId}
          aria-expanded={editing}
          aria-label={
            editing ? "Done editing bot identity" : "Edit bot identity"
          }
          className="group/avatar border-border bg-accent/40 focus-visible:outline-ring relative grid size-16 shrink-0 cursor-pointer place-items-center border focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50"
          disabled={disabled}
          onClick={toggleEditing}
          type="button"
        >
          <BotAvatar avatar={avatar} size={52} slug={slug} />
          <span
            aria-hidden="true"
            className="border-border bg-background/90 pointer-events-none absolute right-0.5 bottom-0.5 grid size-5 place-items-center border opacity-0 transition-opacity group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100 motion-reduce:transition-none [@media(hover:none)]:opacity-100"
          >
            <Pencil className="size-3" />
          </span>
        </button>
        <div className="min-w-0 flex-1">{children}</div>
      </div>

      {editing ? (
        <div className="flex flex-col gap-4" id={optionsId}>
          <fieldset className="flex flex-col gap-2" disabled={disabled}>
            <legend className="text-sm font-medium">Style</legend>
            <div className="grid grid-cols-3 gap-1 pt-3">
              {PICKER_VARIANTS.map((entry) => (
                <button
                  aria-label={`${entry.label} style`}
                  aria-pressed={variant === entry.id}
                  className={cn(
                    "focus-visible:outline-ring flex min-h-24 flex-col items-center justify-center gap-2 border px-2 py-2 transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
                    variant === entry.id
                      ? "border-foreground/50 bg-accent"
                      : "hover:border-border hover:bg-accent/60 border-transparent"
                  )}
                  data-variant={entry.id}
                  key={entry.id}
                  onClick={handleVariantClick}
                  type="button"
                >
                  <span className="grid h-14 w-full shrink-0 place-items-center">
                    <BotAvatar
                      avatar={avatarFor(
                        entry.id === "classic" ? selected : entry.color,
                        entry.id
                      )}
                      size={44}
                      slug={`identity-${entry.id}`}
                    />
                  </span>
                  <span className="text-xs leading-4">{entry.label}</span>
                </button>
              ))}
            </div>
          </fieldset>

          <fieldset className="flex flex-col gap-2" disabled={disabled}>
            <legend className="text-sm font-medium">Color</legend>
            <div className="grid grid-cols-6 gap-1 pt-3">
              {PIX_KEYS.map((color) => {
                const active = selected === color;
                return (
                  <button
                    aria-label={COLOR_LABELS[color]}
                    aria-pressed={active}
                    className={cn(
                      "focus-visible:outline-ring grid h-11 w-full place-items-center border transition-colors focus-visible:outline-2 disabled:cursor-not-allowed disabled:opacity-50",
                      active
                        ? "border-foreground/50 bg-accent"
                        : "hover:border-border hover:bg-accent/60 border-transparent"
                    )}
                    data-color={color}
                    key={color}
                    onClick={handleColorClick}
                    title={COLOR_LABELS[color]}
                    type="button"
                  >
                    {/* The color lives in the robot's lights now, so show that color. */}
                    <span
                      aria-hidden="true"
                      className="size-5"
                      style={{ background: pixGlow(PIX[color]) }}
                    />
                  </button>
                );
              })}
            </div>
            <p className="text-muted-foreground text-xs">
              {COLOR_LABELS[selected]}
            </p>
          </fieldset>
        </div>
      ) : null}
    </div>
  );
}
