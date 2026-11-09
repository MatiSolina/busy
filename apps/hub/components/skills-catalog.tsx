"use client";

import {
  AlertCircle,
  ArrowLeft,
  BookOpen,
  Check,
  ExternalLink,
  LoaderCircle,
  Search,
} from "lucide-react";
import { type ChangeEvent, type FormEvent, useCallback, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import type { Capability, CapabilityInput } from "@/lib/capabilities/types";

export interface SkillCatalogEntry {
  description?: string;
  id: string;
  installs: number;
  name: string;
  slug: string;
  source: string;
  sourceType?: string;
}

export interface SkillPreview {
  capability: CapabilityInput;
  hash: string;
  skill: SkillCatalogEntry;
}

interface Props {
  onBack?: () => void;
  onInstalled: (capability: Capability, reused?: boolean) => void;
}

const SKILL_SOURCE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/u;
const SKILL_SLUG = /^[A-Za-z0-9_.-]+$/u;
const LOCAL_EDIT_ERROR = /local edits|different revision|cannot reinstall/iu;

interface SearchResponse {
  error?: string;
  message?: string;
  skills?: SkillCatalogEntry[];
}

interface PreviewResponse {
  capability?: CapabilityInput;
  error?: string;
  hash?: string;
  message?: string;
  skill?: SkillCatalogEntry;
}

interface InstallResponse {
  capability?: Capability;
  error?: string;
  message?: string;
  reused?: boolean;
}

function assertSearchResponse(
  response: Response,
  body: SearchResponse | null
): asserts body is SearchResponse {
  if (response.ok) {
    return;
  }
  if (response.status === 429) {
    throw new Error(
      "The skills catalog is rate limited. Try again in a moment."
    );
  }
  throw new Error(body?.message || body?.error || "Couldn't search skills.");
}

function assertPreviewResponse(
  response: Response,
  body: PreviewResponse | null
): asserts body is PreviewResponse & {
  capability: CapabilityInput;
  hash: string;
  skill: SkillCatalogEntry;
} {
  if (response.ok && body?.skill && body.capability && body.hash) {
    return;
  }
  throw new Error(body?.message || body?.error || "Couldn't load this skill.");
}

function assertInstallResponse(
  response: Response,
  body: InstallResponse | null
): asserts body is InstallResponse & { capability: Capability } {
  if (response.status === 409) {
    const conflict = body?.message || body?.error;
    if (conflict && LOCAL_EDIT_ERROR.test(conflict)) {
      throw new Error(conflict);
    }
    throw new Error(
      "This skill changed since you reviewed it. Review the latest version before installing."
    );
  }
  if (response.status === 429) {
    throw new Error(
      "The skills catalog is rate limited. Try again in a moment."
    );
  }
  if (!(response.ok && body?.capability)) {
    throw new Error(
      body?.message || body?.error || "Couldn't install this skill."
    );
  }
}

/** Discover skills.sh entries and review the exact snapshot before installing it. */
export function SkillsCatalog({ onBack, onInstalled }: Props) {
  const [query, setQuery] = useState("");
  const [owner, setOwner] = useState("");
  const [results, setResults] = useState<SkillCatalogEntry[]>([]);
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [preview, setPreview] = useState<SkillPreview | null>(null);
  const [previewing, setPreviewing] = useState(false);
  const [failedPreview, setFailedPreview] = useState<SkillCatalogEntry | null>(
    null
  );
  const [installing, setInstalling] = useState(false);
  const [installError, setInstallError] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const search = useCallback(async () => {
    const value = query.trim();
    if (value.length < 2) {
      setError("Search with at least 2 characters.");
      return;
    }
    if (value.length > 120) {
      setError("Searches can be up to 120 characters.");
      return;
    }
    setSearching(true);
    setFailedPreview(null);
    setError(null);
    setNotice(null);
    try {
      const params = new URLSearchParams({ q: value });
      const trimmedOwner = owner.trim();
      if (trimmedOwner) {
        params.set("owner", trimmedOwner);
      }
      const response = await fetch(`/api/skills/search?${params.toString()}`);
      const body = (await response
        .json()
        .catch(() => null)) as SearchResponse | null;
      assertSearchResponse(response, body);
      setResults((body?.skills ?? []).filter(isCatalogEntry));
      setSearched(true);
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Couldn't search skills."
      );
    } finally {
      setSearching(false);
    }
  }, [owner, query]);

  const previewSkill = useCallback(async (entry: SkillCatalogEntry) => {
    setPreviewing(true);
    setError(null);
    setNotice(null);
    setInstallError(false);
    try {
      const response = await fetch(
        `/api/skills/preview?id=${encodeURIComponent(entry.id)}`
      );
      const body = (await response
        .json()
        .catch(() => null)) as PreviewResponse | null;
      assertPreviewResponse(response, body);
      setPreview({
        capability: body.capability,
        hash: body.hash,
        skill: body.skill,
      });
      setFailedPreview(null);
    } catch (cause) {
      setFailedPreview(entry);
      setError(
        cause instanceof Error ? cause.message : "Couldn't load this skill."
      );
    } finally {
      setPreviewing(false);
    }
  }, []);

  const install = useCallback(async () => {
    if (!preview) {
      return;
    }
    setInstalling(true);
    setError(null);
    setNotice(null);
    setInstallError(false);
    try {
      const response = await fetch("/api/skills", {
        body: JSON.stringify({ hash: preview.hash, id: preview.skill.id }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      });
      const body = (await response
        .json()
        .catch(() => null)) as InstallResponse | null;
      assertInstallResponse(response, body);
      onInstalled(body.capability, body.reused);
    } catch (cause) {
      setInstallError(true);
      setError(
        cause instanceof Error ? cause.message : "Couldn't install this skill."
      );
    } finally {
      setInstalling(false);
    }
  }, [onInstalled, preview]);

  const handleBack = useCallback(() => {
    setPreview(null);
    setError(null);
    setNotice(null);
  }, []);
  const handleRefresh = useCallback(() => {
    if (preview) {
      previewSkill(preview.skill);
    }
  }, [preview, previewSkill]);
  const handleSearchSubmit = useCallback(
    (event: FormEvent<HTMLFormElement>) => {
      event.preventDefault();
      search();
    },
    [search]
  );
  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
    []
  );
  const handleOwnerChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setOwner(event.target.value),
    []
  );
  const retryPreview = useCallback(() => {
    if (failedPreview) {
      previewSkill(failedPreview);
    }
  }, [failedPreview, previewSkill]);
  let retry: (() => void) | undefined;
  if (failedPreview) {
    retry = retryPreview;
  } else if (query.trim().length >= 2) {
    retry = search;
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {preview ? (
        <SkillPreviewPanel
          error={error}
          installError={installError}
          installing={installing}
          onBack={handleBack}
          onInstall={install}
          onRefresh={handleRefresh}
          preview={preview}
        />
      ) : (
        <>
          <div className="border-border shrink-0 border-b p-4 sm:px-6">
            {onBack ? (
              <Button
                className="mb-3 -ml-2"
                onClick={onBack}
                size="sm"
                variant="ghost"
              >
                <ArrowLeft aria-hidden /> Your skills
              </Button>
            ) : (
              <h3 className="mb-3 text-sm font-medium">Browse skills.sh</h3>
            )}
            <form onSubmit={handleSearchSubmit}>
              <div className="flex gap-2">
                <label className="relative min-w-0 flex-1">
                  <span className="sr-only">Search skills.sh</span>
                  <Search
                    aria-hidden
                    className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
                  />
                  <Input
                    className="pl-8"
                    maxLength={120}
                    onChange={handleQueryChange}
                    placeholder="Search skills.sh"
                    value={query}
                  />
                </label>
                <Button disabled={searching} type="submit">
                  {searching ? (
                    <LoaderCircle aria-hidden className="animate-spin" />
                  ) : null}
                  {searching ? "Searching…" : "Search"}
                </Button>
              </div>
              <details className="text-muted-foreground mt-3 text-xs">
                <summary className="hover:text-foreground w-fit cursor-pointer">
                  Filter by publisher{owner.trim() ? ` · ${owner.trim()}` : ""}
                </summary>
                <Input
                  aria-label="Owner (optional)"
                  className="mt-2 sm:w-64"
                  maxLength={120}
                  onChange={handleOwnerChange}
                  placeholder="Owner (optional)"
                  value={owner}
                />
              </details>
            </form>
          </div>
          {error ? <ErrorNotice message={error} retry={retry} /> : null}
          {notice ? (
            <p
              className="text-muted-foreground mx-4 mt-4 flex items-center gap-2 text-sm"
              role="status"
            >
              <Check aria-hidden className="size-4 text-emerald-500" />
              {notice}
            </p>
          ) : null}
          <SkillCatalogResults
            onPreview={previewSkill}
            previewing={previewing}
            query={query}
            results={results}
            searched={searched}
          />
        </>
      )}
    </div>
  );
}

