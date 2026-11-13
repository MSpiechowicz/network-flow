import type { NodeId } from '../model/types';
import type { CompiledHop, CompiledPacket, CompiledScenario, CompiledStep } from './compile';

/** How long an arrived packet stays visible after its last hop ends. */
export const DEFAULT_LINGER_MS = 400;

/** Index of the step containing `timeMs`: half-open `[start, end)`, the last step includes the end. */
export function stepIndexAt(c: CompiledScenario, timeMs: number): number {
  const steps = c.steps;
  if (steps.length === 0) {
    return 0;
  }

  // Largest index whose start is at or before the time; equal starts (empty steps) pick the later one.
  let lo = 0;
  let hi = steps.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    const startMs = (steps[mid] as CompiledStep).startMs;
    if (startMs <= timeMs) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }

  return lo;
}

export type ActivePhase = 'travelling' | 'dwelling' | 'arrived' | 'lost' | 'dropped' | 'blocked';

export interface ActivePacket {
  packet: CompiledPacket;
  /** 0 = the main packet, > 0 = broadcast copy `copy` (index `copy - 1` in `packet.floodHops`). */
  copy: number;
  /** The hop being travelled, or the hop just completed while dwelling / arrived / flagged. */
  hop: CompiledHop;
  /** 0..1 along `hop` (from `hop.from` to `hop.to`); quantized to 0 or 1 when `quantize` is set. */
  hopProgress: number;
  phase: ActivePhase;
}

export interface ActivePacketOptions {
  /** Reduced motion: progress jumps between hop endpoints (0 before the hop midpoint, 1 after). */
  quantize?: boolean;
  /** Visibility after arrival. Default 400. */
  lingerMs?: number;
}

/**
 * Packets (and broadcast copies) visible at `timeMs`, ordered by packet index, then copy.
 *
 * Phases of the main copy:
 * - `travelling`: on a hop; `dwelling`: paused at a transit node (hop = the hop just completed,
 *   progress 1). A broadcast packet also dwells at `to` until its copies leave.
 * - `arrived`: delivered, visible for `lingerMs`.
 * - `lost`: the hop leaving `afterNode` is flagged `lost` while it is travelled (progress 0..1; draw it
 *   fading), then stays `lost` at progress 1.
 * - `dropped` / `blocked`: after arriving at `atNode` (dropped) or `to` (blocked) the packet stays
 *   flagged with progress 1.
 * Flagged outcomes (`lost`, `dropped`, `blocked`) remain until the end of their step (inclusive, so the
 * frame auto-pause stops on still shows them) or `lingerMs` after arrival, whichever is later.
 * A packet dropped at its own `from` node has no hops and never appears.
 */
export function selectActivePackets(
  c: CompiledScenario,
  timeMs: number,
  opts?: ActivePacketOptions,
): ActivePacket[] {
  const quantize = opts?.quantize ?? false;
  const lingerMs = opts?.lingerMs ?? DEFAULT_LINGER_MS;
  const result: ActivePacket[] = [];

  for (const packet of c.packets) {
    // Cheap rejection: nothing of this packet can be visible before it starts.
    if (packet.startMs > timeMs || packet.hops.length === 0) {
      continue;
    }

    if (isVisible(c, packet, 0, timeMs, lingerMs)) {
      result.push(mainCopy(packet, timeMs, quantize));
    }

    for (let i = 0; i < packet.floodHops.length; i++) {
      if (isVisible(c, packet, i + 1, timeMs, lingerMs)) {
        result.push(floodCopy(packet, i, timeMs, quantize));
      }
    }
  }

  return result;
}

function isFlagged(packet: CompiledPacket): boolean {
  const kind = packet.def.outcome?.kind;

  return kind === 'lost' || kind === 'dropped' || kind === 'blocked';
}

function copyStart(packet: CompiledPacket, copy: number): number {
  const hop = copy === 0 ? packet.hops[0] : packet.floodHops[copy - 1];

  return (hop as CompiledHop).startMs;
}

/** Exclusive end of visibility (inclusive for flagged outcomes, see `selectActivePackets`). */
function copyEnd(
  c: CompiledScenario,
  packet: CompiledPacket,
  copy: number,
  lingerMs: number,
): number {
  if (copy > 0) {
    return (packet.floodHops[copy - 1] as CompiledHop).endMs + lingerMs;
  }

  if (packet.floodHops.length > 0) {
    // The main packet dwells at `to` until its copies leave.
    return (packet.floodHops[0] as CompiledHop).startMs;
  }

  const lingerEnd = (packet.hops[packet.hops.length - 1] as CompiledHop).endMs + lingerMs;
  if (!isFlagged(packet)) {
    return lingerEnd;
  }

  const step = c.steps[packet.stepIndex];

  return step === undefined ? lingerEnd : Math.max(lingerEnd, step.endMs);
}

function isVisible(
  c: CompiledScenario,
  packet: CompiledPacket,
  copy: number,
  timeMs: number,
  lingerMs: number,
): boolean {
  if (timeMs < copyStart(packet, copy)) {
    return false;
  }

  const end = copyEnd(c, packet, copy, lingerMs);

  // Half-open, so a flagged packet never leaks into the next step; only the very last instant of
  // the scenario is inclusive, because playback parks exactly on `durationMs`.
  return timeMs < end || (copy === 0 && isFlagged(packet) && end >= c.durationMs && timeMs <= end);
}

function progressOf(hop: CompiledHop, timeMs: number, quantize: boolean): number {
  const span = hop.endMs - hop.startMs;
  const raw = span > 0 ? (timeMs - hop.startMs) / span : 1;
  const progress = Math.min(1, Math.max(0, raw));

  if (quantize) {
    return progress < 0.5 ? 0 : 1;
  }

  return progress;
}

