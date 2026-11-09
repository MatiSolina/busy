"use client";

import { useEffect, useRef, useState } from "react";

/**
 * The first page of a PDF, drawn with pdf.js. Not an <iframe>: Blob serves files as attachments, so
 * an iframe stays blank and iOS offers to download the PDF every time the chat renders. Drawn only
 * once it scrolls into view; tapping it opens the whole PDF.
 */
export function PdfPreview({ src, name }: { src: string; name: string }) {
  const box = useRef<HTMLAnchorElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [state, setState] = useState<"waiting" | "ready" | "error">("waiting");

  useEffect(() => {
    let live = true;
    const draw = async () => {
      const pdfjs = await import("pdfjs-dist");
      pdfjs.GlobalWorkerOptions.workerSrc = new URL(
        "pdfjs-dist/build/pdf.worker.min.mjs",
        import.meta.url
      ).toString();
      const task = pdfjs.getDocument({ url: src });
      const doc = await task.promise;
      const page = await doc.getPage(1);
      const target = canvas.current;
      if (!(live && target)) {
        return;
      }
      const width = target.clientWidth || 448;
      const viewport = page.getViewport({
        scale:
          (width * (window.devicePixelRatio || 1)) /
          page.getViewport({ scale: 1 }).width,
      });
      target.width = Math.floor(viewport.width);
      target.height = Math.floor(viewport.height);
      await page.render({ canvas: target, viewport }).promise;
      task.destroy();
      if (live) {
        setState("ready");
      }
    };
    const seen = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) {
        return;
      }
      seen.disconnect();
      draw().catch(() => live && setState("error"));
    });
    if (box.current) {
      seen.observe(box.current);
    }
    return () => {
      live = false;
      seen.disconnect();
    };
  }, [src]);

  if (state === "error") {
    return null;
  }
  return (
    <a
      aria-label={`Open ${name}`}
      className="block bg-white"
      href={src}
      ref={box}
      rel="noreferrer"
      target="_blank"
    >
      <canvas
        aria-label={`Preview of ${name}`}
        className={
          state === "ready" ? "block h-auto w-full" : "block h-0 w-full"
        }
        ref={canvas}
      />
      {state === "waiting" ? (
        <span className="bg-muted block aspect-[1/1.414] w-full animate-pulse" />
      ) : null}
    </a>
  );
}
