"use client";

import { useCallback, useEffect } from "react";
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
import { useMemexStore } from "@/store/useMemexStore";
import { ArchivalCardNode } from "./ArchivalCardNode";
import { AssociativePulseEdge } from "./AssociativePulseEdge";
import { MicrofilmShaders } from "./MicrofilmShaders";

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

function minimapNodeColor(node: MemexNode): string {
  return node.data.cardType === "ghost" ? EDGE_COLORS.ghost : EDGE_COLORS.human;
}

function ArchivalHud() {
  const nodeCount = useMemexStore((s) => s.nodes.length);
  const edgeCount = useMemexStore((s) => s.edges.length);
  const { screenToFlowPosition, fitView } = useReactFlow<MemexNode, AssociativeEdge>();

  const addNote = useCallback(() => {
    const { nodes, addNode } = useMemexStore.getState();
    const center = screenToFlowPosition({
      x: window.innerWidth / 2,
      y: window.innerHeight / 2,
    });
    // Cascade successive notes so they do not stack exactly.
    const offset = (nodes.length % 6) * 24;
    addNode({
      id: `n-${crypto.randomUUID().slice(0, 8)}`,
      type: "memexCard",
      position: { x: center.x - 140 + offset, y: center.y - 80 + offset },
      data: {
        archivalId: nextArchivalId(nodes),
        title: "Untitled Note",
        content: "",
        cardType: "note",
        tags: [],
        createdAt: new Date().toISOString(),
      },
    });
  }, [screenToFlowPosition]);

  const resetToSeed = useCallback(() => {
    useMemexStore.getState().resetToSeed();
    // Wait a frame so React Flow has the seed nodes before the camera glides.
    requestAnimationFrame(() => void fitView(FIT_OPTIONS));
  }, [fitView]);

  const buttonClass =
    "cursor-pointer border border-card-border bg-canvas-bg px-3 py-1.5 font-mono text-[11px] uppercase tracking-[0.12em] text-text-primary transition-colors hover:border-accent-human hover:text-accent-human focus-visible:outline focus-visible:outline-1 focus-visible:outline-accent-human";

  return (
    <Panel position="top-left" className="!m-4">
      <div
        className="w-[250px] bg-card-surface/95 p-3 backdrop-blur-sm"
        style={{ border: "1px solid rgba(255, 178, 54, 0.3)", borderRadius: 2 }}
      >
        <div className="font-mono text-[10px] uppercase tracking-[0.2em] text-text-muted">
          Memex 2.0 · Archival Desk
        </div>
        <div className="mt-1 font-serif text-lg font-semibold text-text-primary">
          Microfilm Index
        </div>

        <div className="mt-3 flex flex-col gap-2">
          <button type="button" className={buttonClass} onClick={addNote}>
            + Add Note
          </button>
          <button type="button" className={buttonClass} onClick={resetToSeed}>
            Reset to 1945 Seed
          </button>
        </div>

        <dl
          className="mt-3 flex gap-5 pt-2.5 font-mono text-[11px] uppercase tracking-wider"
          style={{ borderTop: "1px solid rgba(255, 178, 54, 0.18)" }}
        >
          <div>
            <dt className="text-text-muted">Nodes</dt>
            <dd className="text-accent-human">{String(nodeCount).padStart(3, "0")}</dd>
          </div>
          <div>
            <dt className="text-text-muted">Edges</dt>
            <dd className="text-accent-ghost">{String(edgeCount).padStart(3, "0")}</dd>
          </div>
        </dl>
      </div>
    </Panel>
  );
}

function Flow() {
  const nodes = useMemexStore((s) => s.nodes);
  const edges = useMemexStore((s) => s.edges);
  const onNodesChange = useMemexStore((s) => s.onNodesChange);
  const onEdgesChange = useMemexStore((s) => s.onEdgesChange);
  const onConnect = useMemexStore((s) => s.onConnect);

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
      fitView
      fitViewOptions={FIT_OPTIONS}
      minZoom={0.15}
      maxZoom={2.5}
      deleteKeyCode={["Backspace", "Delete"]}
      proOptions={{ hideAttribution: false }}
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
    </ReactFlow>
  );
}

/**
 * Client-only canvas. The store starts from the demo seed on both server and
 * first client render; the persisted graph (localStorage) is loaded by
 * `hydrate()` after mount, and the canvas only renders once that has happened,
 * so there is no hydration mismatch.
 */
export function MemexCanvas() {
  const hydrated = useMemexStore((s) => s.hydrated);

  useEffect(() => {
    const { hydrated: done, hydrate } = useMemexStore.getState();
    if (!done) hydrate();
  }, []);

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#090A0F" }}>
      <MicrofilmShaders />
      {hydrated ? (
        <ReactFlowProvider>
          <Flow />
        </ReactFlowProvider>
      ) : null}
    </div>
  );
}
