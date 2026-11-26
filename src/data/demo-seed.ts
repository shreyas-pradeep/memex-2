import type {
  AssociativeEdge,
  GhostDiscovery,
  MemexGraphState,
  MemexNode,
  Trail,
} from "@/core/types";
import { EDGE_COLORS } from "@/core/types";

/** Default card size (px). Resizing replaces it via `style: { width, height }`. */
const CARD_WIDTH = 320;
const CARD_HEIGHT = 210;

const node = (
  id: string,
  n: number,
  x: number,
  y: number,
  data: Omit<MemexNode["data"], "archivalId">,
): MemexNode => ({
  id,
  type: "memexCard",
  position: { x, y },
  style: { width: CARD_WIDTH, height: CARD_HEIGHT },
  data: { archivalId: `MEM-1945-${String(n).padStart(4, "0")}`, ...data },
});

export const seedNodes: MemexNode[] = [
  node("n-asw", 1, 0, 0, {
    title: "As We May Think",
    cardType: "artifact",
    content:
      "Vannevar Bush's essay in The Atlantic Monthly, July 1945. Written as the war ended, it asks scientists to turn from building weapons to organizing the growing mass of human knowledge so it can actually be used.",
    tags: ["bush", "1945", "essay", "atlantic"],
    createdAt: "1945-07-01T09:00:00.000Z",
    date: "1945-07",
    imageUrl: "/file.svg",
  }),
  node("n-memex", 2, 460, -40, {
    title: "The Memex Desk",
    cardType: "note",
    content:
      "A desk-sized mechanical device in which an individual stores all books, records and communications on microfilm. It is mechanized so it can be consulted with exceeding speed and flexibility: an enlarged intimate supplement to memory.",
    tags: ["memex", "microfilm", "device"],
    createdAt: "1945-07-02T10:30:00.000Z",
  }),
  node("n-trails", 3, 920, 0, {
    title: "Associative Trails",
    cardType: "quote",
    content:
      "\"The human mind operates by association. With one item in its grasp, it snaps instantly to the next that is suggested by the association of thoughts.\" Bush proposed that users could join two items and save the path as a trail.",
    tags: ["association", "trails", "hypertext"],
    createdAt: "1945-07-03T11:15:00.000Z",
  }),
  node("n-vemap", 4, -20, 380, {
    title: "Differential Analyzer",
    cardType: "artifact",
    content:
      "Built by Bush and colleagues at MIT around 1931, this room-sized mechanical analog computer solved differential equations with shafts, gears and integrators. It shaped his view of what machines could do for thinking.",
    tags: ["mit", "analog", "computing", "1931"],
    createdAt: "1945-07-04T08:45:00.000Z",
    year: 1931,
  }),
  node("n-osrd", 5, 440, 400, {
    title: "Office of Scientific Research and Development",
    cardType: "note",
    content:
      "Bush directed the OSRD during World War II, coordinating about 6,000 scientists on radar, the proximity fuze and the Manhattan Project. His 1945 report Science, The Endless Frontier led to the National Science Foundation.",
    tags: ["osrd", "wwii", "policy", "science"],
    createdAt: "1945-07-05T14:00:00.000Z",
    date: "1941-06",
  }),
  node("n-eniac", 6, 920, 420, {
    title: "ENIAC Unveiled",
    cardType: "artifact",
    content:
      "Completed in late 1945 at the University of Pennsylvania by Eckert and Mauchly, ENIAC was the first large general-purpose electronic digital computer. It was programmed by rewiring, and operated by six women including Jean Bartik and Kay McNulty.",
    tags: ["eniac", "digital", "1945", "upenn"],
    createdAt: "1945-11-15T16:20:00.000Z",
    year: 1945,
  }),
  node("n-engelbart", 7, 1380, 200, {
    title: "Engelbart's Mother of All Demos",
    cardType: "note",
    content:
      "In 1968 Douglas Engelbart demonstrated the mouse, hypertext links and shared-screen collaboration. He had read As We May Think as a young Navy radar technician in 1945 and credited it as the seed of his work.",
    tags: ["engelbart", "1968", "hypertext", "legacy", "memex", "bush"],
    createdAt: "1945-12-01T12:00:00.000Z",
    date: "1968-12-09",
  }),
  node("n-ghost", 8, 920, 800, {
    title: "Ghost Insight: Memory as Network",
    cardType: "ghost",
    content:
      "Bush's trails, ENIAC's stored-program successors and Engelbart's hypertext all treat knowledge as a network of links instead of a hierarchy of folders. Machine-aided association is the common thread from 1945 onward.",
    tags: ["synthesis", "ghost", "network"],
    createdAt: "1945-12-02T03:00:00.000Z",
    confidence: 0.87,
  }),
];

