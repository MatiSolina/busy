"use client";

import { Menu } from "@base-ui/react/menu";
import {
  BookOpen,
  Check,
  ChevronDown,
  FileCode2,
  FilePlus2,
  FolderOpen,
  Layers3,
  LoaderCircle,
  Pencil,
  PlugZap,
  Plus,
  Search,
  Trash2,
  Upload,
  X,
} from "lucide-react";
import {
  type ChangeEvent,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { SkillsCatalog } from "@/components/skills-catalog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  type ImportKind,
  parseCapabilityFiles,
} from "@/lib/capabilities/import";
import type {
  Capability,
  CapabilityInput,
  CapabilitySkill,
} from "@/lib/capabilities/types";
import { cn } from "@/lib/utils";

interface Props {
  kind: ImportKind;
}
type FormState = CapabilityInput;

const emptySkill = (): CapabilitySkill => ({
  content: "",
  description: "",
  files: {},
  name: "",
});
const emptyDraft = (kind: ImportKind): FormState => ({
  description: "",
  kind,
  name: "",
  skills: [emptySkill()],
});
function skillKey(skill: CapabilitySkill): string {
  return `${skill.name}:${skill.description}:${skill.content}`;
}

const addMenuItemClass =
  "flex cursor-default items-center gap-2.5 px-3 py-2.5 text-sm outline-none data-highlighted:bg-accent [&_svg]:size-4 [&_svg]:text-muted-foreground";

function displayCapabilityName(capability: Capability): string {
  return capability.origin?.registry === "skills.sh"
    ? (capability.skills[0]?.name ?? capability.name)
    : capability.name;
}

