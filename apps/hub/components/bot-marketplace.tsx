"use client";

import { ArrowLeft, ArrowUpRight, Check, Plus, Search, X } from "lucide-react";
import type { ChangeEvent, MouseEvent } from "react";
import { useCallback, useState } from "react";
import { PixHead } from "@/components/bot-avatar";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { pixFor, variantFor } from "@/lib/avatar";
import {
  BOT_CATEGORIES,
  BOT_TEMPLATES,
  type BotCategory,
  type BotTemplate,
  searchBotTemplates,
} from "@/lib/bots/marketplace";
import { cn } from "@/lib/utils";

interface BotMarketplaceProps {
  onBack: () => void;
  onChoose: (template: BotTemplate | null) => void;
  onResume?: () => void;
}

export function BotMarketplace({
  onBack,
  onChoose,
  onResume,
}: BotMarketplaceProps) {
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<BotCategory | "all">("all");
  const [detail, setDetail] = useState<BotTemplate | null>(null);
  const filtered = searchBotTemplates(query, category);
  const exploring = category === "all" && !query.trim();
  const featured = exploring ? filtered.filter((entry) => entry.featured) : [];
  const remaining = exploring
    ? filtered.filter((entry) => !entry.featured)
    : filtered;
  const categoryLabel = BOT_CATEGORIES.find(
    (entry) => entry.id === category
  )?.label;
  const resultsTitle = exploring
    ? "More from Busy"
    : (categoryLabel ?? "Search results");

  const search = useCallback((event: ChangeEvent<HTMLInputElement>) => {
    setQuery(event.target.value);
  }, []);

  const clearSearch = useCallback(() => {
    setQuery("");
  }, []);

  const clearFilters = useCallback(() => {
    setQuery("");
    setCategory("all");
  }, []);

  const pickCategory = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const id = event.currentTarget.dataset.category;
    if (id === "all" || BOT_CATEGORIES.some((entry) => entry.id === id)) {
      setCategory(id as BotCategory | "all");
    }
  }, []);

  const inspect = useCallback((event: MouseEvent<HTMLButtonElement>) => {
    const entry = BOT_TEMPLATES.find(
      (template) => template.id === event.currentTarget.dataset.templateId
    );
    if (entry) {
      setDetail(entry);
    }
  }, []);

  const back = useCallback(() => {
    setDetail(null);
  }, []);

  const choose = useCallback(() => {
    onChoose(detail);
    setDetail(null);
  }, [detail, onChoose]);

  const scratch = useCallback(() => {
    onChoose(null);
  }, [onChoose]);

  if (detail) {
    return <TemplateDetail onBack={back} onChoose={choose} template={detail} />;
  }

  return (
    <>
      {/* Keep mobile scrolling outside the nested desktop flex layout. */}
      <div className="min-h-0 flex-1 touch-pan-y touch-pinch-zoom overflow-y-auto overscroll-y-contain sm:flex sm:flex-col sm:overflow-hidden">
        <SheetHeader className="border-border shrink-0 border-b px-6 pt-6 pr-12 pb-5">
          <Button
            aria-label="Back to bot creation"
            className="text-muted-foreground -ml-2.5 self-start"
            onClick={onBack}
            size="sm"
            type="button"
            variant="ghost"
          >
            <ArrowLeft aria-hidden />
            Back
          </Button>
          <SheetTitle className="text-xl tracking-tight">
            Bot marketplace
          </SheetTitle>
          <SheetDescription>
            A team to start from. Pick a bot, then make it yours.
          </SheetDescription>
        </SheetHeader>
        <div className="flex flex-col sm:min-h-0 sm:flex-1 sm:flex-row">
          <nav
            aria-label="Bot categories"
            className="border-border flex shrink-0 gap-1 overflow-x-auto border-b p-3 sm:w-44 sm:flex-col sm:overflow-y-auto sm:border-r sm:border-b-0"
          >
            <button
              aria-pressed={category === "all"}
              className={categoryClass(category === "all")}
              data-category="all"
              onClick={pickCategory}
              type="button"
            >
              All bots
              <span className="text-muted-foreground font-mono text-[11px]">
                {BOT_TEMPLATES.length}
              </span>
            </button>
            {BOT_CATEGORIES.map((entry) => (
              <button
                aria-pressed={category === entry.id}
                className={categoryClass(category === entry.id)}
                data-category={entry.id}
                key={entry.id}
                onClick={pickCategory}
                type="button"
              >
                {entry.label}
              </button>
            ))}
          </nav>
          <div className="flex min-w-0 flex-col sm:min-h-0 sm:flex-1">
            <div className="border-border shrink-0 border-b px-5 py-4">
              <div className="relative">
                <Search
                  aria-hidden
                  className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2"
                />
                <Input
                  aria-label="Search bots"
                  autoFocus
                  className="h-10 pr-10 pl-9"
                  onChange={search}
                  placeholder="Search bots or jobs"
                  type="search"
                  value={query}
                />
                {query ? (
                  <Button
                    aria-label="Clear search"
                    className="text-muted-foreground absolute top-1.5 right-1.5"
                    onClick={clearSearch}
                    size="icon-sm"
                    variant="ghost"
                  >
                    <X aria-hidden />
                  </Button>
                ) : null}
              </div>
            </div>
            <div className="p-5 sm:min-h-0 sm:flex-1 sm:overflow-y-auto sm:overscroll-contain">
              {featured.length > 0 ? (
                <section aria-labelledby="featured-bots" className="mb-7">
                  <div className="mb-3 flex items-baseline justify-between gap-3">
                    <h3 className="text-sm font-medium" id="featured-bots">
                      Featured
                    </h3>
                    <span className="text-muted-foreground text-xs">
                      A few good places to start
                    </span>
                  </div>
                  <ul className="grid gap-3 md:grid-cols-2">
                    {featured.map((template) => (
                      <li key={template.id}>
                        <TemplateCard
                          featured
                          onInspect={inspect}
                          template={template}
                        />
                      </li>
                    ))}
                  </ul>
                </section>
              ) : null}
              <section aria-labelledby="catalog-bots">
                <div className="mb-3 flex items-baseline justify-between gap-3">
                  <h3 className="text-sm font-medium" id="catalog-bots">
                    {resultsTitle}
                  </h3>
                  <span
                    aria-live="polite"
                    className="text-muted-foreground text-xs"
                  >
                    {remaining.length} {remaining.length === 1 ? "bot" : "bots"}
                  </span>
                </div>
                {filtered.length === 0 ? (
                  <div className="border-border flex flex-col items-start gap-3 border border-dashed p-6">
                    <p className="text-sm font-medium">No bots found</p>
                    <p className="text-muted-foreground text-sm">
                      Try a different job or browse all bots. You can also start
                      from scratch.
                    </p>
                    <Button onClick={clearFilters} size="sm" variant="outline">
                      Clear filters
                    </Button>
                  </div>
                ) : (
                  <ul className="grid gap-3 md:grid-cols-2">
                    {remaining.map((template) => (
                      <li key={template.id}>
                        <TemplateCard onInspect={inspect} template={template} />
                      </li>
                    ))}
                  </ul>
                )}
              </section>
            </div>
          </div>
        </div>
      </div>
      <footer className="border-border flex shrink-0 flex-wrap items-center justify-between gap-3 border-t px-5 py-4">
        <p className="text-muted-foreground text-xs">
          Your bot. Your instructions. Its own computer.
        </p>
        <div className="flex items-center gap-2">
          {onResume ? (
            <Button onClick={onResume} size="sm" variant="ghost">
              Continue draft
            </Button>
          ) : null}
          <Button onClick={scratch} size="sm" variant="outline">
            <Plus aria-hidden />
            Start from scratch
          </Button>
        </div>
      </footer>
    </>
  );
}