function SkillCatalogResults({
  onPreview,
  previewing,
  query,
  results,
  searched,
}: {
  onPreview: (entry: SkillCatalogEntry) => void;
  previewing: boolean;
  query: string;
  results: SkillCatalogEntry[];
  searched: boolean;
}) {
  if (!searched) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center gap-3 px-8 py-16 text-center">
        <BookOpen aria-hidden className="text-muted-foreground size-5" />
        <p className="text-sm font-medium">Find a skill for your app</p>
        <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
          Search by name or description, then review the instructions before
          installing.
        </p>
      </div>
    );
  }
  if (results.length === 0) {
    return (
      <div className="text-muted-foreground min-h-0 flex-1 p-8 text-center text-sm">
        No skills matched “{query.trim()}”.
      </div>
    );
  }
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <ul aria-label="skills.sh results" className="divide-border divide-y">
        {results.map((entry) => (
          <SkillResultRow
            busy={previewing}
            entry={entry}
            key={entry.id}
            onPreview={onPreview}
          />
        ))}
      </ul>
    </div>
  );
}

function SkillResultRow({
  entry,
  busy,
  onPreview,
}: {
  entry: SkillCatalogEntry;
  busy: boolean;
  onPreview: (entry: SkillCatalogEntry) => void;
}) {
  const handlePreview = useCallback(() => onPreview(entry), [entry, onPreview]);
  const link = safeSkillUrl(entry);
  const detail = [
    entry.source,
    entry.description?.trim(),
    `${formatInstalls(entry.installs)} installs`,
  ]
    .filter(Boolean)
    .join(" · ");

  return (
    <li className="hover:bg-accent/30 flex min-h-16 items-center gap-3 px-4 py-3 transition-colors sm:px-6">
      <div className="text-muted-foreground grid size-8 shrink-0 place-items-center">
        <BookOpen aria-hidden className="size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <h4
          className="truncate text-sm leading-5 font-medium"
          title={entry.name}
        >
          {entry.name}
        </h4>
        <p
          className="text-muted-foreground mt-0.5 truncate text-xs leading-4"
          title={detail}
        >
          {detail}
        </p>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        <Button
          className="h-8 px-2.5 text-xs"
          disabled={busy}
          onClick={handlePreview}
          size="sm"
          variant="outline"
        >
          {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          {busy ? "Loading…" : "Review skill"}
        </Button>
        {link ? (
          <a
            aria-label={`Open ${entry.name} on skills.sh`}
            className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex size-8 shrink-0 items-center justify-center transition-colors"
            href={link}
            rel="noreferrer"
            target="_blank"
            title="Open source"
          >
            <ExternalLink aria-hidden className="size-3.5" />
          </a>
        ) : null}
      </div>
    </li>
  );
}

function SkillPreviewPanel({
  preview,
  installing,
  installError,
  error,
  onBack,
  onRefresh,
  onInstall,
}: {
  preview: SkillPreview;
  installing: boolean;
  installError: boolean;
  error: string | null;
  onBack: () => void;
  onRefresh: () => void;
  onInstall: () => void;
}) {
  const retry = getPreviewRetry({
    error,
    installError,
    onInstall,
    onRefresh,
  });
  const link = safeSkillUrl(preview.skill);
  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      <div className="border-border border-b p-4">
        <Button onClick={onBack} size="sm" variant="ghost">
          <ArrowLeft aria-hidden /> Back to results
        </Button>
        <div className="mt-3 flex items-start justify-between gap-3">
          <div>
            <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
              Review skill
            </p>
            <h3 className="mt-1 text-base font-medium">{preview.skill.name}</h3>
            <p className="text-muted-foreground mt-1 text-sm">
              {preview.skill.source} · {formatInstalls(preview.skill.installs)}{" "}
              installs
            </p>
          </div>
          {link ? (
            <a
              className="text-muted-foreground hover:bg-accent hover:text-foreground inline-flex shrink-0 items-center gap-1 px-2 py-1.5 text-xs"
              href={link}
              rel="noreferrer"
              target="_blank"
            >
              skills.sh <ExternalLink aria-hidden className="size-3" />
            </a>
          ) : null}
        </div>
        <p className="text-muted-foreground mt-3 text-sm leading-relaxed">
          Review how this skill works before adding it to the app.
        </p>
        <details className="border-border bg-background/30 mt-3 border px-3 py-2">
          <summary className="text-muted-foreground cursor-pointer text-xs">
            Version details
          </summary>
          <p className="text-muted-foreground mt-2 text-xs">Snapshot hash</p>
          <code className="text-foreground/80 mt-1 block font-mono text-[11px] break-all">
            {preview.hash}
          </code>
        </details>
      </div>
      <div className="space-y-4 p-4">
        {preview.capability.skills.map((skill) => (
          <article
            className="border-border bg-accent/20 border p-4"
            key={skill.name}
          >
            <h4 className="text-sm font-medium">{skill.name}</h4>
            <p className="text-muted-foreground mt-1 text-xs">
              {skill.description}
            </p>
            <pre className="bg-background/50 text-foreground/80 mt-3 max-h-64 overflow-auto p-3 text-xs leading-relaxed whitespace-pre-wrap">
              {skill.content}
            </pre>
            {Object.entries(skill.files).length ? (
              <details className="border-border mt-3 border-t pt-3">
                <summary className="text-muted-foreground cursor-pointer text-xs font-medium">
                  {Object.keys(skill.files).length} supporting files
                </summary>
                <ul className="mt-2 space-y-2">
                  {Object.entries(skill.files).map(([path, content]) => (
                    <li key={path}>
                      <p className="text-muted-foreground text-xs">{path}</p>
                      <pre className="bg-background/50 text-foreground/70 mt-1 max-h-32 overflow-auto p-2 text-[11px] whitespace-pre-wrap">
                        {content}
                      </pre>
                    </li>
                  ))}
                </ul>
              </details>
            ) : null}
          </article>
        ))}
      </div>
      {error ? <ErrorNotice message={error} retry={retry} /> : null}
      <div className="border-border bg-popover sticky bottom-0 border-t p-4">
        <Button className="w-full" disabled={installing} onClick={onInstall}>
          {installing ? (
            <LoaderCircle aria-hidden className="animate-spin" />
          ) : null}
          {installing ? "Installing…" : "Install skill"}
        </Button>
        <p className="text-muted-foreground mt-2 text-center text-xs">
          Available to every bot after installation.
        </p>
      </div>
    </div>
  );
}

