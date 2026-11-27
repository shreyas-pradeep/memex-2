import type { Edge, Node } from "@xyflow/react";

export type MemexCardType = "note" | "quote" | "artifact" | "ghost";

export type LinkOrigin = "human" | "ghost";

/** Edge colors: Tungsten Amber for human links, Phantom Violet for Ghost AI links. */
export const EDGE_COLORS: Record<LinkOrigin, string> = {
  human: "#FFB236",
  ghost: "#B388FF",
};

/**
 * Accent color per card type: tungsten amber for notes, electric cyan for
 * quotes, terminal CRT green for artifacts, phantom violet for ghost insights.
 * Note and ghost deliberately reuse the edge colors (`EDGE_COLORS`), which are
 * unchanged: amber still means human, violet still means ghost.
 */
export const CARD_ACCENTS: Record<MemexCardType, string> = {
  note: EDGE_COLORS.human,
  quote: "#38BDF8",
  artifact: "#10B981",
  ghost: EDGE_COLORS.ghost,
};

/**
 * Dialectical stance of an edge, orthogonal to its `origin`:
 * `supports` (default), `refutes` (a tension) or `synthesizes` (a resolution).
 */
export type EdgePolarity = "supports" | "refutes" | "synthesizes";

/** Edge colors per polarity. `supports` keeps the origin color (amber human, violet ghost). */
export const POLARITY_COLORS: Record<EdgePolarity, string> = {
  supports: "#FFB236",
  refutes: "#EF4444",
  synthesizes: "#B388FF",
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
  /** Citation source, e.g. `arXiv:1706.03762`. Absent unless the card came from a resolved source. */
  source?: string;
  /** Link to the PDF of the source (https). */
  pdfUrl?: string;
  /** Authors of the source, in order. Used for bibliography and BibTeX. */
  authors?: string[];
};

export type AssociativeEdgeData = {
  origin: LinkOrigin;
  rationale: string;
  /** Link strength in [0, 1]. */
  strength: number;
  trailId?: string;
  /**
   * Dialectical stance. Absent means `supports` (see `getEdgePolarity`).
   * Never set on display-only ghost discovery edges.
   */
  polarity?: EdgePolarity;
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
