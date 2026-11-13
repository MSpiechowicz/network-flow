import {
  defineScenario,
  type HeaderGroup,
  type PacketDef,
  type PacketMeta,
  type Reference,
  type TcpFlag,
} from '../../model/types';
import { HOST, IP, ISN, MAC, PORT } from '../lib/addresses';
import { ethernet, ipv4, tcp, tcpSynOptions } from '../lib/builders';

/**
 * TCP: a three-way handshake, a two-segment upload with one loss and an RTO retransmission,
 * duplicate and cumulative ACKs, the four-segment close and TIME-WAIT.
 *
 * Headers are shown as captured at the sender. Timestamps are on a global simulated clock
 * (`wireTimeMs` is the moment the sender transmits); the round-trip time is about 24 ms.
 */

const CONN = 'laptop-upload';
const CLIENT_PORT = 51234;
const SERVER_PORT = PORT.http;

/** Payload of a full segment: MSS 1460 minus the 12 bytes the timestamp option takes. */
const FULL_SEGMENT = 1448;

// Absolute sequence numbers. Client bytes: ISN+1 .. ISN+2896; the server sends no data.
const CLIENT_DATA_START = ISN.client + 1;
const SEG1_SEQ = CLIENT_DATA_START;
const SEG2_SEQ = SEG1_SEQ + FULL_SEGMENT;
const CLIENT_DATA_END = SEG2_SEQ + FULL_SEGMENT; // next byte after the upload; also the FIN's seq
const SERVER_NEXT = ISN.server + 1;

/** The server-side router the server's frames are addressed to. */
const SERVER_GATEWAY_MAC = MAC.spare[0];

const REF = {
  tcp: { label: 'RFC 9293: TCP', url: 'https://www.rfc-editor.org/rfc/rfc9293' },
  establish: {
    label: 'RFC 9293 section 3.5: Establishing a connection',
    url: 'https://www.rfc-editor.org/rfc/rfc9293#section-3.5',
  },
  closing: {
    label: 'RFC 9293 section 3.6: Closing a connection',
    url: 'https://www.rfc-editor.org/rfc/rfc9293#section-3.6',
  },
  retransmit: {
    label: 'RFC 9293 section 3.8.1: Retransmission timeout',
    url: 'https://www.rfc-editor.org/rfc/rfc9293#section-3.8.1',
  },
  options: {
    label: 'RFC 7323: Window scale and timestamps',
    url: 'https://www.rfc-editor.org/rfc/rfc7323',
  },
  sack: {
    label: 'RFC 2018: Selective acknowledgments',
    url: 'https://www.rfc-editor.org/rfc/rfc2018',
  },
  congestion: {
    label: 'RFC 5681: TCP congestion control',
    url: 'https://www.rfc-editor.org/rfc/rfc5681',
  },
  fastRetransmit: {
    label: 'RFC 5681 section 3.2: Fast retransmit',
    url: 'https://www.rfc-editor.org/rfc/rfc5681#section-3.2',
  },
  rto: { label: 'RFC 6298: Computing the RTO', url: 'https://www.rfc-editor.org/rfc/rfc6298' },
  rack: {
    label: 'RFC 8985: RACK-TLP loss detection',
    url: 'https://www.rfc-editor.org/rfc/rfc8985',
  },
} as const satisfies Record<string, Reference>;

const NAT_NOTE =
  'The home router’s NAT rewrites the laptop’s source address to `198.51.100.7`, and the server’s replies are addressed to that public address. Each header is shown as the sender transmitted it.';
const PATH_NOTE = 'ARP and the routers inside the Internet cloud are omitted.';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

type Side = 'client' | 'server';

interface SegmentInput {
  from: Side;
  seq: number;
  ack?: number;
  flags: TcpFlag[];
  len: number;
  /** IPv4 Identification. Zero for the server, which sets DF (many stacks send id 0 then). */
  ipId: number;
  window: number;
  retransmission?: boolean;
  /** One SACK block `[left edge, right edge)` of out-of-order data held by the sender. */
  sack?: readonly [number, number];
}