function categoryClass(active: boolean) {
  return cn(
    "hover:bg-accent hover:text-foreground flex shrink-0 items-center justify-between gap-3 px-3 py-2 text-left text-[13px] whitespace-nowrap transition-colors outline-none",
    active ? "bg-accent text-foreground font-medium" : "text-muted-foreground"
  );
}

function TemplateCard({
  featured = false,
  onInspect,
  template,
}: {
  featured?: boolean;
  onInspect: (event: MouseEvent<HTMLButtonElement>) => void;
  template: BotTemplate;
}) {
  return (
    <button
      aria-label={`View ${template.name}`}
      className={cn(
        "group border-border hover:border-foreground/25 hover:bg-accent/50 flex h-full w-full flex-col items-start border p-4 text-left transition-colors outline-none",
        featured && "bg-muted/40"
      )}
      data-template-id={template.id}
      onClick={onInspect}
      type="button"
    >
      <div className="mb-4 flex w-full items-center justify-between gap-3">
        <PixHead
          className={featured ? "size-12" : "size-9"}
          pix={pixFor(template.id, template.avatar)}
          variant={variantFor(template.avatar)}
        />
        <span className="text-muted-foreground text-[11px]">
          {
            BOT_CATEGORIES.find((entry) => entry.id === template.category)
              ?.label
          }
        </span>
      </div>
      <h4 className="text-sm font-medium">{template.name}</h4>
      <p className="text-muted-foreground mt-1 text-[11px]">
        by {template.author}
      </p>
      <p className="text-muted-foreground mt-3 flex-1 text-[13px] leading-relaxed">
        {template.description}
      </p>
      <span className="mt-4 inline-flex items-center gap-1.5 text-xs">
        Meet the bot
        <ArrowUpRight aria-hidden className="size-3.5" />
      </span>
    </button>
  );
}

