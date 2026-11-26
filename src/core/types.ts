import type { Edge, Node } from "@xyflow/react";

export type MemexCardType = "note" | "quote" | "artifact" | "ghost";

export type LinkOrigin = "human" | "ghost";

/** Edge colors: Tungsten Amber for human links, Phantom Violet for Ghost AI links. */
export const EDGE_COLORS: Record<LinkOrigin, string> = {
  human: "#FFB236",
  ghost: "#B388FF",
};

// Declared as `type` aliases (not interfaces) so they satisfy React Flow's
// `Record<string, unknown>` data constraint.
export type MemexNodeData = {
  /** Archival ID, e.g. `MEM-1945-0001`. */
  archivalId: string;
  title: string;
  content: string;
  cardType: MemexCardType;
  tags: string[];
  /** ISO-8601 timestamp. */
  createdAt: string;
  imageUrl?: string;
  /** Ghost AI confidence in [0, 1]. */
  confidence?: number;
  /**
   * Optional event date: `YYYY`, `YYYY-MM` or `YYYY-MM-DD`. Absent when unset
   * (never `null`, never invented). Used only when `year` is absent.
   */
  date?: string;
  /** Optional event year (integer, e.g. 1945 or 2026). Takes precedence over `date`. */
  year?: number;
};

export type AssociativeEdgeData = {
  origin: LinkOrigin;
  rationale: string;
  /** Link strength in [0, 1]. */
  strength: number;
  trailId?: string;
  /** Set only on display-only edges that render a `GhostDiscovery` as a synapse. */
  discoveryId?: string;
};

/** Canvas node: `{ id, position: {x, y}, type, data }`. */
export type MemexNode = Node<MemexNodeData, "memexCard">;

/** Directed canvas edge: `{ id, source, target, type, data }`. */
export type AssociativeEdge = Edge<AssociativeEdgeData, "associative">;

export interface Trail {
  id: string;
  title: string;
  description: string;
  origin: LinkOrigin;
  /** Ordered node IDs forming the trail. */
  nodeIds: string[];
  /** ISO-8601 timestamp. */
  createdAt: string;
}

/** A pre-computed Ghost AI suggestion connecting two cards. */
export interface GhostDiscovery {
  id: string;
  sourceId: string;
  targetId: string;
  rationale: string;
  /** Confidence in [0, 1]. */
  confidence: number;
  trailId?: string;
  /** ISO-8601 timestamp. */
  discoveredAt: string;
}

export interface MemexGraphState {
  nodes: MemexNode[];
  edges: AssociativeEdge[];
  trails: Trail[];
  ghostDiscoveries: GhostDiscovery[];
}
