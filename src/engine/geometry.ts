import type { GridPoint, LinkDef, NodeDef, NodeId, ScenarioDef } from '../model/types';

/** Isometric tile size in screen units (2:1 diamond). */
export const TILE = { w: 128, h: 64 } as const;

export interface Pt {
  x: number;
  y: number;
}

/**
 * Screen-space room a device needs around its base point, used by `sceneBounds`: sprites rise above
 * the grid point and the label sits below it.
 */
export const NODE_EXTENT = { left: 64, right: 64, up: 96, down: 48 } as const;

/** Grid to screen: `x = (col - row) * w / 2`, `y = (col + row) * h / 2 - z` (`z` lifts a point up). */
export function isoToScreen(p: GridPoint, z = 0): Pt {
  return {
    x: ((p.col - p.row) * TILE.w) / 2,
    y: ((p.col + p.row) * TILE.h) / 2 - z,
  };
}

/** Straight segments from node `a` through the link's `via` points to node `b`, in screen space. */
export function linkPolyline(link: LinkDef, nodes: ReadonlyMap<NodeId, NodeDef>): Pt[] {
  const a = nodes.get(link.a);
  const b = nodes.get(link.b);
  if (a === undefined || b === undefined) {
    throw new Error(`Link "${link.id}" references a missing node`);
  }

  return [
    isoToScreen(a.position),
    ...(link.via ?? []).map((point) => isoToScreen(point)),
    isoToScreen(b.position),
  ];
}

/** `linkPolyline` ordered so it starts at `fromNode` (reversed when travelling from `link.b`). */
export function polylineFrom(
  link: LinkDef,
  fromNode: NodeId,
  nodes: ReadonlyMap<NodeId, NodeDef>,
): Pt[] {
  const points = linkPolyline(link, nodes);

  return link.a === fromNode ? points : points.reverse();
}

/**
 * Point at `fraction` (clamped to 0..1) of the polyline's total length, plus the direction of
 * travel there as an angle in radians (`Math.atan2(dy, dx)`, screen y points down). Zero-length
 * segments are skipped; a polyline without length returns its first point and angle 0.
 */
export function pointAlong(points: Pt[], fraction: number): Pt & { angle: number } {
  const first = points[0];
  if (first === undefined) {
    return { x: 0, y: 0, angle: 0 };
  }

  const t = Math.min(1, Math.max(0, fraction));

  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += segmentLength(points[i - 1] as Pt, points[i] as Pt);
  }

  if (total === 0) {
    return { x: first.x, y: first.y, angle: 0 };
  }

  const target = t * total;
  let walked = 0;
  let angle = 0;

  for (let i = 1; i < points.length; i++) {
    const from = points[i - 1] as Pt;
    const to = points[i] as Pt;
    const length = segmentLength(from, to);
    if (length === 0) {
      continue;
    }

    angle = Math.atan2(to.y - from.y, to.x - from.x);

    if (walked + length >= target) {
      const local = (target - walked) / length;

      return { x: from.x + (to.x - from.x) * local, y: from.y + (to.y - from.y) * local, angle };
    }

    walked += length;
  }

  // Floating-point slack: the end of the last non-degenerate segment.
  const last = points[points.length - 1] as Pt;

  return { x: last.x, y: last.y, angle };
}

function segmentLength(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/**
 * Bounding box in screen space of every node (with `NODE_EXTENT`), zone corner and link `via`
 * point, grown by `pad` on all sides (default 24). Empty scenes give a `2 * pad` square at the origin.
 */
export function sceneBounds(
  def: ScenarioDef,
  pad = 24,
): { x: number; y: number; width: number; height: number } {
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  const include = (p: Pt, left = 0, right = 0, up = 0, down = 0): void => {
    minX = Math.min(minX, p.x - left);
    maxX = Math.max(maxX, p.x + right);
    minY = Math.min(minY, p.y - up);
    maxY = Math.max(maxY, p.y + down);
  };

  for (const node of def.nodes) {
    include(
      isoToScreen(node.position),
      NODE_EXTENT.left,
      NODE_EXTENT.right,
      NODE_EXTENT.up,
      NODE_EXTENT.down,
    );
  }

  for (const zone of def.zones ?? []) {
    include(isoToScreen(zone.from));
    include(isoToScreen(zone.to));
    include(isoToScreen({ col: zone.from.col, row: zone.to.row }));
    include(isoToScreen({ col: zone.to.col, row: zone.from.row }));
  }

  for (const link of def.links) {
    for (const point of link.via ?? []) {
      include(isoToScreen(point));
    }
  }

  if (minX > maxX) {
    return { x: -pad, y: -pad, width: 2 * pad, height: 2 * pad };
  }

  return {
    x: minX - pad,
    y: minY - pad,
    width: maxX - minX + 2 * pad,
    height: maxY - minY + 2 * pad,
  };
}
