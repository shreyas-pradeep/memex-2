import type {
  AssociativeEdge,
  AssociativeEdgeData,
  LinkOrigin,
  MemexGraphState,
  MemexNode,
  Trail,
} from "./types";
import { removeNodeFromDiscoveries } from "./ghost-engine";
import { removeNodeFromTrail } from "./trail-engine";

/**
 * Pure graph operations for the Memex canvas. Every function returns a new
 * state (or the same reference when nothing changed) and never mutates its
 * inputs.
 */

export const EMPTY_GRAPH: MemexGraphState = Object.freeze({
  nodes: [],
  edges: [],
  trails: [],
  ghostDiscoveries: [],
}) as MemexGraphState;

/** Deterministic edge ID derived from the (source, target, origin) identity. */
export function edgeId(source: string, target: string, origin: LinkOrigin): string {
  return `e-${origin}-${source}-${target}`;
}

/**
 * Next free archival ID (`MEM-1945-XXXX`): one above the highest existing
 * number, so IDs stay unique even after cards are deleted.
 */
export function nextArchivalId(nodes: readonly MemexNode[]): string {
  let max = 0;
  for (const n of nodes) {
    const m = /^MEM-1945-(\d+)$/.exec(n.data.archivalId);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `MEM-1945-${String(max + 1).padStart(4, "0")}`;
}

/** Adds a node. A node whose ID already exists is rejected (state unchanged). */
export function addNode(state: MemexGraphState, node: MemexNode): MemexGraphState {
  if (state.nodes.some((n) => n.id === node.id)) return state;
  return { ...state, nodes: [...state.nodes, node] };
}

/**
 * Removes every node in `ids` and purges all references to them: connected
 * edges, trail memberships and ghost discoveries (Requirement 2.3).
 */
export function removeNodes(
  state: MemexGraphState,
  ids: Iterable<string>,
): MemexGraphState {
  const doomed = new Set(ids);
  if (doomed.size === 0) return state;
  return {
    nodes: state.nodes.filter((n) => !doomed.has(n.id)),
    edges: state.edges.filter((e) => !doomed.has(e.source) && !doomed.has(e.target)),
    trails: state.trails.map((t) =>
      [...doomed].reduce<Trail>((acc, id) => removeNodeFromTrail(acc, id), t),
    ),
    ghostDiscoveries: removeNodeFromDiscoveries(state.ghostDiscoveries, doomed),
  };
}

export function removeNode(state: MemexGraphState, id: string): MemexGraphState {
  return removeNodes(state, [id]);
}

/**
 * Creates a directed edge. Rejected (state unchanged) when it would be a
 * self-loop, when an endpoint does not exist, or when an edge with the same
 * (source, target, origin) already exists (Requirement 2.2).
 */
export function connectNodes(
  state: MemexGraphState,
  source: string,
  target: string,
  origin: LinkOrigin,
  data: Partial<Omit<AssociativeEdgeData, "origin">> = {},
): MemexGraphState {
  if (source === target) return state;
  const ids = new Set(state.nodes.map((n) => n.id));
  if (!ids.has(source) || !ids.has(target)) return state;
  if (
    state.edges.some(
      (e) => e.source === source && e.target === target && e.data?.origin === origin,
    )
  ) {
    return state;
  }
  const edge: AssociativeEdge = {
    id: edgeId(source, target, origin),
    source,
    target,
    type: "associative",
    data: { rationale: "", strength: 0.5, ...data, origin },
  };
  return { ...state, edges: [...state.edges, edge] };
}

/** Removes one ghost discovery (state unchanged when the ID is unknown). */
export function removeDiscovery(state: MemexGraphState, discoveryId: string): MemexGraphState {
  if (!state.ghostDiscoveries.some((g) => g.id === discoveryId)) return state;
  return {
    ...state,
    ghostDiscoveries: state.ghostDiscoveries.filter((g) => g.id !== discoveryId),
  };
}

/**
 * Accepts a ghost discovery: the synapse becomes a real human edge carrying the
 * rationale and confidence, and the discovery is removed. State is unchanged
 * when the discovery is unknown.
 */
export function acceptDiscovery(state: MemexGraphState, discoveryId: string): MemexGraphState {
  const d = state.ghostDiscoveries.find((g) => g.id === discoveryId);
  if (!d) return state;
  const connected = connectNodes(state, d.sourceId, d.targetId, "human", {
    rationale: d.rationale,
    strength: d.confidence,
  });
  return removeDiscovery(connected, discoveryId);
}

/**
 * Adds a trail. Node IDs that do not exist in the graph are dropped, so a trail
 * can never hold a dangling reference. A trail whose ID already exists is
 * rejected (state unchanged).
 */
export function createTrail(state: MemexGraphState, trail: Trail): MemexGraphState {
  if (state.trails.some((t) => t.id === trail.id)) return state;
  const ids = new Set(state.nodes.map((n) => n.id));
  const nodeIds = trail.nodeIds.filter((id) => ids.has(id));
  return { ...state, trails: [...state.trails, { ...trail, nodeIds }] };
}

export function serializeGraph(state: MemexGraphState): string {
  return JSON.stringify({
    nodes: state.nodes,
    edges: state.edges,
    trails: state.trails,
    ghostDiscoveries: state.ghostDiscoveries,
  });
}

/**
 * Parses JSON produced by `serializeGraph`. Throws on malformed input.
 *
 * `nodes` and `edges` are required. `trails` and `ghostDiscoveries` default to
 * `[]` when absent so graphs saved by older versions still load; a present but
 * non-array value is still rejected. Unknown keys are dropped.
 */
export function deserializeGraph(json: string): MemexGraphState {
  const raw: unknown = JSON.parse(json);
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new Error("Invalid graph JSON: expected an object");
  }
  const obj = raw as Record<string, unknown>;
  for (const key of ["nodes", "edges"] as const) {
    if (!Array.isArray(obj[key])) {
      throw new Error(`Invalid graph JSON: "${key}" must be an array`);
    }
  }
  for (const key of ["trails", "ghostDiscoveries"] as const) {
    if (obj[key] !== undefined && !Array.isArray(obj[key])) {
      throw new Error(`Invalid graph JSON: "${key}" must be an array`);
    }
  }
  return {
    nodes: obj.nodes,
    edges: obj.edges,
    trails: obj.trails ?? [],
    ghostDiscoveries: obj.ghostDiscoveries ?? [],
  } as MemexGraphState;
}