const edge = (
  id: string,
  source: string,
  target: string,
  origin: "human" | "ghost",
  rationale: string,
  strength: number,
  trailId?: string,
): AssociativeEdge => ({
  id,
  source,
  target,
  type: "associative",
  style: { stroke: EDGE_COLORS[origin] },
  data: { origin, rationale, strength, ...(trailId ? { trailId } : {}) },
});

export const seedEdges: AssociativeEdge[] = [
  edge("e-h1", "n-asw", "n-memex", "human", "The essay introduces the memex device.", 0.95, "t-human-bush"),
  edge("e-h2", "n-memex", "n-trails", "human", "Trails are the memex's core feature.", 0.9, "t-human-bush"),
  edge("e-h3", "n-vemap", "n-memex", "human", "Analog computing experience informed the memex design.", 0.7),
  edge("e-h4", "n-osrd", "n-asw", "human", "Wartime coordination motivated the essay's call to organize knowledge.", 0.8),
  edge("e-h5", "n-trails", "n-engelbart", "human", "Engelbart built hypertext from Bush's trail idea.", 0.85, "t-human-bush"),
  edge("e-g1", "n-vemap", "n-eniac", "ghost", "Both are landmark computing machines, analog then electronic digital.", 0.72, "t-ghost-machines"),
  edge("e-g2", "n-eniac", "n-ghost", "ghost", "ENIAC's successors made machine-aided association feasible.", 0.78, "t-ghost-machines"),
  edge("e-g3", "n-trails", "n-ghost", "ghost", "Trails are an early model of knowledge as a network.", 0.88, "t-ghost-machines"),
  edge("e-g4", "n-ghost", "n-engelbart", "ghost", "Engelbart realized the network model in working software.", 0.84, "t-ghost-machines"),
];

export const seedTrails: Trail[] = [
  {
    id: "t-human-bush",
    title: "From Essay to Hypertext",
    description: "Human-curated path from Bush's essay through the memex to Engelbart's demo.",
    origin: "human",
    nodeIds: ["n-asw", "n-memex", "n-trails", "n-engelbart"],
    createdAt: "1945-12-03T09:00:00.000Z",
  },
  {
    id: "t-ghost-machines",
    title: "Machines That Associate",
    description: "Ghost-discovered path from analog computing to the idea of memory as a network.",
    origin: "ghost",
    nodeIds: ["n-vemap", "n-eniac", "n-ghost", "n-engelbart"],
    createdAt: "1945-12-03T09:05:00.000Z",
  },
];

/**
 * Empty on purpose: the seed's ghost links are already drawn as `ghost` edges.
 * Waking the Ghost Engine (or adding a card) discovers the remaining bridges,
 * e.g. "As We May Think" <-> "Engelbart's Mother of All Demos".
 */
export const seedGhostDiscoveries: GhostDiscovery[] = [];

export const demoSeed: MemexGraphState = {
  nodes: seedNodes,
  edges: seedEdges,
  trails: seedTrails,
  ghostDiscoveries: seedGhostDiscoveries,
};
