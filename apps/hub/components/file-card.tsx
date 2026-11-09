import { Download, FileText } from "lucide-react";
import Image from "next/image";
import type { ReactNode } from "react";
import { PdfPreview } from "@/components/pdf-preview";

const size = (bytes: number) =>
  bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toLocaleString("en-US", { maximumFractionDigits: 1 })} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

/** Images, PDF and video preview in place; everything else downloads (spec 2). */
export function FileCard({
  fileId,
  name,
  contentType,
  size: bytes,
}: {
  fileId: string;
  name: string;
  contentType: string;
  size: number;
}) {
  const src = `/api/files/${fileId}`;
  let preview: ReactNode = null;
  if (contentType.startsWith("image/")) {
    preview = (
      <Image
        alt={name}
        className="h-auto max-h-96 w-full bg-black object-contain"
        decoding="async"
        height={384}
        loading="lazy"
        src={src}
        unoptimized
        width={448}
      />
    );
  } else if (contentType === "application/pdf") {
    preview = <PdfPreview name={name} src={src} />;
  } else if (contentType.startsWith("video/")) {
    preview = <VideoPreview src={src} />;
  }

  return (
    <figure className="border-border w-full max-w-md overflow-hidden rounded-lg border">
      {preview}
      <figcaption className="flex items-center gap-3 px-3 py-2.5">
        <FileText
          aria-hidden="true"
          className="text-muted-foreground size-4 shrink-0"
        />
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm">{name}</span>
          <span className="text-muted-foreground block text-[13px] tabular-nums">
            {size(bytes)}
          </span>
        </span>
        <a
          className="text-muted-foreground hover:bg-accent hover:text-foreground flex items-center gap-1.5 rounded-md px-2 py-1 text-[13px] transition-colors"
          download={name}
          href={`${src}?download`}
        >
          <Download aria-hidden="true" className="size-3.5" />
          Download
        </a>
      </figcaption>
    </figure>
  );
}

function VideoPreview({ src }: { src: string }) {
  return (
    <>
      {/* biome-ignore lint/a11y/useMediaCaption: the file API exposes no caption track to attach */}
      <video
        className="max-h-96 w-full bg-black"
        controls
        preload="metadata"
        src={src}
      />
    </>
  );
}