/** Installed skills and plugins, with discovery and imports behind one add menu. */
export function CapabilitiesPanel({ kind }: Props) {
  const [capabilities, setCapabilities] = useState<Capability[]>([]);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [draft, setDraft] = useState<FormState | null>(null);
  const [preview, setPreview] = useState<FormState | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [selectedSkill, setSelectedSkill] = useState(0);
  const [busy, setBusy] = useState<Set<string>>(new Set());
  const [removing, setRemoving] = useState<Set<string>>(new Set());
  const [skillView, setSkillView] = useState<"installed" | "browse">(
    "installed"
  );
  const fileRef = useRef<HTMLInputElement>(null);
  const folderRef = useRef<HTMLInputElement>(null);

  const load = useCallback(
    async (signal?: AbortSignal) => {
      setLoading(true);
      setError(null);
      try {
        const response = await fetch("/api/capabilities", { signal });
        if (!response.ok) {
          throw new Error("Couldn't load capabilities.");
        }
        const body = (await response.json()) as { capabilities?: Capability[] };
        if (signal?.aborted) {
          return;
        }
        setCapabilities(
          (body.capabilities ?? []).filter(
            (capability) => capability.kind === kind
          )
        );
      } catch (cause) {
        if (cause instanceof DOMException && cause.name === "AbortError") {
          return;
        }
        setError(
          cause instanceof Error ? cause.message : "Couldn't load capabilities."
        );
      } finally {
        if (!signal?.aborted) {
          setLoading(false);
        }
      }
    },
    [kind]
  );

  useEffect(() => {
    const controller = new AbortController();
    queueMicrotask(() => {
      if (!controller.signal.aborted) {
        load(controller.signal);
      }
    });
    return () => controller.abort();
  }, [load]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) {
      return capabilities;
    }
    return capabilities.filter((capability) =>
      `${capability.name} ${capability.description} ${capability.skills.map((skill) => `${skill.name} ${skill.description}`).join(" ")}`
        .toLocaleLowerCase()
        .includes(needle)
    );
  }, [capabilities, query]);

  const beginNew = useCallback(() => {
    setNotice(null);
    setError(null);
    setEditingId(null);
    setPreview(null);
    setSelectedSkill(0);
    setDraft(emptyDraft(kind));
  }, [kind]);

  const beginEdit = useCallback((capability: Capability) => {
    setNotice(null);
    setError(null);
    setPreview(null);
    setEditingId(capability.id);
    setSelectedSkill(0);
    setDraft({
      description: capability.description,
      kind: capability.kind,
      name: capability.name,
      ...(capability.version ? { version: capability.version } : {}),
      skills: capability.skills.map((skill) => ({
        ...skill,
        files: { ...skill.files },
      })),
    });
  }, []);

  const closeEditor = useCallback(() => {
    setDraft(null);
    setPreview(null);
    setEditingId(null);
    setSelectedSkill(0);
  }, []);

  const importFiles = useCallback(
    async (files: FileList | null) => {
      if (!files?.length) {
        return;
      }
      setError(null);
      try {
        const imported = await parseCapabilityFiles(
          Array.from(files) as Array<File & { webkitRelativePath?: string }>,
          kind
        );
        setPreview(imported);
        setDraft(null);
        setNotice("Review the import before adding it.");
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Couldn't read that import."
        );
      } finally {
        if (fileRef.current) {
          fileRef.current.value = "";
        }
        if (folderRef.current) {
          folderRef.current.value = "";
        }
      }
    },
    [kind]
  );

  const save = useCallback(
    async (input: FormState, id?: string) => {
      setError(null);
      setNotice(null);
      const key = id ?? "new";
      setBusy((previous) => new Set(previous).add(key));
      try {
        const response = await fetch(
          id
            ? `/api/capabilities/${encodeURIComponent(id)}`
            : "/api/capabilities",
          {
            body: JSON.stringify(input),
            headers: { "Content-Type": "application/json" },
            method: id ? "PATCH" : "POST",
          }
        );
        const body = (await response.json().catch(() => null)) as {
          capability?: Capability;
          error?: string;
        } | null;
        if (!(response.ok && body?.capability)) {
          throw new Error(body?.error || "Couldn't save capability.");
        }
        const saved = body.capability;
        setCapabilities((previous) =>
          id
            ? previous.map((item) => (item.id === id ? saved : item))
            : [saved, ...previous]
        );
        closeEditor();
        setNotice(
          `${kind === "plugin" ? "Plugin" : "Skill"} saved for the app.`
        );
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Couldn't save capability."
        );
      } finally {
        setBusy((previous) => {
          const next = new Set(previous);
          next.delete(key);
          return next;
        });
      }
    },
    [closeEditor, kind]
  );

  const toggle = useCallback(async (capability: Capability) => {
    setError(null);
    setBusy((previous) => new Set(previous).add(capability.id));
    try {
      const response = await fetch(
        `/api/capabilities/${encodeURIComponent(capability.id)}`,
        {
          body: JSON.stringify({ enabled: !capability.enabled }),
          headers: { "Content-Type": "application/json" },
          method: "PATCH",
        }
      );
      const body = (await response.json().catch(() => null)) as {
        capability?: Capability;
        error?: string;
      } | null;
      if (!(response.ok && body?.capability)) {
        throw new Error(body?.error || "Couldn't update capability.");
      }
      const updated = body.capability;
      setCapabilities((previous) =>
        previous.map((item) => (item.id === capability.id ? updated : item))
      );
      setNotice(
        `${displayCapabilityName(capability)} ${updated.enabled ? "enabled" : "disabled"}.`
      );
    } catch (cause) {
      setError(
        cause instanceof Error ? cause.message : "Couldn't update capability."
      );
    } finally {
      setBusy((previous) => {
        const next = new Set(previous);
        next.delete(capability.id);
        return next;
      });
    }
  }, []);

  const remove = useCallback(
    async (capability: Capability) => {
      if (!removing.has(capability.id)) {
        setRemoving((previous) => new Set(previous).add(capability.id));
        return;
      }
      setError(null);
      setBusy((previous) => new Set(previous).add(capability.id));
      try {
        const response = await fetch(
          `/api/capabilities/${encodeURIComponent(capability.id)}`,
          { method: "DELETE" }
        );
        if (!response.ok) {
          throw new Error("Couldn't remove capability.");
        }
        setCapabilities((previous) =>
          previous.filter((item) => item.id !== capability.id)
        );
        setNotice(`${displayCapabilityName(capability)} removed.`);
      } catch (cause) {
        setError(
          cause instanceof Error ? cause.message : "Couldn't remove capability."
        );
      } finally {
        setRemoving((previous) => {
          const next = new Set(previous);
          next.delete(capability.id);
          return next;
        });
        setBusy((previous) => {
          const next = new Set(previous);
          next.delete(capability.id);
          return next;
        });
      }
    },
    [removing]
  );

  const handleImportFileChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => importFiles(event.target.files),
    [importFiles]
  );
  const handleFolderRef = useCallback((element: HTMLInputElement | null) => {
    folderRef.current = element;
    element?.setAttribute("webkitdirectory", "");
    element?.setAttribute("directory", "");
  }, []);
  const handleQueryChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => setQuery(event.target.value),
    []
  );
  const openSkillBrowser = useCallback(() => {
    setSkillView("browse");
    setError(null);
    setNotice(null);
  }, []);
  const openFilePicker = useCallback(() => fileRef.current?.click(), []);
  const openFolderPicker = useCallback(() => folderRef.current?.click(), []);
  const retryLoad = useCallback(() => load(), [load]);
  const backToInstalled = useCallback(() => setSkillView("installed"), []);
  const handleSkillInstalled = useCallback(
    (capability: Capability, reused?: boolean) => {
      setCapabilities((previous) => {
        const found = previous.some((item) => item.id === capability.id);
        return found
          ? previous.map((item) =>
              item.id === capability.id ? capability : item
            )
          : [capability, ...previous];
      });
      const name = displayCapabilityName(capability);
      setNotice(
        reused
          ? `${name} is already installed.`
          : `${name} installed for the app.`
      );
      setSkillView("installed");
    },
    []
  );
  const cancelPreview = useCallback(() => setPreview(null), []);
  const confirmPreview = useCallback(() => {
    if (preview) {
      save(preview);
    }
  }, [preview, save]);
  const saveDraft = useCallback(() => {
    if (draft) {
      save(draft, editingId ?? undefined);
    }
  }, [draft, editingId, save]);

  const title = kind === "plugin" ? "Plugins" : "Skills";
  const showBuiltin = kind === "skill";
  const showingEditor = Boolean(draft || preview);

  return (
    <CapabilityPanelShell
      backToInstalled={backToInstalled}
      beginEdit={beginEdit}
      beginNew={beginNew}
      busy={busy}
      cancelPreview={cancelPreview}
      closeEditor={closeEditor}
      confirmPreview={confirmPreview}
      draft={draft}
      editingId={editingId}
      error={error}
      fileRef={fileRef}
      filtered={filtered}
      handleFolderRef={handleFolderRef}
      handleImportFileChange={handleImportFileChange}
      handleQueryChange={handleQueryChange}
      handleSkillInstalled={handleSkillInstalled}
      kind={kind}
      loading={loading}
      notice={notice}
      onChange={setDraft}
      openFilePicker={openFilePicker}
      openFolderPicker={openFolderPicker}
      openSkillBrowser={openSkillBrowser}
      preview={preview}
      query={query}
      remove={remove}
      removing={removing}
      retryLoad={retryLoad}
      saveDraft={saveDraft}
      selectedSkill={selectedSkill}
      setSelectedSkill={setSelectedSkill}
      showBuiltin={showBuiltin}
      showingEditor={showingEditor}
      skillView={skillView}
      title={title}
      toggle={toggle}
    />
  );
}

