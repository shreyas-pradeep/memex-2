import { create } from "zustand";
import type {
  Connection,
  EdgeChangeset,
  NodeChange,
  NodeChangeset,
} from "@xyflow/react";
import {
  acceptDiscovery,
  addNode as addNodePure,
  edgeId as edgeIdOf,
  snapConnect,
  areConnected,
  computeAutoLayout,
  connectNodes,
  createTrail as createTrailPure,
  deserializeGraph,
  nextArchivalId,
  removeDiscovery,
  removeNodes as removeNodesPure,
  removeTrail as removeTrailPure,
  serializeGraph,
  toggleEdgePolarity as toggleEdgePolarityPure,
} from "@/core/graph-engine";
import { CARD_ACCENTS } from "@/core/types";
import type {
  AssociativeEdge,
  AssociativeEdgeData,
  MemexCardType,
  GhostDiscovery,
  LinkOrigin,
  MemexGraphState,
  MemexNode,
  MemexNodeData,
  Trail,
} from "@/core/types";
import {
  clampTrailIndex,
  getNextTrailIndex,
  getPrevTrailIndex,
} from "@/core/trail-engine";
import { buildManualTrail, loadTrailState } from "@/core/curators-index";
import { DEFAULT_CARD_SIZE, nodeRect } from "@/core/card-geometry";
import {
  cassetteRefs,
  moveCassette as moveCassettePure,
  resolveCassetteId,
} from "@/core/cassette-engine";
import {
  INITIAL_DOCK,
  dockForSelection,
  dockReducer,
  isTrailsOpen,
  resolveDockKey,
  type DockKeyEvent,
  type DockKeyResult,
  type DockState,
  type DockTab,
} from "@/core/command-dock";
import {
  buildMagneticCandidates,
  findMagneticTarget,
  sameMagneticTarget,
  type MagneticTarget,
} from "@/core/magnetic-engine";
import { normalizeTag, type SpotlightType } from "@/core/spotlight";
import {
  exportMemexBundle,
  exportObsidianVaultZip,
  validateAndImportBundle,
  type BundleImportResult,
} from "@/core/vault-bundle";
import {
  DEFAULT_GHOST_THRESHOLD,
  detectGhostSynapses,
  forgeGhostTrail,
  ghostPairKey,
  sanitizeGhostSuggestions,
} from "@/core/ghost-engine";
import { generateAutoTrails, isDuplicateTrail } from "@/core/trail-genesis";
import { GEMINI_KEY_HEADER, loadUserGeminiKey } from "./ai-settings";
import { demoSeed } from "@/data/demo-seed";

/**
 * Saves live under this key. Graphs saved under the earlier key
 * (`memex-2:graph:v1`, the 1945 seed) are left untouched and no longer loaded.
 */
export const STORAGE_KEY = "memex-research-workspace-v1";
/** Dismissed ghost discovery IDs: a sorted JSON array, kept apart from the graph schema. */
export const GHOST_DISMISSED_KEY = "memex-2:ghost-dismissed:v1";
/** Quiet period after the last card creation before the proactive scan runs. */
export const GHOST_AUTOSCAN_MS = 1200;
/** Minimum time the scanning state stays visible, so the radar state is readable. */
export const GHOST_SCAN_MIN_MS = 600;
/** Client-side ceiling for the live route (the server allows two 12s upstream tries). */
export const GHOST_LIVE_TIMEOUT_MS = 30_000;

/** Which engine produced the last scan. Session-only. */
export type GhostEngineMode = "live" | "neural";

/** Fresh deep copy of the demo seed (1945-2026 cognitive AI research) (never hands out the shared module object). */
function freshSeed(): MemexGraphState {
  return deserializeGraph(serializeGraph(demoSeed));
}

function getStorage(): Storage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Accessing localStorage can throw (e.g. blocked by privacy settings).
    return null;
  }
}

/**
 * Makes `style: { width, height }` the single source of truth for card size.
 *
 * `NodeResizer` emits dimension changes with `setAttributes`, which React Flow
 * applies as `node.width` / `node.height`. Those attributes would outrank the
 * (stale) seeded `style` size, so the new size is moved into `style` and the
 * attributes are dropped. Nodes without a resize change are returned as-is.
 */
function moveSizeToStyle(
  nodes: MemexNode[],
  changes: NodeChange<MemexNode>[],
): MemexNode[] {
  const sizes = new Map<string, { width: number; height: number }>();
  for (const c of changes) {
    if (c.type === "dimensions" && c.setAttributes && c.dimensions) {
      sizes.set(c.id, c.dimensions);
    }
  }
  if (sizes.size === 0) return nodes;
  return nodes.map((n) => {
    const size = sizes.get(n.id);
    if (!size) return n;
    const { width, height, ...rest } = n;
    void width;
    void height;
    return { ...rest, style: { ...n.style, width: size.width, height: size.height } };
  });
}

/**
 * Drops React Flow runtime-only fields (selection, drag flag, measured size)
 * so persisted JSON contains only the archival graph. Card size lives in
 * `style: { width, height }`.
 */
function toPersistable(state: MemexGraphState): MemexGraphState {
  return {
    ...state,
    nodes: state.nodes.map((n) => {
      const { selected, dragging, measured, resizing, ...rest } = n;
      void selected;
      void dragging;
      void measured;
      void resizing;
      return rest;
    }),
    edges: state.edges.map((e) => {
      const { selected, ...rest } = e;
      void selected;
      return rest;
    }),
  };
}

/** Writes the graph to localStorage. Failures (quota, unavailable) are ignored. */
export function persistGraph(state: MemexGraphState): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_KEY, serializeGraph(toPersistable(state)));
  } catch {
    // Quota exceeded or storage disabled: the in-memory graph keeps working.
  }
}

export { DEFAULT_CARD_SIZE };

/**
 * Gives cards saved before resizing existed (no `style` size, no `width` /
 * `height`) the default size so they do not collapse. Sized cards are untouched.
 */
function withDefaultSizes(state: MemexGraphState): MemexGraphState {
  return {
    ...state,
    nodes: state.nodes.map((n) => {
      const hasWidth = n.width !== undefined || n.style?.width !== undefined;
      const hasHeight = n.height !== undefined || n.style?.height !== undefined;
      if (hasWidth && hasHeight) return n;
      return {
        ...n,
        style: {
          ...(hasWidth ? {} : { width: DEFAULT_CARD_SIZE.width }),
          ...(hasHeight ? {} : { height: DEFAULT_CARD_SIZE.height }),
          ...n.style,
        },
      };
    }),
  };
}

