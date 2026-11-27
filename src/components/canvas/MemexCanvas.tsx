"use client";

import { memo, useCallback, useEffect, useMemo, useState } from "react";
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
import { buildGhostEdges } from "@/core/ghost-engine";
import { nextArchivalId } from "@/core/graph-engine";
import {
  CARD_ACCENTS,
  type AssociativeEdge,
  type GhostDiscovery,
  type MemexNode,
} from "@/core/types";
import {
  selectGhostCount,
  selectGhostEngineMode,
  selectIsGhostScanning,
  selectTriggerGhostScan,
} from "@/store/ghost-selectors";
import { useMemexStore, type MemexStore } from "@/store/useMemexStore";
import { loadUserGeminiKey } from "@/store/ai-settings";
import { useSprocketSession, selectIsWeaving, selectRequestWeave } from "@/store/useSprocketSession";
import { WEAVE_BUTTON_LABEL, WEAVE_MIN_CARDS, canStartWeave } from "@/core/sprocket-motion";
import { AISettingsModal } from "../ghost/AISettingsModal";
import { SynapseInspectorDrawer } from "../ghost/SynapseInspectorDrawer";
import { ArchivalTimeline } from "../trails/ArchivalTimeline";
import { CuratorsIndexDrawer } from "../trails/CuratorsIndexDrawer";
import { CuratorsIndexTrigger } from "../trails/CuratorsIndexTrigger";
import { TrailCameraDirector } from "../trails/TrailCameraDirector";
import { TrailPlaybackDock } from "../trails/TrailPlaybackDock";
import { AddCardModal, type NewCardInput } from "./AddCardModal";
import { BriefingHost } from "./BriefingHost";
import { ArchivalCardNode } from "./ArchivalCardNode";
import { IngestionPlatenModal } from "./IngestionPlatenModal";
import { AssociativePulseEdge } from "./AssociativePulseEdge";
import { GhostGuidanceBeacon } from "./GhostGuidanceBeacon";
import { RetroToaster } from "./RetroToaster";
import { SprocketCrawler } from "./SprocketCrawler";

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
// Shared empty fallbacks keep selector results referentially stable, so a
// missing slice (stale or partial saved state) never crashes or re-renders.
const NO_NODES: MemexNode[] = [];
const NO_EDGES: AssociativeEdge[] = [];
const NO_DISCOVERIES: GhostDiscovery[] = [];
const selectNodes = (s: MemexStore): MemexNode[] => s.nodes ?? NO_NODES;
const selectEdges = (s: MemexStore): AssociativeEdge[] => s.edges ?? NO_EDGES;
const selectNodeCount = (s: MemexStore) => s.nodes?.length ?? 0;
const selectEdgeCount = (s: MemexStore) => s.edges?.length ?? 0;
const selectOnNodesChange = (s: MemexStore) => s.onNodesChange;
const selectOnEdgesChange = (s: MemexStore) => s.onEdgesChange;
const selectOnConnect = (s: MemexStore) => s.onConnect;
const selectHydrated = (s: MemexStore) => s.hydrated;
const selectHudActiveTrailId = (s: MemexStore) => s.activeTrailId;
const selectDiscoveries = (s: MemexStore): GhostDiscovery[] =>
  s.ghostDiscoveries ?? NO_DISCOVERIES;

function minimapNodeColor(node: MemexNode): string {
  return CARD_ACCENTS[node.data.cardType] ?? CARD_ACCENTS.note;
}

