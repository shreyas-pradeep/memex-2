"use client";

import { useEffect } from "react";
import { useReactFlow } from "@xyflow/react";
import type { AssociativeEdge, MemexNode } from "@/core/types";
import { DEFAULT_CARD_SIZE, useMemexStore, type MemexStore } from "@/store/useMemexStore";

export const TRAIL_ZOOM = 1.15;
export const TRAIL_CAMERA_MS = 800;

const selectActiveTrailId = (s: MemexStore) => s.activeTrailId;
const selectActiveTrailIndex = (s: MemexStore) => s.activeTrailIndex;

function toNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * Glides the camera to each trail stop. Renders nothing. Must be mounted
 * inside `ReactFlowProvider`.
 */
export function TrailCameraDirector() {
  const trailId = useMemexStore(selectActiveTrailId);
  const index = useMemexStore(selectActiveTrailIndex);
  const { setCenter, getInternalNode } = useReactFlow<MemexNode, AssociativeEdge>();

  useEffect(() => {
    if (trailId === null) return;
    const { trails, nodes } = useMemexStore.getState();
    const nodeId = trails.find((t) => t.id === trailId)?.nodeIds[index];
    if (nodeId === undefined) return;
    const node = nodes.find((n) => n.id === nodeId);
    if (!node) return;

    const internal = getInternalNode(nodeId);
    const width =
      internal?.measured.width ??
      toNumber(node.width) ??
      toNumber(node.style?.width) ??
      DEFAULT_CARD_SIZE.width;
    const height =
      internal?.measured.height ??
      toNumber(node.height) ??
      toNumber(node.style?.height) ??
      DEFAULT_CARD_SIZE.height;
    const origin = internal?.internals.positionAbsolute ?? node.position;

    void setCenter(origin.x + width / 2, origin.y + height / 2, {
      zoom: TRAIL_ZOOM,
      duration: TRAIL_CAMERA_MS,
    });
  }, [trailId, index, setCenter, getInternalNode]);

  return null;
}
