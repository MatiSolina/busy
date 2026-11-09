"use client";

import {
  createContext,
  type ReactNode,
  use,
  useCallback,
  useRef,
  useState,
} from "react";
import type { Section } from "@/lib/sections/types";

interface SectionsContextValue {
  busy: boolean;
  createSection: (name: string) => Promise<Section>;
  deleteSection: (id: string) => Promise<void>;
  forgetBot: (slug: string) => void;
  moveBot: (slug: string, sectionId: string | null) => Promise<void>;
  renameSection: (id: string, name: string) => Promise<void>;
  sections: Section[];
}

const SectionsContext = createContext<SectionsContextValue | null>(null);

interface SectionResponse {
  error?: string;
  section?: Section;
}

async function responseError(
  response: Response,
  fallback: string
): Promise<Error> {
  const body = (await response
    .json()
    .catch(() => null)) as SectionResponse | null;
  return new Error(typeof body?.error === "string" ? body.error : fallback);
}

async function jsonRequest<T>(
  url: string,
  init: RequestInit,
  fallback: string
): Promise<T> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, cache: "no-store" });
  } catch (error) {
    throw new Error(fallback, { cause: error });
  }
  if (!response.ok) {
    throw await responseError(response, fallback);
  }
  return (await response.json()) as T;
}

function sectionFromResponse(body: SectionResponse, fallback: string): Section {
  const { section } = body;
  if (
    !section ||
    typeof section.id !== "string" ||
    typeof section.name !== "string" ||
    !Array.isArray(section.botSlugs)
  ) {
    throw new Error(fallback);
  }
  return section;
}

function isOkResponse(body: { ok?: boolean }, fallback: string): void {
  if (body.ok !== true) {
    throw new Error(fallback);
  }
}

function isWriteBusy(ref: { current: boolean }): boolean {
  return ref.current;
}

function withoutBot(sections: Section[], slug: string): Section[] {
  return sections.map((section) => ({
    ...section,
    botSlugs: section.botSlugs.filter((botSlug) => botSlug !== slug),
  }));
}

/**
 * Sections are shared by the desktop and mobile sidebars. A second write is rejected while one
 * is in flight, so a stale response cannot apply over a newer local change.
 */
export function SectionsProvider({
  children,
  initial,
}: {
  children: ReactNode;
  initial?: Section[];
}) {
  const [sections, setSections] = useState<Section[]>(() => initial ?? []);
  const [busy, setBusy] = useState(false);
  const writeBusy = useRef(false);
  const moveRollback = useRef<Section[] | null>(null);

  const enqueue = useCallback(
    async <T,>(work: () => Promise<T>): Promise<T> => {
      if (isWriteBusy(writeBusy)) {
        return Promise.reject(
          new Error("Another section update is in progress.")
        );
      }
      writeBusy.current = true;
      setBusy(true);
      try {
        return await work();
      } finally {
        writeBusy.current = false;
        setBusy(false);
      }
    },
    []
  );

  const createSection = useCallback(
    (name: string) =>
      enqueue(async () => {
        const body = await jsonRequest<SectionResponse>(
          "/api/sections",
          {
            body: JSON.stringify({ name }),
            headers: { "content-type": "application/json" },
            method: "POST",
          },
          "Couldn't create section."
        );
        const section = sectionFromResponse(body, "Couldn't create section.");
        setSections((current) =>
          current.some((item) => item.id === section.id)
            ? current
            : [...current, section]
        );
        return section;
      }),
    [enqueue]
  );

  const renameSection = useCallback(
    (id: string, name: string) =>
      enqueue(async () => {
        const body = await jsonRequest<SectionResponse>(
          `/api/sections/${encodeURIComponent(id)}`,
          {
            body: JSON.stringify({ name }),
            headers: { "content-type": "application/json" },
            method: "PATCH",
          },
          "Couldn't rename section."
        );
        const section = sectionFromResponse(body, "Couldn't rename section.");
        setSections((current) =>
          current.map((item) => (item.id === id ? section : item))
        );
      }),
    [enqueue]
  );

  const deleteSection = useCallback(
    (id: string) =>
      enqueue(async () => {
        const body = await jsonRequest<{ ok?: boolean }>(
          `/api/sections/${encodeURIComponent(id)}`,
          { method: "DELETE" },
          "Couldn't delete section."
        );
        isOkResponse(body, "Couldn't delete section.");
        setSections((current) =>
          current.filter((section) => section.id !== id)
        );
      }),
    [enqueue]
  );

  const moveBot = useCallback(
    (slug: string, sectionId: string | null) =>
      enqueue(async () => {
        moveRollback.current = sections;
        setSections((current) => {
          const next = withoutBot(current, slug);
          if (!sectionId) {
            return next;
          }
          return next.map((section) =>
            section.id === sectionId && !section.botSlugs.includes(slug)
              ? { ...section, botSlugs: [...section.botSlugs, slug] }
              : section
          );
        });
        try {
          const body = await jsonRequest<{ ok?: boolean }>(
            `/api/bots/${encodeURIComponent(slug)}/section`,
            {
              body: JSON.stringify({ sectionId }),
              headers: { "content-type": "application/json" },
              method: "PUT",
            },
            "Couldn't update the bot's section."
          );
          isOkResponse(body, "Couldn't update the bot's section.");
        } catch (error) {
          if (moveRollback.current) {
            setSections(moveRollback.current);
          }
          throw error;
        } finally {
          moveRollback.current = null;
        }
      }),
    [enqueue, sections]
  );

  const forgetBot = useCallback((slug: string) => {
    // A failed move must not restore memberships for bots deleted while saving.
    if (moveRollback.current) {
      moveRollback.current = withoutBot(moveRollback.current, slug);
    }
    setSections((current) => withoutBot(current, slug));
  }, []);

  return (
    <SectionsContext
      value={{
        busy,
        createSection,
        deleteSection,
        forgetBot,
        moveBot,
        renameSection,
        sections,
      }}
    >
      {children}
    </SectionsContext>
  );
}

export function useSections(): SectionsContextValue {
  const context = use(SectionsContext);
  if (!context) {
    throw new Error("SectionsProvider is missing");
  }
  return context;
}
