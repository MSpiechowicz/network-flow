import type {
  LinkDef,
  LinkId,
  LinkMedium,
  NodeAction,
  NodeDef,
  NodeId,
  PacketDef,
  ScenarioDef,
  StepDef,
} from '../model/types';

/** Default travel time of one hop, by link medium. */
export const DEFAULT_HOP_MS: Record<LinkMedium, number> = {
  ethernet: 450,
  wifi: 550,
  wan: 900,
  backbone: 1100,
};
/** Default pause at a transit node between two hops. */
export const DEFAULT_DWELL_MS = 150;
/** Default idle time after the last event of a step. */
export const DEFAULT_TAIL_MS = 600;

export interface CompiledHop {
  linkId: LinkId;
  from: NodeId;
  to: NodeId;
  startMs: number;
  endMs: number;
}

export interface CompiledPacket {
  def: PacketDef;
  /** Index in `CompiledScenario.packets` (scenario-wide capture order). */
  index: number;
  stepIndex: number;
  /** Full route `[from, ...via, to]`, even when the outcome truncates the hops. */
  route: NodeId[];
  /** Hops actually travelled: truncated by a `lost` or `dropped` outcome. */
  hops: CompiledHop[];
  /** Broadcast copies leaving `to`, one hop each. Empty when the outcome truncated the route. */
  floodHops: CompiledHop[];
  /** Absolute animation time: first hop start, and the end of the last hop or flood hop. */
  startMs: number;
  endMs: number;
}

export interface CompiledAction {
  def: NodeAction;
  stepIndex: number;
  startMs: number;
  endMs: number;
}

export interface CompiledStep {
  def: StepDef;
  index: number;
  startMs: number;
  endMs: number;
  packetIndices: number[];
  actionIndices: number[];
}

export interface CompiledScenario {
  def: ScenarioDef;
  steps: CompiledStep[];
  packets: CompiledPacket[];
  actions: CompiledAction[];
  durationMs: number;
  nodeById: ReadonlyMap<NodeId, NodeDef>;
  linkBetween(a: NodeId, b: NodeId): LinkDef | undefined;
}

/**
 * Turns a scenario into absolute animation times.
 *
 * - Steps are contiguous: `steps[0].startMs = 0`, `steps[i].startMs = steps[i-1].endMs`, and
 *   `step.endMs = startMs + max(last packet/flood/action end, 0) + tailMs`.
 * - Hop `k` starts when hop `k-1` ended plus the dwell. With the same hop time on every link this is
 *   exactly `start + k*hopMs + k*dwellMs`; it also stays correct when link media differ.
 * - `lost`: the route keeps the hop leaving `afterNode` (the packet fades on it). `dropped`: the
 *   route ends on arrival at `atNode` (zero hops when that is `from`). Neither floods.
 *
 * Throws if a route step has no link or an outcome node is not on the route; the validator reports
 * these first for registered scenarios.
 */
export function compileScenario(def: ScenarioDef): CompiledScenario {
  const nodeById = new Map<NodeId, NodeDef>();
  for (const node of def.nodes) {
    nodeById.set(node.id, node);
  }

  const linkByPair = new Map<string, LinkDef>();
  for (const link of def.links) {
    linkByPair.set(pairKey(link.a, link.b), link);
    linkByPair.set(pairKey(link.b, link.a), link);
  }

  const linkBetween = (a: NodeId, b: NodeId): LinkDef | undefined => linkByPair.get(pairKey(a, b));

  const steps: CompiledStep[] = [];
  const packets: CompiledPacket[] = [];
  const actions: CompiledAction[] = [];

  let cursor = 0;

  def.steps.forEach((stepDef, stepIndex) => {
    const stepStart = cursor;
    const packetIndices: number[] = [];
    const actionIndices: number[] = [];
    let lastEnd = 0;

    for (const packetDef of stepDef.packets) {
      const packet = compilePacket(
        def,
        packetDef,
        packets.length,
        stepIndex,
        stepStart,
        linkBetween,
      );

      packetIndices.push(packet.index);
      packets.push(packet);
      lastEnd = Math.max(lastEnd, packet.endMs - stepStart);
    }

    for (const actionDef of stepDef.actions ?? []) {
      const action: CompiledAction = {
        def: actionDef,
        stepIndex,
        startMs: stepStart + actionDef.at,
        endMs: stepStart + actionDef.at + actionDef.durationMs,
      };

      actionIndices.push(actions.length);
      actions.push(action);
      lastEnd = Math.max(lastEnd, action.endMs - stepStart);
    }

    const stepEnd = stepStart + lastEnd + (stepDef.tailMs ?? DEFAULT_TAIL_MS);

    steps.push({
      def: stepDef,
      index: stepIndex,
      startMs: stepStart,
      endMs: stepEnd,
      packetIndices,
      actionIndices,
    });
    cursor = stepEnd;
  });

  return { def, steps, packets, actions, durationMs: cursor, nodeById, linkBetween };
}

