"use client";

import { ContextMenu } from "@base-ui/react/context-menu";
import { ChevronRight, FolderPlus, Pencil, Trash2 } from "lucide-react";
import dynamic from "next/dynamic";
import { useCallback, useId, useState } from "react";

import { useChat } from "@/components/chat-app";
import { MountOnOpen } from "@/components/mount-on-open";
import { useSections } from "@/components/sections-provider";
import { SidebarBotRow } from "@/components/sidebar-bot-row";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import type { Section } from "@/lib/sections/types";
import { cn } from "@/lib/utils";

const BotSectionsDrag = dynamic(() =>
  import("@/components/bot-sections-drag").then((m) => m.BotSectionsDrag)
);
const BotSectionDropZone = dynamic(() =>
  import("@/components/bot-sections-drag").then((m) => m.BotSectionDropZone)
);
const UnassignedBotGroup = dynamic(() =>
  import("@/components/unassigned-bot-group").then((m) => m.UnassignedBotGroup)
);

const sectionMenuItemClass =
  "flex cursor-default items-center gap-2 px-3 py-2 text-sm outline-none data-disabled:opacity-50 data-highlighted:bg-accent";

type SectionAction =
  | { kind: "create" }
  | { kind: "rename" | "delete"; section: Section };

interface BotSectionsProps {
  collapsed: boolean;
  onSelect?: () => void;
}

export function BotSections({ collapsed, onSelect }: BotSectionsProps) {
  const order = useChat((state) => state.order);
  const { busy, sections } = useSections();
  const [action, setAction] = useState<SectionAction | null>(null);
  const create = useCallback(() => setAction({ kind: "create" }), []);
  const close = useCallback(() => setAction(null), []);
  const onAreaTouchStart = useCallback<
    NonNullable<ContextMenu.Trigger.Props["onTouchStart"]>
  >((event) => {
    if (
      event.target instanceof Element &&
      event.target.closest("[data-bot-slug]")
    ) {
      event.preventBaseUIHandler();
    }
  }, []);
  const onOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setAction(null);
    }
  }, []);
  const assigned = new Set(sections.flatMap((section) => section.botSlugs));
  const unassigned = order.filter((slug) => !assigned.has(slug));

  const content = (
    <>
      <ContextMenu.Root disabled={busy}>
        <ContextMenu.Trigger
          aria-label="Bots"
          className="min-h-0 flex-1 overflow-y-auto px-2"
          onTouchStart={onAreaTouchStart}
          render={<nav />}
          tabIndex={0}
        >
          {collapsed ? null : (
            <div className="flex h-10 items-center px-3">
              <span className="text-muted-foreground flex-1 text-xs font-medium">
                Bots
              </span>
            </div>
          )}
          {collapsed || sections.length === 0 ? (
            <ul className="flex flex-col gap-0.5">
              {order.map((slug) => (
                <SidebarBotRow
                  collapsed={collapsed}
                  key={slug}
                  onSelect={onSelect}
                  slug={slug}
                />
              ))}
            </ul>
          ) : (
            <div className="space-y-3 pb-2">
              <UnassignedBotGroup onSelect={onSelect} slugs={unassigned} />
              {sections.map((section) => (
                <SectionGroup
                  key={section.id}
                  onAction={setAction}
                  onCreate={create}
                  onSelect={onSelect}
                  section={section}
                  slugs={order.filter((slug) =>
                    section.botSlugs.includes(slug)
                  )}
                />
              ))}
            </div>
          )}
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner className="z-50">
            <ContextMenu.Popup className="bg-popover text-popover-foreground border-border w-48 border p-1 shadow-lg outline-none">
              <CreateSectionMenuItem onCreate={create} />
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <MountOnOpen open={action !== null}>
        <Dialog onOpenChange={onOpenChange} open={action !== null}>
          {action ? (
            <SectionForm
              action={action}
              key={`${action.kind}:${"section" in action ? action.section.id : "new"}`}
              onDone={close}
            />
          ) : null}
        </Dialog>
      </MountOnOpen>
    </>
  );
  return sections.length === 0 ? (
    content
  ) : (
    <BotSectionsDrag>{content}</BotSectionsDrag>
  );
}

function CreateSectionMenuItem({ onCreate }: { onCreate: () => void }) {
  return (
    <ContextMenu.Item className={sectionMenuItemClass} onClick={onCreate}>
      <FolderPlus aria-hidden className="size-3.5" />
      Create section
    </ContextMenu.Item>
  );
}

