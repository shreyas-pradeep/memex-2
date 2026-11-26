import { create } from "zustand";
import type {
  Connection,
  EdgeChangeset,
  NodeChange,
  NodeChangeset,
} from "@xyflow/react";
import {
  addNode as addNodePure,
  computeAutoLayout,
  connectNodes,
  createTrail as createTrailPure,
  deserializeGraph,
  removeNodes as removeNodesPure,
  serializeGraph,
} from "@/core/graph-engine";
import type {
  AssociativeEdge,
  AssociativeEdgeData,
  GhostDiscovery,
  LinkOrigin,
  MemexGraphState,
  MemexNode,
  MemexNodeData,
  Trail,
} from "@/core/types";
import { demoSeed } from "@/data/demo-seed";

export const STORAGE_KEY = "memex-2:graph:v1";

/** Fresh deep copy of the 1945 demo seed (never hands out the shared module object). */
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

export const DEFAULT_CARD_SIZE = { width: 320, height: 210 } as const;

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
};

function sameTags(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((t, i) => t === b[i]);
}

export interface MemexStore extends MemexGraphState {
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
  removeNodes: (ids: string[]) => void;
  /** Updates a card's title, content and/or tags. No-op when nothing changes. */
  updateCard: (id: string, data: CardUpdate) => void;
  connect: (
    source: string,
    target: string,
    origin: LinkOrigin,
    data?: Partial<Omit<AssociativeEdgeData, "origin">>,
  ) => void;
  createTrail: (trail: Trail) => void;
  setGhostDiscoveries: (discoveries: GhostDiscovery[]) => void;
  autoLayout: () => void;

  /** Replaces the whole graph with the 1945 demo seed and persists it. */
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
    set(next);
    persistGraph(next);
  };

  return {
    ...freshSeed(),
    hydrated: false,

    hydrate: () => {
      set({ ...(loadPersistedGraph() ?? freshSeed()), hydrated: true });
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

    addNode: (node) => commit(addNodePure(pick(get()), node)),
    removeNodes: (ids) => commit(removeNodesPure(pick(get()), ids)),
    updateCard: (id, data) => {
      const state = get();
      const node = state.nodes.find((n) => n.id === id);
      if (!node) return;
      const unchanged =
        (data.title === undefined || data.title === node.data.title) &&
        (data.content === undefined || data.content === node.data.content) &&
        (data.tags === undefined || sameTags(data.tags, node.data.tags)) &&
        (data.imageUrl === undefined || data.imageUrl === (node.data.imageUrl ?? ""));
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
          return { ...n, data: nextData };
        }),
      });
    },
    connect: (source, target, origin, data) =>
      commit(connectNodes(pick(get()), source, target, origin, data)),
    createTrail: (trail) => commit(createTrailPure(pick(get()), trail)),
    setGhostDiscoveries: (ghostDiscoveries) =>
      commit({ ...pick(get()), ghostDiscoveries }),
    autoLayout: () => commit(computeAutoLayout(pick(get()))),

    resetToSeed: () => {
      const seed = freshSeed();
      set(seed);
      persistGraph(seed);
    },

    exportJson: () => serializeGraph(toPersistable(pick(get()))),

    importJson: (json) => {
      const graph = withDefaultSizes(deserializeGraph(json));
      set(graph);
      persistGraph(graph);
    },
  };
});
