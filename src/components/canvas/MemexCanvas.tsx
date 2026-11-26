"use client";

import { memo, useCallback, useEffect, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionMode,
  Controls,
  MiniMap,
  Panel,
  ReactFlow,
  ReactFlowProvider,
  useReactFlow,
  type EdgeTypes,
  type NodeTypes,
} from "@xyflow/react";
import { nextArchivalId } from "@/core/graph-engine";
import { EDGE_COLORS, type AssociativeEdge, type MemexNode } from "@/core/types";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { ArchivalTimeline } from "../trails/ArchivalTimeline";
import { TrailCameraDirector } from "../trails/TrailCameraDirector";
import { TrailPlaybackDock } from "../trails/TrailPlaybackDock";
import { TrailSelectorMenu } from "../trails/TrailSelectorMenu";
import { AddCardModal, type NewCardInput } from "./AddCardModal";
import { ArchivalCardNode } from "./ArchivalCardNode";
import { AssociativePulseEdge } from "./AssociativePulseEdge";

// Module-scope so React Flow never sees a new object identity between renders.
// The graph core types nodes `memexCard` and edges `associative`; the
// `archivalCard` / `associativePulse` aliases are the component-level names.
const nodeTypes: NodeTypes = {
  archivalCard: ArchivalCardNode,
  memexCard: ArchivalCardNode,
};
const edgeTypes: EdgeTypes = {
  associativePulse: AssociativePulseEdge,
  associative: AssociativePulseEdge,
};

const CAMERA_MS = 800;
const FIT_OPTIONS = { padding: 0.2, duration: CAMERA_MS } as const;

// Module-scope selectors: stable identities, each subscribes to one slice so a
// change elsewhere in the store never re-renders the canvas.
const selectNodes = (s: MemexStore) => s.nodes;
const selectEdges = (s: MemexStore) => s.edges;
const selectNodeCount = (s: MemexStore) => s.nodes.length;
const selectEdgeCount = (s: MemexStore) => s.edges.length;
const selectOnNodesChange = (s: MemexStore) => s.onNodesChange;
const selectOnEdgesChange = (s: MemexStore) => s.onEdgesChange;
const selectOnConnect = (s: MemexStore) => s.onConnect;
const selectHydrated = (s: MemexStore) => s.hydrated;

function minimapNodeColor(node: MemexNode): string {
  return node.data.cardType === "ghost" ? EDGE_COLORS.ghost : EDGE_COLORS.human;
}