interface CapabilityPanelShellProps {
  backToInstalled: () => void;
  beginEdit: (capability: Capability) => void;
  beginNew: () => void;
  busy: Set<string>;
  cancelPreview: () => void;
  closeEditor: () => void;
  confirmPreview: () => void;
  draft: FormState | null;
  editingId: string | null;
  error: string | null;
  fileRef: { current: HTMLInputElement | null };
  filtered: Capability[];
  handleFolderRef: (element: HTMLInputElement | null) => void;
  handleImportFileChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleQueryChange: (event: ChangeEvent<HTMLInputElement>) => void;
  handleSkillInstalled: (capability: Capability, reused?: boolean) => void;
  kind: ImportKind;
  loading: boolean;
  notice: string | null;
  onChange: (draft: FormState | null) => void;
  openFilePicker: () => void;
  openFolderPicker: () => void;
  openSkillBrowser: () => void;
  preview: FormState | null;
  query: string;
  remove: (capability: Capability) => void;
  removing: Set<string>;
  retryLoad: () => void;
  saveDraft: () => void;
  selectedSkill: number;
  setSelectedSkill: (index: number) => void;
  showBuiltin: boolean;
  showingEditor: boolean;
  skillView: "installed" | "browse";
  title: string;
  toggle: (capability: Capability) => void;
}

function CapabilityPanelShell({
  backToInstalled,
  beginEdit,
  beginNew,
  busy,
  cancelPreview,
  closeEditor,
  confirmPreview,
  draft,
  editingId,
  error,
  fileRef,
  filtered,
  handleFolderRef,
  handleImportFileChange,
  handleQueryChange,
  handleSkillInstalled,
  kind,
  loading,
  notice,
  onChange,
  openFilePicker,
  openFolderPicker,
  openSkillBrowser,
  preview,
  query,
  remove,
  removing,
  retryLoad,
  saveDraft,
  selectedSkill,
  setSelectedSkill,
  showBuiltin,
  showingEditor,
  skillView,
  title,
  toggle,
}: CapabilityPanelShellProps) {
  const importFileLabel = `Import ${kind} file`;
  const importFolderLabel = `Import ${kind} folder`;
  const importFileAccept =
    kind === "plugin" ? ".json,application/json" : ".md,text/markdown";
  const importFolderAccept =
    kind === "plugin" ? ".json,.md,text/*" : ".md,text/*";

  return (
    <div className="bg-popover text-popover-foreground flex min-h-0 flex-1 flex-col">
      <input
        accept={importFileAccept}
        aria-label={importFileLabel}
        className="hidden"
        onChange={handleImportFileChange}
        ref={fileRef}
        type="file"
      />
      <input
        accept={importFolderAccept}
        aria-label={importFolderLabel}
        className="hidden"
        multiple
        onChange={handleImportFileChange}
        ref={handleFolderRef}
        type="file"
      />
      {kind === "skill" && skillView === "browse" ? (
        <SkillsCatalog
          onBack={backToInstalled}
          onInstalled={handleSkillInstalled}
        />
      ) : (
        <CapabilityPanelInstalled
          beginEdit={beginEdit}
          beginNew={beginNew}
          busy={busy}
          cancelPreview={cancelPreview}
          closeEditor={closeEditor}
          confirmPreview={confirmPreview}
          draft={draft}
          editingId={editingId}
          error={error}
          filtered={filtered}
          handleQueryChange={handleQueryChange}
          kind={kind}
          loading={loading}
          notice={notice}
          onChange={onChange}
          openFilePicker={openFilePicker}
          openFolderPicker={openFolderPicker}
          openSkillBrowser={openSkillBrowser}
          preview={preview}
          query={query}
          remove={remove}
          removing={removing}
          retryLoad={retryLoad}
          saveDraft={saveDraft}
          selectedSkill={selectedSkill}
          setSelectedSkill={setSelectedSkill}
          showBuiltin={showBuiltin}
          showingEditor={showingEditor}
          title={title}
          toggle={toggle}
        />
      )}
    </div>
  );
}