/** Reads the stored graph, or `null` when absent, unavailable or corrupt. */
export function loadPersistedGraph(): MemexGraphState | null {
  const storage = getStorage();
  if (!storage) return null;
  try {
    const json = storage.getItem(STORAGE_KEY);
    return json === null ? null : withDefaultSizes(deserializeGraph(json));
  } catch {
    return null;
  }
}

/** Dismissed discovery IDs; empty when absent, unavailable or corrupt. */
export function loadDismissedGhostIds(): string[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw: unknown = JSON.parse(storage.getItem(GHOST_DISMISSED_KEY) ?? "[]");
    return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
  } catch {
    return [];
  }
}

function saveDismissedGhostIds(ids: Iterable<string>): void {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(GHOST_DISMISSED_KEY, JSON.stringify([...new Set(ids)].sort()));
  } catch {
    // Quota exceeded or storage disabled: dismissals last for this session only.
  }
}

function clearDismissedGhostIds(): void {
  try {
    getStorage()?.removeItem(GHOST_DISMISSED_KEY);
  } catch {
    // Storage unavailable: nothing to clear.
  }
}

let autoScanTimer: ReturnType<typeof setTimeout> | undefined;
let scanHoldTimer: ReturnType<typeof setTimeout> | undefined;
let scanInFlight: Promise<void> | null = null;

/** Cancels a pending proactive scan (used on reset/import and by tests). */
export function cancelGhostAutoScan(): void {
  if (autoScanTimer !== undefined) clearTimeout(autoScanTimer);
  autoScanTimer = undefined;
}

function sameDiscoveries(a: GhostDiscovery[], b: GhostDiscovery[]): boolean {
  return (
    a.length === b.length &&
    a.every(
      (d, i) =>
        d.id === b[i].id &&
        d.confidence === b[i].confidence &&
        d.rationale === b[i].rationale &&
        d.trailId === b[i].trailId,
    )
  );
}

function pick(s: MemexGraphState): MemexGraphState {
  return {
    nodes: s.nodes,
    edges: s.edges,
    trails: s.trails,
    ghostDiscoveries: s.ghostDiscoveries,
  };
}

/** Card fields that can be edited inline. */
export type CardUpdate = Partial<Pick<MemexNodeData, "title" | "content" | "tags">> & {
  /** Image URL; an empty string removes the image. */
  imageUrl?: string;
  /** Event year; `null` removes it. */
  year?: number | null;
  /** Event date (`YYYY-MM` or `YYYY-MM-DD`); `null` removes it. */
  date?: string | null;
};

/** How long a timeline-triggered card highlight lasts. */
export const HIGHLIGHT_MS = 1800;
let highlightTimer: ReturnType<typeof setTimeout> | undefined;

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

/** Playback state. Session-only: never persisted or exported. */
const IDLE_PLAYBACK = {
  activeTrailId: null,
  activeTrailIndex: 0,
  isPlayingAuto: false,
} as const;

/** Ghost UI state. Session-only: never persisted or exported. */
const IDLE_GHOST = {
  isGhostScanning: false,
  selectedGhostDiscoveryId: null,
  inspectedEdgeId: null,
  ghostEngineMode: "neural" as GhostEngineMode,
};

/** Spotlight filters (Spec 09). Session-only: never persisted or exported. */
const IDLE_SPOTLIGHT = {
  spotlightQuery: "",
  spotlightType: "all" as SpotlightType,
  spotlightTags: [] as string[],
};

/** Longest spotlight query and most selected tags kept. */
export const SPOTLIGHT_QUERY_MAX = 200;
export const SPOTLIGHT_TAGS_MAX = 20;
/** How long `lastSnapEdgeId` stays set, so the snap pulse can play. */
export const SNAP_PULSE_MS = 1200;
let snapTimer: ReturnType<typeof setTimeout> | undefined;

/** Per-drag cache for magnetic snapping: built once at drag start, read per frame. Never React state. */
interface MagneticSession {
  nodeId: string;
  candidates: MagneticTarget[];
  /** Candidate cards by id (the other cards do not move while one card is dragged). */
  nodes: Map<string, MemexNode>;
  /** Index of the dragged card in `nodes`, so a frame finds it in O(1). */
  hint: number;
}
let magneticSession: MagneticSession | null = null;

/** True while a magnetic drag is being tracked (for tests and diagnostics). */
export function hasMagneticSession(): boolean {
  return magneticSession !== null;
}

function sameDock(a: DockState, b: DockState): boolean {
  return a.open === b.open && a.tab === b.tab;
}

/** Identity of the graph as the scan sees it: card ids plus connected pairs (ignores drags). */
function graphSignature(nodes: readonly MemexNode[], edges: readonly AssociativeEdge[]): string {
  const ids = nodes.map((n) => n.id).sort().join("|");
  const pairs = edges.map((e) => ghostPairKey(e.source, e.target)).sort().join("|");
  return `${ids}#${pairs}`;
}

/**
 * Asks `/api/ghost` for live discoveries. Resolves `null` on any failure,
 * non-ok status, timeout or `source !== "live"`, so the caller can fall back
 * to the local engine. Sends the user's saved key (if any) in a header only.
 */
async function fetchLiveSuggestions(
  nodes: readonly MemexNode[],
  edges: readonly AssociativeEdge[],
): Promise<unknown[] | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), GHOST_LIVE_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = { "Content-Type": "application/json" };
    const userKey = loadUserGeminiKey();
    if (userKey !== "") headers[GEMINI_KEY_HEADER] = userKey;
    const res = await fetch("/api/ghost", {
      method: "POST",
      headers,
      signal: controller.signal,
      body: JSON.stringify({
        nodes: nodes.map((n) => ({ id: n.id, data: n.data })),
        existingEdges: edges.map((e) => ({ source: e.source, target: e.target })),
      }),
    });
    if (!res.ok) return null;
    const body: unknown = await res.json();
    if (typeof body !== "object" || body === null) return null;
    const { source, discoveries } = body as { source?: unknown; discoveries?: unknown };
    return source === "live" && Array.isArray(discoveries) ? (discoveries as unknown[]) : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}


