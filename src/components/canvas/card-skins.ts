import { CARD_ACCENTS, type MemexCardType } from "@/core/types";

/**
 * Presentation constants for the four card "chassis" skins. Pure data and pure
 * helpers (no React), so the exact labels, distinct accents and text contrast
 * can be unit-tested. Tailwind class strings are written out in full so the
 * v4 scanner emits them.
 */

export const CARD_TYPE_ORDER: readonly MemexCardType[] = ["note", "quote", "artifact", "ghost"];

export interface CardSkin {
  cardType: MemexCardType;
  accent: string;
  /** Exact header pill text. */
  label: string;
  /** Card border color (all sides except a thicker left border, see `leftBorderWidth`). */
  border: string;
  /** Left border width in px; 1 everywhere except quotes (4). */
  leftBorderWidth: number;
  /** Header strip background. */
  headerBg: string;
  /** Effective body surface (hex) that body text is read against. */
  surface: string;
  /** Tailwind background class layered on the card surface (empty = none). */
  bodyBgClass: string;
  /** Tailwind classes for the body paragraph. */
  bodyTextClass: string;
  /** Body text color as hex plus alpha, mirroring `bodyTextClass`, for contrast checks. */
  bodyText: { hex: string; alpha: number };
  /** Dark editor panel behind the edit fields. */
  editorBg: string;
  /** Tailwind classes for the edit textarea (inputs stay parchment on near-black). */
  editTextClass: string;
  /** Static resting glow (box-shadow list entry). Never animated. */
  restGlow: string;
  /** Static glow revealed on hover through an opacity transition. */
  hoverGlow: string;
}

const PARCHMENT = "#F4F1EA";

/** `#RRGGBB` to `rgba(r, g, b, a)`. */
export function rgba(hex: string, alpha: number): string {
  const [r, g, b] = hexToRgb(hex);
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/** Composites `fg` at `alpha` over `bg`, returned as `#RRGGBB`. */
export function compositeHex(fg: string, alpha: number, bg: string): string {
  const f = hexToRgb(fg);
  const b = hexToRgb(bg);
  const mix = f.map((c, i) => Math.round(c * alpha + b[i] * (1 - alpha)));
  return `#${mix.map((c) => c.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
}

function channel(c: number): number {
  const s = c / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of `#RRGGBB`. */
export function relativeLuminance(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio of `fg` (optionally translucent) over an opaque `bg`. Between 1 and 21. */
export function contrastRatio(fg: string, bg: string, fgAlpha = 1): number {
  const l1 = relativeLuminance(compositeHex(fg, fgAlpha, bg));
  const l2 = relativeLuminance(bg);
  const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
  return (hi + 0.05) / (lo + 0.05);
}

/** Card chassis under the body: `#141721`, the shared microfiche surface. */
const CHASSIS = "#141721";
/** Tailwind emerald-950 as sRGB (the v4 palette is oklch; this is its hex equivalent). */
const EMERALD_950 = "#002C22";

export const CARD_SKINS: Readonly<Record<MemexCardType, CardSkin>> = {
  note: {
    cardType: "note",
    accent: CARD_ACCENTS.note,
    label: "[NOTE]",
    border: "rgba(255, 178, 54, 0.3)",
    leftBorderWidth: 1,
    headerBg: "#161922",
    surface: CHASSIS,
    bodyBgClass: "",
    bodyTextClass: "text-[12px] leading-relaxed text-text-primary/85",
    bodyText: { hex: PARCHMENT, alpha: 0.85 },
    editorBg: "#0F1118",
    editTextClass: "text-[12px] leading-relaxed text-text-primary",
    restGlow: "0 0 14px rgba(255, 178, 54, 0.12)",
    hoverGlow: "0 0 26px 1px rgba(255, 178, 54, 0.32)",
  },
  quote: {
    cardType: "quote",
    accent: CARD_ACCENTS.quote,
    label: "[QUOTE // EXCERPT]",
    border: "rgba(56, 189, 248, 0.35)",
    leftBorderWidth: 4,
    headerBg: "#131B27",
    surface: "#101822",
    bodyBgClass: "",
    bodyTextClass: "font-serif text-[14px] italic leading-relaxed tracking-wide text-cyan-50/90",
    // Tailwind cyan-50 is #ECFEFF.
    bodyText: { hex: "#ECFEFF", alpha: 0.9 },
    editorBg: "#0C141D",
    editTextClass: "font-serif text-[13px] italic leading-relaxed tracking-wide text-cyan-50",
    restGlow: "0 0 16px rgba(56, 189, 248, 0.2), -6px 0 18px -6px rgba(56, 189, 248, 0.55)",
    hoverGlow: "0 0 26px 1px rgba(56, 189, 248, 0.38), -8px 0 22px -6px rgba(56, 189, 248, 0.6)",
  },
  artifact: {
    cardType: "artifact",
    accent: CARD_ACCENTS.artifact,
    label: "[ARTIFACT // DATA]",
    border: "rgba(16, 185, 129, 0.4)",
    leftBorderWidth: 1,
    headerBg: "#111C1E",
    // `bg-emerald-950/20` over the chassis.
    surface: compositeHex(EMERALD_950, 0.2, CHASSIS),
    bodyBgClass: "bg-emerald-950/20",
    bodyTextClass: "font-mono text-xs leading-relaxed text-emerald-100/90",
    // Tailwind emerald-100 is #D1FAE5.
    bodyText: { hex: "#D1FAE5", alpha: 0.9 },
    editorBg: "#0B1514",
    editTextClass: "font-mono text-xs leading-relaxed text-emerald-100",
    restGlow: "0 0 14px rgba(16, 185, 129, 0.16)",
    hoverGlow: "0 0 26px 1px rgba(16, 185, 129, 0.34)",
  },
  ghost: {
    cardType: "ghost",
    accent: CARD_ACCENTS.ghost,
    label: "[⚡ GHOST SYNAPSE]",
    border: "rgba(179, 136, 255, 0.55)",
    leftBorderWidth: 1,
    headerBg: "#181526",
    surface: CHASSIS,
    bodyBgClass: "",
    bodyTextClass: "text-[12px] leading-relaxed text-text-primary/85",
    bodyText: { hex: PARCHMENT, alpha: 0.85 },
    editorBg: "#0F0E18",
    editTextClass: "text-[12px] leading-relaxed text-text-primary",
    restGlow: "0 0 18px rgba(179, 136, 255, 0.35)",
    hoverGlow: "0 0 26px 1px rgba(179, 136, 255, 0.5)",
  },
};

/** Skin for a card type; an unknown type (stale save) falls back to the note skin. */
export function skinFor(cardType: MemexCardType): CardSkin {
  return CARD_SKINS[cardType] ?? CARD_SKINS.note;
}

/** Static resting box-shadow of a card: the type glow plus a drop shadow. */
export function restShadow(skin: CardSkin): string {
  return `${skin.restGlow}, 0 4px 14px rgba(0, 0, 0, 0.55)`;
}

/** Static scanline texture for artifact bodies: 1px green lines every 3px. */
export const SCANLINES =
  "repeating-linear-gradient(0deg, rgba(16, 185, 129, 0.07) 0px, rgba(16, 185, 129, 0.07) 1px, transparent 1px, transparent 3px)";
