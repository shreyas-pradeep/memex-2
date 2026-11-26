import type {
  AssociativeEdge,
  GhostDiscovery,
  LinkOrigin,
  MemexGraphState,
  MemexNode,
  Trail,
} from "@/core/types";
import { EDGE_COLORS } from "@/core/types";

/**
 * Demo dataset: seven landmark ideas in cognitive AI research, 1945 to 2026,
 * from Bush's associative trails to a spatial-memory hypothesis. Deterministic:
 * fixed ids, positions and timestamps, no clock and no randomness.
 */

/** Default card size (px). Resizing replaces it via `style: { width, height }`. */
const CARD_WIDTH = 340;
const CARD_HEIGHT = 230;

/** `id` doubles as the archival ID (e.g. `MEM-1945-01`). */
const node = (
  id: string,
  x: number,
  y: number,
  data: Omit<MemexNode["data"], "archivalId">,
): MemexNode => ({
  id,
  type: "memexCard",
  position: { x, y },
  style: { width: CARD_WIDTH, height: CARD_HEIGHT },
  data: { archivalId: id, ...data },
});

export const seedNodes: MemexNode[] = [
  node("MEM-1945-01", 80, 140, {
    title: "Vannevar Bush: The Associative Trail Hypothesis",
    cardType: "note",
    content:
      "Bush argues that the human mind does not work by alphabetical or numerical indexing. It operates by association: with one item in its grasp, it snaps to the next that an association of thoughts suggests, along an intricate web of trails. The memex was meant to imitate that process. Source: As We May Think, The Atlantic Monthly, July 1945.",
    tags: ["memex", "associative-trails", "information-retrieval"],
    createdAt: "1945-07-01T00:00:00.000Z",
    year: 1945,
  }),
  node("MEM-1965-02", 500, 140, {
    title: "Ted Nelson: Project Xanadu & Non-Linear Thought",
    cardType: "quote",
    content:
      "\"By 'hypertext' I mean non-sequential writing—text that branches and allows choices to the reader, best read at an interactive screen.\" Nelson introduced the term in his 1965 paper at the ACM 20th National Conference in Cleveland. This wording is his 1981 definition, from Literary Machines.",
    tags: ["hypertext", "xanadu", "non-linear-media"],
    createdAt: "1965-08-24T00:00:00.000Z",
    year: 1965,
  }),
  node("MEM-1968-03", 80, 440, {
    title: "Engelbart: NLS Human Augmentation Rig",
    cardType: "artifact",
    content:
      "A five-key chord keyset and a three-button mouse, used together at the NLS workstation. The system aimed not to replace human reasoning but to amplify problem-solving capacity under heavy conceptual load. Source: The Mother of All Demos, Fall Joint Computer Conference, December 1968.",
    tags: ["hci", "augmentation", "spatial-canvas"],
    createdAt: "1968-12-09T00:00:00.000Z",
    year: 1968,
  }),
  node("MEM-2017-04", 500, 440, {
    title: "Vaswani et al.: Scaled Dot-Product Attention",
    cardType: "note",
    content:
      "Self-attention maps a query and a set of key-value pairs to an output: each query is compared with every key, and the resulting weights mix the values. Read as retrieval, queries probing keys to fetch values resemble Bush's selection of the next item along a trail, computed in parallel across attention heads. Source: Attention Is All You Need (NeurIPS 2017, arXiv:1706.03762).",
    tags: ["attention", "transformers", "deep-learning"],
    createdAt: "2017-06-12T00:00:00.000Z",
    year: 2017,
  }),
  node("MEM-2024-05", 920, 440, {
    title: "Microsoft Research: GraphRAG (From Local to Global)",
    cardType: "artifact",
    content:
      "GraphRAG builds an entity knowledge graph from a text corpus with an LLM, groups related entities into communities, and pre-writes a summary for each community. Questions about the whole corpus are answered by combining those summaries. On datasets of around one million tokens, the authors report answers that are more comprehensive and diverse than a vector-RAG baseline. Source: Edge et al., From Local to Global: A Graph RAG Approach to Query-Focused Summarization (2024, arXiv:2404.16130).",
    tags: ["graphrag", "knowledge-graphs", "retrieval-benchmark"],
    createdAt: "2024-04-24T00:00:00.000Z",
    year: 2024,
  }),
  node("MEM-2024-06", 920, 140, {
    title: "Anthropic: Scaling Monosemanticity",
    cardType: "quote",
    content:
      "Paraphrase, not a verbatim quote: using sparse autoencoders, Anthropic's interpretability team extracted millions of interpretable features from a middle layer of Claude 3 Sonnet. Concepts appear to be stored as directions spread across many neurons (superposition) instead of as single neurons. Source: Templeton et al., Scaling Monosemanticity, Anthropic, May 2024.",
    tags: ["monosemanticity", "latent-space", "interpretability"],
    createdAt: "2024-05-21T00:00:00.000Z",
    year: 2024,
  }),
  node("MEM-2026-07", 500, 740, {
    title: "Working Hypothesis: Spatial Gestalt as Working Memory Bridge",
    cardType: "note",
    content:
      "Untested hypothesis: language models hold vast parametric recall but no persistent spatial layout of a user's ideas. Projecting conceptual clusters onto an infinite, zoomable plane with stable visual landmarks may let a researcher keep far more associative nodes in view than the 7 ± 2 chunks of Miller's working-memory estimate (Cowan's later estimate is about 4). Source: Active Memex Investigation, lab notes.",
    tags: ["working-memory", "spatial-gestalt", "hci-theory"],
    createdAt: "2026-01-01T00:00:00.000Z",
    year: 2026,
  }),
];

