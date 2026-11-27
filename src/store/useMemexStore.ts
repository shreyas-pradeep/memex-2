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
  computeAutoLayout,
  connectNodes,
  createTrail as createTrailPure,
  deserializeGraph,
  nextArchivalId,
  removeDiscovery,
  removeNodes as removeNodesPure,
  serializeGraph,
  toggleEdgePolarity as toggleEdgePolarityPure,
} from "@/core/graph-engine";
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
  forgeCustomTrail,
  getNextTrailIndex,
  getPrevTrailIndex,
} from "@/core/trail-engine";
import {
  DEFAULT_GHOST_THRESHOLD,
  detectGhostSynapses,
  forgeGhostTrail,
  ghostPairKey,
  sanitizeGhostSuggestions,
} from "@/core/ghost-engine";
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

export const DEFAULT_CARD_SIZE = { width: 340, height: 230 } as const;

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
  ghostEngineMode: "neural" as GhostEngineMode,
};

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
  /** Session-only: discovery open in the Synapse Inspector Drawer. */
  selectedGhostDiscoveryId: string | null;
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

  /** Replaces the whole graph with the demo seed and persists it. */
  resetToSeed: () => void;
  exportJson: () => string;
  /** Replaces the graph from JSON; throws (state untouched) when the JSON is invalid. */
  importJson: (json: string) => void;
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
    const trailId = current.activeTrailId;
    if (trailId !== null) {
      const trail = next.trails.find((t) => t.id === trailId);
      const index = trail ? clampTrailIndex(current.activeTrailIndex, trail.nodeIds.length) : -1;
      if (index === -1) set({ ...next, ...IDLE_PLAYBACK, ...selection });
      else set({ ...next, activeTrailIndex: index, ...selection });
    } else {
      set({ ...next, ...selection });
    }
    persistGraph(next);
  };

  return {
    ...freshSeed(),
    ...IDLE_PLAYBACK,
    ...IDLE_GHOST,
    hydrated: false,
    isTimelineOpen: true,
    highlightedNodeId: null,

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
      for (const node of incoming) {
        const fresh: MemexNode = {
          ...node,
          data: { ...node.data, archivalId: nextArchivalId(graph.nodes) },
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
      set({ selectedGhostDiscoveryId: known ? id : null });
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

    forgeTrail: (title, description, nodeIds) => {
      const state = get();
      const known = new Set(state.nodes.map((n) => n.id));
      const valid = nodeIds.filter((id) => known.has(id));
      const trail = forgeCustomTrail(title, description, valid, "human", {
        id: `t-${crypto.randomUUID().slice(0, 8)}`,
        createdAt: new Date().toISOString(),
      });
      if (trail.nodeIds.length < 2) return null;
      commit(createTrailPure(pick(state), trail));
      return trail.id;
    },

    resetToSeed: () => {
      const seed = freshSeed();
      cancelGhostAutoScan();
      clearDismissedGhostIds();
      set({ ...seed, ...IDLE_PLAYBACK, ...IDLE_GHOST });
      persistGraph(seed);
    },

    exportJson: () => serializeGraph(toPersistable(pick(get()))),

    importJson: (json) => {
      const graph = withDefaultSizes(deserializeGraph(json));
      cancelGhostAutoScan();
      set({ ...graph, ...IDLE_PLAYBACK, ...IDLE_GHOST });
      persistGraph(graph);
    },
  };
});

// ---------------------------------------------------------------------------
// Compatibility aliases. Read-only conveniences over the existing store shape;
// they change no behaviour and are not used to style the UI.
// ---------------------------------------------------------------------------

export type { AssociativeEdge, MemexCardType, MemexNode };

/** Reference accent per card type (a naming alias; components keep their own styles). */
export const TYPE_COLORS = {
  note: "#FFB236",
  quote: "#60A5FA",
  artifact: "#34D399",
  ghost: "#B388FF",
} as const satisfies Record<MemexCardType, string>;

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
