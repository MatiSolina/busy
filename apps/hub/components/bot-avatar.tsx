"use client";

import {
  type CSSProperties,
  type ReactNode,
  type Ref,
  useEffect,
  useRef,
} from "react";
import { PixCostume } from "@/components/pix-costume";
import {
  PIX,
  type PixKey,
  type PixVariant,
  pixFor,
  variantFor,
} from "@/lib/avatar";
import { avatarMotionFor } from "@/lib/avatar-motion";
import { cn } from "@/lib/utils";
import "./bot-avatar.css";

function useAvatarPointer(
  trackEyes: boolean,
  gazeX: number,
  gazeY: number,
  tilt: number
) {
  const ref = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = ref.current;
    if (!root) {
      return;
    }

    const reducedMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
    let frame = 0;
    let bounds: DOMRect | null = null;
    let pointerX = 0;
    let pointerY = 0;

    const update = () => {
      frame = 0;
      if (!bounds) {
        return;
      }
      const x = Math.max(
        -1,
        Math.min(
          1,
          (pointerX - bounds.left - bounds.width / 2) / (bounds.width / 2 || 1)
        )
      );
      const y = Math.max(
        -1,
        Math.min(
          1,
          (pointerY - bounds.top - bounds.height / 2) / (bounds.height / 2 || 1)
        )
      );
      root.style.setProperty("--pix-look-x", `${trackEyes ? x * gazeX : 0}px`);
      root.style.setProperty("--pix-look-y", `${trackEyes ? y * gazeY : 0}px`);
      root.style.setProperty("--pix-tilt", `${x * tilt}deg`);
    };

    const move = (event: PointerEvent) => {
      if (!bounds || reducedMotion.matches || event.pointerType === "touch") {
        return;
      }
      pointerX = event.clientX;
      pointerY = event.clientY;
      if (!frame) {
        frame = requestAnimationFrame(update);
      }
    };

    const enter = (event: PointerEvent) => {
      if (reducedMotion.matches || event.pointerType === "touch") {
        return;
      }
      // Measure the still hit area once; the animated head never moves its target.
      bounds = root.getBoundingClientRect();
      root.dataset.pointing = "true";
      move(event);
    };

    const reset = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      bounds = null;
      delete root.dataset.pointing;
      root.style.removeProperty("--pix-look-x");
      root.style.removeProperty("--pix-look-y");
      root.style.removeProperty("--pix-tilt");
    };

    root.addEventListener("pointerenter", enter);
    root.addEventListener("pointermove", move, { passive: true });
    root.addEventListener("pointerleave", reset);
    root.addEventListener("pointercancel", reset);
    reducedMotion.addEventListener("change", reset);

    return () => {
      reset();
      root.removeEventListener("pointerenter", enter);
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerleave", reset);
      root.removeEventListener("pointercancel", reset);
      reducedMotion.removeEventListener("change", reset);
    };
  }, [gazeX, gazeY, tilt, trackEyes]);

  return ref;
}

interface AvatarMotionStyle extends CSSProperties {
  [property: `--pix-${string}`]: number | string;
}

function AvatarMotion({
  children,
  className,
  identity,
  trackEyes = true,
  variant = "classic",
  working = false,
}: {
  children: ReactNode;
  className?: string;
  identity: string;
  trackEyes?: boolean;
  variant?: PixVariant;
  working?: boolean;
}) {
  const motion = avatarMotionFor(identity);
  const motionRef = useAvatarPointer(
    trackEyes,
    motion.gazeX,
    motion.gazeY,
    motion.tilt
  );
  const style: AvatarMotionStyle = {
    "--pix-glance-x": `${motion.gazeX * motion.direction}px`,
    "--pix-glance-y": `${motion.gazeY}px`,
    "--pix-hover-duration": `${motion.hoverDuration}ms`,
    "--pix-light-duration": `${motion.lightDuration}s`,
    "--pix-motion-direction": motion.direction,
    "--pix-motion-scale": motion.scale,
    "--pix-work-delay": `${motion.workDelay}s`,
    "--pix-work-duration": `${motion.workDuration}s`,
  };

  return (
    <span
      aria-hidden="true"
      className={cn("pix-avatar", className)}
      data-motion={motion.name}
      data-pix-variant={variant}
      ref={motionRef}
      style={style}
    >
      <span className="pix-avatar-hop">
        <span
          className={cn("pix-avatar-body", working && "pix-avatar-working")}
        >
          <span className="pix-avatar-tilt">{children}</span>
        </span>
      </span>
    </span>
  );
}

/** A curious face on hover, with little nods and scanning eyes while working. */
export function PixHead({
  pix,
  working = false,
  className,
  eyesRef,
  glow,
  motionKey,
  variant = "classic",
}: {
  pix: PixKey;
  working?: boolean;
  className?: string;
  eyesRef?: Ref<SVGGElement>;
  /** Overrides the lights' color, as the Busy mark's redline lights do. */
  glow?: string;
  motionKey?: string;
  variant?: PixVariant;
}) {
  const c = PIX[pix];
  return (
    <AvatarMotion
      className={className}
      identity={motionKey ?? pix}
      trackEyes={!eyesRef}
      variant={variant}
      working={working}
    >
      <PixCostume
        c={c}
        className="block size-full"
        eyesRef={eyesRef}
        glow={glow}
        variant={variant}
        working={working}
      />
    </AvatarMotion>
  );
}

/** The line thins on inline-sized heads, stays 1.5px on list-sized ones and thickens on the big ones. */
function avatarBoxStyle(size: number): AvatarMotionStyle {
  if (size >= 96) {
    return { "--pix-stroke": "2.5px", height: size, width: size };
  }
  if (size <= 20) {
    return { "--pix-stroke": "1px", height: size, width: size };
  }
  return { height: size, width: size };
}

export function BotAvatar({
  slug,
  avatar,
  size = 28,
  working = false,
  className,
}: {
  slug: string;
  avatar?: string | null;
  size?: number;
  working?: boolean;
  className?: string;
}) {
  return (
    <span
      className={cn("inline-flex shrink-0", className)}
      style={avatarBoxStyle(size)}
    >
      <PixHead
        className="size-full"
        motionKey={slug}
        pix={pixFor(slug, avatar)}
        variant={variantFor(avatar)}
        working={working}
      />
    </span>
  );
}

/** A bot on its way up (deploy, its computer waking): the head, big and dancing, over one line. */
export function BotBooting({
  slug,
  avatar,
  phrase,
  size = 160,
}: {
  slug: string;
  avatar?: string | null;
  phrase: string;
  size?: number;
}) {
  return (
    <div className="flex flex-col items-center gap-6">
      <BotAvatar
        avatar={avatar}
        className="pix-dance"
        size={size}
        slug={slug}
        working
      />
      <p className="font-mono text-lg tracking-tight">{phrase}</p>
    </div>
  );
}