export interface MemexStore extends MemexGraphState {
  /** Session-only: true while the Ghost Engine scan indicator is showing. */
  isGhostScanning: boolean;
  /** Session-only: discovery open in the Synapse tab of the command dock. */
  selectedGhostDiscoveryId: string | null;
  /**
   * Session-only: real edge open in the Synapse tab (Spec 09). Ghost discoveries
   * use `selectedGhostDiscoveryId`; selecting one clears the other.
   */
  inspectedEdgeId: string | null;
  /** Inspects a real edge (unknown ids and `null` clear it) and opens the Synapse tab. */
  inspectEdge: (id: string | null) => void;
  /** Session-only: engine that produced the last scan ("live" Gemini or local "neural"). */
  ghostEngineMode: GhostEngineMode;
  /**
   * Scans the canvas for unconnected, non-dismissed bridges and stores them.
   * Tries the live `/api/ghost` route first and falls back to the local engine
   * on any failure; `{ live: false }` (used by the debounced auto-scan so it
   * never spends API quota) goes straight to the local engine. Concurrent
   * calls share one in-flight scan.
   */
  triggerGhostScan: (options?: { live?: boolean }) => Promise<void>;
  selectGhostDiscovery: (id: string | null) => void;
  /** Turns a ghost synapse into a human edge and removes the discovery. */
  acceptGhostDiscovery: (id: string) => void;
  /** Removes the discovery and keeps the pair from reappearing in later scans. */
  dismissGhostDiscovery: (id: string) => void;
  /** Forges a ghost trail from the discovery and starts playback; returns its ID. */
  convertDiscoveryToTrail: (id: string) => string | null;

  /** Trail currently in cinematic playback, or `null`. Not persisted. */
  activeTrailId: string | null;
  /** Zero-based stop within the active trail. */
  activeTrailIndex: number;
  isPlayingAuto: boolean;

  /** Session-only: user's choice for the chronological timeline bar. Not persisted. */
  isTimelineOpen: boolean;
  /** Session-only: card briefly pulsing after a timeline jump. Auto-clears. */
  highlightedNodeId: string | null;
  toggleTimeline: () => void;
  setTimelineOpen: (open: boolean) => void;
  highlightNode: (id: string) => void;

  /**
   * Session-only: the Curator's Index drawer (Spec 08). Never persisted,
   * exported or read back; `hydrate`, `resetToSeed` and `importJson` leave it
   * as it is (it is interface state, like `isTimelineOpen`), and it starts closed.
   */
  isCuratorDrawerOpen: boolean;
  /**
   * Session-only: the Research Command Dock (Spec 09). `isCuratorDrawerOpen` is
   * a thin alias of `commandDock.open && commandDock.tab === "trails"`.
   */
  commandDock: DockState;
  /** Session-only: bumped when `/` asks the Spotlight search field for focus. */
  dockFocusRequest: number;
  openDockTab: (tab: DockTab) => void;
  toggleDockTab: (tab: DockTab) => void;
  collapseDock: () => void;
  expandDock: () => void;
  /** Applies a key press through the dock rules and returns what the listener must do. */
  dispatchDockKey: (event: DockKeyEvent) => DockKeyResult;
  /**
   * Session-only: bumped by `loadTrailIntoLever` so the camera director glides
   * to stop 1 even when that trail is already active at stop 1.
   */
  trailCameraNonce: number;
  toggleCuratorDrawer: () => void;
  setCuratorDrawerOpen: (open: boolean) => void;

  /** Session-only: the card offer shown while a card is dragged next to a related one. */
  magneticTarget: MagneticTarget | null;
  /** Session-only: edge created by the last magnetic snap; clears itself after `SNAP_PULSE_MS`. */
  lastSnapEdgeId: string | null;
  /** Starts tracking a drag: scores the card against the canvas once and caches the candidates. */
  beginMagneticDrag: (nodeId: string) => void;
  /** Per frame: O(candidates) rectangle checks against the cache; updates state only when the offer changes. */
  updateMagneticDrag: (nodeId: string) => void;
  /** Drop: connects to the offered card (like accepting a discovery) and clears the session. */
  endMagneticDrag: (nodeId: string) => { snapped: boolean; edgeId?: string };
  /** Drops the cache and the offer without connecting (drag cancelled, unmount). */
  cancelMagneticDrag: () => void;
  /**
   * Moves every card of a cassette by `(dx, dy)` in one update. Persists only
   * when `commit` is true (the end of the drag, which persists even with a zero delta).
   */
  moveCassette: (cassetteId: string, dx: number, dy: number, options?: { commit?: boolean }) => void;

  /** Session-only spotlight filters (Spec 09). */
  spotlightQuery: string;
  spotlightType: SpotlightType;
  spotlightTags: string[];
  setSpotlightQuery: (query: string) => void;
  setSpotlightType: (type: SpotlightType) => void;
  toggleSpotlightTag: (tag: string) => void;
  clearSpotlight: () => void;

  /** True once `hydrate()` has run on the client. */
  hydrated: boolean;

  /**
   * Loads the persisted graph (falling back to the demo seed when nothing valid
   * is stored). Call once on the client after mount; the initial state is the
   * seed so server and first client render match.
   */
  hydrate: () => void;

  // @xyflow/react handlers
  onNodesChange: (changes: NodeChangeset<MemexNode>) => void;
  onEdgesChange: (changes: EdgeChangeset<AssociativeEdge>) => void;
  onConnect: (connection: Connection) => void;

  // Graph engine actions
  addNode: (node: MemexNode) => void;
  /**
   * Adds an ingested source (cards plus edges) in one update and persists once.
   * Cards whose ID already exists are dropped; archival IDs are reassigned so
   * they are unique on the canvas; edges are validated by the graph engine.
   * Then starts one local ghost scan (the debounced auto-scan is cancelled).
   * Returns the IDs of the cards actually added.
   */
  ingestSource: (nodes: MemexNode[], edges: AssociativeEdge[]) => string[];
  removeNodes: (ids: string[]) => void;
  /** Updates a card's title, content, tags, image and/or event date. No-op when nothing changes. */
  updateCard: (id: string, data: CardUpdate) => void;
  connect: (
    source: string,
    target: string,
    origin: LinkOrigin,
    data?: Partial<Omit<AssociativeEdgeData, "origin">>,
  ) => void;
  createTrail: (trail: Trail) => void;
  /**
   * Advances a real edge's polarity (supports -> refutes -> synthesizes ->
   * supports) and persists it. Unknown ids are a no-op; display-only ghost
   * synapses are not store edges, so they cannot be toggled.
   */
  toggleEdgePolarity: (edgeId: string) => void;
  setGhostDiscoveries: (discoveries: GhostDiscovery[]) => void;
  autoLayout: () => void;

