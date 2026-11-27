import { isValidEventDate, normalizeTrailColor } from "./trail-engine";
import type {
  AssociativeEdge,
  AssociativeEdgeData,
  EdgePolarity,
  GhostDiscovery,
  LinkOrigin,
  MemexCardType,
  MemexGraphState,
  MemexNode,
  MemexNodeData,
  Trail,
} from "./types";

export {
  buildObsidianFiles,
  exportObsidianVaultZip,
  sanitizeObsidianFilename,
  type ObsidianFile,
  type ObsidianExportOptions,
} from "./obsidian-export";

/**
 * Portable `.memex` bundle (Spec 09). `exportMemexBundle` writes one
 * deterministic JSON document; `validateAndImportBundle` reads it back through
 * a strict, field-by-field validator that never throws and never spreads an
 * untrusted object. Pure: no React, no store, no clock (the timestamp is an
 * option), and no secret ever enters a bundle (everything is whitelisted).
 */

export const BUNDLE_SCHEMA = "memex-bundle";
export const BUNDLE_VERSION = "2.0";
/** Placeholder `exportedAt` when the caller supplies none (keeps output deterministic). */
export const BUNDLE_EPOCH = "1945-07-01T00:00:00.000Z";

/** Largest accepted bundle (5 MB of UTF-8). */
export const MAX_BUNDLE_BYTES = 5_000_000;
export const MAX_BUNDLE_CARDS = 2000;
export const MAX_BUNDLE_EDGES = 10_000;
export const MAX_BUNDLE_TRAILS = 500;
export const MAX_BUNDLE_DISCOVERIES = 1000;
export const MAX_BUNDLE_DISMISSED = 10_000;
export const MAX_TRAIL_STOPS = 2000;
export const MAX_ERRORS = 25;
/** Longest value of each kind of string (UTF-16 code units). */
export const BUNDLE_STRING_LIMITS = {
  id: 200,
  title: 2000,
  content: 200_000,
  rationale: 10_000,
  tag: 200,
  short: 500,
  url: 2_000_000,
} as const;
const MAX_TAGS_PER_CARD = 100;
const MAX_AUTHORS = 200;
const MAX_DEPTH = 32;
const MAX_POSITION = 1e7;
const MAX_CARD_SIDE = 1e5;
const MIN_YEAR = 0;
const MAX_YEAR = 9999;

export type GhostBundleEngine = "neural" | "live";

/** Ghost settings carried by a bundle. Never holds keys or tokens. */
export interface GhostBundleSettings {
  /** Engine that produced the last scan (informational; import does not change it). */
  engine?: GhostBundleEngine;
  /** Detection threshold in `[0, 1]` (informational). */
  threshold?: number;
  /** Discovery ids the user dismissed (sorted and de-duplicated on export). */
  dismissedDiscoveryIds?: readonly string[];
}

/** Settings as read back: the dismissed list is always present. */
export interface ImportedGhostSettings {
  engine?: GhostBundleEngine;
  threshold?: number;
  dismissedDiscoveryIds: string[];
}

/** What `exportMemexBundle` takes: the pure graph plus optional ghost settings. */
export type MemexBundleInput = MemexGraphState & { ghostSettings?: GhostBundleSettings };

export interface ExportBundleOptions {
  /** ISO-8601 export time (default `BUNDLE_EPOCH`). */
  exportedAt?: string;
}

export type BundleImportResult =
  | {
      ok: true;
      /** `"2.0"` for a bundle, `"1.x"` for a legacy plain graph export. */
      version: string;
      state: MemexGraphState;
      ghostSettings: ImportedGhostSettings;
      warnings: string[];
    }
  | { ok: false; errors: string[] };

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

function exportNode(n: MemexNode): MemexNode {
  const d = n.data;
  const data: MemexNodeData = {
    archivalId: d.archivalId,
    title: d.title,
    content: d.content,
    cardType: d.cardType,
    tags: [...d.tags],
    createdAt: d.createdAt,
    ...(d.imageUrl !== undefined ? { imageUrl: d.imageUrl } : {}),
    ...(d.confidence !== undefined ? { confidence: d.confidence } : {}),
    ...(d.date !== undefined ? { date: d.date } : {}),
    ...(d.year !== undefined ? { year: d.year } : {}),
    ...(d.source !== undefined ? { source: d.source } : {}),
    ...(d.pdfUrl !== undefined ? { pdfUrl: d.pdfUrl } : {}),
    ...(d.authors !== undefined ? { authors: [...d.authors] } : {}),
    ...(d.cassetteId !== undefined ? { cassetteId: d.cassetteId } : {}),
    ...(d.cassetteTitle !== undefined ? { cassetteTitle: d.cassetteTitle } : {}),
  };
  const style =
    n.style === undefined
      ? undefined
      : {
          ...(n.style.width !== undefined ? { width: n.style.width } : {}),
          ...(n.style.height !== undefined ? { height: n.style.height } : {}),
        };
  return {
    id: n.id,
    type: "memexCard",
    position: { x: n.position.x, y: n.position.y },
    ...(style !== undefined ? { style } : {}),
    data,
  };
}

