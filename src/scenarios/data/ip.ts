import {
  defineScenario,
  type NodeId,
  type PacketDef,
  type PacketOutcome,
  type Reference,
} from '../../model/types';
import { IP, MAC } from '../lib/addresses';
import { ethernet, icmp, ipv4, type Ipv4Input } from '../lib/builders';

/**
 * IP: a four-hop path modelled as one packet per hop (so TTL and the Ethernet header can be seen
 * to change while the IP addresses do not), longest-prefix match, TTL expiry with ICMP Time
 * Exceeded, fragmentation at a 1400-byte link, and DF with ICMP Fragmentation Needed.
 *
 * Every router interface has its own MAC address. IPv4 header checksums are computed for real
 * (RFC 1071), so the value visibly changes when a router rewrites TTL. `wireTimeMs` is the moment
 * the sender of each hop transmits, on a global simulated clock: about 0.3 ms on a LAN, 4 ms
 * between R1 and R2 and 5 ms between R2 and R3.
 */

// Addressing plan. Network A 198.51.100.0/24 holds the host and R1; the three router-to-router
// links are /30s in 203.0.113.0/24; network B 192.0.2.64/26 holds R3 and the server.
const HOST_A = '198.51.100.23';
const R1_NET_A = '198.51.100.1';
const R1_TO_R2 = '203.0.113.1';
const R2_TO_R1 = '203.0.113.2';
const R2_TO_R3 = '203.0.113.5';
const R3_TO_R2 = '203.0.113.6';
const R4_TO_R2 = '203.0.113.10';
const R3_NET_B = '192.0.2.65';
const SERVER = IP.origin; // 192.0.2.80, inside 192.0.2.64/26

// One MAC per router interface.
const MAC_R1_HOST = MAC.spare[0];
const MAC_R1_R2 = MAC.spare[1];
const MAC_R2_R1 = MAC.spare[2];
const MAC_R2_R3 = MAC.spare[3];
const MAC_R3_R2 = MAC.spare[4];
const MAC_R3_SERVER = MAC.spare[5];
const MAC_R4_R2 = MAC.spare[6];

/** Ethernet header per link direction: what the sender on that link writes. */
const FRAME = {
  hostToR1: { src: MAC.laptop, dst: MAC_R1_HOST },
  r1ToR2: { src: MAC_R1_R2, dst: MAC_R2_R1 },
  r2ToR3: { src: MAC_R2_R3, dst: MAC_R3_R2 },
  r3ToServer: { src: MAC_R3_SERVER, dst: MAC.origin },
  r2ToR1: { src: MAC_R2_R1, dst: MAC_R1_R2 },
  r3ToR2: { src: MAC_R3_R2, dst: MAC_R2_R3 },
} as const;

type Frame = (typeof FRAME)[keyof typeof FRAME];

/** The Identification values of the pings: one per probe so fragments can be told apart. */
const ID = {
  path: 0x5e10,
  probe: 0x5e11,
  fragmented: 0x7c21,
  dontFragment: 0x7c22,
  timeExceeded: 0x8a01,
  fragNeeded: 0x8a02,
} as const;

const REF = {
  ip: { label: 'RFC 791: Internet Protocol', url: 'https://www.rfc-editor.org/rfc/rfc791' },
  ipFragmentation: {
    label: 'RFC 791 section 3.2: Fragmentation and reassembly',
    url: 'https://www.rfc-editor.org/rfc/rfc791#section-3.2',
  },
  routers: {
    label: 'RFC 1812: Requirements for IPv4 routers',
    url: 'https://www.rfc-editor.org/rfc/rfc1812',
  },
  hosts: {
    label: 'RFC 1122: Requirements for Internet hosts',
    url: 'https://www.rfc-editor.org/rfc/rfc1122',
  },
  icmp: { label: 'RFC 792: ICMP', url: 'https://www.rfc-editor.org/rfc/rfc792' },
  pmtud: { label: 'RFC 1191: Path MTU Discovery', url: 'https://www.rfc-editor.org/rfc/rfc1191' },
  cidr: { label: 'RFC 4632: CIDR', url: 'https://www.rfc-editor.org/rfc/rfc4632' },
  checksum: {
    label: 'RFC 1071: Computing the Internet checksum',
    url: 'https://www.rfc-editor.org/rfc/rfc1071',
  },
  ipv6: { label: 'RFC 8200: IPv6', url: 'https://www.rfc-editor.org/rfc/rfc8200' },
  ipv6Pmtud: {
    label: 'RFC 8201: Path MTU Discovery for IPv6',
    url: 'https://www.rfc-editor.org/rfc/rfc8201',
  },
} as const satisfies Record<string, Reference>;