  /** Starts playback of a trail at stop 0, or exits playback with `null`. */
  setActiveTrail: (trailId: string | null) => void;
  nextTrailStep: () => void;
  prevTrailStep: () => void;
  setTrailStep: (index: number) => void;
  toggleAutoPlay: () => void;
  exitTrailPlayback: () => void;
  /** Creates a human trail from ordered card IDs and returns its ID (null when fewer than 2 valid cards). */
  forgeTrail: (title: string, description: string, nodeIds: string[]) => string | null;
  /**
   * Blazes a manual trail (Spec 08), built on `forgeCustomTrail`. The order of
   * `cardIds` is kept; repeats (first occurrence wins) and unknown ids are
   * dropped; fewer than 2 valid cards returns `null` and changes nothing. The
   * id is unique among existing trails, the origin is `human`, the name is
   * trimmed (empty becomes "Untitled Trail"), and an optional `#RRGGBB` color
   * is kept when valid. Persists once and returns the new trail id.
   */
  createManualTrail: (
    name: string,
    description: string,
    cardIds: readonly string[],
    color?: string,
  ) => string | null;
  /**
   * Removes a trail and persists once. Unknown ids are a no-op. Deleting the
   * trail that is playing ends playback (the same reset as `exitTrailPlayback`).
   * Auto trails can be generated again afterwards.
   */
  deleteTrail: (trailId: string) => void;
  /**
   * Loads a trail into the 1945 Lever: it becomes the active trail at stop 0
   * with auto-play off, the Curator's Index closes and the camera glides to
   * stop 1. Unknown or empty trails are a no-op.
   */
  loadTrailIntoLever: (trailId: string) => void;
  /**
   * Generates the auto trails the live graph supports (Lineage Arc, Dialectical
   * Debate, Dense Conceptual Nexus) and stores those that are new: a trail whose
   * id or ordered card sequence already exists is skipped. Persists once and
   * returns the trails actually added; `[]` (and no write) when nothing is new.
   * Never touches playback state.
   */
  generateAndAddAutoTrails: () => Trail[];

  /** Replaces the whole graph with the demo seed and persists it. */
  resetToSeed: () => void;
  exportJson: () => string;
  /** Replaces the graph from JSON; throws (state untouched) when the JSON is invalid. */
  importJson: (json: string) => void;
  /** The portable `.memex` bundle (Spec 09): graph plus ghost settings, never any API key. */
  exportBundleJson: () => string;
  /**
   * Validates a bundle (or a legacy graph export) and, when it is valid,
   * replaces the graph like `importJson` does and restores the dismissed ghost
   * ids. On failure nothing changes. Never throws.
   */
  importBundle: (json: string) => BundleImportResult;
  /** The vault as an Obsidian-ready ZIP (one Markdown file per card). */
  exportObsidianZip: () => Promise<Blob>;
}

