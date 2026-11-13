import type { CompiledScenario } from '../../engine/compile';
import { selectActiveNodes, selectActivePackets } from '../../engine/selectors';
import type { ActivePacket } from '../../engine/selectors';
import type { NodeId } from '../../model/types';

/** Everything the scene draws at one instant that moves every frame. */
export interface PacketFrame {
  timeMs: number;
  items: ActivePacket[];
}

interface FrameMemo {
  compiled: CompiledScenario;
  timeMs: number;
  quantize: boolean;
  frame: PacketFrame;
}

let memo: FrameMemo | null = null;

/**
 * Active packets at `timeMs`. The packet layer and the link highlight both need them on every tick, so
 * the last answer is kept and the engine selector runs once per tick.
 */
export function frameAt(c: CompiledScenario, timeMs: number, quantize: boolean): PacketFrame {
  if (
    memo !== null &&
    memo.compiled === c &&
    memo.timeMs === timeMs &&
    memo.quantize === quantize
  ) {
    return memo.frame;
  }

  const frame: PacketFrame = { timeMs, items: selectActivePackets(c, timeMs, { quantize }) };
  memo = { compiled: c, timeMs, quantize, frame };

  return frame;
}

export function sameStrings(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) {
    return false;
  }

  return a.every((value, index) => value === b[index]);
}

/* -------------------------------------------------------------------- links */

export type LinkState = 'active' | 'route';

export interface LinkHighlight {
  linkId: string;
  protocol: string;
  /** `forward` when the packet travels from `link.a` towards `link.b`. */
  direction: 'forward' | 'reverse';
  state: LinkState;
}

const LINK_SEP = '|';

/**
 * Links to recolour right now, as sorted keys (`linkId|protocol|direction|state`). A link is `active`
 * while a packet is on it, and part of the `route` while a visible packet has crossed or will cross it.
 * The value only changes when that set changes, so subscribers re-render a few times per step.
 */
export function selectLinkHighlights(
  c: CompiledScenario,
  timeMs: number,
  quantize: boolean,
): string[] {
  const { items } = frameAt(c, timeMs, quantize);
  const active = new Map<string, string>();
  const route = new Map<string, string>();

  const key = (linkId: string, protocol: string, from: NodeId, to: NodeId, state: LinkState) => {
    const link = c.linkBetween(from, to);
    const direction = link !== undefined && link.a === from ? 'forward' : 'reverse';

    return `${linkId}${LINK_SEP}${protocol}${LINK_SEP}${direction}${LINK_SEP}${state}`;
  };

  for (const item of items) {
    const { hop, packet, phase } = item;
    const protocol = packet.def.protocol;
    const moving = phase === 'travelling' || phase === 'lost';

    if (moving) {
      if (!active.has(hop.linkId)) {
        active.set(hop.linkId, key(hop.linkId, protocol, hop.from, hop.to, 'active'));
      }
    } else if (!route.has(hop.linkId)) {
      route.set(hop.linkId, key(hop.linkId, protocol, hop.from, hop.to, 'route'));
    }

    if (item.copy === 0) {
      for (const other of packet.hops) {
        if (!route.has(other.linkId)) {
          route.set(other.linkId, key(other.linkId, protocol, other.from, other.to, 'route'));
        }
      }
    }
  }

  const keys: string[] = [...active.values()];
  for (const [linkId, value] of route) {
    if (!active.has(linkId)) {
      keys.push(value);
    }
  }

  return keys.sort();
}

export function parseLinkHighlight(value: string): LinkHighlight {
  const [linkId = '', protocol = '', direction = 'forward', state = 'route'] =
    value.split(LINK_SEP);

  return {
    linkId,
    protocol,
    direction: direction === 'reverse' ? 'reverse' : 'forward',
    state: state === 'active' ? 'active' : 'route',
  };
}

/* -------------------------------------------------------------------- nodes */

export type NodeHighlight = 'active' | 'focus';

/**
 * Highlighted devices as sorted keys (`nodeId|active` or `nodeId|focus`): senders, receivers and hosts of
 * running actions from the engine, plus the step's own `focus` list.
 */
export function selectNodeHighlights(
  c: CompiledScenario,
  stepIndex: number,
  timeMs: number,
): string[] {
  const active = selectActiveNodes(c, stepIndex, timeMs);
  const keys: string[] = [];

  for (const id of active) {
    keys.push(`${id}|active`);
  }

  for (const id of c.steps[stepIndex]?.def.focus ?? []) {
    if (!active.has(id)) {
      keys.push(`${id}|focus`);
    }
  }

  return keys.sort();
}

export function nodeHighlightMap(keys: readonly string[]): Map<NodeId, NodeHighlight> {
  const map = new Map<NodeId, NodeHighlight>();

  for (const key of keys) {
    const cut = key.lastIndexOf('|');
    map.set(key.slice(0, cut), key.slice(cut + 1) === 'active' ? 'active' : 'focus');
  }

  return map;
}

/* ------------------------------------------------------------------ actions */

/**
 * Actions whose badge is shown: the latest one started on each device, until the end of its step.
 * Keys are `actionIndex|running`, where `running` is 1 while the action's own time span is under way.
 */
export function selectActionBadges(
  c: CompiledScenario,
  stepIndex: number,
  timeMs: number,
): string[] {
  const step = c.steps[stepIndex];
  if (step === undefined) {
    return [];
  }

  const latest = new Map<NodeId, number>();

  for (const index of step.actionIndices) {
    const action = c.actions[index];
    if (action === undefined || timeMs < action.startMs) {
      continue;
    }

    const earlier = latest.get(action.def.node);
    const earlierStart =
      earlier === undefined ? -Infinity : (c.actions[earlier]?.startMs ?? -Infinity);
    if (action.startMs >= earlierStart) {
      latest.set(action.def.node, index);
    }
  }

  const keys: string[] = [];
  for (const index of latest.values()) {
    const action = c.actions[index];
    if (action !== undefined) {
      keys.push(`${index}|${timeMs <= action.endMs ? 1 : 0}`);
    }
  }

  return keys.sort();
}
