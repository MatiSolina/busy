import { and, desc, eq, ilike, lt, not, or, type SQL, sql } from "drizzle-orm";
import { bots, db, files } from "@/lib/db";
import {
  LIBRARY_FILE_CATEGORIES,
  type LibraryFile,
  type LibraryFileCategory,
  type LibraryFileSource,
  type LibraryResponse,
} from "./library-types";

export const DEFAULT_LIBRARY_PAGE_SIZE = 48;
export const MAX_LIBRARY_PAGE_SIZE = 100;

export interface LibraryQuery {
  botSlug: string | null;
  category: LibraryFileCategory | null;
  cursor: LibraryCursor | null;
  limit: number;
  search: string | null;
  /** Undefined keeps the historical generated-files default; null means all sources. */
  source?: LibraryFileSource | null;
}

export interface LibraryCursor {
  createdAt: string;
  id: string;
}

interface LibraryRow {
  botAvatar: string | null;
  botName: string;
  botSlug: string;
  contentType: string;
  createdAt: Date;
  /** Exact database timestamp used only for cursor comparison. */
  cursorCreatedAt?: string;
  id: string;
  name: string;
  size: number;
  source: string;
  status: string;
  version: number;
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;
// biome-ignore lint/style/useNamedCaptureGroup: Cursor timestamps use stable numeric captures in an ES2017 build.
const TIMESTAMP = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})\.(\d{3}|\d{6})Z$/u;
const POSITIVE_INTEGER = /^[0-9]+$/u;

function validDate(value: string): boolean {
  const match = TIMESTAMP.exec(value);
  if (!match) {
    return false;
  }
  const milliseconds = match[2].slice(0, 3);
  const date = new Date(`${match[1]}.${milliseconds}Z`);
  return (
    !Number.isNaN(date.getTime()) &&
    date.toISOString() === `${match[1]}.${milliseconds}Z`
  );
}

function validCursor(value: unknown): value is LibraryCursor {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { createdAt?: unknown }).createdAt === "string" &&
    validDate((value as { createdAt: string }).createdAt) &&
    typeof (value as { id?: unknown }).id === "string" &&
    UUID.test((value as { id: string }).id)
  );
}

export function encodeLibraryCursor(cursor: LibraryCursor): string {
  return Buffer.from(JSON.stringify(cursor), "utf8").toString("base64url");
}

