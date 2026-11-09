"use client";

import { useEffect, useRef } from "react";
import { PixHead } from "@/components/bot-avatar";
import { BUSY_GLOW } from "@/components/busy-mark";

export function LoginAvatar() {
  const eyesRef = useRef<SVGGElement>(null);

  useEffect(() => {
    const eyes = eyesRef.current;
    const avatar = eyes?.ownerSVGElement;
    if (!(eyes && avatar)) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame: number | null = null;
    let pointer = { x: 0, y: 0 };

    const reset = () => {
      if (frame !== null) {
        cancelAnimationFrame(frame);
        frame = null;
      }
      eyes.style.transform = "";
    };

    const lookAtPointer = () => {
      frame = null;
      const bounds = avatar.getBoundingClientRect();
      const dx = pointer.x - (bounds.left + bounds.width / 2);
      // The eyes sit four units below the center of the 96-unit SVG viewBox.
      const dy = pointer.y - (bounds.top + (bounds.height * 52) / 96);
      const distance = Math.max(bounds.width, Math.hypot(dx, dy));
      if (distance === 0) {
        return;
      }
      const x = Math.round((dx / distance) * 10);
      const y = Math.round((dy / distance) * 6);
      eyes.style.transform = `translate(${x}px, ${y}px)`;
    };

    const onPointerMove = (event: PointerEvent) => {
      if (reducedMotion.matches || event.pointerType === "touch") {
        return;
      }
      pointer = { x: event.clientX, y: event.clientY };
      if (frame === null) {
        frame = requestAnimationFrame(lookAtPointer);
      }
    };

    window.addEventListener("pointermove", onPointerMove, { passive: true });
    window.addEventListener("blur", reset);
    document.documentElement.addEventListener("pointerleave", reset);
    reducedMotion.addEventListener("change", reset);

    return () => {
      reset();
      window.removeEventListener("pointermove", onPointerMove);
      window.removeEventListener("blur", reset);
      document.documentElement.removeEventListener("pointerleave", reset);
      reducedMotion.removeEventListener("change", reset);
    };
  }, []);

  return (
    <PixHead
      className="size-20"
      eyesRef={eyesRef}
      glow={BUSY_GLOW}
      pix="lime"
    />
  );
}
