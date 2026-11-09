// Bot avatars: Pix heads with an optional costume and a stable legacy color.
// A bot shows the head it picked (agents.avatar) or, until it picks one, a stable head per id.

export interface PixColors {
  eyes: string;
  face: string;
  head: string;
  lights: string;
}

export const PIX = {
  brown: {
    eyes: "#ffffff",
    face: "#1c0f08",
    head: "#925430",
    lights: "#482613",
  },
  cream: {
    eyes: "#fff8ea",
    face: "#30291d",
    head: "#f0e5cd",
    lights: "#a6906b",
  },
  green: {
    eyes: "#ffffff",
    face: "#101d09",
    head: "#60a43c",
    lights: "#213e16",
  },
  lavender: {
    eyes: "#ffffff",
    face: "#271f3a",
    head: "#dad7e8",
    lights: "#77728f",
  },
  lime: {
    eyes: "#ffffff",
    face: "#0d1405",
    head: "#9ce452",
    lights: "#3a6315",
  },
  night: {
    eyes: "#ffd362",
    face: "#161320",
    head: "#322e3e",
    lights: "#131118",
  },
  orange: {
    eyes: "#fbcd64",
    face: "#411c05",
    head: "#e26616",
    lights: "#411c05",
  },
  purple: {
    eyes: "#ffffff",
    face: "#130c1d",
    head: "#604c80",
    lights: "#271c3a",
  },
  red: { eyes: "#ffffff", face: "#1a0607", head: "#e03638", lights: "#6a1212" },
  sand: {
    eyes: "#ffffff",
    face: "#1a140b",
    head: "#d1bf9e",
    lights: "#6c583a",
  },
  violet: {
    eyes: "#ffffff",
    face: "#120a1e",
    head: "#8e67ca",
    lights: "#3f2566",
  },
  white: {
    eyes: "#ffffff",
    face: "#27272c",
    head: "#f2f2f8",
    lights: "#9a9aa6",
  },
} as const satisfies Record<string, PixColors>;

export type PixKey = keyof typeof PIX;

/** A head too dark to read on black lights up in this neutral instead. */
const DIM_GLOW = "#8b8983";

/**
 * The color of a bot's three lights. Busy draws its robots in line (as on
 * busybot.dev), so the lights carry the bot's color: its head color, unless
 * that head is too dark to read on a black screen.
 */
export function pixGlow(c: PixColors): string {
  const [r, g, b] = [1, 3, 5].map((i) => {
    const channel = Number.parseInt(c.head.slice(i, i + 2), 16) / 255;
    return channel <= 0.040_45
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4;
  });
  const luminance = 0.2126 * (r ?? 0) + 0.7152 * (g ?? 0) + 0.0722 * (b ?? 0);
  return luminance < 0.05 ? DIM_GLOW : c.head;
}

export const PIX_KEYS: PixKey[] = [
  "lime",
  "green",
  "violet",
  "purple",
  "red",
  "orange",
  "sand",
  "cream",
  "white",
  "lavender",
  "brown",
  "night",
];

export const PIX_VARIANTS = [
  { color: "lime", id: "classic", label: "Classic" },
  { color: "orange", id: "disco", label: "Disco" },
  { color: "lavender", id: "pop", label: "Pop" },
  { color: "night", id: "punk", label: "Punk" },
  { color: "lime", id: "nerd", label: "Nerd" },
  { color: "violet", id: "gamer", label: "Gamer" },
  { color: "red", id: "chef", label: "Chef" },
] as const satisfies readonly { color: PixKey; id: string; label: string }[];

export type PixVariant = (typeof PIX_VARIANTS)[number]["id"];

export function isPixVariant(value: unknown): value is PixVariant {
  return PIX_VARIANTS.some((variant) => variant.id === value);
}

/** Only the explicit Pix costume format opts a legacy avatar into a new style. */
export function variantFor(avatar?: string | null): PixVariant {
  if (typeof avatar !== "string") {
    return "classic";
  }
  const [format, variant, color, ...extra] = avatar.split(":");
  return format === "pix" &&
    extra.length === 0 &&
    isPixVariant(variant) &&
    isPixKey(color)
    ? variant
    : "classic";
}

/** Keep classic colors byte-for-byte compatible with existing saved identities. */
export function avatarFor(color: PixKey, variant: PixVariant): string {
  return variant === "classic" ? color : `pix:${variant}:${color}`;
}

export function isPixKey(value: unknown): value is PixKey {
  return typeof value === "string" && Object.hasOwn(PIX, value);
}

function colorFromAvatar(value: unknown): PixKey | undefined {
  if (isPixKey(value)) {
    return value;
  }
  if (typeof value !== "string") {
    return undefined;
  }
  const separator = value.lastIndexOf(":");
  if (separator < 0) {
    return undefined;
  }
  const color = value.slice(separator + 1);
  return isPixKey(color) ? color : undefined;
}

/** The chosen head, or a stable one per id (FNV-1a hash) so a bot keeps its face everywhere. */
export function pixFor(id: string, avatar?: string | null): PixKey {
  const selected = colorFromAvatar(avatar);
  if (selected) {
    return selected;
  }
  let h = 0x81_1c_9d_c5;
  for (let i = 0; i < id.length; i += 1) {
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a intentionally uses 32-bit arithmetic for stable legacy hashes.
    h ^= id.charCodeAt(i);
    // biome-ignore lint/suspicious/noBitwiseOperators: FNV-1a intentionally uses 32-bit arithmetic for stable legacy hashes.
    h = Math.imul(h, 0x01_00_01_93) >>> 0;
  }
  return PIX_KEYS[h % PIX_KEYS.length] ?? "lime";
}