function exportEdge(e: AssociativeEdge): AssociativeEdge {
  const d = e.data;
  return {
    id: e.id,
    source: e.source,
    target: e.target,
    type: "associative",
    ...(typeof e.style?.stroke === "string" ? { style: { stroke: e.style.stroke } } : {}),
    ...(d !== undefined
      ? {
          data: {
            origin: d.origin,
            rationale: d.rationale,
            strength: d.strength,
            ...(d.trailId !== undefined ? { trailId: d.trailId } : {}),
            ...(d.polarity !== undefined ? { polarity: d.polarity } : {}),
            ...(d.discoveryId !== undefined ? { discoveryId: d.discoveryId } : {}),
          },
        }
      : {}),
  };
}

function exportTrail(t: Trail): Trail {
  const color = normalizeTrailColor(t.color);
  return {
    id: t.id,
    title: t.title,
    description: t.description,
    origin: t.origin,
    nodeIds: [...t.nodeIds],
    createdAt: t.createdAt,
    ...(color !== undefined ? { color } : {}),
  };
}

function exportDiscovery(g: GhostDiscovery): GhostDiscovery {
  return {
    id: g.id,
    sourceId: g.sourceId,
    targetId: g.targetId,
    rationale: g.rationale,
    confidence: g.confidence,
    ...(g.trailId !== undefined ? { trailId: g.trailId } : {}),
    discoveredAt: g.discoveredAt,
  };
}

function cmpStr(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * Serializes the graph and the ghost settings as a pretty-printed bundle with a
 * fixed key order. Only whitelisted fields are copied, so runtime fields
 * (`selected`, `dragging`, `measured`, `resizing`) and anything unknown (an API
 * key someone attached to the input, for one) never reach the output. The
 * dismissed ids are sorted and de-duplicated. Does not mutate its input.
 */
export function exportMemexBundle(input: MemexBundleInput, options: ExportBundleOptions = {}): string {
  const s = input.ghostSettings;
  const dismissed = [...new Set(s?.dismissedDiscoveryIds ?? [])].sort(cmpStr);
  const ghostSettings: ImportedGhostSettings = {
    ...(s?.engine === "neural" || s?.engine === "live" ? { engine: s.engine } : {}),
    ...(typeof s?.threshold === "number" && Number.isFinite(s.threshold) ? { threshold: s.threshold } : {}),
    dismissedDiscoveryIds: dismissed,
  };
  return JSON.stringify(
    {
      schema: BUNDLE_SCHEMA,
      version: BUNDLE_VERSION,
      exportedAt: options.exportedAt ?? BUNDLE_EPOCH,
      cards: input.nodes.map(exportNode),
      edges: input.edges.map(exportEdge),
      trails: input.trails.map(exportTrail),
      ghostDiscoveries: input.ghostDiscoveries.map(exportDiscovery),
      ghostSettings,
    },
    null,
    2,
  );
}

// ---------------------------------------------------------------------------
// URL safety
// ---------------------------------------------------------------------------

const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp)(?:;[a-z0-9=.+-]+)*,/i;

/**
 * True for an `http(s)` URL, a relative URL and, when `allowDataImage` is set,
 * a `data:image/<raster>` URL. Everything with another scheme (`javascript:`,
 * `vbscript:`, `file:`, `data:text/html`, `data:image/svg+xml`, ...) is false,
 * and so is any URL containing whitespace or control characters (browsers strip
 * them before reading the scheme, so `java\\tscript:` would slip through).
 */
