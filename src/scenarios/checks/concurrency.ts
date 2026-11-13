import type { LinkMedium, PacketDef, ScenarioDef, StepDef } from '../../model/types';
import { errorIssue, type ValidationIssue } from './issue';
import { routeOf } from './refs';
import { buildTopology, type Topology } from './topology';

/**
 * Local copy of the engine's timing rules (plan section 2.3). The validator must not import the
 * engine, so these values are repeated here; keep them in step with `src/engine/compile.ts`.
 */
const DEFAULT_HOP_MS: Record<LinkMedium, number> = {
  ethernet: 450,
  wifi: 550,
  wan: 900,
  backbone: 1100,
};
const DEFAULT_DWELL_MS = 150;

export const MAX_CONCURRENT_PACKETS = 12;

/** Time span `[startMs, endMs)` during which one packet or broadcast copy is on screen. */
interface Span {
  startMs: number;
  endMs: number;
}

/**
 * Spans of one packet: the main packet from `at` to its last hop, and one span per broadcast
 * copy. Hop k starts after the previous hops and the dwell at each transit node. A lost packet
 * vanishes on the hop leaving `afterNode`; a dropped one stops on arrival at `atNode`.
 * Returns an empty list when the route does not resolve (that is reported elsewhere).
 */
function packetSpans(packet: PacketDef, topology: Topology): Span[] {
  const route = routeOf(packet);
  const dwellMs = packet.dwellMs ?? DEFAULT_DWELL_MS;

  let hopCount = route.length - 1;
  if (packet.outcome?.kind === 'lost') {
    const index = route.indexOf(packet.outcome.afterNode);
    if (index !== -1) hopCount = Math.min(hopCount, index + 1);
  } else if (packet.outcome?.kind === 'dropped') {
    const index = route.indexOf(packet.outcome.atNode);
    if (index !== -1) hopCount = Math.min(hopCount, index);
  }

  function hopMsBetween(a: string | undefined, b: string | undefined): number | undefined {
    if (a === undefined || b === undefined) return undefined;
    const link = topology.linkBetween(a, b);

    return link ? (packet.hopMs ?? DEFAULT_HOP_MS[link.medium]) : undefined;
  }

  let cursor = packet.at;
  for (let k = 0; k < hopCount; k++) {
    const hopMs = hopMsBetween(route[k], route[k + 1]);
    if (hopMs === undefined) return [];

    cursor += hopMs + (k + 1 < hopCount ? dwellMs : 0);
  }

  const spans: Span[] = [];
  if (hopCount > 0) {
    spans.push({ startMs: packet.at, endMs: cursor });
  }

  // Broadcast copies leave `to` after the main packet has arrived and dwelled there.
  if (packet.outcome === undefined || packet.outcome.kind === 'delivered') {
    for (const target of packet.floodTo ?? []) {
      const hopMs = hopMsBetween(packet.to, target);
      if (hopMs === undefined) continue;

      const startMs = cursor + dwellMs;
      spans.push({ startMs, endMs: startMs + hopMs });
    }
  }

  return spans;
}

/** Most packets (including broadcast copies) on screen at the same instant within one step. */
export function maxConcurrentInStep(
  step: StepDef,
  topology: Topology,
): { count: number; atMs: number } {
  const events: { timeMs: number; delta: 1 | -1 }[] = [];

  for (const packet of step.packets) {
    for (const span of packetSpans(packet, topology)) {
      events.push({ timeMs: span.startMs, delta: 1 }, { timeMs: span.endMs, delta: -1 });
    }
  }

  // Spans are half-open, so at equal times the ends are processed before the starts.
  events.sort((x, y) => x.timeMs - y.timeMs || x.delta - y.delta);

  let current = 0;
  let best = { count: 0, atMs: 0 };
  for (const event of events) {
    current += event.delta;

    if (current > best.count) {
      best = { count: current, atMs: event.timeMs };
    }
  }

  return best;
}

/** Errors for every step that puts more than `limit` packets on screen at once. */
export function checkConcurrency(
  def: ScenarioDef,
  limit: number = MAX_CONCURRENT_PACKETS,
): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const topology = buildTopology(def);

  def.steps.forEach((step, index) => {
    const { count, atMs } = maxConcurrentInStep(step, topology);

    if (count > limit) {
      issues.push(
        errorIssue(
          'concurrent-packets-exceeded',
          `steps[${index}].packets`,
          `step "${step.id}" has ${count} packets on screen at once (at ${atMs} ms); the limit is ${limit}`,
        ),
      );
    }
  });

  return issues;
}