const PRIVATE_NOTE =
  'The laptop has a public documentation address so that NAT, which rewrites IP addresses, stays out of this path.';
const ARP_NOTE = 'ARP, which supplies each next-hop MAC address, is not shown.';
const REPLY_NOTE = 'The echo reply from the server is omitted; only the outbound probes are drawn.';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

const PROTOCOL_NUMBER = { ICMP: 1, TCP: 6, UDP: 17 } as const;

function addressWords(address: string): [number, number] {
  const o = address.split('.').map(Number);
  const [a = 0, b = 0, c = 0, d = 0] = o;

  return [a * 256 + b, c * 256 + d];
}

/**
 * The IPv4 header checksum (RFC 1071) of a 20-byte header with these fields: the one's complement
 * of the one's-complement sum of the ten 16-bit words, with the checksum word taken as zero.
 */
function headerChecksum(h: Omit<Ipv4Input, 'checksum'>): string {
  const flagsAndOffset = (h.df ? 0x4000 : 0) | (h.mf ? 0x2000 : 0) | (h.fragOffset ?? 0);
  const words = [
    0x4500, // version 4, IHL 5, DSCP/ECN 0
    h.totalLength ?? 0,
    h.id ?? 0,
    flagsAndOffset,
    (h.ttl << 8) | PROTOCOL_NUMBER[h.protocol],
    0,
    ...addressWords(h.src),
    ...addressWords(h.dst),
  ];

  let sum = words.reduce((acc, w) => acc + w, 0);
  while (sum > 0xffff) {
    sum = (sum & 0xffff) + (sum >> 16);
  }

  return `0x${(~sum & 0xffff).toString(16).padStart(4, '0')}`;
}

/** `ipv4()` with the real checksum filled in. */
function ip(input: Omit<Ipv4Input, 'checksum'>): ReturnType<typeof ipv4> {
  return ipv4({ ...input, checksum: headerChecksum(input) });
}

interface Hop {
  id: string;
  from: NodeId;
  to: NodeId;
  via?: NodeId[];
  frame: Frame;
  at: number;
  wireTimeMs: number;
  outcome?: PacketOutcome;
}

/** A hop of the host's ping towards the server: same IP addresses, per-hop TTL and frame. */
function echoHop(
  hop: Hop,
  p: { ttl: number; id: number; label: string; summary: string; df?: boolean },
): PacketDef {
  const header = ip({
    src: HOST_A,
    dst: SERVER,
    ttl: p.ttl,
    id: p.id,
    df: p.df,
    protocol: 'ICMP',
    totalLength: 84,
  });

  return {
    id: hop.id,
    from: hop.from,
    to: hop.to,
    via: hop.via,
    protocol: 'icmp',
    label: p.label,
    summary: p.summary,
    headers: [
      ethernet({ ...hop.frame, etherType: 'IPv4' }),
      header.group,
      icmp({
        type: 8,
        code: 0,
        note: 'Echo request: a ping probe. The code is always 0.',
      }),
    ],
    sizeBytes: 98,
    at: hop.at,
    wireTimeMs: hop.wireTimeMs,
    outcome: hop.outcome,
    meta: { ipv4: header.meta },
  };
}

/** A 1500-byte ping (1472 bytes of echo data) in one piece, as R2 forwards it towards R3. */
function bigEcho(
  hop: Hop,
  p: { id: number; df: boolean; label: string; summary: string },
): PacketDef {
  const header = ip({
    src: HOST_A,
    dst: SERVER,
    ttl: 62,
    id: p.id,
    df: p.df,
    protocol: 'ICMP',
    totalLength: 1500,
  });

  return {
    id: hop.id,
    from: hop.from,
    to: hop.to,
    protocol: 'icmp',
    label: p.label,
    summary: p.summary,
    headers: [
      ethernet({ ...hop.frame, etherType: 'IPv4' }),
      header.group,
      icmp({ type: 8, code: 0, note: 'Echo request carrying 1472 bytes of data.' }),
    ],
    sizeBytes: 1514,
    at: hop.at,
    wireTimeMs: hop.wireTimeMs,
    outcome: hop.outcome,
    meta: { ipv4: header.meta },
  };
}