export function isSafeBundleUrl(url: string, allowDataImage: boolean): boolean {
  if (url === "" || url.length > BUNDLE_STRING_LIMITS.url) return false;
  if (/[\u0000-\u0020\u007F-\u009F\u2028\u2029]/.test(url)) return false;
  const scheme = /^([A-Za-z][A-Za-z0-9+.-]*):/.exec(url);
  if (scheme === null) return true; // relative or protocol-relative
  const name = scheme[1].toLowerCase();
  if (name === "http" || name === "https") return /^https?:\/\/[^/?#]+/i.test(url);
  if (name === "data") return allowDataImage && DATA_IMAGE.test(url);
  return false;
}

// ---------------------------------------------------------------------------
// Import
// ---------------------------------------------------------------------------

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);
/** Fields React Flow adds at runtime; ignored silently (they are never exported). */
const RUNTIME_KEYS: ReadonlySet<string> = new Set(["selected", "dragging", "measured", "resizing"]);

const CARD_TYPES: readonly MemexCardType[] = ["note", "quote", "artifact", "ghost"];
const ORIGINS: readonly LinkOrigin[] = ["human", "ghost"];
const POLARITIES: readonly EdgePolarity[] = ["supports", "refutes", "synthesizes"];

const NODE_KEYS = new Set(["id", "type", "position", "style", "data"]);
const POSITION_KEYS = new Set(["x", "y"]);
const STYLE_KEYS = new Set(["width", "height"]);
const DATA_KEYS = new Set([
  "archivalId", "title", "content", "cardType", "tags", "createdAt", "imageUrl", "confidence",
  "date", "year", "source", "pdfUrl", "authors", "cassetteId", "cassetteTitle",
]);
const EDGE_KEYS = new Set(["id", "source", "target", "type", "style", "data"]);
const EDGE_STYLE_KEYS = new Set(["stroke"]);
const STROKE_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const EDGE_DATA_KEYS = new Set(["origin", "rationale", "strength", "trailId", "polarity", "discoveryId"]);
const TRAIL_KEYS = new Set(["id", "title", "description", "origin", "nodeIds", "createdAt", "color"]);
const DISCOVERY_KEYS = new Set([
  "id", "sourceId", "targetId", "rationale", "confidence", "trailId", "discoveredAt",
]);
const SETTINGS_KEYS = new Set(["engine", "threshold", "dismissedDiscoveryIds"]);
const BUNDLE_KEYS = new Set([
  "schema", "version", "exportedAt", "cards", "edges", "trails", "ghostDiscoveries", "ghostSettings",
]);
const LEGACY_KEYS = new Set(["nodes", "edges", "trails", "ghostDiscoveries"]);

type Obj = Record<string, unknown>;

interface Ctx {
  errors: string[];
  warnings: string[];
  unknown: number;
  overflow: boolean;
}

function fail(ctx: Ctx, message: string): void {
  if (ctx.errors.length < MAX_ERRORS) ctx.errors.push(message);
  else ctx.overflow = true;
}

function isObj(v: unknown): v is Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) return false;
  const proto: unknown = Object.getPrototypeOf(v);
  return proto === Object.prototype || proto === null;
}

function has(o: Obj, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

function noteUnknown(ctx: Ctx, o: Obj, allowed: ReadonlySet<string>): void {
  for (const k of Object.keys(o)) if (!allowed.has(k) && !RUNTIME_KEYS.has(k)) ctx.unknown++;
}

/** First forbidden key (or depth problem) anywhere in the parsed tree, as a message. */
function findHostileKey(root: unknown): string | null {
  const stack: { value: unknown; path: string; depth: number }[] = [{ value: root, path: "$", depth: 0 }];
  while (stack.length > 0) {
    const { value, path, depth } = stack.pop() as { value: unknown; path: string; depth: number };
    if (typeof value !== "object" || value === null) continue;
    if (depth > MAX_DEPTH) return `Nested too deeply at ${path}.`;
    if (Array.isArray(value)) {
      for (let i = 0; i < value.length; i++) stack.push({ value: value[i], path: `${path}[${i}]`, depth: depth + 1 });
      continue;
    }
    for (const key of Object.keys(value)) {
      if (FORBIDDEN_KEYS.has(key)) return `Forbidden key "${key}" at ${path}.`;
      stack.push({ value: (value as Obj)[key], path: `${path}.${key}`, depth: depth + 1 });
    }
  }
  return null;
}

function readString(
  ctx: Ctx, o: Obj, key: string, path: string, max: number,
  { required = true, allowEmpty = true }: { required?: boolean; allowEmpty?: boolean } = {},
): string | undefined {
  if (!has(o, key)) {
    if (required) fail(ctx, `${path}.${key} is required.`);
    return undefined;
  }
  const v = o[key];
  if (typeof v !== "string") {
    fail(ctx, `${path}.${key} must be a string.`);
    return undefined;
  }
  if (!allowEmpty && v === "") {
    fail(ctx, `${path}.${key} must not be empty.`);
    return undefined;
  }
  if (v.length > max) {
    fail(ctx, `${path}.${key} is too long (limit ${max} characters).`);
    return undefined;
  }
  return v;
}

function readTimestamp(ctx: Ctx, o: Obj, key: string, path: string): string | undefined {
  const v = readString(ctx, o, key, path, BUNDLE_STRING_LIMITS.short);
  if (v !== undefined && !Number.isFinite(Date.parse(v))) {
    fail(ctx, `${path}.${key} is not a valid date-time.`);
    return undefined;
  }
  return v;
}

function readNumber(
  ctx: Ctx, o: Obj, key: string, path: string, min: number, max: number,
  { required = true, integer = false }: { required?: boolean; integer?: boolean } = {},
): number | undefined {
  if (!has(o, key)) {
    if (required) fail(ctx, `${path}.${key} is required.`);
    return undefined;
  }
  const v = o[key];
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max || (integer && !Number.isInteger(v))) {
    fail(ctx, `${path}.${key} must be ${integer ? "an integer" : "a finite number"} between ${min} and ${max}.`);
    return undefined;
  }
  return v;
}