interface Segment {
  headers: HeaderGroup[];
  meta: PacketMeta;
  sizeBytes: number;
  info: string;
}

const FLAG_ORDER: readonly TcpFlag[] = ['SYN', 'FIN', 'RST', 'PSH', 'ACK'];

/** Builds the link, IPv4 and TCP headers of one segment, with the sizes the options imply. */
function segment(input: SegmentInput): Segment {
  const isSyn = input.flags.includes('SYN');
  const fromClient = input.from === 'client';
  const srcPort = fromClient ? CLIENT_PORT : SERVER_PORT;
  const dstPort = fromClient ? SERVER_PORT : CLIENT_PORT;

  // TCP header: 20 bytes fixed; a SYN carries 20 bytes of options (MSS, SACK permitted,
  // timestamps, NOP, window scale); later segments carry timestamps (12 bytes with padding)
  // and, on a SACKing duplicate ACK, one SACK block (12 bytes with padding).
  const tcpHeaderBytes = isSyn ? 40 : 32 + (input.sack ? 12 : 0);
  const totalLength = 20 + tcpHeaderBytes + input.len;

  const options = isSyn
    ? tcpSynOptions({ windowScale: 7 })
    : [
        {
          name: 'Option: Timestamps',
          value: 'TSval/TSecr',
          note: '10 bytes plus 2 bytes of padding',
        },
        ...(input.sack
          ? [
              {
                name: 'Option: SACK',
                value: `${input.sack[0]}-${input.sack[1]}`,
                note: 'left edge to right edge (exclusive) of data held out of order',
              },
            ]
          : []),
      ];

  const ip = ipv4({
    src: fromClient ? IP.laptop : IP.origin,
    dst: fromClient ? IP.origin : IP.routerPublic,
    ttl: 64,
    id: input.ipId,
    df: true,
    protocol: 'TCP',
    totalLength,
  });
  const seg = tcp(
    {
      conn: CONN,
      srcPort,
      dstPort,
      seq: input.seq,
      ack: input.ack,
      flags: input.flags,
      len: input.len,
      window: input.window,
      retransmission: input.retransmission,
    },
    { options },
  );

  const link = ethernet(
    fromClient
      ? { src: MAC.laptop, dst: MAC.routerLan, etherType: 'IPv4' }
      : { src: MAC.origin, dst: SERVER_GATEWAY_MAC, etherType: 'IPv4' },
  );

  const flags = FLAG_ORDER.filter((f) => input.flags.includes(f)).join(', ');
  const parts = [`${srcPort} → ${dstPort} [${flags}] Seq=${input.seq}`];
  if (input.ack !== undefined) parts.push(`Ack=${input.ack}`);
  if (isSyn) parts.push(`Win=${input.window}`);
  parts.push(`Len=${input.len}`);
  if (isSyn) parts.push('MSS=1460 SACK_PERM WS=128');
  if (input.sack) parts.push(`SACK=${input.sack[0]}-${input.sack[1]}`);

  return {
    headers: [link, ip.group, seg.group],
    meta: { ipv4: ip.meta, tcp: seg.meta },
    sizeBytes: totalLength + 14,
    info: parts.join(' '),
  };
}

type Route = Pick<PacketDef, 'from' | 'via' | 'to'>;

const CLIENT_ROUTE: Route = { from: 'laptop', via: ['router', 'cloud'], to: 'server' };
const SERVER_ROUTE: Route = { from: 'server', via: ['cloud', 'router'], to: 'laptop' };