// ---------------------------------------------------------------------------
// The four hops of the path, TTL 64 down to 61
// ---------------------------------------------------------------------------

const PATH_SUMMARY = `Echo (ping) request ${HOST_A} → ${SERVER}`;

const hop1 = echoHop(
  {
    id: 'p-hop1',
    from: 'laptop',
    to: 'r1',
    frame: FRAME.hostToR1,
    at: 700,
    wireTimeMs: 0,
  },
  { ttl: 64, id: ID.path, label: 'Echo · TTL 64', summary: `${PATH_SUMMARY} ttl=64` },
);
const hop2 = echoHop(
  { id: 'p-hop2', from: 'r1', to: 'r2', frame: FRAME.r1ToR2, at: 900, wireTimeMs: 0.35 },
  { ttl: 63, id: ID.path, label: 'Echo · TTL 63', summary: `${PATH_SUMMARY} ttl=63` },
);
const hop3 = echoHop(
  { id: 'p-hop3', from: 'r2', to: 'r3', frame: FRAME.r2ToR3, at: 1000, wireTimeMs: 4.4 },
  { ttl: 62, id: ID.path, label: 'Echo · TTL 62', summary: `${PATH_SUMMARY} ttl=62` },
);
const hop4 = echoHop(
  { id: 'p-hop4', from: 'r3', to: 'server', frame: FRAME.r3ToServer, at: 0, wireTimeMs: 9.45 },
  { ttl: 61, id: ID.path, label: 'Echo · TTL 61', summary: `${PATH_SUMMARY} ttl=61` },
);

// ---------------------------------------------------------------------------
// TTL expiry
// ---------------------------------------------------------------------------

const PROBE_SUMMARY = `Echo (ping) request ${HOST_A} → ${SERVER}`;

const probe1 = echoHop(
  {
    id: 'p-probe-1',
    from: 'laptop',
    to: 'r1',
    frame: FRAME.hostToR1,
    at: 0,
    wireTimeMs: 2000,
  },
  { ttl: 2, id: ID.probe, label: 'Probe · TTL 2', summary: `${PROBE_SUMMARY} ttl=2` },
);
const probe2 = echoHop(
  {
    id: 'p-probe-2',
    from: 'r1',
    to: 'r2',
    frame: FRAME.r1ToR2,
    at: 600,
    wireTimeMs: 2000.35,
    outcome: {
      kind: 'dropped',
      atNode: 'r2',
      note: 'R2 decrements TTL from 1 to 0 and discards the packet.',
    },
  },
  { ttl: 1, id: ID.probe, label: 'Probe · TTL 1', summary: `${PROBE_SUMMARY} ttl=1` },
);

const timeExceededIp = ip({
  src: R2_TO_R1,
  dst: HOST_A,
  ttl: 64,
  id: ID.timeExceeded,
  protocol: 'ICMP',
  totalLength: 56,
});

const fragNeededIp = ip({
  src: R3_TO_R2,
  dst: HOST_A,
  ttl: 64,
  id: ID.fragNeeded,
  protocol: 'ICMP',
  totalLength: 56,
});

// ---------------------------------------------------------------------------
// Fragmentation: 1500-byte packet over an MTU of 1400
// ---------------------------------------------------------------------------

const frag1Ip = ip({
  src: HOST_A,
  dst: SERVER,
  ttl: 61,
  id: ID.fragmented,
  mf: true,
  fragOffset: 0,
  protocol: 'ICMP',
  totalLength: 1396, // 20 + 1376 data bytes
});
const frag2Ip = ip({
  src: HOST_A,
  dst: SERVER,
  ttl: 61,
  id: ID.fragmented,
  mf: false,
  fragOffset: 172, // 1376 / 8
  protocol: 'ICMP',
  totalLength: 124, // 20 + 104 data bytes
});

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

