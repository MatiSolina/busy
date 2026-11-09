import type { Ref } from "react";
import { type PixColors, type PixVariant, pixGlow } from "@/lib/avatar";

const HEAD = "M-39 -40H39V-35H44V35H39V40H-39V35H-44V-35H-39Z";

interface CostumeProps {
  c: PixColors;
  className?: string;
  eyesRef?: Ref<SVGGElement>;
  /** Overrides the lights' color, as the Busy mark's redline lights do. */
  glow?: string;
  variant: PixVariant;
  working?: boolean;
}

function Rect({
  fill,
  height,
  width,
  x,
  y,
}: {
  fill: string;
  height: number;
  width: number;
  x: number;
  y: number;
}) {
  return <rect fill={fill} height={height} width={width} x={x} y={y} />;
}

function DiscoBack() {
  return (
    <path
      d="M-36 -58H28V-52H44V-44H52V-30H56V-6H50V10H40V-22H-40V10H-52V-6H-56V-30H-50V-44H-36Z"
      fill="#35251e"
    />
  );
}

function DiscoFront() {
  return (
    <>
      <path
        d="M-36 -58H28V-52H44V-42H50V-26H40V-20H28V-28H16V-22H4V-28H-10V-20H-24V-28H-40V-18H-50V-38H-44V-48H-36Z"
        fill="#563827"
      />
      <Rect fill="#80523c" height={8} width={12} x={-28} y={-52} />
      <Rect fill="#80523c" height={8} width={10} x={-42} y={-40} />
      <Rect fill="#80523c" height={8} width={16} x={4} y={-50} />
      <Rect fill="#35251e" height={8} width={12} x={30} y={-38} />
    </>
  );
}

function PopBack() {
  return (
    <path
      d="M-32 -52H30V-46H42V-34H50V34H40V42H30V-28H-30V42H-44V34H-50V-28H-44V-44H-32Z"
      fill="#ba447b"
    />
  );
}

function PopFront() {
  return (
    <>
      <path
        d="M-32 -52H30V-46H40V-34H44V-10H34V-26H20V-32H8V-24H-4V-30H-16V-24H-34V-8H-44V-34H-40V-44H-32Z"
        fill="#f080b6"
      />
      <Rect fill="#ffb5d5" height={6} width={28} x={-28} y={-46} />
      <Rect fill="#f080b6" height={34} width={10} x={34} y={-4} />
      <Rect fill="#f080b6" height={34} width={10} x={-44} y={-4} />
      <Rect fill="#ffb5d5" height={12} width={6} x={-44} y={22} />
    </>
  );
}

function PunkHair() {
  return (
    <>
      <path
        d="M-16 -28V-48H-10V-60H0V-54H6V-62H16V-52H22V-32H14V-24H4V-30H-4V-24Z"
        fill="#f080b6"
      />
      <Rect fill="#ffb5d5" height={20} width={6} x={-4} y={-54} />
      <Rect fill="#ba447b" height={14} width={6} x={12} y={-46} />
    </>
  );
}

function NerdGlasses() {
  return (
    <>
      <path
        d="M-36 -12h30v34h-30Z M-31 -7v24h20V-7Z"
        fill="#7cddf5"
        fillRule="evenodd"
      />
      <path
        d="M6 -12h30v34H6Z M11 -7v24h20V-7Z"
        fill="#7cddf5"
        fillRule="evenodd"
      />
      <Rect fill="#7cddf5" height={6} width={12} x={-6} y={-2} />
      <Rect fill="#7cddf5" height={6} width={10} x={-44} y={-8} />
      <Rect fill="#7cddf5" height={6} width={10} x={34} y={-8} />
    </>
  );
}

function DiscoGlasses() {
  return (
    <>
      <path d="M-36 -12h30v24h-6v6h-18v-6h-6Z" fill="#f78acb" />
      <path d="M-31 -6h20V8h-5v4h-10V8h-5Z" fill="#56273f" />
      <Rect fill="#f78acb" height={6} width={6} x={-28} y={-4} />
      <path d="M6 -12h30v24h-6v6H12V12H6Z" fill="#f78acb" />
      <path d="M11 -6h20V8h-5v4H16V8h-5Z" fill="#56273f" />
      <Rect fill="#f78acb" height={6} width={6} x={14} y={-4} />
      <Rect fill="#f78acb" height={6} width={12} x={-6} y={-2} />
      <Rect fill="#f78acb" height={6} width={10} x={-44} y={-8} />
      <Rect fill="#f78acb" height={6} width={10} x={34} y={-8} />
    </>
  );
}

function PopGlasses() {
  return (
    <>
      <path
        d="M-30 -14h18v6h6v24h-6v6h-18v-6h-6V-8h6Z M-29 -7v22h16V-7Z"
        fill="#ffd36c"
        fillRule="evenodd"
      />
      <path
        d="M12 -14h18v6h6v24h-6v6H12v-6H6V-8h6Z M13 -7v22h16V-7Z"
        fill="#ffd36c"
        fillRule="evenodd"
      />
      <Rect fill="#ffd36c" height={6} width={12} x={-6} y={-2} />
      <Rect fill="#ffd36c" height={6} width={10} x={-44} y={-8} />
      <Rect fill="#ffd36c" height={6} width={10} x={34} y={-8} />
    </>
  );
}

