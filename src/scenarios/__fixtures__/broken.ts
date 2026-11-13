import type { PacketDef, ScenarioDef, TcpMeta } from '../../model/types';
import type { ProtocolId } from '../../protocols/registry';
import { IP, ISN } from '../lib/addresses';
import minimal from './minimal';

/**
 * Deliberately invalid scenarios for the validator's negative tests, one per error class.
 *
 * Each case is a copy of the valid `minimal` fixture with exactly one defect injected, so a
 * validator that is correct reports `expect` and little else. This module must never be matched
 * by the `SCENARIOS` glob (it lives in `__fixtures__`, outside `data/`).
 *
 * Not covered here, because they cannot be expressed in a single scenario: duplicate scenario
 * ids across files, and a scenario id that differs from its file name (test those against
 * `SCENARIO_ENTRIES` from `src/scenarios/index.ts`).
 */
export interface BrokenCase {
  /** Stable kebab-case name of the case, usable as a test title. */
  name: string;
  scenario: ScenarioDef;
  /** Short description of the error the validator must raise. */
  expect: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Indexed access that fails loudly instead of returning `undefined`. */
function at<T>(items: readonly T[], index: number, what: string): T {
  const value = items[index];
  if (value === undefined) {
    throw new Error(`broken fixture: no ${what} at index ${index}`);
  }

  return value;
}

/** Fresh deep copy of the valid fixture: nodes laptop/router/server, steps syn/syn-ack/ack. */
function base(): ScenarioDef {
  const copy: ScenarioDef = structuredClone(minimal);

  return copy;
}

function firstPacket(s: ScenarioDef, stepIndex: number): PacketDef {
  return at(at(s.steps, stepIndex, 'step').packets, 0, 'packet');
}

function tcpMeta(s: ScenarioDef, stepIndex: number): TcpMeta {
  const meta = firstPacket(s, stepIndex).meta?.tcp;
  if (!meta) {
    throw new Error(`broken fixture: step ${stepIndex} has no tcp meta`);
  }

  return meta;
}

/** A valid packet with no TCP meta, for padding steps. Defaults to laptop to router. */
function filler(id: string, over: Partial<PacketDef> = {}): PacketDef {
  return {
    id,
    from: 'laptop',
    to: 'router',
    protocol: 'ipv4',
    label: 'filler',
    summary: 'Filler packet',
    headers: [],
    at: 0,
    wireTimeMs: 0,
    ...over,
  };
}

/** Appends a correct two-fragment pair (1500-byte datagram over MTU 1400) to step 0. */
function addFragments(s: ScenarioDef): { first: PacketDef; second: PacketDef } {
  const common = { src: IP.laptop, dst: IP.routerLan, ttl: 64, id: 0x4242 };
  const first = filler('frag-1', {
    meta: { ipv4: { ...common, mf: true, fragOffset: 0, totalLength: 1396 } },
  });
  const second = filler('frag-2', {
    at: 100,
    meta: { ipv4: { ...common, mf: false, fragOffset: 172, totalLength: 124 } },
  });
  at(s.steps, 0, 'step').packets.push(first, second);

  return { first, second };
}

function make(name: string, expect: string, mutate: (s: ScenarioDef) => void): BrokenCase {
  const scenario = base();
  mutate(scenario);

  return { name, scenario, expect };
}

// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export const BROKEN_SCENARIOS: readonly BrokenCase[] = [
  // Identity and uniqueness
  make('scenario-id-not-kebab-case', 'scenario id must be kebab-case', (s) => {
    s.id = 'Not_Kebab';
  }),
  make('duplicate-node-id', 'duplicate node id "laptop"', (s) => {
    s.nodes.push({ ...at(s.nodes, 0, 'node'), position: { col: 9, row: 9 } });
  }),
  make('duplicate-link-id', 'duplicate link id "laptop-router"', (s) => {
    s.links.push({ ...at(s.links, 0, 'link'), a: 'laptop', b: 'server' });
  }),
  make('duplicate-step-id', 'duplicate step id "syn"', (s) => {
    at(s.steps, 1, 'step').id = at(s.steps, 0, 'step').id;
  }),
  make('duplicate-packet-id', 'duplicate packet id "p-syn"', (s) => {
    firstPacket(s, 1).id = firstPacket(s, 0).id;
  }),
  make('duplicate-action-id', 'duplicate action id "a-established"', (s) => {
    const step = at(s.steps, 2, 'step');
    const action = at(step.actions ?? [], 0, 'action');
    step.actions = [...(step.actions ?? []), { ...action, at: 2600 }];
  }),