function CapabilityPanelInstalled({
  beginEdit,
  beginNew,
  busy,
  cancelPreview,
  closeEditor,
  confirmPreview,
  draft,
  editingId,
  error,
  filtered,
  handleQueryChange,
  kind,
  loading,
  notice,
  onChange,
  openFilePicker,
  openFolderPicker,
  openSkillBrowser,
  preview,
  query,
  remove,
  removing,
  retryLoad,
  saveDraft,
  selectedSkill,
  setSelectedSkill,
  showBuiltin,
  showingEditor,
  title,
  toggle,
}: Omit<
  CapabilityPanelShellProps,
  | "backToInstalled"
  | "fileRef"
  | "handleFolderRef"
  | "handleImportFileChange"
  | "handleSkillInstalled"
  | "kind"
  | "skillView"
> & {
  kind: ImportKind;
}) {
  const noun = kind === "plugin" ? "plugin" : "skill";
  return (
    <>
      <CapabilityToolbar
        beginNew={beginNew}
        kind={kind}
        loading={loading}
        noun={noun}
        onBrowse={openSkillBrowser}
        onChange={handleQueryChange}
        onFileImport={openFilePicker}
        onFolderImport={openFolderPicker}
        query={query}
        showingEditor={showingEditor}
        title={title}
      />
      <div className="min-h-0 flex-1 overflow-y-auto">
        <CapabilityNotices error={error} notice={notice} onRetry={retryLoad} />
        <CapabilityEditors
          busy={busy}
          cancelPreview={cancelPreview}
          confirmPreview={confirmPreview}
          draft={draft}
          editingId={editingId}
          kind={kind}
          onCancel={closeEditor}
          onChange={onChange}
          onSave={saveDraft}
          preview={preview}
          selectedSkill={selectedSkill}
          setSelectedSkill={setSelectedSkill}
        />
        <CapabilityPanelList
          busy={busy}
          filtered={filtered}
          kind={kind}
          loading={loading}
          noun={noun}
          onEdit={beginEdit}
          query={query}
          remove={remove}
          removing={removing}
          showBuiltin={showBuiltin}
          showingEditor={showingEditor}
          title={title}
          toggle={toggle}
        />
      </div>
    </>
  );
}

function CapabilityToolbar({
  beginNew,
  kind,
  loading,
  onChange,
  onBrowse,
  onFileImport,
  onFolderImport,
  noun,
  query,
  showingEditor,
  title,
}: {
  beginNew: () => void;
  kind: ImportKind;
  loading: boolean;
  onChange: (event: ChangeEvent<HTMLInputElement>) => void;
  onBrowse: () => void;
  onFileImport: () => void;
  onFolderImport: () => void;
  noun: string;
  query: string;
  showingEditor: boolean;
  title: string;
}) {
  if (showingEditor) {
    return null;
  }
  const canCreate = kind === "skill";
  return (
    <div className="border-border shrink-0 border-b p-4 sm:px-6">
      <div className="flex items-center gap-3">
        <label className="relative min-w-0 flex-1">
          <span className="sr-only">Search {title.toLowerCase()}</span>
          <Search
            aria-hidden
            className="text-muted-foreground pointer-events-none absolute top-1/2 left-2.5 size-4 -translate-y-1/2"
          />
          <Input
            className="pl-8"
            onChange={onChange}
            placeholder={`Search ${title.toLowerCase()}`}
            value={query}
          />
        </label>
        {canCreate ? (
          <Menu.Root>
            <Menu.Trigger
              disabled={loading}
              render={<Button className="shrink-0" variant="outline" />}
            >
              <Plus aria-hidden /> Add {noun}{" "}
              <ChevronDown aria-hidden className="size-3.5" />
            </Menu.Trigger>
            <Menu.Portal>
              <Menu.Positioner align="end" className="z-50" sideOffset={6}>
                <Menu.Popup className="border-border bg-popover text-popover-foreground w-56 max-w-[calc(100vw-2rem)] border p-1 shadow-xl outline-none">
                  <Menu.Item className={addMenuItemClass} onClick={onBrowse}>
                    <Search aria-hidden /> Browse skills.sh
                  </Menu.Item>
                  <Menu.Item className={addMenuItemClass} onClick={beginNew}>
                    <FilePlus2 aria-hidden /> Create skill
                  </Menu.Item>
                  <Menu.Separator className="bg-border my-1 h-px" />
                  <Menu.Item
                    className={addMenuItemClass}
                    onClick={onFileImport}
                  >
                    <Upload aria-hidden /> Import SKILL.md
                  </Menu.Item>
                  <Menu.Item
                    className={addMenuItemClass}
                    onClick={onFolderImport}
                  >
                    <FolderOpen aria-hidden /> Import folder
                  </Menu.Item>
                  <p className="border-border text-muted-foreground border-t px-3 py-2 text-[11px]">
                    Text files · up to 512 KiB
                  </p>
                </Menu.Popup>
              </Menu.Positioner>
            </Menu.Portal>
          </Menu.Root>
        ) : (
          <Button
            className="shrink-0"
            disabled={loading}
            onClick={onFolderImport}
            variant="outline"
          >
            <Plus aria-hidden /> Add plugin
          </Button>
        )}
      </div>
      <p className="text-muted-foreground mt-3 text-xs">
        {canCreate
          ? "Reusable instructions available to every bot in this app."
          : "Skill packages imported from Claude or Codex and available to every bot."}
      </p>
    </div>
  );
}