export const useMemexStore = create<MemexStore>()((set, get) => {
  /** Applies a graph update, then persists it. */
  const commit = (next: MemexGraphState) => {
    const current = get();
    if (
      next.nodes === current.nodes &&
      next.edges === current.edges &&
      next.trails === current.trails &&
      next.ghostDiscoveries === current.ghostDiscoveries
    ) {
      return;
    }
    // Keep playback valid when the graph changes under it (e.g. a card in the
    // active trail is deleted).
    // Close the inspector when its discovery disappears (deleted card, accept, dismiss).
    const selected = current.selectedGhostDiscoveryId;
    const selection =
      selected !== null && !next.ghostDiscoveries.some((g) => g.id === selected)
        ? { selectedGhostDiscoveryId: null }
        : {};
    const inspected = current.inspectedEdgeId;
    const inspection =
      inspected !== null && !next.edges.some((e) => e.id === inspected)
        ? { inspectedEdgeId: null }
        : {};
    const trailId = current.activeTrailId;
    if (trailId !== null) {
      const trail = next.trails.find((t) => t.id === trailId);
      const index = trail ? clampTrailIndex(current.activeTrailIndex, trail.nodeIds.length) : -1;
      if (index === -1) set({ ...next, ...IDLE_PLAYBACK, ...selection, ...inspection });
      else set({ ...next, activeTrailIndex: index, ...selection, ...inspection });
    } else {
      set({ ...next, ...selection, ...inspection });
    }
    if (magneticSession !== null) reconcileMagneticSession(next);
    persistGraph(next);
  };

  /** Sets the dock and its Spec 08 alias together; skips the write when nothing changes. */
  const applyDock = (dock: DockState) => {
    const current = get();
    const alias = isTrailsOpen(dock);
    if (sameDock(dock, current.commandDock) && current.isCuratorDrawerOpen === alias) return;
    set({ commandDock: dock, isCuratorDrawerOpen: alias });
  };

  /** Ends the magnetic session without connecting anything. */
  const cancelMagnetic = () => {
    magneticSession = null;
    if (get().magneticTarget !== null) set({ magneticTarget: null });
  };

  /** Keeps the session valid when the graph changes under a drag (card deleted, pair connected). */
  const reconcileMagneticSession = (graph: MemexGraphState) => {
    const session = magneticSession;
    if (session === null) return;
    const ids = new Set(graph.nodes.map((n) => n.id));
    if (!ids.has(session.nodeId)) return cancelMagnetic();
    const candidates = session.candidates.filter(
      (c) => ids.has(c.targetId) && !areConnected(graph.edges, c.sourceId, c.targetId),
    );
    if (candidates.length === session.candidates.length) return;
    session.candidates = candidates;
    const target = get().magneticTarget;
    if (target !== null && !candidates.includes(target)) set({ magneticTarget: null });
  };

  /** Replaces the graph for an import: the same session resets as `importJson`. */
  const replaceGraph = (graph: MemexGraphState) => {
    cancelGhostAutoScan();
    cancelMagnetic();
    set({ ...graph, ...IDLE_PLAYBACK, ...IDLE_GHOST, ...IDLE_SPOTLIGHT });
    persistGraph(graph);
  };

  return {
    ...freshSeed(),
    ...IDLE_PLAYBACK,
    ...IDLE_GHOST,
    hydrated: false,
    isTimelineOpen: true,
    highlightedNodeId: null,
    isCuratorDrawerOpen: false,
    commandDock: INITIAL_DOCK,
    dockFocusRequest: 0,
    trailCameraNonce: 0,
    magneticTarget: null,
    lastSnapEdgeId: null,
    ...IDLE_SPOTLIGHT,

    // Spec 08 aliases: "the drawer" is the dock showing the Trails tab. The
    // alias flag decides the direction, so a flag set by hand stays consistent.
    toggleCuratorDrawer: () => get().setCuratorDrawerOpen(!get().isCuratorDrawerOpen),
    setCuratorDrawerOpen: (open) => {
      const dock = get().commandDock;
      applyDock(
        open
          ? dockReducer(dock, { type: "openTab", tab: "trails" })
          : isTrailsOpen(dock)
            ? dockReducer(dock, { type: "collapse" })
            : dock,
      );
    },
    openDockTab: (tab) => applyDock(dockReducer(get().commandDock, { type: "openTab", tab })),
    toggleDockTab: (tab) => applyDock(dockReducer(get().commandDock, { type: "toggleTab", tab })),
    collapseDock: () => applyDock(dockReducer(get().commandDock, { type: "collapse" })),
    expandDock: () => applyDock(dockReducer(get().commandDock, { type: "expand" })),
    dispatchDockKey: (event) => {
      const result = resolveDockKey(get().commandDock, event);
      applyDock(result.state);
      if (result.focusSpotlightInput) set({ dockFocusRequest: get().dockFocusRequest + 1 });
      return result;
    },

    beginMagneticDrag: (nodeId) => {
      const { nodes, edges } = get();
      cancelMagnetic();
      const hint = nodes.findIndex((n) => n.id === nodeId);
      if (hint === -1) return;
      // React Flow drags every selected card together: no target for a group. A plain press collapses a
      // multi-selection to the pressed card before the drag (SingleCardDragIsolation), so only a deliberate
      // group drag (Shift/Cmd/Ctrl held) reaches this guard.
      if (nodes[hint].selected === true && nodes.filter((n) => n.selected === true).length > 1) return;
      const candidates = buildMagneticCandidates(nodeId, nodes, edges);
      const wanted = new Set(candidates.map((c) => c.targetId));
      magneticSession = {
        nodeId,
        candidates,
        nodes: new Map(nodes.filter((n) => wanted.has(n.id)).map((n) => [n.id, n])),
        hint,
      };
    },

    updateMagneticDrag: (nodeId) => {
      const session = magneticSession;
      if (session === null || session.nodeId !== nodeId) {
        if (get().magneticTarget !== null) set({ magneticTarget: null });
        return;
      }
      const nodes = get().nodes;
      let node = nodes[session.hint];
      if (node === undefined || node.id !== nodeId) {
        session.hint = nodes.findIndex((n) => n.id === nodeId);
        if (session.hint === -1) return cancelMagnetic();
        node = nodes[session.hint];
      }
      const rect = nodeRect(node);
      const target = rect === null ? null : findMagneticTarget(rect, session.candidates, session.nodes);
      if (!sameMagneticTarget(target, get().magneticTarget)) set({ magneticTarget: target });
    },

    endMagneticDrag: (nodeId) => {
      const session = magneticSession;
      const target = get().magneticTarget;
      magneticSession = null;
      if (session === null || session.nodeId !== nodeId || target === null || target.sourceId !== nodeId) {
        if (target !== null) set({ magneticTarget: null });
        return { snapped: false };
      }
      const graph = pick(get());
      const next = snapConnect(graph, target.sourceId, target.targetId, {
        rationale: target.rationale,
        strength: target.affinity,
      });
      if (next === graph) {
        set({ magneticTarget: null });
        return { snapped: false };
      }
      commit(next);
      const edgeId = edgeIdOf(target.sourceId, target.targetId, "human");
      set({ magneticTarget: null, lastSnapEdgeId: edgeId });
      if (snapTimer !== undefined) clearTimeout(snapTimer);
      snapTimer = setTimeout(() => {
        snapTimer = undefined;
        if (get().lastSnapEdgeId === edgeId) set({ lastSnapEdgeId: null });
      }, SNAP_PULSE_MS);
      return { snapped: true, edgeId };
    },

    cancelMagneticDrag: () => cancelMagnetic(),

    moveCassette: (cassetteId, dx, dy, options) => {
      const state = get();
      if (!state.nodes.some((n) => n.data.cassetteId === cassetteId)) return;
      const nodes = moveCassettePure(state.nodes, cassetteId, dx, dy);
      if (options?.commit === true) {
        const graph = { ...pick(state), nodes };
        // The end of a drag persists even when the last frame moved nothing.
        if (nodes === state.nodes) persistGraph(graph);
        else commit(graph);
      } else if (nodes !== state.nodes) {
        set({ nodes });
      }
    },

    setSpotlightQuery: (query) => {
      const next = query.slice(0, SPOTLIGHT_QUERY_MAX);
      if (next !== get().spotlightQuery) set({ spotlightQuery: next });
    },
    setSpotlightType: (type) => {
      const valid: readonly SpotlightType[] = ["all", "note", "quote", "artifact", "ghost"];
      if (valid.includes(type) && type !== get().spotlightType) set({ spotlightType: type });
    },
    toggleSpotlightTag: (tag) => {
      const key = normalizeTag(tag);
      if (key === "") return;
      const tags = get().spotlightTags;
      if (tags.includes(key)) return set({ spotlightTags: tags.filter((t) => t !== key) });
      if (tags.length >= SPOTLIGHT_TAGS_MAX) return;
      set({ spotlightTags: [...tags, key] });
    },
    clearSpotlight: () => {
      const s = get();
      if (s.spotlightQuery !== "" || s.spotlightType !== "all" || s.spotlightTags.length > 0) {
        set({ ...IDLE_SPOTLIGHT, spotlightTags: [] });
      }
    },

    toggleTimeline: () => set({ isTimelineOpen: !get().isTimelineOpen }),
    setTimelineOpen: (open) => set({ isTimelineOpen: open }),
    highlightNode: (id) => {
      if (highlightTimer !== undefined) clearTimeout(highlightTimer);
      set({ highlightedNodeId: id });
      highlightTimer = setTimeout(() => {
        highlightTimer = undefined;
        if (get().highlightedNodeId === id) set({ highlightedNodeId: null });
      }, HIGHLIGHT_MS);
    },

    hydrate: () => {
      cancelGhostAutoScan();
      cancelMagnetic();
      set({
        ...(loadPersistedGraph() ?? freshSeed()),
        ...IDLE_PLAYBACK,
        ...IDLE_GHOST,
        hydrated: true,
      });
    },

    onNodesChange: (changes) => {
      const removed = changes.getByType("remove").map((c) => c.id);

      // Removals go through the graph engine so edges, trails and ghost
      // discoveries are purged (Requirement 2.3). The remaining changes are
      // then applied by React Flow's changeset (its `remove` entries are no-ops
      // for nodes that are already gone).
      let next = pick(get());
      if (removed.length > 0) next = removeNodesPure(next, removed);
      const all = changes.toArray();
      next = {
        ...next,
        nodes: moveSizeToStyle(changes.applyTo(next.nodes), all),
      };

      // Persist only durable changes. Drag and resize frames, selection and
      // measurement changes update the store at 60fps without touching
      // localStorage; the final drag frame (`dragging: false`) and the resize
      // end (`resizing: false`) persist.
      const resizingFrame = all.some(
        (c) => c.type === "dimensions" && c.resizing === true,
      );
      const durable =
        !resizingFrame &&
        all.some(
          (c) =>
            c.type === "remove" ||
            c.type === "add" ||
            c.type === "replace" ||
            c.type === "update" ||
            c.type === "data" ||
            (c.type === "dimensions" && c.resizing === false) ||
            (c.type === "position" && c.dragging !== true),
        );

      if (durable) commit(next);
      else set({ nodes: next.nodes });
    },

    onEdgesChange: (changes) => {
      const state = get();
      const edges = changes.applyTo(state.edges);
      const durable = changes.toArray().some((c) => c.type !== "select");
      if (durable) commit({ ...pick(state), edges });
      else set({ edges });
    },

    onConnect: ({ source, target }) => {
      if (!source || !target) return;
      commit(connectNodes(pick(get()), source, target, "human"));
    },

    addNode: (node) => {
      const before = get().nodes;
      commit(addNodePure(pick(get()), node));
      if (get().nodes === before) return;
      // Proactive discovery: one timer, restarted by every new card, so a burst
      // of cards causes a single scan.
      cancelGhostAutoScan();
      autoScanTimer = setTimeout(() => {
        autoScanTimer = undefined;
        // Auto-scans stay local so card creation never spends API quota.
        void get().triggerGhostScan({ live: false });
      }, GHOST_AUTOSCAN_MS);
    },
    ingestSource: (incoming, incomingEdges) => {
      let graph = pick(get());
      const added: string[] = [];
      // Cassette ids are re-checked against the canvas at insertion time (the
      // check is idempotent when the platen already resolved them).
      const existingCassettes = cassetteRefs(graph.nodes);
      const cassetteMap = new Map<string, string>();
      for (const node of incoming) {
        const cid = node.data.cassetteId;
        if (cid !== undefined && !cassetteMap.has(cid)) {
          cassetteMap.set(cid, resolveCassetteId(cid, node.data.cassetteTitle ?? cid, existingCassettes));
        }
      }
      for (const node of incoming) {
        const cid = node.data.cassetteId;
        const fresh: MemexNode = {
          ...node,
          data: {
            ...node.data,
            archivalId: nextArchivalId(graph.nodes),
            ...(cid !== undefined ? { cassetteId: cassetteMap.get(cid) ?? cid } : {}),
          },
        };
        const next = addNodePure(graph, fresh);
        if (next !== graph) added.push(node.id);
        graph = next;
      }
      if (added.length === 0) return [];
      const addedSet = new Set(added);
      for (const e of incomingEdges) {
        if (!addedSet.has(e.source) || !addedSet.has(e.target)) continue;
        graph = connectNodes(graph, e.source, e.target, "human", {
          rationale: e.data?.rationale ?? "",
          strength: e.data?.strength ?? 0.5,
        });
      }
      commit(graph);
      // One scan: drop any pending debounced one, then scan locally (no API quota).
      cancelGhostAutoScan();
      const scan = () => void get().triggerGhostScan({ live: false });
      if (scanInFlight) void scanInFlight.then(scan);
      else scan();
      return added;
    },
    removeNodes: (ids) => commit(removeNodesPure(pick(get()), ids)),
    updateCard: (id, data) => {
      const state = get();
      const node = state.nodes.find((n) => n.id === id);
      if (!node) return;
      const unchanged =
        (data.title === undefined || data.title === node.data.title) &&
        (data.content === undefined || data.content === node.data.content) &&
        (data.tags === undefined || sameTags(data.tags, node.data.tags)) &&
        (data.imageUrl === undefined || data.imageUrl === (node.data.imageUrl ?? "")) &&
        (data.year === undefined || (data.year ?? undefined) === node.data.year) &&
        (data.date === undefined || (data.date ?? undefined) === node.data.date);
      if (unchanged) return;
      const patch: Partial<MemexNodeData> = {};
      if (data.title !== undefined) patch.title = data.title;
      if (data.content !== undefined) patch.content = data.content;
      if (data.tags !== undefined) patch.tags = [...data.tags];
      commit({
        ...pick(state),
        nodes: state.nodes.map((n) => {
          if (n.id !== id) return n;
          const nextData: MemexNodeData = { ...n.data, ...patch };
          if (data.imageUrl !== undefined) {
            if (data.imageUrl) nextData.imageUrl = data.imageUrl;
            else delete nextData.imageUrl;
          }
          if (data.year !== undefined) {
            if (data.year === null) delete nextData.year;
            else nextData.year = data.year;
          }
          if (data.date !== undefined) {
            if (data.date === null) delete nextData.date;
            else nextData.date = data.date;
          }
          return { ...n, data: nextData };
        }),
      });
    },
    connect: (source, target, origin, data) =>
      commit(connectNodes(pick(get()), source, target, origin, data)),
    createTrail: (trail) => commit(createTrailPure(pick(get()), trail)),
    toggleEdgePolarity: (edgeId) => commit(toggleEdgePolarityPure(pick(get()), edgeId)),
    setGhostDiscoveries: (ghostDiscoveries) =>
      commit({ ...pick(get()), ghostDiscoveries }),
    autoLayout: () => commit(computeAutoLayout(pick(get()))),

    triggerGhostScan: (options) => {
      if (scanInFlight) return scanInFlight;
      const run = async (): Promise<void> => {
        const startedAt = Date.now();
        const start = get();
        set({ isGhostScanning: true });
        try {
          let mode: GhostEngineMode = "neural";
          let live: GhostDiscovery[] | null = null;
          if (options?.live !== false) {
            const signature = graphSignature(start.nodes, start.edges);
            const suggestions = await fetchLiveSuggestions(start.nodes, start.edges);
            const now = get();
            // Drop live results when the graph changed while the request was in flight.
            if (suggestions !== null && graphSignature(now.nodes, now.edges) === signature) {
              const clean = sanitizeGhostSuggestions(suggestions, now.nodes, now.edges, {
                dismissed: loadDismissedGhostIds(),
                discoveredAt: new Date().toISOString(),
              });
              if (clean.length > 0) live = clean;
            }
          }
          const state = get();
          const previous = new Map(state.ghostDiscoveries.map((d) => [d.id, d]));
          let found: GhostDiscovery[];
          if (live !== null) {
            mode = "live";
            found = live;
          } else {
            found = detectGhostSynapses(state.nodes, state.edges, DEFAULT_GHOST_THRESHOLD, {
              dismissed: loadDismissedGhostIds(),
              discoveredAt: new Date().toISOString(),
            });
          }
          found = found.map((d) => {
            const old = previous.get(d.id);
            return old
              ? { ...d, discoveredAt: old.discoveredAt, ...(old.trailId ? { trailId: old.trailId } : {}) }
              : d;
          });
          if (!sameDiscoveries(found, state.ghostDiscoveries)) {
            commit({ ...pick(state), ghostDiscoveries: found });
          }
          set({ ghostEngineMode: mode });
        } finally {
          const hold = Math.max(0, GHOST_SCAN_MIN_MS - (Date.now() - startedAt));
          if (scanHoldTimer !== undefined) clearTimeout(scanHoldTimer);
          if (hold === 0) set({ isGhostScanning: false });
          else {
            scanHoldTimer = setTimeout(() => {
              scanHoldTimer = undefined;
              set({ isGhostScanning: false });
            }, hold);
          }
        }
      };
      scanInFlight = run().finally(() => {
        scanInFlight = null;
      });
      return scanInFlight;
    },

    selectGhostDiscovery: (id) => {
      const known = id !== null && get().ghostDiscoveries.some((g) => g.id === id);
      if (!known) return set({ selectedGhostDiscoveryId: null });
      const dock = dockForSelection(get().commandDock, { selectedGhostDiscoveryId: id, inspectedEdgeId: null });
      set({
        selectedGhostDiscoveryId: id,
        inspectedEdgeId: null,
        commandDock: dock,
        isCuratorDrawerOpen: isTrailsOpen(dock),
      });
    },

    inspectEdge: (id) => {
      const known = id !== null && get().edges.some((e) => e.id === id);
      if (!known) return set({ inspectedEdgeId: null });
      const dock = dockForSelection(get().commandDock, { selectedGhostDiscoveryId: null, inspectedEdgeId: id });
      set({
        inspectedEdgeId: id,
        selectedGhostDiscoveryId: null,
        commandDock: dock,
        isCuratorDrawerOpen: isTrailsOpen(dock),
      });
    },

    acceptGhostDiscovery: (id) => commit(acceptDiscovery(pick(get()), id)),

    dismissGhostDiscovery: (id) => {
      const state = get();
      if (!state.ghostDiscoveries.some((g) => g.id === id)) return;
      saveDismissedGhostIds([...loadDismissedGhostIds(), id]);
      commit(removeDiscovery(pick(state), id));
    },

    convertDiscoveryToTrail: (id) => {
      const state = get();
      const discovery = state.ghostDiscoveries.find((g) => g.id === id);
      if (!discovery) return null;
      const trail = forgeGhostTrail(discovery, state.nodes, new Date().toISOString());
      const graph = createTrailPure(pick(state), trail);
      const stored = graph.trails.find((t) => t.id === trail.id);
      if (!stored || stored.nodeIds.length < 2) return null;
      commit({
        ...graph,
        ghostDiscoveries: graph.ghostDiscoveries.map((g) =>
          g.id === id ? { ...g, trailId: trail.id } : g,
        ),
      });
      set({ selectedGhostDiscoveryId: null });
      get().setActiveTrail(trail.id);
      return trail.id;
    },

    setActiveTrail: (trailId) => {
      if (trailId === null) return set({ ...IDLE_PLAYBACK });
      const trail = get().trails.find((t) => t.id === trailId);
      if (!trail || trail.nodeIds.length === 0) return set({ ...IDLE_PLAYBACK });
      set({ activeTrailId: trailId, activeTrailIndex: 0, isPlayingAuto: false });
    },

    nextTrailStep: () => {
      const { activeTrailId, activeTrailIndex, trails } = get();
      const trail = trails.find((t) => t.id === activeTrailId);
      if (!trail) return;
      const next = getNextTrailIndex(activeTrailIndex, trail.nodeIds.length);
      if (next === -1) return set({ ...IDLE_PLAYBACK });
      // Auto-play stops once the last stop is reached.
      set({ activeTrailIndex: next, isPlayingAuto: get().isPlayingAuto && next < trail.nodeIds.length - 1 });
    },

    prevTrailStep: () => {
      const { activeTrailId, activeTrailIndex, trails } = get();
      const trail = trails.find((t) => t.id === activeTrailId);
      if (!trail) return;
      const prev = getPrevTrailIndex(activeTrailIndex, trail.nodeIds.length);
      if (prev === -1) return set({ ...IDLE_PLAYBACK });
      set({ activeTrailIndex: prev });
    },

    setTrailStep: (index) => {
      const { activeTrailId, trails } = get();
      const trail = trails.find((t) => t.id === activeTrailId);
      if (!trail) return;
      const i = clampTrailIndex(index, trail.nodeIds.length);
      if (i === -1) return set({ ...IDLE_PLAYBACK });
      set({ activeTrailIndex: i });
    },

    toggleAutoPlay: () => {
      const { activeTrailId, activeTrailIndex, isPlayingAuto, trails } = get();
      const trail = trails.find((t) => t.id === activeTrailId);
      if (!trail) return;
      // Nothing to auto-play from the last stop.
      if (!isPlayingAuto && activeTrailIndex >= trail.nodeIds.length - 1) return;
      set({ isPlayingAuto: !isPlayingAuto });
    },

    exitTrailPlayback: () => set({ ...IDLE_PLAYBACK }),

    forgeTrail: (title, description, nodeIds) => get().createManualTrail(title, description, nodeIds),

    createManualTrail: (name, description, cardIds, color) => {
      const state = get();
      const trail = buildManualTrail({
        title: name,
        description,
        cardIds,
        knownNodeIds: state.nodes.map((n) => n.id),
        existingTrailIds: state.trails.map((t) => t.id),
        idSeed: crypto.randomUUID().slice(0, 8),
        createdAt: new Date().toISOString(),
        color,
      });
      if (trail === null) return null;
      const next = createTrailPure(pick(state), trail);
      if (next.trails === state.trails) return null;
      commit(next);
      return trail.id;
    },

    deleteTrail: (trailId) => {
      const state = get();
      if (!state.trails.some((t) => t.id === trailId)) return;
      // `commit` ends playback when the active trail is the one that vanished.
      commit(removeTrailPure(pick(state), trailId));
    },

    loadTrailIntoLever: (trailId) => {
      const lever = loadTrailState(get().trails, trailId);
      if (lever === null) return;
      const dock = get().commandDock;
      const closed = isTrailsOpen(dock) ? dockReducer(dock, { type: "collapse" }) : dock;
      set({
        ...lever,
        commandDock: closed,
        isCuratorDrawerOpen: false,
        trailCameraNonce: get().trailCameraNonce + 1,
      });
    },

    generateAndAddAutoTrails: () => {
      const state = get();
      const generated = generateAutoTrails(state.nodes, state.edges, state.ghostDiscoveries, {
        createdAt: new Date().toISOString(),
      });
      let graph = pick(state);
      const known = [...state.trails];
      const added: Trail[] = [];
      for (const trail of generated) {
        if (isDuplicateTrail(trail, known)) continue;
        const next = createTrailPure(graph, trail);
        if (next === graph) continue;
        graph = next;
        known.push(trail);
        added.push(next.trails[next.trails.length - 1]);
      }
      if (added.length === 0) return [];
      commit(graph);
      return added;
    },

    resetToSeed: () => {
      const seed = freshSeed();
      cancelGhostAutoScan();
      cancelMagnetic();
      clearDismissedGhostIds();
      set({ ...seed, ...IDLE_PLAYBACK, ...IDLE_GHOST, ...IDLE_SPOTLIGHT });
      persistGraph(seed);
    },

    exportJson: () => serializeGraph(toPersistable(pick(get()))),

    importJson: (json) => {
      replaceGraph(withDefaultSizes(deserializeGraph(json)));
    },

    exportBundleJson: () => {
      const state = get();
      return exportMemexBundle(
        {
          ...toPersistable(pick(state)),
          ghostSettings: {
            engine: state.ghostEngineMode,
            threshold: DEFAULT_GHOST_THRESHOLD,
            dismissedDiscoveryIds: loadDismissedGhostIds(),
          },
        },
        { exportedAt: new Date().toISOString() },
      );
    },

    importBundle: (json) => {
      const result = validateAndImportBundle(json);
      if (!result.ok) return result;
      replaceGraph(withDefaultSizes(result.state));
      // A bundle carries its own dismissals; a legacy graph file carries none, so keep ours.
      if (result.version !== "1.x") {
        if (result.ghostSettings.dismissedDiscoveryIds.length > 0) {
          saveDismissedGhostIds(result.ghostSettings.dismissedDiscoveryIds);
        } else {
          clearDismissedGhostIds();
        }
      }
      return result;
    },

    exportObsidianZip: () => {
      const { nodes, edges } = get();
      return exportObsidianVaultZip(nodes, edges, { modified: new Date().toISOString() });
    },
  };
});