function mainCopy(packet: CompiledPacket, timeMs: number, quantize: boolean): ActivePacket {
  const hops = packet.hops;
  const lastIndex = hops.length - 1;
  const outcome = packet.def.outcome?.kind;

  for (let k = 0; k <= lastIndex; k++) {
    const hop = hops[k] as CompiledHop;
    if (timeMs >= hop.endMs) {
      continue;
    }

    if (timeMs >= hop.startMs) {
      const phase: ActivePhase = k === lastIndex && outcome === 'lost' ? 'lost' : 'travelling';

      return { packet, copy: 0, hop, hopProgress: progressOf(hop, timeMs, quantize), phase };
    }

    // Between hop k-1 and hop k: dwelling at the transit node. k > 0 because timeMs >= startMs.
    const previous = hops[k - 1] as CompiledHop;

    return { packet, copy: 0, hop: previous, hopProgress: 1, phase: 'dwelling' };
  }

  const last = hops[lastIndex] as CompiledHop;

  return { packet, copy: 0, hop: last, hopProgress: 1, phase: terminalPhase(packet) };
}

function terminalPhase(packet: CompiledPacket): ActivePhase {
  const outcome = packet.def.outcome?.kind;

  if (outcome === 'lost' || outcome === 'dropped' || outcome === 'blocked') {
    return outcome;
  }

  return packet.floodHops.length > 0 ? 'dwelling' : 'arrived';
}

function floodCopy(
  packet: CompiledPacket,
  index: number,
  timeMs: number,
  quantize: boolean,
): ActivePacket {
  const hop = packet.floodHops[index] as CompiledHop;
  const arrived = timeMs >= hop.endMs;

  return {
    packet,
    copy: index + 1,
    hop,
    hopProgress: progressOf(hop, timeMs, quantize),
    phase: arrived ? 'arrived' : 'travelling',
  };
}

/**
 * Nodes to highlight in the given step: the sender while its first hop is under way, the receiver for
 * `DEFAULT_LINGER_MS` after arrival (the node a `dropped` packet stops at counts; a `lost` packet has no
 * receiver), flood recipients on arrival, and nodes with a running local action.
 * The step's `focus` list is not included; the UI reads it from `steps[stepIndex].def.focus`.
 */
export function selectActiveNodes(
  c: CompiledScenario,
  stepIndex: number,
  timeMs: number,
): Set<NodeId> {
  const nodes = new Set<NodeId>();
  const step = c.steps[stepIndex];
  if (step === undefined) {
    return nodes;
  }

  for (const index of step.packetIndices) {
    const packet = c.packets[index] as CompiledPacket;
    const first = packet.hops[0];
    const last = packet.hops[packet.hops.length - 1];
    if (first === undefined || last === undefined) {
      continue;
    }

    if (timeMs >= first.startMs && timeMs <= first.endMs) {
      nodes.add(packet.def.from);
    }

    const lost = packet.def.outcome?.kind === 'lost';
    if (!lost && timeMs >= last.endMs && timeMs <= last.endMs + DEFAULT_LINGER_MS) {
      nodes.add(last.to);
    }

    for (const hop of packet.floodHops) {
      if (timeMs >= hop.endMs && timeMs <= hop.endMs + DEFAULT_LINGER_MS) {
        nodes.add(hop.to);
      }
    }
  }

  for (const index of step.actionIndices) {
    const action = c.actions[index];
    if (action !== undefined && timeMs >= action.startMs && timeMs <= action.endMs) {
      nodes.add(action.def.node);
    }
  }

  return nodes;
}

export interface PacketRow {
  packet: CompiledPacket;
  state: 'past' | 'current';
}

/** Packets whose `startMs <= timeMs` in capture order; `current` when they belong to `stepIndex`. */
export function selectPacketRows(
  c: CompiledScenario,
  stepIndex: number,
  timeMs: number,
): PacketRow[] {
  const rows: PacketRow[] = [];

  for (const packet of c.packets) {
    if (packet.startMs <= timeMs) {
      rows.push({ packet, state: packet.stepIndex === stepIndex ? 'current' : 'past' });
    }
  }

  return rows;
}

/** `selectPacketRows(...).length` without allocating; for equality checks that only need the count. */
export function countStartedPackets(c: CompiledScenario, timeMs: number): number {
  let count = 0;

  for (const packet of c.packets) {
    if (packet.startMs <= timeMs) {
      count++;
    }
  }

  return count;
}

const concurrentCache = new WeakMap<CompiledScenario, number>();

/** Most packets (broadcast copies included) visible at once with the default linger. Cached. */
export function maxConcurrentPackets(c: CompiledScenario): number {
  const cached = concurrentCache.get(c);
  if (cached !== undefined) {
    return cached;
  }

  // Sweep over [start, end) windows; at equal times a window ends before another begins.
  const events: { at: number; delta: 1 | -1 }[] = [];

  for (const packet of c.packets) {
    if (packet.hops.length === 0) {
      continue;
    }

    for (let copy = 0; copy <= packet.floodHops.length; copy++) {
      events.push({ at: copyStart(packet, copy), delta: 1 });
      events.push({ at: copyEnd(c, packet, copy, DEFAULT_LINGER_MS), delta: -1 });
    }
  }

  events.sort((a, b) => a.at - b.at || a.delta - b.delta);

  let current = 0;
  let max = 0;
  for (const event of events) {
    current += event.delta;
    max = Math.max(max, current);
  }

  concurrentCache.set(c, max);

  return max;
}