function readEnum<T extends string>(
  ctx: Ctx, o: Obj, key: string, path: string, allowed: readonly T[], required = true,
): T | undefined {
  if (!has(o, key)) {
    if (required) fail(ctx, `${path}.${key} is required.`);
    return undefined;
  }
  const v = o[key];
  if (typeof v !== "string" || !(allowed as readonly string[]).includes(v)) {
    fail(ctx, `${path}.${key} must be one of ${allowed.join(", ")}.`);
    return undefined;
  }
  return v as T;
}

function readStringArray(
  ctx: Ctx, o: Obj, key: string, path: string, maxItems: number, maxLen: number, required: boolean,
): string[] | undefined {
  if (!has(o, key)) {
    if (required) fail(ctx, `${path}.${key} is required.`);
    return undefined;
  }
  const v = o[key];
  if (!Array.isArray(v)) {
    fail(ctx, `${path}.${key} must be an array of strings.`);
    return undefined;
  }
  if (v.length > maxItems) {
    fail(ctx, `${path}.${key} has too many entries (limit ${maxItems}).`);
    return undefined;
  }
  const out: string[] = [];
  for (let i = 0; i < v.length; i++) {
    const item: unknown = v[i];
    if (typeof item !== "string" || item.length > maxLen) {
      fail(ctx, `${path}.${key}[${i}] must be a string of at most ${maxLen} characters.`);
      return undefined;
    }
    out.push(item);
  }
  return out;
}

function readUrl(ctx: Ctx, o: Obj, key: string, path: string, allowDataImage: boolean): string | undefined {
  const v = readString(ctx, o, key, path, BUNDLE_STRING_LIMITS.url, { required: false });
  if (v === undefined) return undefined;
  if (!isSafeBundleUrl(v, allowDataImage)) {
    fail(
      ctx,
      `${path}.${key} is not a safe URL (only http, https${allowDataImage ? ", data:image" : ""} and relative URLs are allowed).`,
    );
    return undefined;
  }
  return v;
}