// ---------------------------------------------------------------------------
// Compatibility aliases. Read-only conveniences over the existing store shape;
// they change no behaviour and are not used to style the UI.
// ---------------------------------------------------------------------------

export type { AssociativeEdge, MemexCardType, MemexNode };

/** Reference accent per card type (alias of `CARD_ACCENTS` in `core/types`). */
export const TYPE_COLORS: Record<MemexCardType, string> = CARD_ACCENTS;

/**
 * Describes how the Ghost Engine is configured today. Descriptive only: the
 * store does not hold it. `engine` is `ghostEngineMode` (what produced the last
 * scan), `threshold` is `DEFAULT_GHOST_THRESHOLD`, and `hasUserKey` reflects
 * whether a Gemini key is saved (`ai-settings.ts`, sent only to `/api/ghost`).
 */
export interface GhostSettings {
  engine: GhostEngineMode;
  threshold: number;
  hasUserKey: boolean;
}

const EMPTY_NODES: MemexNode[] = [];
const EMPTY_EDGES: AssociativeEdge[] = [];
const EMPTY_DISCOVERIES: GhostDiscovery[] = [];

export const selectCards = (s: MemexStore): MemexNode[] => s.nodes ?? EMPTY_NODES;
export const selectEdges = (s: MemexStore): AssociativeEdge[] => s.edges ?? EMPTY_EDGES;
export const selectDiscoveries = (s: MemexStore): GhostDiscovery[] =>
  s.ghostDiscoveries ?? EMPTY_DISCOVERIES;
export const selectActiveTrailId = (s: MemexStore): string | null => s.activeTrailId;
export const selectActiveStepIndex = (s: MemexStore): number => s.activeTrailIndex;
export const selectIsPlayingTrail = (s: MemexStore): boolean => s.isPlayingAuto;
export const selectOnNodesChange = (s: MemexStore): MemexStore["onNodesChange"] => s.onNodesChange;
export const selectOnEdgesChange = (s: MemexStore): MemexStore["onEdgesChange"] => s.onEdgesChange;
export const selectOnConnect = (s: MemexStore): MemexStore["onConnect"] => s.onConnect;