function getPreviewRetry({
  error,
  installError,
  onInstall,
  onRefresh,
}: {
  error: string | null;
  installError: boolean;
  onInstall: () => void;
  onRefresh: () => void;
}): (() => void) | undefined {
  if (!installError) {
    return onRefresh;
  }
  if (error?.includes("changed since")) {
    return onRefresh;
  }
  if (error?.includes("rate limited") || error?.includes("Couldn't install")) {
    return onInstall;
  }
  return undefined;
}

function ErrorNotice({
  message,
  retry,
}: {
  message: string;
  retry?: () => void;
}) {
  return (
    <div
      className="border-destructive/30 bg-destructive/10 mx-4 mt-4 flex items-start gap-2 border p-3 text-sm"
      role="alert"
    >
      <AlertCircle
        aria-hidden
        className="text-destructive mt-0.5 size-4 shrink-0"
      />
      <span className="min-w-0 flex-1">{message}</span>
      {retry ? (
        <Button onClick={retry} size="sm" variant="ghost">
          Retry
        </Button>
      ) : null}
    </div>
  );
}

function formatInstalls(value: number): string {
  return Number.isFinite(value)
    ? Intl.NumberFormat("en", {
        maximumFractionDigits: 1,
        notation: "compact",
      }).format(value)
    : "—";
}

function safeSkillUrl(entry: SkillCatalogEntry): string | null {
  const source = entry.source.trim();
  const slug = entry.slug.trim();
  if (!(SKILL_SOURCE.test(source) && SKILL_SLUG.test(slug))) {
    return null;
  }
  return `https://skills.sh/${source.split("/").map(encodeURIComponent).join("/")}/${encodeURIComponent(slug)}`;
}

function isCatalogEntry(value: unknown): value is SkillCatalogEntry {
  if (!value || typeof value !== "object") {
    return false;
  }
  const entry = value as Partial<SkillCatalogEntry>;
  return (
    typeof entry.id === "string" &&
    typeof entry.name === "string" &&
    typeof entry.slug === "string" &&
    typeof entry.source === "string" &&
    typeof entry.installs === "number"
  );
}