const edge = (
  id: string,
  source: string,
  target: string,
  origin: LinkOrigin,
  rationale: string,
  strength: number,
  trailId: string,
): AssociativeEdge => ({
  id,
  source,
  target,
  type: "associative",
  style: { stroke: EDGE_COLORS[origin] },
  data: { origin, rationale, strength, trailId },
});

const EVOLUTION = "trail-evolution";
const RETRIEVAL = "trail-retrieval";

export const seedEdges: AssociativeEdge[] = [
  edge(
    "edge-1945-1965",
    "MEM-1945-01",
    "MEM-1965-02",
    "human",
    "Hypertext Lineage: Nelson's hypertext generalizes Bush's trails into branching, linked text.",
    0.95,
    EVOLUTION,
  ),
  edge(
    "edge-1945-1968",
    "MEM-1945-01",
    "MEM-1968-03",
    "human",
    "HCI Physical Realization: Engelbart built working tools for the augmentation Bush imagined.",
    0.92,
    EVOLUTION,
  ),
  edge(
    "edge-1965-2017",
    "MEM-1965-02",
    "MEM-2017-04",
    "human",
    "Associative Queries: following a link and attending to a key both select what to read next.",
    0.88,
    EVOLUTION,
  ),
  edge(
    "edge-2017-2026",
    "MEM-2017-04",
    "MEM-2026-07",
    "human",
    "Frontier Working Memory: attention models recall well but lack the spatial layout this hypothesis adds.",
    0.89,
    EVOLUTION,
  ),
  edge(
    "edge-2017-2024-g",
    "MEM-2017-04",
    "MEM-2024-05",
    "ghost",
    "Multi-Hop Attention: GraphRAG layers explicit graph hops on top of attention-based retrieval.",
    0.91,
    RETRIEVAL,
  ),
  edge(
    "edge-2017-2024-m",
    "MEM-2017-04",
    "MEM-2024-06",
    "ghost",
    "Latent Geometries: interpretability probes the representations that attention layers build.",
    0.94,
    RETRIEVAL,
  ),
  // Added so consecutive stops of each trail are connected (see `getTrailEdges`).
  edge(
    "edge-1965-1968",
    "MEM-1965-02",
    "MEM-1968-03",
    "human",
    "Hypertext in Practice: Engelbart's 1968 demo showed linked, interactive text on a screen.",
    0.9,
    EVOLUTION,
  ),
  edge(
    "edge-1968-2017",
    "MEM-1968-03",
    "MEM-2017-04",
    "human",
    "Augmentation to Attention: both aim to extend how much a person can hold and follow at once.",
    0.8,
    EVOLUTION,
  ),
  edge(
    "edge-1945-2017-g",
    "MEM-1945-01",
    "MEM-2017-04",
    "ghost",
    "Trail Selection as Retrieval: choosing the next item by association is what attention computes.",
    0.86,
    RETRIEVAL,
  ),
  edge(
    "edge-2024-05-06-g",
    "MEM-2024-05",
    "MEM-2024-06",
    "ghost",
    "Structure Beyond Text: one builds explicit entity graphs, the other finds graph-like features inside models.",
    0.82,
    RETRIEVAL,
  ),
  edge(
    "edge-2024-06-2026-g",
    "MEM-2024-06",
    "MEM-2026-07",
    "ghost",
    "From Latent to Visible: features hidden inside models could be surfaced as spatial landmarks.",
    0.8,
    RETRIEVAL,
  ),
];

export const seedTrails: Trail[] = [
  {
    id: EVOLUTION,
    title: "The Associative Trail: 1945 to Latent Space",
    description:
      "Traces how non-linear associative trails evolved from microfilm into hypertext, transformer attention matrices, and spatial memory canvases.",
    origin: "human",
    nodeIds: ["MEM-1945-01", "MEM-1965-02", "MEM-1968-03", "MEM-2017-04", "MEM-2026-07"],
    createdAt: "2026-01-02T09:00:00.000Z",
  },
  {
    id: RETRIEVAL,
    title: "Knowledge Retrieval & Latent Geometries",
    description:
      "Empirical comparison of modern GraphRAG architectures, sparse autoencoder monosemanticity, and structured graph memory.",
    origin: "ghost",
    nodeIds: ["MEM-1945-01", "MEM-2017-04", "MEM-2024-05", "MEM-2024-06", "MEM-2026-07"],
    createdAt: "2026-01-02T09:05:00.000Z",
  },
];

/**
 * Empty on purpose: waking the Ghost Engine (or adding a card) discovers the
 * bridges between cards the seed leaves unconnected.
 */
export const seedGhostDiscoveries: GhostDiscovery[] = [];

export const demoSeed: MemexGraphState = {
  nodes: seedNodes,
  edges: seedEdges,
  trails: seedTrails,
  ghostDiscoveries: seedGhostDiscoveries,
};