const ROUTING_TABLE_R2 = [
  'Destination        Next hop        Out',
  '203.0.113.0/30     connected       eth0',
  '203.0.113.4/30     connected       eth1',
  '203.0.113.8/30     connected       eth2',
  '198.51.100.0/24    203.0.113.1     eth0',
  '192.0.2.0/24       203.0.113.10    eth2',
  '192.0.2.64/26      203.0.113.6     eth1',
  '0.0.0.0/0          203.0.113.10    eth2',
].join('\n');

export default defineScenario({
  id: 'ip',
  title: 'IP',
  tagline: 'Hop-by-hop forwarding, TTL, longest-prefix match and fragmentation.',
  category: 'foundations',
  order: 1,
  protocols: ['ethernet', 'ipv4', 'icmp'],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'Your laptop',
      sublabel: HOST_A,
      position: { col: 0, row: 2 },
      zone: 'net-a',
      addresses: { ipv4: HOST_A, mac: MAC.laptop },
    },
    {
      id: 'r1',
      kind: 'router',
      label: 'Router R1',
      sublabel: `${R1_NET_A} · ${R1_TO_R2}`,
      position: { col: 3.25, row: 2 },
      zone: 'net-a',
      sequence: 'lane',
      addresses: { ipv4: R1_NET_A, mac: MAC_R1_HOST },
    },
    {
      id: 'r2',
      kind: 'router',
      label: 'Router R2',
      sublabel: `${R2_TO_R1} · ${R2_TO_R3}`,
      position: { col: 6.5, row: 2 },
      zone: 'transit',
      sequence: 'lane',
      addresses: { ipv4: R2_TO_R1, mac: MAC_R2_R1 },
    },
    {
      id: 'r4',
      kind: 'router',
      label: 'Upstream router R4',
      sublabel: R4_TO_R2,
      position: { col: 6.5, row: -1.25 },
      zone: 'transit',
      addresses: { ipv4: R4_TO_R2, mac: MAC_R4_R2 },
    },
    {
      id: 'r3',
      kind: 'router',
      label: 'Router R3',
      sublabel: `${R3_TO_R2} · ${R3_NET_B}`,
      position: { col: 9.75, row: 2 },
      zone: 'net-b',
      sequence: 'lane',
      addresses: { ipv4: R3_TO_R2, mac: MAC_R3_R2 },
    },
    {
      id: 'server',
      kind: 'server',
      label: 'Server',
      sublabel: SERVER,
      position: { col: 12.75, row: 2 },
      zone: 'net-b',
      addresses: { ipv4: SERVER, mac: MAC.origin },
    },
  ],
  links: [
    {
      id: 'laptop-r1',
      a: 'laptop',
      b: 'r1',
      medium: 'ethernet',
      label: '198.51.100.0/24',
      mtu: 1500,
    },
    { id: 'r1-r2', a: 'r1', b: 'r2', medium: 'wan', label: '203.0.113.0/30', mtu: 1500 },
    { id: 'r2-r3', a: 'r2', b: 'r3', medium: 'backbone', label: '203.0.113.4/30', mtu: 1500 },
    { id: 'r2-r4', a: 'r2', b: 'r4', medium: 'backbone', label: '203.0.113.8/30', mtu: 1500 },
    { id: 'r3-server', a: 'r3', b: 'server', medium: 'ethernet', label: 'MTU 1400', mtu: 1400 },
  ],
  zones: [
    {
      id: 'net-a',
      label: 'Network A · 198.51.100.0/24',
      from: { col: -0.9, row: 0.5 },
      to: { col: 4.2, row: 3.5 },
      tone: 'lan',
    },
    {
      id: 'transit',
      label: 'Transit',
      from: { col: 5.3, row: -2.3 },
      to: { col: 7.7, row: 3.1 },
      tone: 'isp',
    },
    {
      id: 'net-b',
      label: 'Network B · 192.0.2.64/26',
      from: { col: 8.8, row: 0.5 },
      to: { col: 13.7, row: 3.5 },
      tone: 'datacenter',
    },
  ],
  phases: [
    { id: 'forwarding', label: 'Forwarding' },
    { id: 'ttl', label: 'TTL' },
    { id: 'mtu', label: 'MTU' },
  ],
  sequenceLanes: ['laptop', 'r1', 'r2', 'r3', 'server'],
  steps: [
    {
      id: 'host-send',
      phase: 'forwarding',
      title: 'The host sends to its default gateway',
      summary:
        'The destination is off the laptop’s subnet, so the frame goes to the gateway’s MAC address while the IP destination stays the server’s.',
      body: [
        {
          type: 'p',
          text: 'A host compares the destination with its own subnet, `198.51.100.0/24`. `192.0.2.80` is outside it, so the laptop hands the packet to its **default gateway**, router R1. The Ethernet destination is R1’s MAC address; the IP destination stays the final server.',
        },
        {
          type: 'p',
          text: 'Two addresses do two jobs. The IP address names the endpoint for the whole journey. The MAC address names only the next device on the current link. The sender starts TTL at 64.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'The probes are ICMP echo requests (`ping`). They exercise IP without ports or connections to distract from the IP header.',
        },
      ],
      packets: [hop1],
      actions: [
        {
          id: 'a-off-link',
          node: 'laptop',
          kind: 'process',
          label: 'Off-link: use gateway',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['laptop', 'r1'],
      simplifications: [ARP_NOTE, PRIVATE_NOTE, REPLY_NOTE],
      references: [REF.ip, REF.hosts, REF.cidr],
    },
    {
      id: 'router-1',
      phase: 'forwarding',
      title: 'Router 1 forwards: TTL falls, MACs change',
      summary:
        'R1 lowers TTL from 64 to 63, recomputes the header checksum and builds a new Ethernet header. The IP source and destination are untouched.',
      body: [
        {
          type: 'p',
          text: 'A router strips the Ethernet header, reads the IPv4 header, looks up the destination in its routing table, decrements **TTL**, recomputes the **header checksum** (the TTL change invalidates it) and wraps the packet in a new frame for the next hop.',
        },
        {
          type: 'p',
          text: 'Compare with the previous packet: the Ethernet source and destination are new, TTL is 63 and the checksum differs. Source `198.51.100.23`, destination `192.0.2.80` and Identification `0x5e10` are exactly as before.',
        },
      ],
      packets: [hop2],
      actions: [
        {
          id: 'a-r1-forward',
          node: 'r1',
          kind: 'process',
          label: 'Lookup · TTL − 1 · new checksum',
          at: 0,
          durationMs: 800,
        },
      ],
      focus: ['r1', 'r2'],
      simplifications: [
        ARP_NOTE,
        'Each hop is drawn as its own packet. On the wire it is one IP packet carried in a new Ethernet frame at every link.',
      ],
      references: [REF.routers, REF.checksum, REF.ip],
    },
    {
      id: 'router-2-lpm',
      phase: 'forwarding',
      title: 'Router 2 chooses by longest prefix match',
      summary:
        'Three routes match `192.0.2.80`. R2 uses the most specific one, `192.0.2.64/26`, not the broader `/24` or the default route.',
      body: [
        {
          type: 'p',
          text: 'Routers do not stop at the first match. Of all routes that contain the destination, they use the one with the **longest prefix**: the one that fixes the most address bits.',
        },
        { type: 'code', caption: 'Routing table of R2', text: ROUTING_TABLE_R2 },
        {
          type: 'p',
          text: '`192.0.2.80` lies inside the `/26` (addresses 64 to 127), the `/24` and the default route. The `/26` wins and points to R3, so the packet leaves with TTL 62. The two broader routes would have sent it to R4.',
        },
      ],
      packets: [hop3],
      actions: [
        {
          id: 'a-r2-lookup',
          node: 'r2',
          kind: 'process',
          label: 'Best match: 192.0.2.64/26',
          at: 0,
          durationMs: 900,
        },
      ],
      focus: ['r2', 'r3', 'r4'],
      simplifications: [
        'Real tables hold many more routes and are built by routing protocols; this one is reduced to what the lesson needs.',
      ],
      references: [REF.cidr, REF.routers],
    },
    {
      id: 'last-hop',
      phase: 'forwarding',
      title: 'The last router delivers on its own subnet',
      summary:
        '`192.0.2.80` sits on a network attached directly to R3, so R3 addresses the frame to the server itself. TTL is now 61.',
      body: [
        {
          type: 'p',
          text: 'R3 has a connected route for `192.0.2.64/26`, so no further router is needed: the next hop is the destination itself. R3 learns the server’s MAC address (with ARP) and uses it as the Ethernet destination.',
        },
        {
          type: 'p',
          text: 'Across the path TTL fell by one at each router: 64, 63, 62, 61. Four different Ethernet frames carried one IP packet whose addresses and Identification never changed.',
        },
      ],
      packets: [hop4],
      focus: ['r3', 'server'],
      simplifications: [ARP_NOTE, REPLY_NOTE],
      references: [REF.ip, REF.routers],
    },
    {
      id: 'ttl-expiry',
      phase: 'ttl',
      title: 'TTL reaches 0: Router 2 drops the probe',
      summary:
        'A probe sent with TTL 2 survives R1 with TTL 1, but R2 decrements it to 0 and must discard it.',
      body: [
        {
          type: 'p',
          text: 'TTL limits how many routers a packet may cross, so a routing loop cannot keep packets circulating forever. This probe, like those `traceroute` sends, starts with TTL 2. R1 forwards it with TTL 1.',
        },
        {
          type: 'p',
          text: 'R2 decrements TTL to 0 and so **discards the packet** instead of forwarding it. Only forwarding decrements TTL, so a packet that reaches its destination with TTL 1 is still delivered. The X marks the drop at R2.',
        },
      ],
      packets: [probe1, probe2],
      focus: ['r1', 'r2'],
      simplifications: [ARP_NOTE, PRIVATE_NOTE],
      references: [REF.routers, REF.ip],
    },
    {
      id: 'time-exceeded',
      phase: 'ttl',
      title: 'ICMP Time Exceeded returns to the sender',
      summary:
        'R2 sends ICMP type 11, code 0 to the probe’s source, quoting the start of the dropped packet. This is how `traceroute` discovers each router.',
      body: [
        {
          type: 'p',
          text: 'The error is addressed to the dropped packet’s **source**, `198.51.100.23`, from R2’s own address, `203.0.113.2`. ICMP type `11` is Time Exceeded and code `0` means TTL exceeded in transit.',
        },
        {
          type: 'p',
          text: 'It quotes the dropped packet’s IPv4 header and its first 8 payload bytes, which lets the sender match the error to the probe it sent.',
        },
        {
          type: 'p',
          text: '`traceroute` exploits this: it sends probes with TTL 1, 2, 3 and so on, and records which router answers each. Routers may choose not to answer, and many rate-limit ICMP.',
        },
      ],
      packets: [
        {
          id: 'p-time-exceeded',
          from: 'r2',
          via: ['r1'],
          to: 'laptop',
          protocol: 'icmp',
          label: 'Time Exceeded',
          summary: 'Time-to-live exceeded (Time to live exceeded in transit)',
          headers: [
            ethernet({ ...FRAME.r2ToR1, etherType: 'IPv4' }),
            timeExceededIp.group,
            icmp({
              type: 11,
              code: 0,
              note: 'The router dropped the packet because its TTL reached 0.',
              original: `IPv4 header (${HOST_A} → ${SERVER}, id 0x5e11, TTL as received) + first 8 bytes`,
            }),
          ],
          sizeBytes: 70,
          at: 0,
          wireTimeMs: 2004.4,
          meta: { ipv4: timeExceededIp.meta },
        },
      ],
      focus: ['r2', 'laptop'],
      simplifications: [
        'The return trip is drawn as one packet through R1, shown as R2 sent it; R1’s own TTL decrement and new Ethernet header are not repeated.',
        'Routers may quote more than 8 payload bytes; 8 is the minimum RFC 792 requires.',
      ],
      references: [REF.icmp, REF.routers],
    },
    {
      id: 'fragmentation',
      phase: 'mtu',
      title: 'Fragmentation at a smaller-MTU link',
      summary:
        'R3’s link to the server has an MTU of 1400. A 1500-byte packet without DF is split into two fragments that share one Identification value.',
      body: [
        {
          type: 'p',
          text: 'R3 must put a 1500-byte packet onto a link whose MTU is 1400 bytes. DF is clear, so R3 **fragments** it. The 1480 data bytes, including the ICMP header, are split at a multiple of 8 because the offset field counts 8-byte units: 1376 bytes, then 104.',
        },
        {
          type: 'code',
          caption: 'The two fragments',
          text: '            totalLength  data  MF  offset\nfragment 1  1396         1376  1   0\nfragment 2  124          104   0   172  (172 × 8 = 1376)',
        },
        {
          type: 'p',
          text: 'Each fragment has its own 20-byte header and the same Identification, `0x7c21`. Only the destination reassembles; routers on the way treat every fragment as an independent packet.',
        },
      ],
      packets: [
        bigEcho(
          { id: 'p-big', from: 'r2', to: 'r3', frame: FRAME.r2ToR3, at: 0, wireTimeMs: 4000 },
          {
            id: ID.fragmented,
            df: false,
            label: 'Echo · 1500 B',
            summary: `Echo (ping) request ${HOST_A} → ${SERVER}, 1500-byte packet`,
          },
        ),
        {
          id: 'p-frag-1',
          from: 'r3',
          to: 'server',
          protocol: 'ipv4',
          label: 'Fragment 1 (MF)',
          summary: 'Fragmented IP protocol (proto=ICMP 1, off=0, ID=7c21)',
          headers: [
            ethernet({ ...FRAME.r3ToServer, etherType: 'IPv4' }),
            frag1Ip.group,
            icmp({
              type: 8,
              code: 0,
              note: 'Only the first fragment carries the ICMP header.',
            }),
          ],
          payload:
            'Bytes 0 to 1375 of the datagram: the 8-byte ICMP header and 1368 bytes of data.',
          sizeBytes: 1410,
          at: 2300,
          wireTimeMs: 4005.05,
          meta: { ipv4: frag1Ip.meta },
        },
        {
          id: 'p-frag-2',
          from: 'r3',
          to: 'server',
          protocol: 'ipv4',
          label: 'Fragment 2 (last)',
          summary: 'Fragmented IP protocol (proto=ICMP 1, off=1376, ID=7c21)',
          headers: [ethernet({ ...FRAME.r3ToServer, etherType: 'IPv4' }), frag2Ip.group],
          payload: 'Bytes 1376 to 1479 of the datagram: the last 104 bytes of data.',
          sizeBytes: 138,
          at: 2500,
          wireTimeMs: 4005.06,
          meta: { ipv4: frag2Ip.meta },
        },
      ],
      actions: [
        {
          id: 'a-r3-fragment',
          node: 'r3',
          kind: 'process',
          label: '1500 > MTU 1400: fragment',
          at: 1250,
          durationMs: 900,
        },
      ],
      focus: ['r3', 'server'],
      simplifications: [
        'The earlier hops of this ping are not repeated: the 1500-byte packet is drawn leaving R2 with TTL 62.',
        'An ICMP echo is used because it can be sent at any size. TCP avoids fragmentation with MSS and Path MTU Discovery.',
        REPLY_NOTE,
      ],
      references: [REF.ipFragmentation, REF.ip, REF.routers],
    },
    {
      id: 'reassembly',
      phase: 'mtu',
      title: 'Only the destination reassembles',
      summary:
        'The server collects the fragments by source, destination, protocol and Identification and rebuilds the datagram. Losing any fragment loses it all.',
      body: [
        {
          type: 'p',
          text: 'The destination matches fragments by source, destination, protocol and Identification, places each at its offset, and knows the datagram is complete when it holds the fragment with MF=0 and every byte before it. Until then it buffers the pieces and discards them if a reassembly timer expires.',
        },
        {
          type: 'p',
          text: 'Fragmentation has costs. One lost fragment forces the sender to resend the whole datagram, the destination must buffer partial datagrams, and only the first fragment carries the transport header, which many firewalls dislike. That is why modern senders avoid it with Path MTU Discovery.',
        },
      ],
      packets: [],
      actions: [
        {
          id: 'a-reassemble',
          node: 'server',
          kind: 'store',
          label: 'Reassemble id 0x7c21: 1480 B',
          at: 0,
          durationMs: 1600,
        },
      ],
      focus: ['server'],
      simplifications: [
        'The reassembly timeout is not shown; RFC 1122 suggests a value between 60 and 120 seconds.',
      ],
      references: [REF.ipFragmentation, REF.hosts],
      tailMs: 900,
    },
    {
      id: 'df-drop',
      phase: 'mtu',
      title: 'DF set: Router 3 drops the oversized packet',
      summary:
        'The same 1500-byte packet, now with DF set, may not be fragmented. R3 cannot forward it over the 1400-byte link, so it drops it.',
      body: [
        {
          type: 'p',
          text: 'Hosts normally set the **Don’t Fragment** bit and discover the path’s MTU instead of letting routers fragment. This ping has the same size as before and a new Identification, `0x7c22`. DF forbids splitting, and the packet does not fit the 1400-byte link, so R3 discards it.',
        },
        {
          type: 'p',
          text: 'A silent drop would leave the sender guessing, so R3 reports the problem in an ICMP message, as the next step shows.',
        },
      ],
      packets: [
        bigEcho(
          {
            id: 'p-big-df',
            from: 'r2',
            to: 'r3',
            frame: FRAME.r2ToR3,
            at: 0,
            wireTimeMs: 6000,
            outcome: {
              kind: 'dropped',
              atNode: 'r3',
              note: 'The packet exceeds the 1400-byte MTU and DF is set, so R3 drops it.',
            },
          },
          {
            id: ID.dontFragment,
            df: true,
            label: 'Echo · 1500 B DF',
            summary: `Echo (ping) request ${HOST_A} → ${SERVER}, 1500-byte packet, DF set`,
          },
        ),
      ],
      focus: ['r3'],
      simplifications: [
        'The earlier hops of this ping are not repeated: the packet is drawn leaving R2 with TTL 62.',
      ],
      references: [REF.pmtud, REF.ip],
    },
    {
      id: 'frag-needed',
      phase: 'mtu',
      title: 'ICMP Fragmentation Needed with the MTU',
      summary:
        'R3 returns ICMP type 3, code 4 with next-hop MTU 1400, so the sender can use smaller packets: Path MTU Discovery.',
      body: [
        {
          type: 'p',
          text: 'The message says the packet was too big and DF was set, and names the **next-hop MTU**, `1400`. The host records a path MTU of 1400 for this destination and sends smaller packets. TCP does this by lowering its segment size.',
        },
        {
          type: 'p',
          text: 'The mechanism fails when a firewall drops all ICMP: large packets then vanish without explanation, the so-called PMTU black hole.',
        },
        {
          type: 'callout',
          tone: 'warning',
          text: '**IPv6 routers never fragment.** Only the sending host may, using a Fragment extension header. A router that cannot forward a packet drops it and returns ICMPv6 Packet Too Big (type 2). Every IPv6 link must support an MTU of at least 1280 bytes.',
        },
      ],
      packets: [
        {
          id: 'p-frag-needed',
          from: 'r3',
          via: ['r2', 'r1'],
          to: 'laptop',
          protocol: 'icmp',
          label: 'Frag Needed',
          summary: 'Destination unreachable (Fragmentation needed), next-hop MTU 1400',
          headers: [
            ethernet({ ...FRAME.r3ToR2, etherType: 'IPv4' }),
            fragNeededIp.group,
            icmp({
              type: 3,
              code: 4,
              nextHopMtu: 1400,
              note: 'The packet is too big for the next link and DF was set.',
              original: `IPv4 header (${HOST_A} → ${SERVER}, id 0x7c22, DF) + first 8 bytes`,
            }),
          ],
          sizeBytes: 70,
          at: 700,
          wireTimeMs: 6005.05,
          meta: { ipv4: fragNeededIp.meta },
        },
      ],
      actions: [
        {
          id: 'a-r3-df-drop',
          node: 'r3',
          kind: 'process',
          label: 'Drop (DF) and report',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-path-mtu',
          node: 'laptop',
          kind: 'store',
          label: 'Path MTU = 1400',
          at: 3500,
          durationMs: 900,
        },
      ],
      focus: ['r3', 'laptop'],
      simplifications: [
        'The return trip is drawn as one packet through R2 and R1, shown as R3 sent it.',
        'Hosts age out a learned path MTU after a while and probe again; that is not shown.',
      ],
      references: [REF.pmtud, REF.icmp, REF.ipv6, REF.ipv6Pmtud],
    },
  ],
});