function CapabilityNotices({
  error,
  notice,
  onRetry,
}: {
  error: string | null;
  notice: string | null;
  onRetry: () => void;
}) {
  return (
    <>
      {error ? (
        <div
          className="border-destructive/30 bg-destructive/10 mx-4 mt-4 flex items-start justify-between gap-3 border p-3 text-sm"
          role="alert"
        >
          <span>{error}</span>
          <Button onClick={onRetry} size="sm" variant="ghost">
            Retry
          </Button>
        </div>
      ) : null}
      {notice ? (
        <p
          className="text-muted-foreground mx-4 mt-4 flex items-center gap-2 text-sm"
          role="status"
        >
          <Check aria-hidden className="size-4 text-emerald-500" />
          {notice}
        </p>
      ) : null}
    </>
  );
}

function CapabilityEditors({
  busy,
  cancelPreview,
  confirmPreview,
  draft,
  editingId,
  kind,
  onChange,
  onCancel,
  onSave,
  preview,
  selectedSkill,
  setSelectedSkill,
}: {
  busy: Set<string>;
  cancelPreview: () => void;
  confirmPreview: () => void;
  draft: FormState | null;
  editingId: string | null;
  kind: ImportKind;
  onChange: (draft: FormState | null) => void;
  onCancel: () => void;
  onSave: () => void;
  preview: FormState | null;
  selectedSkill: number;
  setSelectedSkill: (index: number) => void;
}) {
  return (
    <>
      {preview ? (
        <ImportPreview
          busy={busy.has("new")}
          draft={preview}
          kind={kind}
          onCancel={cancelPreview}
          onConfirm={confirmPreview}
        />
      ) : null}
      {draft ? (
        <CapabilityEditor
          busy={busy.has(editingId ?? "new")}
          draft={draft}
          editing={Boolean(editingId)}
          kind={kind}
          onCancel={onCancel}
          onChange={onChange}
          onSave={onSave}
          selectedSkill={selectedSkill}
          setSelectedSkill={setSelectedSkill}
        />
      ) : null}
    </>
  );
}

function CapabilityPanelList({
  busy,
  filtered,
  kind,
  loading,
  noun,
  query,
  remove,
  removing,
  showBuiltin,
  showingEditor,
  title,
  toggle,
  onEdit,
}: {
  busy: Set<string>;
  filtered: Capability[];
  kind: ImportKind;
  loading: boolean;
  noun: string;
  query: string;
  remove: (capability: Capability) => void;
  removing: Set<string>;
  showBuiltin: boolean;
  showingEditor: boolean;
  title: string;
  toggle: (capability: Capability) => void;
  onEdit: (capability: Capability) => void;
}) {
  if (showingEditor) {
    return null;
  }
  if (loading) {
    return (
      <div
        className="text-muted-foreground flex items-center gap-2 p-6 text-sm"
        role="status"
      >
        <LoaderCircle aria-hidden className="size-4 animate-spin" /> Loading{" "}
        {title.toLowerCase()}…
      </div>
    );
  }
  const builtins = showBuiltin ? builtinSkillsMatching(query) : [];
  if (
    filtered.length === 0 &&
    builtins.length === 0 &&
    (kind !== "skill" || query.trim())
  ) {
    return <EmptyState noun={noun} query={query} title={title} />;
  }
  return (
    <ul aria-label={title} className="divide-border divide-y">
      {builtins.map((skill) => (
        <BuiltinSkillRow key={skill.name} {...skill} />
      ))}
      {filtered.map((capability) => (
        <CapabilityRow
          busy={busy.has(capability.id)}
          capability={capability}
          key={capability.id}
          onEdit={onEdit}
          onRemove={remove}
          onToggle={toggle}
          removing={removing.has(capability.id)}
        />
      ))}
    </ul>
  );
}

function EmptyState({
  title,
  noun,
  query,
}: {
  title: string;
  noun: string;
  query: string;
}) {
  return (
    <div className="flex flex-col items-center gap-3 px-8 py-16 text-center">
      <div className="border-border bg-accent/40 grid size-10 place-items-center border">
        <FileCode2 aria-hidden className="text-muted-foreground size-5" />
      </div>
      <p className="text-sm font-medium">
        {query
          ? `No ${title.toLowerCase()} match “${query}”.`
          : `No ${title.toLowerCase()} yet.`}
      </p>
      {query ? null : (
        <p className="text-muted-foreground max-w-xs text-sm leading-relaxed">
          Use “Add {noun}” to{" "}
          {noun === "plugin"
            ? "import a skill package from Claude or Codex."
            : "find, create or import reusable instructions."}
        </p>
      )}
    </div>
  );
}