function tcpPacket(
  id: string,
  route: Route,
  label: string,
  seg: Segment,
  timing: Pick<PacketDef, 'at' | 'wireTimeMs'>,
  extra: Partial<PacketDef> = {},
): PacketDef {
  return {
    id,
    ...route,
    protocol: 'tcp',
    label,
    summary: seg.info,
    headers: seg.headers,
    sizeBytes: seg.sizeBytes,
    meta: seg.meta,
    ...timing,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Segments
// ---------------------------------------------------------------------------

const syn = segment({
  from: 'client',
  seq: ISN.client,
  flags: ['SYN'],
  len: 0,
  ipId: 0x1c46,
  window: 64240,
});
const synAck = segment({
  from: 'server',
  seq: ISN.server,
  ack: ISN.client + 1,
  flags: ['SYN', 'ACK'],
  len: 0,
  ipId: 0,
  window: 65160,
});
const handshakeAck = segment({
  from: 'client',
  seq: CLIENT_DATA_START,
  ack: SERVER_NEXT,
  flags: ['ACK'],
  len: 0,
  ipId: 0x1c47,
  window: 502,
});
const seg1 = segment({
  from: 'client',
  seq: SEG1_SEQ,
  ack: SERVER_NEXT,
  flags: ['ACK'],
  len: FULL_SEGMENT,
  ipId: 0x1c48,
  window: 502,
});
const seg2 = segment({
  from: 'client',
  seq: SEG2_SEQ,
  ack: SERVER_NEXT,
  flags: ['PSH', 'ACK'],
  len: FULL_SEGMENT,
  ipId: 0x1c49,
  window: 502,
});
const dupAck = segment({
  from: 'server',
  seq: SERVER_NEXT,
  ack: SEG1_SEQ,
  flags: ['ACK'],
  len: 0,
  ipId: 0,
  window: 509,
  sack: [SEG2_SEQ, CLIENT_DATA_END],
});
const retransmit = segment({
  from: 'client',
  seq: SEG1_SEQ,
  ack: SERVER_NEXT,
  flags: ['ACK'],
  len: FULL_SEGMENT,
  ipId: 0x1c4a,
  window: 502,
  retransmission: true,
});
const cumulativeAck = segment({
  from: 'server',
  seq: SERVER_NEXT,
  ack: CLIENT_DATA_END,
  flags: ['ACK'],
  len: 0,
  ipId: 0,
  window: 509,
});
const clientFin = segment({
  from: 'client',
  seq: CLIENT_DATA_END,
  ack: SERVER_NEXT,
  flags: ['FIN', 'ACK'],
  len: 0,
  ipId: 0x1c4b,
  window: 502,
});
const finAck = segment({
  from: 'server',
  seq: SERVER_NEXT,
  ack: CLIENT_DATA_END + 1,
  flags: ['ACK'],
  len: 0,
  ipId: 0,
  window: 509,
});
const serverFin = segment({
  from: 'server',
  seq: SERVER_NEXT,
  ack: CLIENT_DATA_END + 1,
  flags: ['FIN', 'ACK'],
  len: 0,
  ipId: 0,
  window: 509,
});
const finalAck = segment({
  from: 'client',
  seq: CLIENT_DATA_END + 1,
  ack: SERVER_NEXT + 1,
  flags: ['ACK'],
  len: 0,
  ipId: 0x1c4c,
  window: 502,
});

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export default defineScenario({
  id: 'tcp',
  title: 'TCP',
  tagline: 'A reliable byte stream built from sequence numbers, ACKs and timers.',
  category: 'foundations',
  order: 2,
  protocols: ['ethernet', 'ipv4', 'tcp'],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'Your laptop',
      sublabel: IP.laptop,
      position: { col: 0, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop },
    },
    {
      id: 'router',
      kind: 'router',
      label: 'Home router',
      sublabel: IP.routerLan,
      position: { col: 2.5, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.routerLan, mac: MAC.routerLan },
    },
    {
      id: 'cloud',
      kind: 'cloud',
      label: 'Internet',
      position: { col: 5, row: 2 },
      zone: 'internet',
    },
    {
      id: 'server',
      kind: 'origin-server',
      label: 'Web server',
      sublabel: IP.origin,
      position: { col: 8.25, row: 2 },
      zone: 'datacenter',
      addresses: { ipv4: IP.origin, mac: MAC.origin, hostname: HOST.origin },
    },
  ],
  links: [
    { id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' },
    { id: 'router-cloud', a: 'router', b: 'cloud', medium: 'wan' },
    { id: 'cloud-server', a: 'cloud', b: 'server', medium: 'wan' },
  ],
  zones: [
    {
      id: 'home',
      label: 'Home LAN',
      from: { col: -0.75, row: 0.5 },
      to: { col: 3.25, row: 3.5 },
      tone: 'lan',
    },
    {
      id: 'internet',
      label: 'Internet',
      from: { col: 3.5, row: 0.5 },
      to: { col: 6.5, row: 3.5 },
      tone: 'internet',
    },
    {
      id: 'datacenter',
      label: 'Data centre',
      from: { col: 6.75, row: 0.5 },
      to: { col: 9.75, row: 3.5 },
      tone: 'datacenter',
    },
  ],
  phases: [
    { id: 'handshake', label: 'Opening' },
    { id: 'data', label: 'Sending data' },
    { id: 'close', label: 'Closing' },
  ],
  sequenceLanes: ['laptop', 'server'],
  steps: [
    {
      id: 'syn',
      phase: 'handshake',
      title: 'SYN: the client proposes a connection',
      summary:
        'The laptop picks an initial sequence number and its options, then sends a **SYN** to port 80 of the server.',
      body: [
        {
          type: 'p',
          text: `TCP opens with a three-way handshake that synchronises sequence numbers. The client chooses an initial sequence number (ISN), here \`${ISN.client}\`, and an ephemeral source port, then sends a segment with only the **SYN** flag set.`,
        },
        {
          type: 'p',
          text: 'The SYN also carries options: MSS 1460 (the largest payload the client will accept in one segment), SACK permitted, timestamps and a window-scale factor of 7. The window field in a SYN is never scaled, so it shows 64240 as written.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: `A SYN consumes one sequence number although it carries no data, so the first data byte will be numbered \`${CLIENT_DATA_START}\`.`,
        },
      ],
      packets: [tcpPacket('p-syn', CLIENT_ROUTE, 'SYN', syn, { at: 700, wireTimeMs: 0 })],
      actions: [
        {
          id: 'a-syn-sent',
          node: 'laptop',
          kind: 'process',
          label: 'SYN-SENT',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-syn-received',
          node: 'server',
          kind: 'process',
          label: 'SYN-RECEIVED',
          at: 3450,
          durationMs: 700,
        },
      ],
      focus: ['laptop'],
      simplifications: [NAT_NOTE, PATH_NOTE],
      references: [REF.establish, REF.options, REF.sack],
    },
    {
      id: 'syn-ack',
      phase: 'handshake',
      title: 'SYN-ACK: the server accepts and answers',
      summary:
        'The server picks its own ISN and acknowledges the SYN: its acknowledgment number is the client’s ISN plus one.',
      body: [
        {
          type: 'p',
          text: `The reply sets **SYN** and **ACK**. Its acknowledgment number, \`${ISN.client + 1}\`, says that everything before that byte has arrived, and it counts the SYN as one sequence number. Its own SYN starts a separate numbering space for the opposite direction, beginning at \`${ISN.server}\`.`,
        },
        {
          type: 'p',
          text: 'The server answers the options too. Window scaling and SACK are used only when both SYNs offer them, and each side’s scale factor applies to the window that side advertises.',
        },
      ],
      packets: [
        tcpPacket('p-synack', SERVER_ROUTE, 'SYN-ACK', synAck, { at: 0, wireTimeMs: 12.2 }),
      ],
      focus: ['server'],
      simplifications: [NAT_NOTE, PATH_NOTE],
      references: [REF.establish, REF.options],
    },
    {
      id: 'ack',
      phase: 'handshake',
      title: 'ACK: the connection is established',
      summary:
        'The client acknowledges the server’s SYN. Both ends now consider the connection open and may send data.',
      body: [
        {
          type: 'p',
          text: `The third segment completes the handshake. Its sequence number is \`${CLIENT_DATA_START}\` (client ISN plus one) and its acknowledgment number is \`${SERVER_NEXT}\` (server ISN plus one). Each side has shown it can send and receive, and each knows where the other’s numbering starts.`,
        },
        {
          type: 'p',
          text: 'The client enters **ESTABLISHED** as it sends this ACK; the server enters it when the ACK arrives. A handshake ACK may already carry data, but here it is a pure ACK.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'A connection is identified by its four-tuple: both addresses and both ports. Sequence numbers then order and acknowledge the bytes within it.',
        },
      ],
      packets: [
        tcpPacket('p-handshake-ack', CLIENT_ROUTE, 'ACK', handshakeAck, {
          at: 700,
          wireTimeMs: 24.3,
        }),
      ],
      actions: [
        {
          id: 'a-client-established',
          node: 'laptop',
          kind: 'process',
          label: 'ESTABLISHED',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-server-established',
          node: 'server',
          kind: 'process',
          label: 'ESTABLISHED',
          at: 3450,
          durationMs: 700,
        },
      ],
      focus: ['laptop', 'server'],
      simplifications: [NAT_NOTE, PATH_NOTE],
      references: [REF.establish, REF.tcp],
    },
    {
      id: 'data-loss',
      phase: 'data',
      title: 'Two segments leave; the first is lost',
      summary:
        'The client sends 2,896 bytes as two full segments. Segment 1 is dropped on the way; segment 2 arrives.',
      body: [
        {
          type: 'p',
          text: `With MSS 1460 and the 12-byte timestamp option, a full segment carries 1448 bytes. The upload therefore becomes two segments: relative bytes 1 to 1448 (\`Seq=${SEG1_SEQ}\`) and 1449 to 2896 (\`Seq=${SEG2_SEQ}\`).`,
        },
        {
          type: 'p',
          text: 'Segment 1 is dropped, for example by an overflowing queue. The client cannot know that. It keeps both segments in its send buffer and runs a retransmission timer for the oldest unacknowledged byte.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'A sender may have several segments in flight before any ACK returns. The receiver’s window and the congestion window limit how much.',
        },
      ],
      packets: [
        tcpPacket(
          'p-seg1',
          CLIENT_ROUTE,
          'Seg 1 · 1448 B',
          seg1,
          { at: 0, wireTimeMs: 24.6 },
          {
            payload: 'First 1448 bytes of the request body (relative sequence 1 to 1448).',
            outcome: {
              kind: 'lost',
              afterNode: 'cloud',
              note: 'Dropped by a congested queue on the way to the server.',
            },
          },
        ),
        tcpPacket(
          'p-seg2',
          CLIENT_ROUTE,
          'Seg 2 · 1448 B',
          seg2,
          { at: 450, wireTimeMs: 24.7 },
          { payload: 'Next 1448 bytes of the request body (relative sequence 1449 to 2896).' },
        ),
      ],
      focus: ['laptop'],
      simplifications: [
        'The client’s congestion window is not shown; the two segments are assumed to fit in it.',
        'Where the loss happens inside the cloud is arbitrary; the animation drops segment 1 on the last link.',
        NAT_NOTE,
        PATH_NOTE,
      ],
      references: [REF.tcp, REF.options, REF.congestion],
    },
    {
      id: 'dup-ack',
      phase: 'data',
      title: 'Out-of-order data triggers a duplicate ACK',
      summary: `The server holds bytes it cannot deliver yet, so it repeats its ACK number (\`${SEG1_SEQ}\`) and adds a SACK block describing segment 2.`,
      body: [
        {
          type: 'p',
          text: `TCP acknowledgments are **cumulative**: the number names the next byte the receiver is still waiting for, not the last one it saw. Segment 2 starts after a gap, so the server stores it and repeats \`Ack=${SEG1_SEQ}\`. A pure ACK that repeats the previous acknowledgment number is a **duplicate ACK**.`,
        },
        {
          type: 'p',
          text: `Because the handshake negotiated SACK, the ACK also lists the range that did arrive, \`${SEG2_SEQ}\` to \`${CLIENT_DATA_END}\`, so the sender knows exactly what is missing.`,
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'Fast retransmit needs **three** duplicate ACKs. Only one can arrive here, because the client has nothing further to send, so recovery falls back to the retransmission timer.',
        },
      ],
      packets: [
        tcpPacket('p-dup-ack', SERVER_ROUTE, 'Dup ACK + SACK', dupAck, {
          at: 700,
          wireTimeMs: 36.8,
        }),
      ],
      actions: [
        {
          id: 'a-buffer-out-of-order',
          node: 'server',
          kind: 'store',
          label: 'Hold segment 2',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['server'],
      simplifications: [
        'A receiver may also delay ordinary ACKs by a few tens of milliseconds; that is not shown.',
        NAT_NOTE,
      ],
      references: [REF.sack, REF.fastRetransmit, REF.tcp],
    },
    {
      id: 'rto',
      phase: 'data',
      title: 'RTO fires: segment 1 is sent again',
      summary: `No ACK has covered segment 1 within the timeout, so the client retransmits it with the **same sequence number**, \`${SEG1_SEQ}\`.`,
      body: [
        {
          type: 'p',
          text: 'The timer started when segment 1 was first sent. When it expires the client retransmits the oldest unacknowledged data. The retransmission reuses the original sequence number, because that number names the bytes, not the transmission.',
        },
        {
          type: 'p',
          text: 'The timeout here is about 200 ms, a common minimum in practice; RFC 6298 recommends a longer floor of one second. It is derived from measured round-trip times, and each further timeout doubles it.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'A timeout is treated as a sign of congestion: the sender shrinks its congestion window to one segment before growing it again.',
        },
      ],
      packets: [
        tcpPacket(
          'p-retransmit',
          CLIENT_ROUTE,
          'Retransmit seg 1',
          retransmit,
          { at: 800, wireTimeMs: 224.7 },
          { payload: 'The same 1448 bytes as segment 1, in a new IP packet.' },
        ),
      ],
      actions: [
        {
          id: 'a-rto-fired',
          node: 'laptop',
          kind: 'process',
          label: 'RTO timer fires',
          at: 0,
          durationMs: 700,
        },
      ],
      focus: ['laptop'],
      simplifications: [
        'Modern stacks may probe sooner with tail loss probes (RACK-TLP, RFC 8985); this scenario shows the classic timer-based recovery.',
        NAT_NOTE,
        PATH_NOTE,
      ],
      references: [REF.retransmit, REF.rto, REF.congestion, REF.rack],
    },
    {
      id: 'cumulative-ack',
      phase: 'data',
      title: 'A cumulative ACK covers both segments',
      summary: `With segment 1 back, the data is contiguous. One ACK, \`${CLIENT_DATA_END}\`, acknowledges all 2,896 bytes.`,
      body: [
        {
          type: 'p',
          text: `The retransmission fills the gap, so the server now holds bytes 1 to 2896 in order and can pass them to the application. It does not acknowledge each segment separately: one cumulative ACK names the next byte it expects, \`${SEG1_SEQ} + 2896 = ${CLIENT_DATA_END}\`.`,
        },
        {
          type: 'p',
          text: 'A segment that fills a gap is acknowledged immediately rather than after the usual delay, because that is the moment the sender most wants to hear. The client can now free both segments from its send buffer.',
        },
      ],
      packets: [
        tcpPacket('p-cumulative-ack', SERVER_ROUTE, 'Cumulative ACK', cumulativeAck, {
          at: 0,
          wireTimeMs: 236.8,
        }),
      ],
      actions: [
        {
          id: 'a-buffer-freed',
          node: 'laptop',
          kind: 'store',
          label: 'Send buffer freed',
          at: 3000,
          durationMs: 700,
        },
      ],
      focus: ['server', 'laptop'],
      simplifications: [NAT_NOTE, PATH_NOTE],
      references: [REF.tcp, REF.congestion],
    },
    {
      id: 'fin',
      phase: 'close',
      title: 'FIN: the client finishes sending',
      summary:
        'The client sends **FIN** because it has no more data; the server acknowledges it. The connection is now half-closed.',
      body: [
        {
          type: 'p',
          text: `Each direction closes on its own. The client’s **FIN** uses one sequence number (\`${CLIENT_DATA_END}\`) and ends its byte stream; the server’s ACK, \`${CLIENT_DATA_END + 1}\`, confirms the stream is complete.`,
        },
        {
          type: 'p',
          text: 'The connection is now half-closed. The client waits in FIN-WAIT-2 and can still receive data. The server is in CLOSE-WAIT until its own application closes the socket.',
        },
        {
          type: 'callout',
          tone: 'tip',
          text: 'This scenario shows the textbook four-segment close. A server often merges its ACK and FIN into one segment, which makes the close three segments.',
        },
      ],
      packets: [
        tcpPacket('p-client-fin', CLIENT_ROUTE, 'FIN', clientFin, { at: 700, wireTimeMs: 260 }),
        tcpPacket('p-fin-ack', SERVER_ROUTE, 'ACK (of FIN)', finAck, {
          at: 3600,
          wireTimeMs: 272.1,
        }),
      ],
      actions: [
        {
          id: 'a-fin-wait',
          node: 'laptop',
          kind: 'process',
          label: 'FIN-WAIT-1',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-close-wait',
          node: 'server',
          kind: 'process',
          label: 'CLOSE-WAIT',
          at: 3450,
          durationMs: 700,
        },
      ],
      focus: ['laptop', 'server'],
      simplifications: [
        'No application reply is modelled; a real server would normally answer the upload before the connection closes.',
        NAT_NOTE,
      ],
      references: [REF.closing, REF.tcp],
    },
    {
      id: 'server-fin',
      phase: 'close',
      title: 'The server’s FIN and the final ACK',
      summary:
        'When the server’s application closes, it sends its own **FIN**. The client acknowledges it, and both directions are closed.',
      body: [
        {
          type: 'p',
          text: `The server’s FIN uses one number of its own (\`${SERVER_NEXT}\`), so the client acknowledges \`${SERVER_NEXT + 1}\`. That last ACK carries \`Seq=${CLIENT_DATA_END + 1}\`, the number after the client’s FIN.`,
        },
        {
          type: 'p',
          text: 'The server sits in LAST-ACK and moves to CLOSED when the ACK arrives, releasing its state. The client is not finished: as the side that closed first, it enters TIME-WAIT.',
        },
      ],
      packets: [
        tcpPacket('p-server-fin', SERVER_ROUTE, 'FIN (server)', serverFin, {
          at: 0,
          wireTimeMs: 285,
        }),
        tcpPacket('p-final-ack', CLIENT_ROUTE, 'Final ACK', finalAck, {
          at: 2800,
          wireTimeMs: 297.1,
        }),
      ],
      actions: [
        {
          id: 'a-last-ack',
          node: 'server',
          kind: 'process',
          label: 'LAST-ACK',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-server-closed',
          node: 'server',
          kind: 'process',
          label: 'CLOSED',
          at: 5500,
          durationMs: 600,
        },
      ],
      focus: ['server', 'laptop'],
      simplifications: [NAT_NOTE, PATH_NOTE],
      references: [REF.closing, REF.tcp],
    },
    {
      id: 'time-wait',
      phase: 'close',
      title: 'TIME-WAIT: the closing side lingers',
      summary:
        'The side that sent the first FIN keeps its connection state for 2×MSL, so stray segments cannot be mistaken for a new connection.',
      body: [
        {
          type: 'p',
          text: 'TIME-WAIT belongs to the **active closer**, here the client, and lasts twice the maximum segment lifetime (2×MSL). RFC 9293 takes MSL to be 2 minutes; real stacks often use less, and Linux uses a fixed 60 seconds.',
        },
        {
          type: 'p',
          text: 'It has two jobs. If the final ACK was lost, the server will resend its FIN, and a client that still holds state can acknowledge it again. It also lets old duplicates of this four-tuple die out before the same ports are reused.',
        },
        {
          type: 'callout',
          tone: 'tip',
          text: 'A client that opens many short connections to one server can run short of free source ports, because every closed connection lingers in TIME-WAIT.',
        },
      ],
      packets: [],
      actions: [
        {
          id: 'a-time-wait',
          node: 'laptop',
          kind: 'process',
          label: 'TIME-WAIT (2×MSL)',
          at: 0,
          durationMs: 3000,
        },
      ],
      focus: ['laptop'],
      simplifications: [
        'The 2×MSL wait is not played in real time; the timer is shown as a single badge.',
      ],
      references: [REF.closing, REF.tcp],
      tailMs: 1200,
    },
  ],
});
