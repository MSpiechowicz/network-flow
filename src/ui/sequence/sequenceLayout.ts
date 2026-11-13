import type { CompiledPacket, CompiledScenario } from '../../engine/compile';
import { stepIndexAt } from '../../engine/selectors';
import type { NodeId, PacketOutcome } from '../../model/types';
import { NODE_KINDS } from '../../protocols/nodeKinds';
import { DEFAULT_TAIL_MS } from '../../engine/compile';

/** Height of the title row at the top of every step band, in px. */
export const BAND_TITLE_HEIGHT = 30;
const TOP_PADDING = 6;
const BOTTOM_PADDING = 40;
/** Shortest arrow or action, so instant events stay visible. */
const MIN_EXTENT = 14;
/** How far along its way a lost or dropped packet is drawn when it stops. */
const STOP_FRACTION = 0.5;

export interface SequenceLayout {
  lanes: { nodeId: NodeId; x: number; label: string }[];
  arrows: {
    packetIndex: number;
    x1: number;
    y1: number;
    x2: number;
    y2: number;
    endKind: PacketOutcome['kind'];
  }[];
  actions: { actionIndex: number; x: number; y0: number; y1: number }[];
  stepBands: { stepIndex: number; y0: number; y1: number }[];
  height: number;
  /** Time to y. At a step boundary the later step wins, like `stepIndexAt`. */
  timeToY(t: number): number;
  /**
   * Where the playhead sits at `t`. Same as `timeToY` while a step's packets and actions run; in
   * the idle tail of a step it also glides across the next step's title row, so the playhead never
   * jumps over a title.
   */
  playheadY(t: number): number;
}

export interface SequenceOptions {
  /** Distance between two lane centres. Default 150. */
  laneGap?: number;
  /** Vertical px per millisecond of animation time. Default 0.06. */
  pxPerMs?: number;
  /** Space left of the first lane, so a few lanes can be centred. Default 0. */
  padLeft?: number;
}

export const DEFAULT_LANE_GAP = 150;
export const DEFAULT_PX_PER_MS = 0.06;

/**
 * Devices that get a lane. An explicit `sequenceLanes` list wins. Otherwise: nodes in order of first
 * appearance on a packet route or as an action host, left out when the device is `hidden` (routers,
 * switches and clouds by default). A hidden device that is itself the sender, receiver or action host
 * still gets a lane, because an arrow needs somewhere to end.
 */
export function sequenceLaneIds(c: CompiledScenario): NodeId[] {
  const explicit = c.def.sequenceLanes;
  if (explicit !== undefined) {
    return explicit.filter((id) => c.nodeById.has(id));
  }

  const appearances: { at: number; ids: NodeId[] }[] = [
    ...c.packets.map((packet) => ({
      at: packet.startMs,
      ids: packet.route.filter(
        (id, index) => index === 0 || index === packet.route.length - 1 || isLaneNode(c, id),
      ),
    })),
    ...c.actions.map((action) => ({ at: action.startMs, ids: [action.def.node] })),
  ];
  // Array.prototype.sort is stable, so ties keep capture order.
  appearances.sort((a, b) => a.at - b.at);

  const lanes: NodeId[] = [];

  for (const { ids } of appearances) {
    for (const id of ids) {
      if (c.nodeById.has(id) && !lanes.includes(id)) {
        lanes.push(id);
      }
    }
  }

  return lanes;
}

function isLaneNode(c: CompiledScenario, id: NodeId): boolean {
  const node = c.nodeById.get(id);

  return node !== undefined && (node.sequence ?? NODE_KINDS[node.kind].defaultSequence) === 'lane';
}