function SectionGroup({
  onAction,
  onCreate,
  onSelect,
  section,
  slugs,
}: {
  onAction: (action: SectionAction) => void;
  onCreate: () => void;
  onSelect?: () => void;
  section: Section;
  slugs: string[];
}) {
  const [open, setOpen] = useState(true);
  const { busy } = useSections();
  const id = useId();
  const toggle = useCallback(() => setOpen((value) => !value), []);
  const rename = useCallback(
    () => onAction({ kind: "rename", section }),
    [onAction, section]
  );
  const remove = useCallback(
    () => onAction({ kind: "delete", section }),
    [onAction, section]
  );

  return (
    <BotSectionDropZone name={section.name} sectionId={section.id}>
      <ContextMenu.Root disabled={busy}>
        <ContextMenu.Trigger className="flex items-center">
          <button
            aria-controls={id}
            aria-expanded={open}
            className="text-muted-foreground hover:text-foreground flex min-w-0 flex-1 items-center gap-2 py-2 pr-1 pl-2 text-left text-sm"
            onClick={toggle}
            type="button"
          >
            <ChevronRight
              aria-hidden
              className={cn(
                "size-3.5 shrink-0 motion-safe:transition-transform",
                open && "rotate-90"
              )}
            />
            <span className="min-w-0 flex-1 truncate">{section.name}</span>
          </button>
        </ContextMenu.Trigger>
        <ContextMenu.Portal>
          <ContextMenu.Positioner align="start" className="z-50" sideOffset={4}>
            <ContextMenu.Popup className="bg-popover text-popover-foreground border-border w-48 border p-1 shadow-lg outline-none">
              <CreateSectionMenuItem onCreate={onCreate} />
              <ContextMenu.Separator className="bg-border my-1 h-px" />
              <ContextMenu.Item
                className={sectionMenuItemClass}
                onClick={rename}
              >
                <Pencil aria-hidden className="size-3.5" />
                Rename section
              </ContextMenu.Item>
              <ContextMenu.Item
                className={sectionMenuItemClass}
                onClick={remove}
              >
                <Trash2 aria-hidden className="size-3.5" />
                Delete section
              </ContextMenu.Item>
            </ContextMenu.Popup>
          </ContextMenu.Positioner>
        </ContextMenu.Portal>
      </ContextMenu.Root>
      <div hidden={!open} id={id}>
        {slugs.length > 0 ? (
          <ul className="flex flex-col gap-0.5">
            {slugs.map((slug) => (
              <SidebarBotRow key={slug} onSelect={onSelect} slug={slug} />
            ))}
          </ul>
        ) : (
          <p className="text-muted-foreground px-8 py-2 text-xs">
            Drop bots here.
          </p>
        )}
      </div>
    </BotSectionDropZone>
  );
}

function SectionForm({
  action,
  onDone,
}: {
  action: SectionAction;
  onDone: () => void;
}) {
  const { busy, createSection, deleteSection, renameSection } = useSections();
  const [error, setError] = useState<string | null>(null);
  const id = useId();
  const deleting = action.kind === "delete";
  const titles = {
    create: "Create section",
    delete: "Delete section",
    rename: "Rename section",
  };
  const title = titles[action.kind];
  const submitLabel = busy ? "Saving…" : title;
  const submit = useCallback(
    async (event: React.FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      const name = String(
        new FormData(event.currentTarget).get("name") ?? ""
      ).trim();
      setError(null);
      try {
        if (action.kind === "create") {
          await createSection(name);
        } else if (action.kind === "delete") {
          await deleteSection(action.section.id);
        } else {
          await renameSection(action.section.id, name);
        }
        onDone();
      } catch (failure) {
        setError(
          failure instanceof Error
            ? failure.message
            : "Couldn't save the section. Try again."
        );
      }
    },
    [action, createSection, deleteSection, onDone, renameSection]
  );

  return (
    <DialogContent>
      <form className="grid gap-4" onSubmit={submit}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            {deleting
              ? `Delete “${action.section.name}”? Its bots will move to No section. Their chats and files will stay available.`
              : "Group your bots by team, client or project."}
          </DialogDescription>
        </DialogHeader>
        {deleting ? null : (
          <div className="grid gap-2">
            <Label htmlFor={id}>Section name</Label>
            <Input
              defaultValue={action.kind === "rename" ? action.section.name : ""}
              disabled={busy}
              id={id}
              maxLength={60}
              name="name"
              required
            />
          </div>
        )}
        {error ? (
          <p className="text-destructive text-sm" role="alert">
            {error}
          </p>
        ) : null}
        <DialogFooter>
          <Button
            disabled={busy}
            onClick={onDone}
            type="button"
            variant="outline"
          >
            Cancel
          </Button>
          <Button
            disabled={busy}
            type="submit"
            variant={deleting ? "destructive" : "default"}
          >
            {submitLabel}
          </Button>
        </DialogFooter>
      </form>
    </DialogContent>
  );
}