function TemplateDetail({
  onBack,
  onChoose,
  template,
}: {
  onBack: () => void;
  onChoose: () => void;
  template: BotTemplate;
}) {
  return (
    <>
      <SheetHeader className="border-border shrink-0 border-b p-5 pr-12">
        <Button
          autoFocus
          className="text-muted-foreground -ml-2.5 self-start"
          onClick={onBack}
          size="sm"
          variant="ghost"
        >
          <ArrowLeft aria-hidden />
          All bots
        </Button>
        <SheetDescription className="sr-only">
          Review this bot before using the template.
        </SheetDescription>
      </SheetHeader>
      <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-8 sm:px-10">
        <div className="mx-auto max-w-2xl">
          <div className="flex items-start gap-5">
            <PixHead
              className="size-20 shrink-0 sm:size-24"
              pix={pixFor(template.id, template.avatar)}
              variant={variantFor(template.avatar)}
            />
            <div className="min-w-0 pt-1">
              <p className="text-muted-foreground mb-2 text-xs">
                {
                  BOT_CATEGORIES.find((entry) => entry.id === template.category)
                    ?.label
                }
              </p>
              <SheetTitle className="text-2xl font-medium tracking-tight">
                {template.name}
              </SheetTitle>
              <p className="text-muted-foreground mt-2 text-sm">
                by {template.author}
              </p>
            </div>
          </div>
          <p className="mt-8 text-base leading-relaxed">
            {template.description}
          </p>
          <section className="border-border mt-8 border-t pt-6">
            <h3 className="text-sm font-medium">Try asking</h3>
            <ul className="mt-4 space-y-3">
              {template.starterPrompts.map((prompt) => (
                <li
                  className="border-border text-muted-foreground border-l-2 py-1 pl-4 text-sm leading-relaxed"
                  key={prompt}
                >
                  {prompt}
                </li>
              ))}
            </ul>
          </section>
          {template.suggestedTools.length > 0 ? (
            <section className="border-border mt-8 border-t pt-6">
              <h3 className="text-sm font-medium">Suggested apps</h3>
              <ul className="mt-3 flex flex-wrap gap-2">
                {template.suggestedTools.map((tool) => (
                  <li
                    className="border-border text-muted-foreground border px-2.5 py-1.5 text-xs"
                    key={tool}
                  >
                    {tool}
                  </li>
                ))}
              </ul>
              <p className="text-muted-foreground mt-3 text-xs">
                Optional. Connect apps after creating your bot.
              </p>
            </section>
          ) : null}
          <details className="border-border mt-8 border-t pt-6">
            <summary className="cursor-pointer text-sm font-medium outline-none">
              Read the instructions
            </summary>
            <p className="text-muted-foreground mt-4 text-sm leading-relaxed whitespace-pre-wrap">
              {template.instructions}
            </p>
          </details>
        </div>
      </div>
      <footer className="border-border flex shrink-0 flex-wrap items-center justify-between gap-4 border-t p-5 sm:px-8">
        <p className="text-muted-foreground flex items-center gap-2 text-xs">
          <Check aria-hidden className="size-3.5" />
          Customize before creating
        </p>
        <Button onClick={onChoose}>
          Use template
          <ArrowUpRight aria-hidden />
        </Button>
      </footer>
    </>
  );
}