  // Topology
  make('link-endpoint-missing', 'link "laptop-router" references unknown node "ghost"', (s) => {
    at(s.links, 0, 'link').b = 'ghost';
  }),
  make('self-link', 'link connects node "laptop" to itself', (s) => {
    s.links.push({ id: 'laptop-self', a: 'laptop', b: 'laptop', medium: 'ethernet' });
  }),
  make('duplicate-link-pair', 'more than one link between "router" and "laptop"', (s) => {
    s.links.push({ id: 'router-laptop', a: 'router', b: 'laptop', medium: 'ethernet' });
  }),
  make('shared-grid-cell', 'nodes "laptop" and "router" occupy the same grid cell', (s) => {
    at(s.nodes, 1, 'node').position = { ...at(s.nodes, 0, 'node').position };
  }),
  make('unknown-zone', 'node references unknown zone "nowhere"', (s) => {
    at(s.nodes, 0, 'node').zone = 'nowhere';
  }),
  make('unknown-phase', 'step references unknown phase "ghost"', (s) => {
    at(s.steps, 0, 'step').phase = 'ghost';
  }),
  make('sequence-lane-missing', 'sequenceLanes references unknown node "ghost"', (s) => {
    s.sequenceLanes = ['laptop', 'ghost'];
  }),

  // Packet routes
  make('packet-from-missing', 'packet "p-syn" has unknown `from` node "ghost"', (s) => {
    firstPacket(s, 0).from = 'ghost';
  }),
  make('packet-to-missing', 'packet "p-syn" has unknown `to` node "ghost"', (s) => {
    firstPacket(s, 0).to = 'ghost';
  }),
  make('packet-via-missing', 'packet "p-syn" has unknown `via` node "ghost"', (s) => {
    firstPacket(s, 0).via = ['ghost'];
  }),
  make(
    'route-hop-not-linked',
    'consecutive route nodes "laptop" and "server" are not linked',
    (s) => {
      delete firstPacket(s, 0).via;
    },
  ),
  make(
    'flood-target-not-neighbour',
    'floodTo node "server" is not a neighbour of `to` "laptop"',
    (s) => {
      const p = firstPacket(s, 0);
      p.from = 'router';
      p.to = 'laptop';
      delete p.via;
      p.delivery = 'broadcast';
      p.floodTo = ['server'];
    },
  ),
  make(
    'flood-without-broadcast-delivery',
    'packet with floodTo must set delivery "broadcast"',
    (s) => {
      const p = firstPacket(s, 0);
      p.to = 'router';
      delete p.via;
      p.floodTo = ['server'];
    },
  ),

  // Outcomes
  make('lost-after-node-not-on-route', 'lost outcome node "server" is not on the route', (s) => {
    const p = firstPacket(s, 0);
    p.to = 'router';
    delete p.via;
    p.outcome = { kind: 'lost', afterNode: 'server', note: 'x' };
  }),
  make('lost-after-destination', 'lost outcome afterNode must not be the destination', (s) => {
    firstPacket(s, 0).outcome = { kind: 'lost', afterNode: 'server', note: 'x' };
  }),
  make('dropped-node-not-on-route', 'dropped outcome node "server" is not on the route', (s) => {
    const p = firstPacket(s, 0);
    p.to = 'router';
    delete p.via;
    p.outcome = { kind: 'dropped', atNode: 'server', note: 'x' };
  }),

