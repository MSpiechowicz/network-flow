import type { LinkDef, NodeId, ScenarioDef } from '../../model/types';

export interface Topology {
  nodeIds: ReadonlySet<NodeId>;
  /** The link joining two nodes in either direction, if any. */
  linkBetween(a: NodeId, b: NodeId): LinkDef | undefined;
  /** Nodes directly linked to `id`. */
  neighbours(id: NodeId): ReadonlySet<NodeId>;
}

function pairKey(a: NodeId, b: NodeId): string {
  return a < b ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/** Lookup structures over the nodes and links. Links with unknown endpoints are ignored. */
export function buildTopology(def: ScenarioDef): Topology {
  const nodeIds = new Set(def.nodes.map((n) => n.id));
  const linksByPair = new Map<string, LinkDef>();
  const neighbourSets = new Map<NodeId, Set<NodeId>>();

  for (const link of def.links) {
    if (!nodeIds.has(link.a) || !nodeIds.has(link.b) || link.a === link.b) {
      continue;
    }

    const key = pairKey(link.a, link.b);
    if (!linksByPair.has(key)) {
      linksByPair.set(key, link);
    }

    for (const [from, to] of [
      [link.a, link.b],
      [link.b, link.a],
    ] as const) {
      const set = neighbourSets.get(from) ?? new Set<NodeId>();
      set.add(to);
      neighbourSets.set(from, set);
    }
  }

  const none: ReadonlySet<NodeId> = new Set();

  return {
    nodeIds,
    linkBetween: (a, b) => linksByPair.get(pairKey(a, b)),
    neighbours: (id) => neighbourSets.get(id) ?? none,
  };
}