export function layoutSequence(c: CompiledScenario, opts?: SequenceOptions): SequenceLayout {
  const laneGap = opts?.laneGap ?? DEFAULT_LANE_GAP;
  const pxPerMs = opts?.pxPerMs ?? DEFAULT_PX_PER_MS;
  const padLeft = opts?.padLeft ?? 0;

  const laneIds = sequenceLaneIds(c);
  const laneX = new Map<NodeId, number>();
  const lanes = laneIds.map((nodeId, index) => {
    const x = padLeft + laneGap * (index + 0.5);
    laneX.set(nodeId, x);

    return { nodeId, x, label: c.nodeById.get(nodeId)?.label ?? nodeId };
  });

  // Every step is a band: a title row, then its time span.
  const stepBands: SequenceLayout['stepBands'] = [];
  let cursor = TOP_PADDING;
  for (const step of c.steps) {
    const y1 = cursor + BAND_TITLE_HEIGHT + (step.endMs - step.startMs) * pxPerMs;
    stepBands.push({ stepIndex: step.index, y0: cursor, y1 });
    cursor = y1;
  }

  const timeToY = (t: number): number => {
    const index = stepIndexAt(c, t);
    const step = c.steps[index];
    const band = stepBands[index];
    if (step === undefined || band === undefined) {
      return TOP_PADDING;
    }

    const local = Math.min(Math.max(t, step.startMs), step.endMs) - step.startMs;

    return band.y0 + BAND_TITLE_HEIGHT + local * pxPerMs;
  };

  const playheadY = (t: number): number => {
    const index = stepIndexAt(c, t);
    const step = c.steps[index];
    const band = stepBands[index];
    if (step === undefined || band === undefined) {
      return TOP_PADDING;
    }

    const duration = step.endMs - step.startMs;
    const local = Math.min(Math.max(t, step.startMs), step.endMs) - step.startMs;
    const tail = Math.min(step.def.tailMs ?? DEFAULT_TAIL_MS, duration);
    const tailStart = duration - tail;
    const top = band.y0 + BAND_TITLE_HEIGHT;
    if (tail <= 0 || local <= tailStart) {
      return top + local * pxPerMs;
    }

    const nextTitle = index < c.steps.length - 1 ? BAND_TITLE_HEIGHT : 0;

    return top + tailStart * pxPerMs + ((local - tailStart) / tail) * (tail * pxPerMs + nextTitle);
  };

  const arrows = c.packets.map((packet) => layoutArrow(packet, laneX, laneIds, timeToY));

  const actions: SequenceLayout['actions'] = [];
  c.actions.forEach((action, actionIndex) => {
    const x = laneX.get(action.def.node);
    if (x === undefined) {
      return;
    }

    const y0 = timeToY(action.startMs);
    actions.push({ actionIndex, x, y0, y1: Math.max(timeToY(action.endMs), y0 + MIN_EXTENT) });
  });

  return {
    lanes,
    arrows,
    actions,
    stepBands,
    height: cursor + BOTTOM_PADDING,
    timeToY,
    playheadY,
  };
}

function layoutArrow(
  packet: CompiledPacket,
  laneX: ReadonlyMap<NodeId, number>,
  laneIds: readonly NodeId[],
  timeToY: (t: number) => number,
): SequenceLayout['arrows'][number] {
  const route = packet.route;
  const fallback = laneX.get(laneIds[0] ?? '') ?? 0;

  // An endpoint without a lane borrows the nearest device on the route that has one.
  const startId = route.find((id) => laneX.has(id));
  const endId = [...route].reverse().find((id) => laneX.has(id));
  const x1 = laneX.get(startId ?? '') ?? fallback;
  let xEnd = laneX.get(endId ?? '') ?? x1;
  let endMs = packet.hops[packet.hops.length - 1]?.endMs ?? packet.startMs;

  // A broadcast received by a device without a lane (a switch) is drawn as going to the neighbours it
  // is flooded to: the arrow ends on the first of them, the view draws the others as dotted copies.
  const received = route[route.length - 1] ?? '';
  if (!laneX.has(received) && xEnd === x1) {
    const flooded = packet.floodHops.find((hop) => laneX.has(hop.to));
    if (flooded !== undefined) {
      xEnd = laneX.get(flooded.to) ?? xEnd;
      endMs = flooded.endMs;
    }
  }

  const kind = packet.def.outcome?.kind ?? 'delivered';
  const stops = kind === 'lost' || kind === 'dropped';
  const x2 = stops ? x1 + (xEnd - x1) * STOP_FRACTION : xEnd;

  const y1 = timeToY(packet.startMs);
  const y2 = Math.max(timeToY(endMs), y1 + MIN_EXTENT);

  return { packetIndex: packet.index, x1, y1, x2, y2, endKind: kind };
}