function CapabilityRow({
  capability,
  busy,
  removing,
  onToggle,
  onEdit,
  onRemove,
}: {
  capability: Capability;
  busy: boolean;
  removing: boolean;
  onToggle: (capability: Capability) => void;
  onEdit: (capability: Capability) => void;
  onRemove: (capability: Capability) => void;
}) {
  const handleToggle = useCallback(
    () => onToggle(capability),
    [capability, onToggle]
  );
  const handleEdit = useCallback(
    () => onEdit(capability),
    [capability, onEdit]
  );
  const handleRemove = useCallback(
    () => onRemove(capability),
    [capability, onRemove]
  );
  const registryOrigin =
    capability.kind === "skill" && capability.origin?.registry === "skills.sh"
      ? capability.origin
      : null;
  const displayName = registryOrigin
    ? capability.skills[0]?.name || capability.name
    : capability.name;
  const publisher = registryOrigin?.id.split("/")[0];
  return (
    <li className="flex items-start gap-3 p-4">
      <div className="border-border bg-accent/40 grid size-9 shrink-0 place-items-center border">
        {capability.kind === "plugin" ? (
          <PlugZap aria-hidden className="text-muted-foreground size-4" />
        ) : (
          <Layers3 aria-hidden className="text-muted-foreground size-4" />
        )}
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate text-sm font-medium">{displayName}</h3>
              {registryOrigin?.modified ? (
                <span className="shrink-0 border border-amber-500/30 px-2 py-0.5 text-[11px] text-amber-500">
                  Modified locally
                </span>
              ) : null}
            </div>
            <p className="text-muted-foreground mt-0.5 text-[13px] leading-snug">
              {capability.description}
            </p>
            {publisher ? (
              <p className="text-muted-foreground mt-1 text-xs">
                From {publisher} · skills.sh
              </p>
            ) : null}
          </div>
          <span className="text-muted-foreground shrink-0 text-xs">
            {capability.skills.length}{" "}
            {capability.skills.length === 1 ? "skill" : "skills"}
          </span>
        </div>
        <div className="mt-3 flex items-center gap-2">
          <button
            aria-checked={capability.enabled}
            className={cn(
              "relative inline-flex h-5 w-9 shrink-0 border transition-colors",
              capability.enabled
                ? "border-foreground bg-foreground"
                : "border-input bg-transparent"
            )}
            disabled={busy}
            onClick={handleToggle}
            role="switch"
            type="button"
          >
            <span
              className={cn(
                "absolute top-0.5 size-3.5 transition-transform",
                capability.enabled
                  ? "bg-background translate-x-[17px]"
                  : "bg-muted-foreground translate-x-0.5"
              )}
            />
            <span className="sr-only">
              {capability.enabled ? "Disable" : "Enable"} {displayName}
            </span>
          </button>
          <span className="text-muted-foreground text-xs">
            {capability.enabled ? "Enabled" : "Disabled"}
          </span>
          <Button
            disabled={busy}
            onClick={handleEdit}
            size="sm"
            variant="ghost"
          >
            <Pencil aria-hidden /> Edit
          </Button>
          <Button
            className={cn(
              "ml-auto",
              removing ? "text-destructive" : "text-muted-foreground"
            )}
            disabled={busy}
            onClick={handleRemove}
            size="sm"
            variant="ghost"
          >
            {removing ? (
              "Remove for good?"
            ) : (
              <>
                <Trash2 aria-hidden /> Remove
              </>
            )}
          </Button>
        </div>
      </div>
    </li>
  );
}

// The skills every bot ships with (templates/bot/agent/skills/<name>/SKILL.md).
const BUILTIN_SKILLS = [
  {
    description: "Find and recommend skills from the skills.sh catalog.",
    name: "find-skills",
  },
  {
    description: "Write and send messages as you, in your own voice.",
    name: "send-on-behalf",
  },
  {
    description: "Logins, codes and private details through a secure form.",
    name: "sign-in",
  },
  {
    description: "Buy, book and pay only after your explicit yes.",
    name: "purchases",
  },
  {
    description: "Reach services that have no connected app.",
    name: "no-connector-fallback",
  },
  { description: "Create and change recurring routines.", name: "routines" },
  {
    description: "Turn a finished workflow into a reusable skill.",
    name: "skill-authoring",
  },
  {
    description: "Guide you around Busy without inventing menus.",
    name: "busy-app-ui",
  },
  {
    description: "Diagnose the bot's computer when it misbehaves.",
    name: "computer-troubleshooting",
  },
  {
    description: "Learn a task from a demonstration you record.",
    name: "learn-from-demonstration",
  },
] as const;

function builtinSkillsMatching(query: string) {
  const needle = query.trim().toLocaleLowerCase();
  return BUILTIN_SKILLS.filter(
    (skill) =>
      !needle ||
      skill.name.includes(needle) ||
      skill.description.toLocaleLowerCase().includes(needle)
  );
}

function BuiltinSkillRow({
  name,
  description,
}: {
  name: string;
  description: string;
}) {
  return (
    <li className="border-border flex items-start gap-3 border-b p-4">
      <div className="border-border bg-accent/40 grid size-9 shrink-0 place-items-center border">
        <BookOpen aria-hidden className="text-muted-foreground size-4" />
      </div>
      <div className="min-w-0 flex-1">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <h3 className="truncate text-sm font-medium">{name}</h3>
            <p className="text-muted-foreground mt-0.5 text-[13px] leading-snug">
              {description}
            </p>
          </div>
          <span className="border-border text-muted-foreground shrink-0 border px-2 py-0.5 text-xs">
            Included
          </span>
        </div>
        <p className="text-muted-foreground mt-2 text-xs">
          Available to this bot by default. It stays enabled and cannot be
          removed.
        </p>
      </div>
    </li>
  );
}