export function decodeLibraryCursor(
  value: string | null
): LibraryCursor | null {
  if (!value || value.length > 256) {
    return null;
  }
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8")
    );
    return validCursor(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function positiveInt(value: string | null): number | null {
  if (!(value && POSITIVE_INTEGER.test(value))) {
    return null;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function parseSource(value: string): LibraryFileSource | null | undefined {
  if (value === "all") {
    return null;
  }
  if (value === "bot" || value === "user") {
    return value;
  }
  return value ? undefined : "bot";
}

/** Parse the browser's query string. Invalid optional values fail closed. */
export function parseLibraryQuery(
  params: URLSearchParams
): LibraryQuery | null {
  const requestedLimit = params.get("limit");
  const parsedLimit =
    requestedLimit === null
      ? DEFAULT_LIBRARY_PAGE_SIZE
      : positiveInt(requestedLimit);
  if (parsedLimit === null) {
    return null;
  }

  const cursorValue = params.get("cursor");
  const cursor = cursorValue ? decodeLibraryCursor(cursorValue) : null;
  if (cursorValue && !cursor) {
    return null;
  }

  const search = (params.get("q") ?? "").trim();
  const botSlug = (params.get("bot") ?? "").trim();
  const categoryValue = (params.get("type") ?? "").trim();
  const sourceValue = (params.get("source") ?? "bot").trim();
  let category: LibraryFileCategory | null = null;
  if (
    categoryValue &&
    LIBRARY_FILE_CATEGORIES.includes(categoryValue as LibraryFileCategory)
  ) {
    category = categoryValue as LibraryFileCategory;
  }
  if (categoryValue && !category) {
    return null;
  }
  const source = parseSource(sourceValue);
  if (source === undefined) {
    return null;
  }
  if (search.length > 200 || botSlug.length > 80) {
    return null;
  }

  return {
    botSlug: botSlug || null,
    category,
    cursor,
    limit: Math.min(parsedLimit, MAX_LIBRARY_PAGE_SIZE),
    search: search || null,
    source,
  };
}

// Escape LIKE metacharacters so search means a literal substring, not a pattern supplied by a user.
const likePattern = (value: string) =>
  `%${value.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;

function requireSql(value: SQL | undefined): SQL {
  if (!value) {
    throw new Error("Expected a non-empty SQL predicate");
  }
  return value;
}

const categorySql = (category: LibraryFileCategory) => {
  switch (category) {
    case "image":
      return ilike(files.contentType, "image/%");
    case "video":
      return ilike(files.contentType, "video/%");
    case "audio":
      return ilike(files.contentType, "audio/%");
    case "spreadsheet":
      return requireSql(
        or(
          ilike(files.contentType, "text/csv"),
          ilike(files.contentType, "text/tab-separated-values"),
          ilike(files.contentType, "application/vnd.ms-excel"),
          ilike(
            files.contentType,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          ),
          ilike(
            files.contentType,
            "application/vnd.oasis.opendocument.spreadsheet"
          )
        )
      );
    case "presentation":
      return requireSql(
        or(
          ilike(files.contentType, "application/vnd.ms-powerpoint"),
          ilike(
            files.contentType,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          ),
          ilike(
            files.contentType,
            "application/vnd.oasis.opendocument.presentation"
          )
        )
      );
    case "document":
      return requireSql(
        or(
          and(
            not(ilike(files.contentType, "text/csv")),
            not(ilike(files.contentType, "text/tab-separated-values")),
            ilike(files.contentType, "text/%")
          ),
          ilike(files.contentType, "application/pdf"),
          ilike(files.contentType, "application/msword"),
          ilike(
            files.contentType,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          ),
          ilike(files.contentType, "application/rtf"),
          ilike(files.contentType, "application/vnd.oasis.opendocument.text")
        )
      );
    case "other":
      return and(
        not(ilike(files.contentType, "text/%")),
        not(ilike(files.contentType, "image/%")),
        not(ilike(files.contentType, "video/%")),
        not(ilike(files.contentType, "audio/%")),
        not(ilike(files.contentType, "application/pdf")),
        not(ilike(files.contentType, "application/msword")),
        not(
          ilike(
            files.contentType,
            "application/vnd.openxmlformats-officedocument.wordprocessingml.document"
          )
        ),
        not(ilike(files.contentType, "application/rtf")),
        not(
          ilike(files.contentType, "application/vnd.oasis.opendocument.text")
        ),
        not(ilike(files.contentType, "text/csv")),
        not(ilike(files.contentType, "text/tab-separated-values")),
        not(ilike(files.contentType, "application/vnd.ms-excel")),
        not(
          ilike(
            files.contentType,
            "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"
          )
        ),
        not(
          ilike(
            files.contentType,
            "application/vnd.oasis.opendocument.spreadsheet"
          )
        ),
        not(ilike(files.contentType, "application/vnd.ms-powerpoint")),
        not(
          ilike(
            files.contentType,
            "application/vnd.openxmlformats-officedocument.presentationml.presentation"
          )
        ),
        not(
          ilike(
            files.contentType,
            "application/vnd.oasis.opendocument.presentation"
          )
        )
      );
    default:
      throw new Error(`unknown library category: ${category}`);
  }
};

function whereFor(query: LibraryQuery) {
  const conditions = [eq(files.status, "ready")];
  const source = query.source === undefined ? "bot" : query.source;
  if (source) {
    conditions.push(eq(files.source, source));
  }
  if (query.botSlug) {
    conditions.push(eq(bots.slug, query.botSlug));
  }
  if (query.category) {
    conditions.push(requireSql(categorySql(query.category)));
  }
  if (query.search) {
    conditions.push(
      requireSql(
        or(
          ilike(files.name, likePattern(query.search)),
          ilike(bots.name, likePattern(query.search)),
          ilike(bots.slug, likePattern(query.search))
        )
      )
    );
  }
  if (query.cursor) {
    // Keep the cursor as a bound timestamptz expression instead of converting it to a JS Date;
    // JavaScript Date and JSON only retain milliseconds while Postgres stores microseconds.
    const at = sql`${query.cursor.createdAt}::timestamptz`;
    // The id tie-breaker makes adjacent pages deterministic when several files share a timestamp.
    conditions.push(
      requireSql(
        or(
          lt(files.createdAt, at),
          and(eq(files.createdAt, at), lt(files.id, query.cursor.id))
        )
      )
    );
  }
  return and(...conditions);
}

export function projectLibraryRow(
  row: LibraryRow,
  includeUser = false
): LibraryFile | null {
  // Keep this guard in addition to the SQL predicates: a future query refactor cannot accidentally
  // expose pending uploads or files the bot did not generate.
  if (row.status !== "ready" || (row.source === "user" && !includeUser)) {
    return null;
  }
  return {
    bot: { avatar: row.botAvatar, name: row.botName, slug: row.botSlug },
    contentType: row.contentType,
    createdAt: row.createdAt.toISOString(),
    id: row.id,
    name: row.name,
    size: row.size,
    ...(row.source === "user" ? { source: "user" as const } : {}),
    version: row.version,
  };
}

/** List generated files without returning Blob paths or signed URLs. */
export async function listLibraryFiles(
  query: LibraryQuery
): Promise<LibraryResponse> {
  const rows = await db()
    .select({
      botAvatar: bots.avatar,
      botName: bots.name,
      botSlug: bots.slug,
      contentType: files.contentType,
      createdAt: files.createdAt,
      cursorCreatedAt: sql<string>`to_char(${files.createdAt} AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      id: files.id,
      name: files.name,
      size: files.size,
      source: files.source,
      status: files.status,
      version: files.version,
    })
    .from(files)
    .innerJoin(bots, eq(files.botId, bots.id))
    .where(whereFor(query))
    .orderBy(desc(files.createdAt), desc(files.id))
    .limit(query.limit + 1);

  const projected = rows.flatMap((row) => {
    const item = projectLibraryRow(
      row,
      query.source === null || query.source === "user"
    );
    if (!item) {
      return [];
    }
    return [
      {
        cursorCreatedAt: row.cursorCreatedAt ?? row.createdAt.toISOString(),
        item,
      },
    ];
  });
  const hasMore = projected.length > query.limit;
  const page = hasMore ? projected.slice(0, query.limit) : projected;
  const last = page.at(-1);
  return {
    files: page.map(({ item }) => item),
    nextCursor:
      hasMore && last
        ? encodeLibraryCursor({
            createdAt: last.cursorCreatedAt,
            id: last.item.id,
          })
        : null,
  };
}