function readCardData(ctx: Ctx, raw: unknown, path: string): MemexNodeData | undefined {
  if (!isObj(raw)) {
    fail(ctx, `${path} must be an object.`);
    return undefined;
  }
  noteUnknown(ctx, raw, DATA_KEYS);
  const before = ctx.errors.length;
  const archivalId = readString(ctx, raw, "archivalId", path, BUNDLE_STRING_LIMITS.id);
  const title = readString(ctx, raw, "title", path, BUNDLE_STRING_LIMITS.title);
  const content = readString(ctx, raw, "content", path, BUNDLE_STRING_LIMITS.content);
  const cardType = readEnum(ctx, raw, "cardType", path, CARD_TYPES);
  const tags = readStringArray(ctx, raw, "tags", path, MAX_TAGS_PER_CARD, BUNDLE_STRING_LIMITS.tag, true);
  const createdAt = readTimestamp(ctx, raw, "createdAt", path);
  const imageUrl = readUrl(ctx, raw, "imageUrl", path, true);
  const confidence = readNumber(ctx, raw, "confidence", path, 0, 1, { required: false });
  const date = readString(ctx, raw, "date", path, 10, { required: false });
  if (date !== undefined && !isValidEventDate(date)) fail(ctx, `${path}.date must be YYYY, YYYY-MM or YYYY-MM-DD.`);
  const year = readNumber(ctx, raw, "year", path, MIN_YEAR, MAX_YEAR, { required: false, integer: true });
  const source = readString(ctx, raw, "source", path, BUNDLE_STRING_LIMITS.short, { required: false });
  const pdfUrl = readUrl(ctx, raw, "pdfUrl", path, false);
  const authors = readStringArray(ctx, raw, "authors", path, MAX_AUTHORS, BUNDLE_STRING_LIMITS.short, false);
  const cassetteId = readString(ctx, raw, "cassetteId", path, BUNDLE_STRING_LIMITS.id, { required: false, allowEmpty: false });
  const cassetteTitle = readString(ctx, raw, "cassetteTitle", path, BUNDLE_STRING_LIMITS.short, { required: false });
  if (ctx.errors.length > before || ctx.overflow) return undefined;
  if (
    archivalId === undefined || title === undefined || content === undefined ||
    cardType === undefined || tags === undefined || createdAt === undefined
  ) {
    return undefined;
  }
  return {
    archivalId,
    title,
    content,
    cardType,
    tags,
    createdAt,
    ...(imageUrl !== undefined ? { imageUrl } : {}),
    ...(confidence !== undefined ? { confidence } : {}),
    ...(date !== undefined ? { date } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(source !== undefined ? { source } : {}),
    ...(pdfUrl !== undefined ? { pdfUrl } : {}),
    ...(authors !== undefined ? { authors } : {}),
    ...(cassetteId !== undefined ? { cassetteId } : {}),
    ...(cassetteTitle !== undefined ? { cassetteTitle } : {}),
  };
}

function readNode(ctx: Ctx, raw: unknown, i: number): MemexNode | undefined {
  const path = `cards[${i}]`;
  if (!isObj(raw)) {
    fail(ctx, `${path} must be an object.`);
    return undefined;
  }
  noteUnknown(ctx, raw, NODE_KEYS);
  const before = ctx.errors.length;
  const id = readString(ctx, raw, "id", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  if (has(raw, "type") && raw.type !== "memexCard") fail(ctx, `${path}.type must be "memexCard".`);

  let position: { x: number; y: number } | undefined;
  if (!has(raw, "position")) fail(ctx, `${path}.position is required.`);
  else if (!isObj(raw.position)) fail(ctx, `${path}.position must be an object.`);
  else {
    noteUnknown(ctx, raw.position, POSITION_KEYS);
    const x = readNumber(ctx, raw.position, "x", `${path}.position`, -MAX_POSITION, MAX_POSITION);
    const y = readNumber(ctx, raw.position, "y", `${path}.position`, -MAX_POSITION, MAX_POSITION);
    if (x !== undefined && y !== undefined) position = { x: x + 0, y: y + 0 };
  }

  let style: { width?: number; height?: number } | undefined;
  if (has(raw, "style")) {
    if (!isObj(raw.style)) fail(ctx, `${path}.style must be an object.`);
    else {
      noteUnknown(ctx, raw.style, STYLE_KEYS);
      const width = readNumber(ctx, raw.style, "width", `${path}.style`, Number.MIN_VALUE, MAX_CARD_SIDE, { required: false });
      const height = readNumber(ctx, raw.style, "height", `${path}.style`, Number.MIN_VALUE, MAX_CARD_SIDE, { required: false });
      style = { ...(width !== undefined ? { width } : {}), ...(height !== undefined ? { height } : {}) };
    }
  }

  const data = has(raw, "data") ? readCardData(ctx, raw.data, `${path}.data`) : (fail(ctx, `${path}.data is required.`), undefined);
  if (ctx.errors.length > before || id === undefined || position === undefined || data === undefined) return undefined;
  return {
    id,
    type: "memexCard",
    position,
    ...(style !== undefined ? { style } : {}),
    data,
  };
}

function readEdge(ctx: Ctx, raw: unknown, i: number): AssociativeEdge | undefined {
  const path = `edges[${i}]`;
  if (!isObj(raw)) {
    fail(ctx, `${path} must be an object.`);
    return undefined;
  }
  noteUnknown(ctx, raw, EDGE_KEYS);
  const before = ctx.errors.length;
  const id = readString(ctx, raw, "id", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  const source = readString(ctx, raw, "source", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  const target = readString(ctx, raw, "target", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  if (has(raw, "type") && raw.type !== "associative") fail(ctx, `${path}.type must be "associative".`);
  // The seed annotates edges with `style: { stroke }`; only a hex color is kept.
  let stroke: string | undefined;
  if (has(raw, "style")) {
    if (!isObj(raw.style)) fail(ctx, `${path}.style must be an object.`);
    else {
      noteUnknown(ctx, raw.style, EDGE_STYLE_KEYS);
      if (typeof raw.style.stroke === "string" && STROKE_COLOR.test(raw.style.stroke)) stroke = raw.style.stroke;
      else if (has(raw.style, "stroke")) ctx.warnings.push(`${path}.style.stroke is not a hex color and was ignored.`);
    }
  }
  let data: AssociativeEdgeData | undefined;
  if (has(raw, "data")) {
    const d = raw.data;
    const dp = `${path}.data`;
    if (!isObj(d)) fail(ctx, `${dp} must be an object.`);
    else {
      noteUnknown(ctx, d, EDGE_DATA_KEYS);
      const origin = readEnum(ctx, d, "origin", dp, ORIGINS);
      const rationale = readString(ctx, d, "rationale", dp, BUNDLE_STRING_LIMITS.rationale);
      const strength = readNumber(ctx, d, "strength", dp, 0, 1);
      const trailId = readString(ctx, d, "trailId", dp, BUNDLE_STRING_LIMITS.id, { required: false });
      const polarity = readEnum(ctx, d, "polarity", dp, POLARITIES, false);
      const discoveryId = readString(ctx, d, "discoveryId", dp, BUNDLE_STRING_LIMITS.id, { required: false });
      if (origin !== undefined && rationale !== undefined && strength !== undefined) {
        data = {
          origin,
          rationale,
          strength,
          ...(trailId !== undefined ? { trailId } : {}),
          ...(polarity !== undefined ? { polarity } : {}),
          ...(discoveryId !== undefined ? { discoveryId } : {}),
        };
      }
    }
  }
  if (ctx.errors.length > before || id === undefined || source === undefined || target === undefined) return undefined;
  return {
    id,
    source,
    target,
    type: "associative",
    ...(stroke !== undefined ? { style: { stroke } } : {}),
    ...(data !== undefined ? { data } : {}),
  };
}

function readTrail(ctx: Ctx, raw: unknown, i: number): Trail | undefined {
  const path = `trails[${i}]`;
  if (!isObj(raw)) {
    fail(ctx, `${path} must be an object.`);
    return undefined;
  }
  noteUnknown(ctx, raw, TRAIL_KEYS);
  const before = ctx.errors.length;
  const id = readString(ctx, raw, "id", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  const title = readString(ctx, raw, "title", path, BUNDLE_STRING_LIMITS.title);
  const description = readString(ctx, raw, "description", path, BUNDLE_STRING_LIMITS.rationale);
  const origin = readEnum(ctx, raw, "origin", path, ORIGINS);
  const nodeIds = readStringArray(ctx, raw, "nodeIds", path, MAX_TRAIL_STOPS, BUNDLE_STRING_LIMITS.id, true);
  const createdAt = readTimestamp(ctx, raw, "createdAt", path);
  let color: string | undefined;
  if (has(raw, "color")) {
    color = normalizeTrailColor(raw.color);
    if (color === undefined) ctx.warnings.push(`${path}.color is not a #RRGGBB color and was ignored.`);
  }
  if (
    ctx.errors.length > before || id === undefined || title === undefined || description === undefined ||
    origin === undefined || nodeIds === undefined || createdAt === undefined
  ) {
    return undefined;
  }
  return { id, title, description, origin, nodeIds, createdAt, ...(color !== undefined ? { color } : {}) };
}

function readDiscovery(ctx: Ctx, raw: unknown, i: number): GhostDiscovery | undefined {
  const path = `ghostDiscoveries[${i}]`;
  if (!isObj(raw)) {
    fail(ctx, `${path} must be an object.`);
    return undefined;
  }
  noteUnknown(ctx, raw, DISCOVERY_KEYS);
  const before = ctx.errors.length;
  const id = readString(ctx, raw, "id", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  const sourceId = readString(ctx, raw, "sourceId", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  const targetId = readString(ctx, raw, "targetId", path, BUNDLE_STRING_LIMITS.id, { allowEmpty: false });
  const rationale = readString(ctx, raw, "rationale", path, BUNDLE_STRING_LIMITS.rationale);
  const confidence = readNumber(ctx, raw, "confidence", path, 0, 1);
  const trailId = readString(ctx, raw, "trailId", path, BUNDLE_STRING_LIMITS.id, { required: false });
  const discoveredAt = readTimestamp(ctx, raw, "discoveredAt", path);
  if (
    ctx.errors.length > before || id === undefined || sourceId === undefined || targetId === undefined ||
    rationale === undefined || confidence === undefined || discoveredAt === undefined
  ) {
    return undefined;
  }
  return { id, sourceId, targetId, rationale, confidence, ...(trailId !== undefined ? { trailId } : {}), discoveredAt };
}

function readSettings(ctx: Ctx, raw: unknown): ImportedGhostSettings {
  const settings: ImportedGhostSettings = { dismissedDiscoveryIds: [] };
  if (raw === undefined) return settings;
  if (!isObj(raw)) {
    ctx.warnings.push("ghostSettings is not an object and was ignored.");
    return settings;
  }
  noteUnknown(ctx, raw, SETTINGS_KEYS);
  if (raw.engine === "neural" || raw.engine === "live") settings.engine = raw.engine;
  else if (has(raw, "engine")) ctx.warnings.push("ghostSettings.engine is not a known engine and was ignored.");
  if (typeof raw.threshold === "number" && Number.isFinite(raw.threshold) && raw.threshold >= 0 && raw.threshold <= 1) {
    settings.threshold = raw.threshold;
  } else if (has(raw, "threshold")) ctx.warnings.push("ghostSettings.threshold is not within [0, 1] and was ignored.");
  if (has(raw, "dismissedDiscoveryIds")) {
    const before = ctx.errors.length;
    const ids = readStringArray(ctx, raw, "dismissedDiscoveryIds", "ghostSettings", MAX_BUNDLE_DISMISSED, BUNDLE_STRING_LIMITS.id, true);
    if (ids !== undefined && ctx.errors.length === before) {
      settings.dismissedDiscoveryIds = [...new Set(ids)].sort(cmpStr);
    }
  }
  return settings;
}

function readList<T>(
  ctx: Ctx, raw: unknown, name: string, max: number, read: (ctx: Ctx, item: unknown, i: number) => T | undefined,
  { required }: { required: boolean },
): T[] {
  if (raw === undefined) {
    if (required) fail(ctx, `"${name}" is required.`);
    return [];
  }
  if (!Array.isArray(raw)) {
    fail(ctx, `"${name}" must be an array.`);
    return [];
  }
  if (raw.length > max) {
    fail(ctx, `"${name}" has too many entries (${raw.length}, limit ${max}).`);
    return [];
  }
  const out: T[] = [];
  raw.forEach((item: unknown, i) => {
    const value = read(ctx, item, i);
    if (value !== undefined) out.push(value);
  });
  return out;
}

function checkUnique(ctx: Ctx, label: string, ids: readonly string[]): void {
  const seen = new Set<string>();
  for (const id of ids) {
    if (seen.has(id)) fail(ctx, `Duplicate ${label} id "${id}".`);
    seen.add(id);
  }
}

/**
 * Validates a bundle (or a legacy plain graph export) and rebuilds the graph
 * field by field. Never throws and never mutates anything: bad input yields
 * `{ ok: false, errors }`.
 *
 * Accepts: `schema: "memex-bundle"` with version `2.0` (another `2.x` is read
 * with a warning); or the plain `serializeGraph` format (`nodes`, `edges`,
 * optional `trails` and `ghostDiscoveries`) as version `"1.x"` with a warning.
 * Rejects: more than 5 MB, invalid JSON, the keys `__proto__`, `constructor` or
 * `prototype` anywhere, limits exceeded, any field of the wrong type or range,
 * `javascript:`-style URLs, duplicate ids, and dangling references (an edge,
 * trail stop or discovery that names a missing card). Dangling references are
 * rejected, not dropped, because the app never writes them: one means the file
 * was damaged or hand-edited, and a silent drop would lose links unnoticed.
 * Unknown fields are dropped and counted in one warning.
 */
export function validateAndImportBundle(json: string): BundleImportResult {
  try {
    return validate(json);
  } catch {
    return { ok: false, errors: ["The file could not be read as a Memex bundle."] };
  }
}

function validate(json: unknown): BundleImportResult {
  if (typeof json !== "string") return { ok: false, errors: ["The bundle must be provided as text."] };
  if (json.length > MAX_BUNDLE_BYTES) {
    return { ok: false, errors: [`The file is too large (limit ${MAX_BUNDLE_BYTES / 1_000_000} MB).`] };
  }
  if (json.length * 3 > MAX_BUNDLE_BYTES && new TextEncoder().encode(json).length > MAX_BUNDLE_BYTES) {
    return { ok: false, errors: [`The file is too large (limit ${MAX_BUNDLE_BYTES / 1_000_000} MB).`] };
  }
  let root: unknown;
  try {
    root = JSON.parse(json);
  } catch {
    return { ok: false, errors: ["The file is not valid JSON."] };
  }
  if (!isObj(root)) return { ok: false, errors: ["The file must contain a JSON object."] };
  const hostile = findHostileKey(root);
  if (hostile !== null) return { ok: false, errors: [hostile] };

  const ctx: Ctx = { errors: [], warnings: [], unknown: 0, overflow: false };
  let version: string;
  let cardsRaw: unknown;
  let settingsRaw: unknown;
  if (has(root, "schema")) {
    if (root.schema !== BUNDLE_SCHEMA) {
      return { ok: false, errors: [`Unsupported schema "${typeof root.schema === "string" ? root.schema : typeof root.schema}". Expected "${BUNDLE_SCHEMA}".`] };
    }
    const v = root.version;
    if (typeof v !== "string" || !/^2\.\d{1,3}$/.test(v)) {
      return { ok: false, errors: [`Unsupported bundle version ${typeof v === "string" ? `"${v}"` : "(missing)"}. This app reads version ${BUNDLE_VERSION}.`] };
    }
    if (v !== BUNDLE_VERSION) ctx.warnings.push(`Bundle version ${v} is newer than ${BUNDLE_VERSION}; unknown fields were ignored.`);
    version = v;
    noteUnknown(ctx, root, BUNDLE_KEYS);
    cardsRaw = root.cards;
    settingsRaw = root.ghostSettings;
  } else if (Array.isArray(root.nodes) && Array.isArray(root.edges)) {
    version = "1.x";
    ctx.warnings.push("Legacy graph file (no bundle header): imported as version 1.x. Ghost settings were not included.");
    noteUnknown(ctx, root, LEGACY_KEYS);
    cardsRaw = root.nodes;
  } else {
    return { ok: false, errors: ["This is not a Memex bundle or graph export."] };
  }

  const nodes = readList(ctx, cardsRaw, version === "1.x" ? "nodes" : "cards", MAX_BUNDLE_CARDS, readNode, { required: true });
  const edges = readList(ctx, root.edges, "edges", MAX_BUNDLE_EDGES, readEdge, { required: true });
  const trails = readList(ctx, root.trails, "trails", MAX_BUNDLE_TRAILS, readTrail, { required: version !== "1.x" });
  const ghostDiscoveries = readList(ctx, root.ghostDiscoveries, "ghostDiscoveries", MAX_BUNDLE_DISCOVERIES, readDiscovery, {
    required: version !== "1.x",
  });
  const ghostSettings = readSettings(ctx, settingsRaw);

  checkUnique(ctx, "card", nodes.map((n) => n.id));
  checkUnique(ctx, "edge", edges.map((e) => e.id));
  checkUnique(ctx, "trail", trails.map((t) => t.id));
  checkUnique(ctx, "discovery", ghostDiscoveries.map((g) => g.id));
  const cardIds = new Set(nodes.map((n) => n.id));
  for (const e of edges) {
    for (const end of [e.source, e.target]) {
      if (!cardIds.has(end)) fail(ctx, `Edge "${e.id}" points at a card that is not in the file ("${end}").`);
    }
  }
  for (const t of trails) {
    for (const id of t.nodeIds) {
      if (!cardIds.has(id)) fail(ctx, `Trail "${t.id}" lists a card that is not in the file ("${id}").`);
    }
  }
  for (const g of ghostDiscoveries) {
    for (const id of [g.sourceId, g.targetId]) {
      if (!cardIds.has(id)) fail(ctx, `Ghost discovery "${g.id}" points at a card that is not in the file ("${id}").`);
    }
  }

  if (ctx.errors.length > 0) {
    const errors = ctx.overflow ? [...ctx.errors, "More problems were found and not listed."] : ctx.errors;
    return { ok: false, errors };
  }
  if (ctx.unknown > 0) {
    ctx.warnings.push(`${ctx.unknown} unknown ${ctx.unknown === 1 ? "field was" : "fields were"} ignored.`);
  }
  return {
    ok: true,
    version,
    state: { nodes, edges, trails, ghostDiscoveries },
    ghostSettings,
    warnings: ctx.warnings,
  };
}