function pairKey(a: NodeId, b: NodeId): string {
  return `${a}\u0000${b}`;
}

function compilePacket(
  scenario: ScenarioDef,
  def: PacketDef,
  index: number,
  stepIndex: number,
  stepStart: number,
  linkBetween: (a: NodeId, b: NodeId) => LinkDef | undefined,
): CompiledPacket {
  const route = [def.from, ...(def.via ?? []), def.to];
  const startMs = stepStart + def.at;
  const dwellMs = def.dwellMs ?? DEFAULT_DWELL_MS;

  const hopLink = (from: NodeId, to: NodeId): LinkDef => {
    const link = linkBetween(from, to);
    if (link === undefined) {
      throw new Error(
        `Scenario "${scenario.id}", packet "${def.id}": no link between "${from}" and "${to}"`,
      );
    }

    return link;
  };

  const hopCount = travelledHopCount(scenario, def, route);

  const hops: CompiledHop[] = [];
  let cursor = startMs;

  for (let k = 0; k < hopCount; k++) {
    const from = route[k] as NodeId;
    const to = route[k + 1] as NodeId;
    const link = hopLink(from, to);

    if (k > 0) {
      cursor += dwellMs;
    }

    const hop: CompiledHop = {
      linkId: link.id,
      from,
      to,
      startMs: cursor,
      endMs: cursor + (def.hopMs ?? DEFAULT_HOP_MS[link.medium]),
    };

    hops.push(hop);
    cursor = hop.endMs;
  }

  const floodHops: CompiledHop[] = [];
  const reachesDestination = hopCount === route.length - 1;
  let endMs = cursor;

  if (reachesDestination && def.floodTo !== undefined) {
    const floodStart = hops.length > 0 ? cursor + dwellMs : cursor;

    for (const neighbour of def.floodTo) {
      const link = hopLink(def.to, neighbour);
      const hop: CompiledHop = {
        linkId: link.id,
        from: def.to,
        to: neighbour,
        startMs: floodStart,
        endMs: floodStart + (def.hopMs ?? DEFAULT_HOP_MS[link.medium]),
      };

      floodHops.push(hop);
      endMs = Math.max(endMs, hop.endMs);
    }
  }

  return { def, index, stepIndex, route, hops, floodHops, startMs, endMs };
}

/** Number of route hops the packet actually travels, given its outcome. */
function travelledHopCount(scenario: ScenarioDef, def: PacketDef, route: NodeId[]): number {
  const full = route.length - 1;
  const outcome = def.outcome;

  if (outcome === undefined) {
    return full;
  }

  if (outcome.kind === 'lost') {
    const at = route.indexOf(outcome.afterNode);
    assertOnRoute(scenario, def, at, outcome.afterNode);

    // The hop leaving afterNode is the one the packet fades on; the last node has no such hop.
    return Math.min(at + 1, full);
  }

  if (outcome.kind === 'dropped') {
    const at = route.indexOf(outcome.atNode);
    assertOnRoute(scenario, def, at, outcome.atNode);

    return at;
  }

  return full;
}

function assertOnRoute(scenario: ScenarioDef, def: PacketDef, at: number, node: NodeId): void {
  if (at < 0) {
    throw new Error(
      `Scenario "${scenario.id}", packet "${def.id}": outcome node "${node}" is not on the route`,
    );
  }
}