function ArchivalHud() {
  const nodeCount = useMemexStore(selectNodeCount);
  const edgeCount = useMemexStore(selectEdgeCount);
  const { screenToFlowPosition, fitView } = useReactFlow<MemexNode, AssociativeEdge>();

  const [modalOpen, setModalOpen] = useState(false);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const openModal = useCallback(() => setModalOpen(true), []);

  const addCard = useCallback(
    (input: NewCardInput) => {
      const { nodes, addNode } = useMemexStore.getState();
      const center = screenToFlowPosition({
        x: window.innerWidth / 2,
        y: window.innerHeight / 2,
      });
      // Cascade successive cards so they do not stack exactly.
      const offset = (nodes.length % 6) * 24;
      addNode({
        id: `n-${crypto.randomUUID().slice(0, 8)}`,
        type: "memexCard",
        position: { x: center.x - 160 + offset, y: center.y - 105 + offset },
        style: { width: 320, height: 210 },
        data: {
          archivalId: nextArchivalId(nodes),
          title: input.title,
          content: input.content,
          cardType: input.cardType,
          tags: input.tags,
          createdAt: new Date().toISOString(),
          ...(input.imageUrl ? { imageUrl: input.imageUrl } : {}),
          ...(input.year !== undefined ? { year: input.year } : {}),
          ...(input.date !== undefined ? { date: input.date } : {}),
        },
      });
      setModalOpen(false);
    },
    [screenToFlowPosition],
  );

  const resetToSeed = useCallback(() => {
    useMemexStore.getState().resetToSeed();
    // Wait a frame so React Flow has the seed nodes before the camera glides.
    requestAnimationFrame(() => void fitView(FIT_OPTIONS));
  }, [fitView]);

  const buttonBase =
    "cursor-pointer rounded-xl border px-3 py-2 font-mono text-[11px] font-semibold uppercase tracking-[0.16em] shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65),0_6px_14px_rgba(0,0,0,0.4)] transition-[color,border-color,box-shadow,transform] duration-100 active:translate-y-[2px] active:shadow-[inset_0_2px_6px_rgba(0,0,0,0.7)] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2";
  const addButtonClass = `${buttonBase} border-accent-human/50 bg-gradient-to-b from-[#161922] to-[#141721] text-accent-human hover:border-accent-human hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_2px_0_rgba(0,0,0,0.65),0_0_16px_rgba(255,178,54,0.3)] focus-visible:outline-accent-human`;
  const resetButtonClass = `${buttonBase} border-white/10 bg-gradient-to-b from-[#161922] to-[#090A0F] text-text-muted hover:border-accent-ghost/60 hover:text-accent-ghost hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.08),0_2px_0_rgba(0,0,0,0.65),0_0_16px_rgba(179,136,255,0.3)] focus-visible:outline-accent-ghost`;

  const readoutStyle = { textShadow: "0 0 10px rgba(255, 178, 54, 0.65)" } as const;
  const nodesLabel = String(nodeCount).padStart(3, "0");
  const edgesLabel = String(edgeCount).padStart(3, "0");

  return (
    <Panel position="top-left" className="!m-4">
      <div className="w-[260px] rounded-2xl border border-white/10 bg-[#141721]/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_12px_36px_rgba(0,0,0,0.55)]">
        <div className="flex items-center gap-2 font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          <span
            aria-hidden="true"
            className="h-1.5 w-1.5 rounded-full bg-accent-human"
            style={{ boxShadow: "0 0 8px 2px rgba(255, 178, 54, 0.6)" }}
          />
          Memex 2.0 · Archival Desk
        </div>
        <div className="mt-1 font-serif text-lg font-semibold text-text-primary">
          Microfilm Index
        </div>

        <div className="mt-3 grid grid-cols-2 gap-2">
          <button type="button" className={addButtonClass} onClick={openModal}>
            + Add Note
          </button>
          <button type="button" className={resetButtonClass} onClick={resetToSeed}>
            Reset Seed
          </button>
        </div>

        <div
          role="status"
          aria-label={`${nodeCount} nodes, ${edgeCount} edges`}
          className="mt-3 rounded-xl border border-white/5 bg-[#090A0F]/80 px-3 py-2 text-center font-mono text-[13px] font-semibold uppercase tracking-[0.14em] text-accent-human shadow-[inset_0_2px_6px_rgba(0,0,0,0.6)]"
          style={readoutStyle}
        >
          {nodesLabel} Nodes // {edgesLabel} Edges
        </div>
      </div>
      <AddCardModal open={modalOpen} onClose={closeModal} onSubmit={addCard} />
    </Panel>
  );
}

const Flow = memo(function Flow() {
  const nodes = useMemexStore(selectNodes);
  const edges = useMemexStore(selectEdges);
  const onNodesChange = useMemexStore(selectOnNodesChange);
  const onEdgesChange = useMemexStore(selectOnEdgesChange);
  const onConnect = useMemexStore(selectOnConnect);

  return (
    <ReactFlow<MemexNode, AssociativeEdge>
      nodes={nodes}
      edges={edges}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      connectionMode={ConnectionMode.Loose}
      nodeDragThreshold={4}
      fitView
      fitViewOptions={FIT_OPTIONS}
      minZoom={0.15}
      maxZoom={2.5}
      deleteKeyCode={["Backspace", "Delete"]}
      proOptions={{ hideAttribution: true }}
      style={{ background: "#090A0F" }}
    >
      {/* Dot matrix: fine 20px grid plus brighter registration dots every 100px. */}
      <Background
        id="grid-fine"
        variant={BackgroundVariant.Dots}
        gap={20}
        size={1}
        color="rgba(142, 148, 165, 0.16)"
      />
      <Background
        id="grid-major"
        variant={BackgroundVariant.Dots}
        gap={100}
        size={2}
        color="rgba(255, 178, 54, 0.28)"
      />
      <MiniMap<MemexNode>
        pannable
        zoomable
        nodeColor={minimapNodeColor}
        nodeStrokeColor="transparent"
        nodeBorderRadius={1}
        maskColor="rgba(9, 10, 15, 0.78)"
        style={{ background: "#0E1119" }}
        ariaLabel="Archive minimap"
      />
      <Controls showInteractive={false} />
      <ArchivalHud />
      <TrailSelectorMenu />
      <TrailCameraDirector />
      <TrailPlaybackDock />
      <ArchivalTimeline />
    </ReactFlow>
  );
});

/**
 * Client-only canvas. The store starts from the demo seed on both server and
 * first client render; the persisted graph (localStorage) is loaded by
 * `hydrate()` after mount, and the canvas only renders once that has happened,
 * so there is no hydration mismatch.
 */
export function MemexCanvas() {
  const hydrated = useMemexStore(selectHydrated);

  useEffect(() => {
    const { hydrated: done, hydrate } = useMemexStore.getState();
    if (!done) hydrate();
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#090A0F" }}>
      {hydrated ? (
        <ReactFlowProvider>
          <Flow />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}