export interface AutoLayoutOptions {
  columnWidth?: number;
  rowHeight?: number;
}

/**
 * Deterministic layered layout. Nodes are placed in columns by BFS depth from
 * the roots (nodes with no incoming edge); cycles and unreachable nodes are
 * handled by seeding the BFS from the first unvisited node. Rows follow input
 * order within each column.
 */
export function computeAutoLayout(
  state: MemexGraphState,
  { columnWidth = 460, rowHeight = 380 }: AutoLayoutOptions = {},
): MemexGraphState {
  const ids = state.nodes.map((n) => n.id);
  const idSet = new Set(ids);
  const outgoing = new Map<string, string[]>(ids.map((id) => [id, []]));
  const hasIncoming = new Set<string>();
  for (const e of state.edges) {
    if (!idSet.has(e.source) || !idSet.has(e.target) || e.source === e.target) continue;
    outgoing.get(e.source)!.push(e.target);
    hasIncoming.add(e.target);
  }

  const depth = new Map<string, number>();
  const bfs = (start: string) => {
    depth.set(start, 0);
    const queue = [start];
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i];
      for (const next of outgoing.get(cur)!) {
        if (!depth.has(next)) {
          depth.set(next, depth.get(cur)! + 1);
          queue.push(next);
        }
      }
    }
  };
  for (const id of ids) if (!hasIncoming.has(id) && !depth.has(id)) bfs(id);
  for (const id of ids) if (!depth.has(id)) bfs(id);

  const rowCount = new Map<number, number>();
  const nodes = state.nodes.map((n) => {
    const col = depth.get(n.id)!;
    const row = rowCount.get(col) ?? 0;
    rowCount.set(col, row + 1);
    return { ...n, position: { x: col * columnWidth, y: row * rowHeight } };
  });
  return { ...state, nodes };
}