function GamerBack() {
  return (
    <path
      d="M-52 12V-24H-46V-40H-34V-48H34V-40H46V-24H52V12H44V-24H36V-36H-36V-24H-44V12Z"
      fill="#bba5ff"
    />
  );
}

function GamerFront() {
  return (
    <>
      <Rect fill="#bba5ff" height={34} width={14} x={-56} y={-10} />
      <Rect fill="#bba5ff" height={34} width={14} x={42} y={-10} />
      <Rect fill="#41345f" height={22} width={6} x={-52} y={-4} />
      <Rect fill="#41345f" height={22} width={6} x={46} y={-4} />
      <path d="M50 20H56V32H30V26H50Z" fill="#bba5ff" />
      <Rect fill="#41345f" height={10} width={12} x={24} y={24} />
    </>
  );
}

function ChefHat() {
  return (
    <>
      <path
        d="M-28 -60H-6V-56H10V-60H28V-54H38V-40H30V-34H-30V-40H-40V-52H-28Z"
        fill="#f4f4f2"
      />
      <Rect fill="#f4f4f2" height={14} width={60} x={-30} y={-34} />
      <Rect fill="#c6ccd4" height={6} width={60} x={-30} y={-24} />
      <Rect fill="#dce1e5" height={14} width={6} x={-8} y={-50} />
    </>
  );
}

function ThemeEyes({
  color,
  variant,
  working,
}: {
  color: string;
  variant: PixVariant;
  working: boolean;
}) {
  if (variant === "punk") {
    return (
      <>
        <path d="M-18 -10h8v8h8v8h-8v8h-8V6h-8v-8h8Z" fill={color} />
        <path d="M10 -10h8v8h8v8h-8v8h-8V6H2v-8h8Z" fill={color} />
      </>
    );
  }
  if (variant === "pop") {
    return (
      <>
        <path d="M-14 -6h8v4h4v16h-4v4h-8v-4h-4V-2h4Z" fill={color} />
        <path d="M10 -6h8v4h4v16h-4v4h-8v-4H6V-2h4Z" fill={color} />
      </>
    );
  }
  if (variant === "gamer") {
    return (
      <>
        <Rect fill={color} height={26} width={12} x={-18} y={-10} />
        <Rect fill={color} height={18} width={8} x={10} y={-2} />
      </>
    );
  }
  if (variant === "chef") {
    return (
      <>
        <path d="M-20 12V0h4v-4h8v4h4v12h-4V4h-8v8Z" fill={color} />
        <path d="M4 12V0h4v-4h8v4h4v12h-4V4h-8v8Z" fill={color} />
      </>
    );
  }
  return (
    <>
      <Rect
        fill={color}
        height={working ? 18 : 24}
        width={8}
        x={-16}
        y={working ? -12 : -8}
      />
      <Rect
        fill={color}
        height={working ? 18 : 24}
        width={8}
        x={8}
        y={working ? -12 : -8}
      />
    </>
  );
}

function ThemeBack({ variant }: { variant: PixVariant }) {
  if (variant === "gamer") {
    return <GamerBack />;
  }
  if (variant === "disco") {
    return <DiscoBack />;
  }
  if (variant === "pop") {
    return <PopBack />;
  }
  return null;
}

function ThemeFront({ variant }: { variant: PixVariant }) {
  if (variant === "disco") {
    return <DiscoFront />;
  }
  if (variant === "pop") {
    return <PopFront />;
  }
  if (variant === "punk") {
    return <PunkHair />;
  }
  if (variant === "nerd") {
    return <NerdGlasses />;
  }
  if (variant === "gamer") {
    return <GamerFront />;
  }
  if (variant === "chef") {
    return <ChefHat />;
  }
  return null;
}

function ThemeMiddle({ variant }: { variant: PixVariant }) {
  if (variant === "disco") {
    return <DiscoGlasses />;
  }
  if (variant === "pop") {
    return <PopGlasses />;
  }
  return null;
}

/**
 * A Pix head drawn in line, as on busybot.dev: the outline and eyes in the
 * current text color, a black screen, and the three lights in the bot's color.
 * Costumes keep their own colors on top.
 */
export function PixCostume({
  c,
  className,
  eyesRef,
  glow,
  variant,
  working = false,
}: CostumeProps) {
  const themed = variant !== "classic";
  const lights = glow ?? pixGlow(c);
  return (
    <svg
      aria-hidden="true"
      className={className}
      overflow="visible"
      shapeRendering={themed ? "crispEdges" : undefined}
      viewBox="-48 -48 96 96"
    >
      <ThemeBack variant={variant} />
      <path className="pix-avatar-line pix-avatar-screen" d={HEAD} />
      <g className="pix-avatar-lights" fill={lights}>
        <Rect fill={lights} height={10} width={10} x={-34} y={-34} />
        <Rect fill={lights} height={10} width={10} x={-20} y={-34} />
        <Rect fill={lights} height={10} width={10} x={-6} y={-34} />
      </g>
      <rect
        className="pix-avatar-line"
        fill="none"
        height={48}
        width={68}
        x={-34}
        y={-18}
      />
      <g className="pix-avatar-gaze">
        <g
          className={working ? "pix-avatar-glance" : undefined}
          fill="currentColor"
          ref={eyesRef}
          style={{ transformBox: "fill-box" }}
        >
          <ThemeEyes color="currentColor" variant={variant} working={working} />
        </g>
      </g>
      <ThemeMiddle variant={variant} />
      <ThemeFront variant={variant} />
    </svg>
  );
}
