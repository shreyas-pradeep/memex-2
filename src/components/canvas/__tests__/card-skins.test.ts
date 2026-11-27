import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CARD_ACCENTS, EDGE_COLORS, type MemexCardType } from "@/core/types";
import { TYPE_COLORS } from "@/store/useMemexStore";
import {
  CARD_SKINS,
  CARD_TYPE_ORDER,
  compositeHex,
  contrastRatio,
  restShadow,
  rgba,
  skinFor,
} from "../card-skins";

const TYPES: readonly MemexCardType[] = ["note", "quote", "artifact", "ghost"];
const hex = /^#[0-9A-F]{6}$/i;

describe("card skins", () => {
  it("has exactly one skin per card type, in a fixed order", () => {
    expect([...CARD_TYPE_ORDER]).toEqual([...TYPES]);
    expect(Object.keys(CARD_SKINS).sort()).toEqual([...TYPES].sort());
    for (const t of TYPES) expect(CARD_SKINS[t].cardType).toBe(t);
  });

  it("uses the exact pill labels", () => {
    expect(CARD_SKINS.note.label).toBe("[NOTE]");
    expect(CARD_SKINS.quote.label).toBe("[QUOTE // EXCERPT]");
    expect(CARD_SKINS.artifact.label).toBe("[ARTIFACT // DATA]");
    expect(CARD_SKINS.ghost.label).toBe("[⚡ GHOST SYNAPSE]");
  });

  it("gives every type a distinct accent with the specified palette", () => {
    const accents = TYPES.map((t) => CARD_SKINS[t].accent.toUpperCase());
    expect(new Set(accents).size).toBe(4);
    expect(CARD_SKINS.note.accent).toBe("#FFB236");
    expect(CARD_SKINS.quote.accent).toBe("#38BDF8");
    expect(CARD_SKINS.artifact.accent).toBe("#10B981");
    expect(CARD_SKINS.ghost.accent).toBe("#B388FF");
    for (const t of TYPES) {
      expect(CARD_SKINS[t].accent).toMatch(hex);
      expect(CARD_SKINS[t].accent).toBe(CARD_ACCENTS[t]);
    }
  });

  it("keeps the store's TYPE_COLORS and edge semantics consistent", () => {
    expect(TYPE_COLORS).toEqual(CARD_ACCENTS);
    expect(TYPE_COLORS.quote).not.toBe("#60A5FA");
    // Edges keep their meaning: amber human, violet ghost.
    expect(EDGE_COLORS).toEqual({ human: "#FFB236", ghost: "#B388FF" });
  });

  it("specifies borders, glows and the quote spine", () => {
    expect(CARD_SKINS.note.border).toBe("rgba(255, 178, 54, 0.3)");
    expect(CARD_SKINS.artifact.border).toBe("rgba(16, 185, 129, 0.4)");
    expect(CARD_SKINS.quote.leftBorderWidth).toBe(4);
    expect(CARD_SKINS.quote.restGlow).toMatch(/56, 189, 248/);
    for (const t of ["note", "artifact", "ghost"] as const) expect(CARD_SKINS[t].leftBorderWidth).toBe(1);
    expect(CARD_SKINS.ghost.restGlow).toBe("0 0 18px rgba(179, 136, 255, 0.35)");
    expect(restShadow(CARD_SKINS.ghost)).toContain("0 0 18px rgba(179, 136, 255, 0.35)");
  });

  it("applies the specified body typography per type", () => {
    expect(CARD_SKINS.quote.bodyTextClass).toMatch(/font-serif/);
    expect(CARD_SKINS.quote.bodyTextClass).toMatch(/\bitalic\b/);
    expect(CARD_SKINS.quote.bodyTextClass).toMatch(/tracking-wide/);
    expect(CARD_SKINS.quote.bodyTextClass).toMatch(/text-cyan-50\/90/);
    expect(CARD_SKINS.artifact.bodyTextClass).toMatch(/font-mono/);
    expect(CARD_SKINS.artifact.bodyTextClass).toMatch(/text-emerald-100\/90/);
    expect(CARD_SKINS.artifact.bodyTextClass).toMatch(/\btext-xs\b/);
    expect(CARD_SKINS.artifact.bodyTextClass).toMatch(/leading-relaxed/);
    expect(CARD_SKINS.artifact.bodyBgClass).toBe("bg-emerald-950/20");
    expect(CARD_SKINS.note.surface).toBe("#141721");
  });

  it("never animates a glow: no skin string mentions a transition or animation", () => {
    for (const t of TYPES) {
      const skin = CARD_SKINS[t];
      for (const value of [skin.restGlow, skin.hoverGlow, skin.bodyTextClass, skin.editTextClass]) {
        expect(value).not.toMatch(/filter|blur\(|animate-/);
      }
    }
  });

  it("falls back to the note skin for an unknown type", () => {
    expect(skinFor("mystery" as MemexCardType)).toBe(CARD_SKINS.note);
  });
});

describe("card skin contrast (WCAG AA)", () => {
  it("body text is at least 4.5:1 on every effective surface", () => {
    for (const t of TYPES) {
      const skin = CARD_SKINS[t];
      expect(contrastRatio(skin.bodyText.hex, skin.surface, skin.bodyText.alpha), t).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("titles, ids, years and tag text read on the surface", () => {
    for (const t of TYPES) {
      const skin = CARD_SKINS[t];
      expect(contrastRatio("#F4F1EA", skin.surface), `${t} title`).toBeGreaterThanOrEqual(7);
      expect(contrastRatio("#8E94A5", skin.surface), `${t} muted`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio("#8E94A5", skin.headerBg), `${t} id`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(skin.accent, skin.surface), `${t} tags`).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(skin.accent, skin.headerBg), `${t} pill`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("edit fields keep parchment and tinted text readable on the near-black field", () => {
    for (const t of TYPES) {
      expect(contrastRatio("#F4F1EA", "#090A0F"), t).toBeGreaterThanOrEqual(7);
      expect(contrastRatio("#8E94A5", "#090A0F"), t).toBeGreaterThanOrEqual(4.5);
      expect(contrastRatio(CARD_SKINS[t].accent, CARD_SKINS[t].editorBg), `${t} tag chips`).toBeGreaterThanOrEqual(4.5);
    }
    expect(contrastRatio("#ECFEFF", "#090A0F")).toBeGreaterThanOrEqual(7);
    expect(contrastRatio("#D1FAE5", "#090A0F")).toBeGreaterThanOrEqual(7);
  });

  it("the contrast helper is symmetric-bounded and matches known values", () => {
    expect(contrastRatio("#FFFFFF", "#000000")).toBeCloseTo(21, 5);
    expect(contrastRatio("#777777", "#777777")).toBeCloseTo(1, 5);
    fc.assert(
      fc.property(fc.integer({ min: 0, max: 0xffffff }), fc.integer({ min: 0, max: 0xffffff }), fc.double({ min: 0, max: 1, noNaN: true }), (a, b, alpha) => {
        const h = (n: number) => `#${n.toString(16).padStart(6, "0")}`;
        const c = contrastRatio(h(a), h(b), alpha);
        expect(c).toBeGreaterThanOrEqual(1);
        expect(c).toBeLessThanOrEqual(21.0001);
        expect(compositeHex(h(a), 1, h(b))).toBe(h(a).toUpperCase());
        expect(compositeHex(h(a), 0, h(b))).toBe(h(b).toUpperCase());
      }),
      { numRuns: 200 },
    );
  });

  it("rgba converts hex colors", () => {
    expect(rgba("#38BDF8", 0.5)).toBe("rgba(56, 189, 248, 0.5)");
  });
});