  // Registry, timing and text limits
  make('unknown-protocol', 'protocol "gopher" is not in the protocol registry', (s) => {
    firstPacket(s, 0).protocol = 'gopher' as unknown as ProtocolId;
  }),
  make('negative-at', 'packet `at` must be >= 0', (s) => {
    firstPacket(s, 0).at = -1;
  }),
  make('packets-not-sorted-by-at', 'packets in a step must be sorted by `at`', (s) => {
    firstPacket(s, 0).at = 500;
    at(s.steps, 0, 'step').packets.push(filler('late', { at: 100 }));
  }),
  make('wire-time-decreases', 'wireTimeMs must not decrease across the scenario', (s) => {
    firstPacket(s, 2).wireTimeMs = 1;
  }),
  make('step-summary-empty', 'step summary must not be empty', (s) => {
    at(s.steps, 0, 'step').summary = '';
  }),
  make('step-title-too-long', 'step title is longer than 48 characters', (s) => {
    at(s.steps, 0, 'step').title = 'T'.repeat(49);
  }),
  make('step-summary-too-long', 'step summary is longer than 200 characters', (s) => {
    at(s.steps, 0, 'step').summary = 'S'.repeat(201);
  }),
  make('packet-label-too-long', 'packet label is longer than 18 characters', (s) => {
    firstPacket(s, 0).label = 'L'.repeat(19);
  }),
  make('action-node-missing', 'action references unknown node "ghost"', (s) => {
    const action = at(at(s.steps, 2, 'step').actions ?? [], 0, 'action');
    action.node = 'ghost';
  }),
  make('too-many-concurrent-packets', 'more than 12 packets on screen at once', (s) => {
    const step = at(s.steps, 0, 'step');
    for (let i = 0; i < 12; i++) {
      step.packets.push(filler(`extra-${i}`));
    }
  }),

  // Addresses
  make('public-ipv4-in-node', 'node address 8.8.8.8 is outside the documentation ranges', (s) => {
    at(s.nodes, 0, 'node').addresses = { ipv4: '8.8.8.8' };
  }),
  make(
    'public-ipv4-in-meta',
    'meta.ipv4 address 1.1.1.1 is outside the documentation ranges',
    (s) => {
      const ipv4 = firstPacket(s, 0).meta?.ipv4;
      if (!ipv4) throw new Error('broken fixture: no ipv4 meta');
      ipv4.dst = '1.1.1.1';
    },
  ),
  make('ipv6-outside-documentation-range', 'IPv6 address must be in 2001:db8::/32', (s) => {
    at(s.nodes, 0, 'node').addresses = { ipv6: '2a00:1450::1' };
  }),
  make('hostname-not-reserved', 'hostname must end in a reserved example domain', (s) => {
    at(s.nodes, 2, 'node').addresses = { hostname: 'www.realsite.com' };
  }),

  // TCP
  make('tcp-first-segment-not-syn', 'first TCP segment of a connection must be SYN', (s) => {
    const m = tcpMeta(s, 0);
    m.flags = ['ACK'];
    m.ack = ISN.server;
  }),
  make('tcp-second-segment-not-syn-ack', 'second segment of the handshake must be SYN+ACK', (s) => {
    tcpMeta(s, 1).flags = ['ACK'];
  }),
  make('tcp-synack-wrong-ack', 'SYN-ACK ack must equal client ISN + 1', (s) => {
    tcpMeta(s, 1).ack = ISN.client + 2;
  }),
  make('tcp-seq-mismatch', 'segment seq does not match the expected next sequence number', (s) => {
    tcpMeta(s, 2).seq = ISN.client + 5;
  }),
  make('tcp-ack-beyond-peer-seq', 'ack acknowledges bytes the peer has not sent', (s) => {
    tcpMeta(s, 2).ack = ISN.server + 10;
  }),

  // IPv4 fragments
  make('fragment-offset-gap', 'fragment offsets are not contiguous', (s) => {
    const { second } = addFragments(s);
    const ipv4 = second.meta?.ipv4;
    if (!ipv4) throw new Error('broken fixture: no ipv4 meta');
    ipv4.fragOffset = 173;
  }),
  make(
    'fragment-length-not-multiple-of-8',
    'data length of a non-last fragment must be a multiple of 8',
    (s) => {
      const { first } = addFragments(s);
      const ipv4 = first.meta?.ipv4;
      if (!ipv4) throw new Error('broken fixture: no ipv4 meta');
      ipv4.totalLength = 1395;
    },
  ),
];