function ArchivalHud() {
  const nodeCount = useMemexStore(selectNodeCount);
  const edgeCount = useMemexStore(selectEdgeCount);
  const scanning = useMemexStore(selectIsGhostScanning);
  const ghostCount = useMemexStore(selectGhostCount);
  const triggerScan = useMemexStore(selectTriggerGhostScan);
  const engineMode = useMemexStore(selectGhostEngineMode);
  const wakeGhost = useCallback(() => void triggerScan(), [triggerScan]);
  // Auto-weave: granular, primitive selectors (a card drag changes none of them).
  const activeTrailId = useMemexStore(selectHudActiveTrailId);
  const isWeaving = useSprocketSession(selectIsWeaving);
  const requestWeave = useSprocketSession(selectRequestWeave);
  const weaveReady = canStartWeave({ cardCount: nodeCount, activeTrailId, isWeaving });
  const weaveHint = isWeaving
    ? "Sprocket is weaving. Press Esc or click Sprocket to stop."
    : activeTrailId !== null
      ? "Exit the playing trail to weave a new one."
      : "Sprocket generates a trail from your cards and scampers along it.";

  // Key detection: the server reports whether GEMINI_API_KEY is set (never the key);
  // a key saved in this browser also counts.
  const [serverLive, setServerLive] = useState(false);
  // The canvas mounts only after hydration (client-only), so reading storage here is safe.
  const [userKey, setUserKey] = useState(() => loadUserGeminiKey() !== "");
  const [settingsOpen, setSettingsOpen] = useState(false);
  const closeSettings = useCallback(() => setSettingsOpen(false), []);
  const openSettings = useCallback(() => setSettingsOpen(true), []);
  useEffect(() => {
    const controller = new AbortController();
    fetch("/api/ghost", { signal: controller.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((b: { live?: unknown } | null) => setServerLive(b?.live === true))
      .catch(() => setServerLive(false));
    return () => controller.abort();
  }, []);
  const aiLive = serverLive || userKey;
  const { screenToFlowPosition, fitView } = useReactFlow<MemexNode, AssociativeEdge>();

  const [modalOpen, setModalOpen] = useState(false);
  const closeModal = useCallback(() => setModalOpen(false), []);
  const openModal = useCallback(() => setModalOpen(true), []);

  const [platenOpen, setPlatenOpen] = useState(false);
  const closePlaten = useCallback(() => setPlatenOpen(false), []);
  const openPlaten = useCallback(() => setPlatenOpen(true), []);
  // Shortcut `I` opens the platen; ignored while typing or with modifier keys.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== "i" || e.ctrlKey || e.metaKey || e.altKey || e.shiftKey) return;
      if (e.repeat || e.defaultPrevented) return;
      const t = e.target;
      if (
        t instanceof HTMLElement &&
        (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName))
      ) {
        return;
      }
      e.preventDefault();
      setPlatenOpen(true);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  const onIngested = useCallback(
    (ids: string[]) => {
      if (ids.length === 0) return;
      // Wait a frame so React Flow has the new nodes before the camera glides.
      requestAnimationFrame(() =>
        void fitView({ nodes: ids.map((id) => ({ id })), padding: 0.25, duration: CAMERA_MS }),
      );
    },
    [fitView],
  );

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

  const ghostButtonClass = `${buttonBase} border-accent-ghost/60 bg-gradient-to-b from-[#161922] to-[#141721] text-accent-ghost hover:border-accent-ghost hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.1),0_2px_0_rgba(0,0,0,0.65),0_0_16px_rgba(179,136,255,0.35)] focus-visible:outline-accent-ghost`;
  const readoutStyle = { textShadow: "0 0 10px rgba(255, 178, 54, 0.65)" } as const;
  const nodesLabel = String(nodeCount).padStart(3, "0");
  const edgesLabel = String(edgeCount).padStart(3, "0");

  return (
    <Panel position="top-left" className="!m-4">
      <div className="max-h-[calc(100vh-2rem)] w-[260px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-2xl border border-white/10 bg-[#141721]/95 p-4 shadow-[inset_0_1px_0_rgba(255,255,255,0.07),0_12px_36px_rgba(0,0,0,0.55)]">
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

        <button
          type="button"
          onClick={openPlaten}
          aria-keyshortcuts="I"
          className="mt-2 flex w-full cursor-pointer items-center justify-center gap-2 rounded-xl border border-accent-human bg-accent-human px-3 py-2.5 font-mono text-[11px] font-bold uppercase tracking-[0.16em] text-[#090A0F] shadow-[inset_0_1px_0_rgba(255,255,255,0.35),0_2px_0_rgba(0,0,0,0.65),0_0_18px_rgba(255,178,54,0.35)] transition-[box-shadow,transform] duration-100 hover:brightness-110 active:translate-y-[2px] focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-human"
        >
          + Ingest Source (Platen)
          <kbd className="rounded border border-[#090A0F]/40 px-1 text-[10px]">I</kbd>
        </button>

        <button
          type="button"
          onClick={wakeGhost}
          aria-busy={scanning}
          className={`${ghostButtonClass} mt-2 flex w-full items-center justify-center gap-2`}
        >
          <span
            aria-hidden="true"
            className={`relative inline-block h-2 w-2 rounded-full bg-accent-ghost ${scanning ? "animate-ping" : ""}`}
            style={{ boxShadow: "0 0 8px 2px rgba(179, 136, 255, 0.6)" }}
          />
          {scanning ? "Scanning archive…" : "⚡ Wake Ghost Engine"}
        </button>
        {nodeCount >= WEAVE_MIN_CARDS ? (
          <>
            <button
              type="button"
              onClick={() => void requestWeave()}
              disabled={!weaveReady}
              aria-busy={isWeaving}
              aria-describedby="auto-weave-hint"
              aria-label="Auto-weave trail: Sprocket builds a trail from your cards and walks it"
              title={weaveHint}
              className={`${ghostButtonClass} mt-2 flex w-full flex-wrap items-center justify-center gap-x-2 gap-y-0.5 text-center disabled:cursor-not-allowed disabled:opacity-40`}
            >
              <span aria-hidden="true">{isWeaving ? "Weaving…" : `[${WEAVE_BUTTON_LABEL}]`}</span>
            </button>
            <span id="auto-weave-hint" className="sr-only">
              {weaveHint}
            </span>
          </>
        ) : null}
        <GhostGuidanceBeacon />
        <div className="mt-2 flex items-center gap-2">
          <span
            role="status"
            title={`Last scan used the ${engineMode === "live" ? "live Gemini" : "local neural"} engine`}
            className={`flex-1 rounded-xl border px-2 py-1.5 text-center font-mono text-[10px] font-semibold uppercase tracking-[0.16em] ${
              aiLive
                ? "border-accent-ghost/60 text-accent-ghost"
                : "border-white/10 text-text-muted"
            }`}
          >
            {aiLive ? "[ ⚡ AI: LIVE ]" : "[ ⚡ AI: NEURAL ]"}
          </span>
          <button
            type="button"
            onClick={openSettings}
            aria-label="AI settings"
            title="AI settings"
            className="cursor-pointer rounded-xl border border-white/10 bg-[#090A0F] px-2.5 py-1.5 font-mono text-[12px] text-text-muted hover:border-accent-ghost/60 hover:text-accent-ghost focus-visible:outline focus-visible:outline-1 focus-visible:outline-offset-2 focus-visible:outline-accent-ghost"
          >
            ⚙
          </button>
        </div>
        <div
          role="status"
          aria-live="polite"
          className="mt-1 text-center font-mono text-[10px] uppercase tracking-[0.16em] text-text-muted"
        >
          {scanning
            ? "Radar sweep in progress"
            : `${ghostCount} ${ghostCount === 1 ? "synapse" : "synapses"} detected`}
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
      <AISettingsModal open={settingsOpen} onClose={closeSettings} onKeyChange={setUserKey} />
      <IngestionPlatenModal open={platenOpen} onClose={closePlaten} onIngested={onIngested} />
      <AddCardModal open={modalOpen} onClose={closeModal} onSubmit={addCard} />
    </Panel>
  );
}

const Flow = memo(function Flow() {
  const nodes = useMemexStore(selectNodes);
  const realEdges = useMemexStore(selectEdges);
  const discoveries = useMemexStore(selectDiscoveries);
  // Ghost synapses are derived display edges; memoized on the two source arrays
  // so card drags never rebuild them.
  const edges = useMemo(
    () => ((discoveries?.length ?? 0) === 0 ? realEdges : [...realEdges, ...buildGhostEdges(discoveries)]),
    [realEdges, discoveries],
  );
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
      <CuratorsIndexTrigger />
      <TrailCameraDirector />
      <TrailPlaybackDock />
      <ArchivalTimeline />
      <SprocketCrawler />
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
    <div style={{ position: "relative", width: "100vw", height: "100vh", background: "#090A0F" }}>
      {hydrated ? (
        <ReactFlowProvider>
          <Flow />
        </ReactFlowProvider>
      ) : null}
      {hydrated ? <SynapseInspectorDrawer /> : null}
      {hydrated ? <CuratorsIndexDrawer /> : null}
      <BriefingHost />
      <RetroToaster />
    </div>
  );
}
