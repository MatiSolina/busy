// ponytail: the formats the MVP produces; anything else downloads as octet-stream.
// A Map, not an object literal: a name like `x.constructor` must not reach Object.prototype.
const TYPES = new Map(
  Object.entries({
    csv: "text/csv",
    docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    gif: "image/gif",
    html: "text/html",
    jpeg: "image/jpeg",
    jpg: "image/jpeg",
    json: "application/json",
    md: "text/markdown",
    mov: "video/quicktime",
    mp4: "video/mp4",
    pdf: "application/pdf",
    png: "image/png",
    pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    svg: "image/svg+xml",
    txt: "text/plain",
    webm: "video/webm",
    webp: "image/webp",
    xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  })
);

export function contentTypeOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return (
    (dot >= 0 && TYPES.get(name.slice(dot + 1).toLowerCase())) ||
    "application/octet-stream"
  );
}