function ImportPreview({
  draft,
  kind,
  busy,
  onCancel,
  onConfirm,
}: {
  draft: FormState;
  kind: ImportKind;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const [selected, setSelected] = useState(0);
  const skill = draft.skills[selected] ?? draft.skills[0];
  if (!skill) {
    return null;
  }
  return (
    <section
      aria-label="Import preview"
      className="border-border bg-accent/20 m-4 border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            Review import
          </p>
          <h3 className="mt-1 text-sm font-medium">{draft.name}</h3>
          <p className="text-muted-foreground mt-1 text-sm">
            {draft.description}
          </p>
        </div>
        <Button
          aria-label="Cancel import"
          onClick={onCancel}
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="text-muted-foreground mt-4 grid grid-cols-2 gap-2 text-xs">
        <span>{kind === "plugin" ? "Plugin" : "Skill"}</span>
        <span className="text-right">
          {draft.skills.length} {draft.skills.length === 1 ? "skill" : "skills"}
          {draft.version ? ` · v${draft.version}` : ""}
        </span>
      </div>
      <div className="border-border mt-3 border-t pt-3">
        <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
          Included skills
        </p>
        <div className="mt-2 flex flex-wrap gap-1">
          {draft.skills.map((item, index) => (
            <SkillTab
              active={selected === index}
              index={index}
              key={skillKey(item)}
              label={item.name}
              onSelect={setSelected}
            />
          ))}
        </div>
        <div className="border-border bg-background/40 mt-3 border p-3">
          <div className="flex items-center justify-between gap-3">
            <h4 className="text-sm font-medium">{skill.name}</h4>
            <span className="text-muted-foreground text-xs">
              {Object.keys(skill.files).length} supporting files
            </span>
          </div>
          <p className="text-muted-foreground mt-1 text-xs">
            {skill.description}
          </p>
          <pre className="text-foreground/80 mt-3 max-h-44 overflow-auto text-xs leading-relaxed whitespace-pre-wrap">
            {skill.content}
          </pre>
          {Object.keys(skill.files).length ? (
            <div className="border-border mt-3 border-t pt-2">
              <p className="text-muted-foreground text-xs font-medium">
                Supporting files
              </p>
              <ul className="text-muted-foreground mt-1 space-y-1 text-xs">
                {Object.entries(skill.files).map(([path, content]) => (
                  <li key={path}>
                    <details>
                      <summary className="hover:text-foreground cursor-pointer truncate">
                        {path}
                      </summary>
                      <pre className="bg-background/50 text-foreground/70 mt-1 max-h-28 overflow-auto p-2 text-[11px] leading-relaxed whitespace-pre-wrap">
                        {content}
                      </pre>
                    </details>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </div>
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" variant="outline">
          Cancel
        </Button>
        <Button disabled={busy} onClick={onConfirm} size="sm">
          {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          {busy ? "Adding…" : `Add ${kind}`}
        </Button>
      </div>
    </section>
  );
}

function SkillTab({
  active,
  index,
  label,
  onSelect,
}: {
  active: boolean;
  index: number;
  label: string;
  onSelect: (index: number) => void;
}) {
  const handleSelect = useCallback(() => onSelect(index), [index, onSelect]);
  return (
    <button
      className={cn(
        "px-2 py-1 text-xs transition-colors",
        active
          ? "bg-foreground text-background"
          : "bg-accent text-muted-foreground hover:text-foreground"
      )}
      onClick={handleSelect}
      type="button"
    >
      {label}
    </button>
  );
}

function CapabilityEditor({
  draft,
  kind,
  editing,
  selectedSkill,
  setSelectedSkill,
  onChange,
  onCancel,
  onSave,
  busy,
}: {
  draft: FormState;
  kind: ImportKind;
  editing: boolean;
  selectedSkill: number;
  setSelectedSkill: (index: number) => void;
  onChange: (draft: FormState) => void;
  onCancel: () => void;
  onSave: () => void;
  busy: boolean;
}) {
  const id = useId();
  const nameId = `${id}-capability-name`;
  const descriptionId = `${id}-capability-description`;
  const skillNameId = `${id}-skill-name`;
  const skillDescriptionId = `${id}-skill-description`;
  const contentId = `${id}-skill-content`;
  const skill = draft.skills[selectedSkill] ?? draft.skills[0];
  const standalone = kind === "skill";

  const update = useCallback(
    (patch: Partial<CapabilitySkill>) =>
      onChange({
        ...draft,
        skills: draft.skills.map((item, index) =>
          index === selectedSkill ? { ...item, ...patch } : item
        ),
      }),
    [draft, onChange, selectedSkill]
  );
  const updateCapabilityName = useCallback(
    (name: string) =>
      onChange({
        ...draft,
        name,
        skills: draft.skills.map((item, index) =>
          index === 0 ? { ...item, name } : item
        ),
      }),
    [draft, onChange]
  );
  const updateCapabilityDescription = useCallback(
    (description: string) =>
      onChange({
        ...draft,
        description,
        skills: draft.skills.map((item, index) =>
          index === 0 ? { ...item, description } : item
        ),
      }),
    [draft, onChange]
  );
  const handleNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      if (standalone) {
        updateCapabilityName(value);
      } else {
        onChange({ ...draft, name: value });
      }
    },
    [draft, onChange, standalone, updateCapabilityName]
  );
  const handleDescriptionChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      const { value } = event.target;
      if (standalone) {
        updateCapabilityDescription(value);
      } else {
        onChange({ ...draft, description: value });
      }
    },
    [draft, onChange, standalone, updateCapabilityDescription]
  );
  const handleSelectedSkillChange = useCallback(
    (event: ChangeEvent<HTMLSelectElement>) => {
      setSelectedSkill(Number(event.target.value));
    },
    [setSelectedSkill]
  );
  const handleSkillNameChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      update({ name: event.target.value });
    },
    [update]
  );
  const handleSkillDescriptionChange = useCallback(
    (event: ChangeEvent<HTMLInputElement>) => {
      update({ description: event.target.value });
    },
    [update]
  );
  const handleContentChange = useCallback(
    (event: ChangeEvent<HTMLTextAreaElement>) => {
      update({ content: event.target.value });
    },
    [update]
  );

  if (!skill) {
    return null;
  }

  let saveLabel = "Save changes";
  if (busy) {
    saveLabel = "Saving…";
  } else if (!editing) {
    saveLabel = `Add ${kind}`;
  }

  return (
    <section
      aria-label={editing ? "Edit capability" : "Add capability"}
      className="border-border bg-accent/20 m-4 border p-4"
    >
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-muted-foreground text-xs font-medium tracking-wide uppercase">
            {editing ? "Edit" : "Add"} {kind}
          </p>
          <h3 className="mt-1 text-sm font-medium">
            {editing
              ? "Keep the procedure current"
              : "Define a reusable procedure"}
          </h3>
        </div>
        <Button
          aria-label="Close editor"
          onClick={onCancel}
          size="icon-sm"
          variant="ghost"
        >
          <X aria-hidden />
        </Button>
      </div>
      <div className="mt-4 grid gap-4">
        <div className="grid gap-2">
          <Label htmlFor={nameId}>Name</Label>
          <Input
            id={nameId}
            maxLength={64}
            onChange={handleNameChange}
            placeholder={
              kind === "plugin" ? "contract-review" : "review-contract"
            }
            value={standalone ? skill.name : draft.name}
          />
        </div>
        <div className="grid gap-2">
          <Label htmlFor={descriptionId}>Description</Label>
          <Input
            id={descriptionId}
            maxLength={2000}
            onChange={handleDescriptionChange}
            placeholder="When should the bot use this?"
            value={draft.description}
          />
        </div>
        {!standalone && draft.skills.length > 1 ? (
          <label className="grid gap-2 text-sm">
            <span className="font-medium">Skill</span>
            <span className="relative">
              <select
                className="border-input h-9 w-full appearance-none border bg-transparent px-3 pr-8 text-sm outline-none"
                onChange={handleSelectedSkillChange}
                value={selectedSkill}
              >
                {draft.skills.map((item, index) => (
                  <option key={skillKey(item)} value={index}>
                    {item.name || `Skill ${index + 1}`}
                  </option>
                ))}
              </select>
              <ChevronDown
                aria-hidden
                className="text-muted-foreground pointer-events-none absolute top-1/2 right-2.5 size-4 -translate-y-1/2"
              />
            </span>
          </label>
        ) : null}
        {standalone ? null : (
          <>
            <div className="grid gap-2">
              <Label htmlFor={skillNameId}>Skill name</Label>
              <Input
                id={skillNameId}
                maxLength={64}
                onChange={handleSkillNameChange}
                placeholder="review"
                value={skill.name}
              />
            </div>
            <div className="grid gap-2">
              <Label htmlFor={skillDescriptionId}>When to use it</Label>
              <Input
                id={skillDescriptionId}
                maxLength={2000}
                onChange={handleSkillDescriptionChange}
                placeholder="Use when reviewing a contract"
                value={skill.description}
              />
            </div>
          </>
        )}
        <div className="grid gap-2">
          <Label htmlFor={contentId}>Instructions</Label>
          <Textarea
            className="min-h-36"
            id={contentId}
            onChange={handleContentChange}
            placeholder="Write the procedure the bot should follow…"
            value={skill.content}
          />
        </div>
        {Object.keys(skill.files).length ? (
          <p className="text-muted-foreground text-xs">
            {Object.keys(skill.files).length} supporting files preserved from
            the import.
          </p>
        ) : null}
      </div>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel} size="sm" variant="outline">
          Cancel
        </Button>
        <Button disabled={busy} onClick={onSave} size="sm">
          {busy ? <LoaderCircle aria-hidden className="animate-spin" /> : null}
          {saveLabel}
        </Button>
      </div>
    </section>
  );
}
