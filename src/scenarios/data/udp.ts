import {
  defineScenario,
  type HeaderField,
  type HeaderGroup,
  type PacketDef,
  type Reference,
} from '../../model/types';
import { IP, MAC, PORT } from '../lib/addresses';
import { ethernet, ipv4, udp } from '../lib/builders';

/**
 * UDP: an NTP exchange on port 123, then a lossy media-style stream with one lost and one
 * reordered datagram, contrasted with TCP.
 *
 * Headers are shown as captured at the sender, so the table lists datagrams in send order;
 * `wireTimeMs` is the moment the sender transmits on a global simulated clock. The round-trip
 * time to the NTP server is 25 ms: 12 ms each way plus 1 ms of server processing.
 */

const NTP_SERVER_IP = '203.0.113.123';
const MEDIA_SERVER_IP = '192.0.2.150';
const NTP_CLIENT_PORT = 49321;
const MEDIA_PORT = 5004;
const MEDIA_CLIENT_PORT = 58012;

/** NTP message length (RFC 5905, no extension fields) and the media payload per datagram. */
const NTP_BYTES = 48;
const MEDIA_BYTES = 172; // 12-byte application header + 160 bytes of audio (20 ms at 8 kHz)

const NTP_SERVER_MAC = MAC.spare[0];
const MEDIA_SERVER_MAC = MAC.spare[1];
const NTP_GATEWAY_MAC = MAC.spare[2];
const MEDIA_GATEWAY_MAC = MAC.spare[3];

const REF = {
  udp: { label: 'RFC 768: User Datagram Protocol', url: 'https://www.rfc-editor.org/rfc/rfc768' },
  usage: {
    label: 'RFC 8085: UDP usage guidelines',
    url: 'https://www.rfc-editor.org/rfc/rfc8085',
  },
  ntp: { label: 'RFC 5905: NTP version 4', url: 'https://www.rfc-editor.org/rfc/rfc5905' },
  ntpFormat: {
    label: 'RFC 5905 section 7.3: Packet header',
    url: 'https://www.rfc-editor.org/rfc/rfc5905#section-7.3',
  },
  ntpOnWire: {
    label: 'RFC 5905 section 8: On-wire protocol',
    url: 'https://www.rfc-editor.org/rfc/rfc5905#section-8',
  },
  rtp: { label: 'RFC 3550: RTP', url: 'https://www.rfc-editor.org/rfc/rfc3550' },
  tcp: { label: 'RFC 9293: TCP', url: 'https://www.rfc-editor.org/rfc/rfc9293' },
  quic: { label: 'RFC 9000: QUIC', url: 'https://www.rfc-editor.org/rfc/rfc9000' },
} as const satisfies Record<string, Reference>;

const NAT_NOTE =
  'The home router’s NAT rewrites the laptop’s source address to `198.51.100.7`, and replies are addressed to that public address. Each header is shown as the sender transmitted it.';
const PATH_NOTE = 'ARP and the routers inside the Internet cloud are omitted.';

// ---------------------------------------------------------------------------
// Local helpers
// ---------------------------------------------------------------------------

/**
 * NTPv4 message (application layer, 48 bytes). The shared builders have no NTP builder, so this
 * local one writes the RFC 5905 packet header fields; timestamps are shown as UTC times.
 */
function ntpMessage(m: { mode: 'client' | 'server' }): HeaderGroup {
  const client = m.mode === 'client';

  const fields: HeaderField[] = [
    { name: 'Leap Indicator', value: '0 (no warning)' },
    { name: 'Version', value: '4' },
    { name: 'Mode', value: client ? '3 (client)' : '4 (server)' },
    {
      name: 'Stratum',
      value: client ? '0 (unspecified)' : '2 (secondary reference)',
      note: client ? undefined : 'its clock is set from a stratum 1 source',
    },
    { name: 'Poll', value: '6', note: '2^6 = 64 s between requests' },
    {
      name: 'Precision',
      value: client ? '-20' : '-23',
      note: client ? 'about 1 µs' : 'about 119 ns',
    },
    { name: 'Root Delay', value: client ? '0' : '0.011 s' },
    { name: 'Root Dispersion', value: client ? '0' : '0.008 s' },
    {
      name: 'Reference ID',
      value: client ? '0 (none)' : '192.0.2.201',
      note: client ? undefined : 'for stratum 2 and above: the address of the upstream server',
    },
    {
      name: 'Reference Timestamp',
      value: client ? 'not set' : '09:14:31.874 UTC',
      note: client ? undefined : 'when the server clock was last updated',
    },
    {
      name: 'Origin Timestamp',
      value: client ? 'not set' : 'T1 = 09:15:02.100 UTC',
      note: client ? undefined : 'copied from the request’s transmit timestamp',
    },
    {
      name: 'Receive Timestamp',
      value: client ? 'not set' : 'T2 = 09:15:02.150 UTC',
      note: client ? undefined : 'server clock when the request arrived',
    },
    {
      name: 'Transmit Timestamp',
      value: client ? 'T1 = 09:15:02.100 UTC' : 'T3 = 09:15:02.151 UTC',
      note: 'on the wire: 64-bit seconds since 1900; shown as a UTC time',
    },
  ];

  return {
    layer: 'application',
    protocol: 'ntp',
    title: 'Network Time Protocol (v4)',
    fields: fields.map((f) => (f.note === undefined ? { name: f.name, value: f.value } : f)),
  };
}

const ntpRequestIp = ipv4({
  src: IP.laptop,
  dst: NTP_SERVER_IP,
  ttl: 64,
  id: 0x4f21,
  protocol: 'UDP',
  totalLength: 20 + 8 + NTP_BYTES,
});
const ntpResponseIp = ipv4({
  src: NTP_SERVER_IP,
  dst: IP.routerPublic,
  ttl: 64,
  id: 0x2b90,
  protocol: 'UDP',
  totalLength: 20 + 8 + NTP_BYTES,
});

/** One media datagram: app sequence `n` (1-based), sent from the media server to the laptop. */
function mediaDatagram(
  n: number,
  timing: Pick<PacketDef, 'at' | 'wireTimeMs'>,
  extra: Partial<PacketDef> = {},
): PacketDef {
  const ip = ipv4({
    src: MEDIA_SERVER_IP,
    dst: IP.routerPublic,
    ttl: 64,
    id: 0x3a10 + n - 1,
    protocol: 'UDP',
    totalLength: 20 + 8 + MEDIA_BYTES,
  });

  return {
    id: `p-media-${n}`,
    from: 'media',
    via: ['cloud', 'router'],
    to: 'laptop',
    protocol: 'udp',
    label: `Media #${n}`,
    summary: `${MEDIA_PORT} → ${MEDIA_CLIENT_PORT} Len=${MEDIA_BYTES} (app seq ${n})`,
    headers: [
      ethernet({ src: MEDIA_SERVER_MAC, dst: MEDIA_GATEWAY_MAC, etherType: 'IPv4' }),
      ip.group,
      udp({ srcPort: MEDIA_PORT, dstPort: MEDIA_CLIENT_PORT, length: 8 + MEDIA_BYTES }),
    ],
    payload: `App header: seq=${n} ts=${(n - 1) * 160}, then 160 bytes of audio (20 ms).`,
    sizeBytes: 20 + 8 + MEDIA_BYTES + 14,
    meta: { ipv4: ip.meta },
    ...timing,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

export default defineScenario({
  id: 'udp',
  title: 'UDP',
  tagline: 'Connectionless datagrams: no handshake, no acknowledgments, no ordering.',
  category: 'foundations',
  order: 3,
  protocols: ['ethernet', 'ipv4', 'udp', 'ntp'],
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
      id: 'ntp',
      kind: 'server',
      label: 'NTP server',
      sublabel: NTP_SERVER_IP,
      position: { col: 5.5, row: -1.25 },
      zone: 'ntp-site',
      addresses: { ipv4: NTP_SERVER_IP, mac: NTP_SERVER_MAC, hostname: 'ntp.example.net' },
    },
    {
      id: 'media',
      kind: 'server',
      label: 'Media server',
      sublabel: MEDIA_SERVER_IP,
      position: { col: 8.25, row: 2 },
      zone: 'media-site',
      addresses: { ipv4: MEDIA_SERVER_IP, mac: MEDIA_SERVER_MAC, hostname: 'media.example.net' },
    },
  ],
  links: [
    { id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' },
    { id: 'router-cloud', a: 'router', b: 'cloud', medium: 'wan' },
    { id: 'cloud-ntp', a: 'cloud', b: 'ntp', medium: 'wan' },
    { id: 'cloud-media', a: 'cloud', b: 'media', medium: 'wan' },
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
      id: 'ntp-site',
      label: 'Time service',
      from: { col: 4, row: -2.75 },
      to: { col: 7, row: 0.25 },
      tone: 'remote',
    },
    {
      id: 'media-site',
      label: 'Media service',
      from: { col: 6.75, row: 0.5 },
      to: { col: 9.75, row: 3.5 },
      tone: 'datacenter',
    },
  ],
  phases: [
    { id: 'ntp', label: 'A request and a response' },
    { id: 'stream', label: 'A lossy stream' },
    { id: 'compare', label: 'Compared with TCP' },
  ],
  sequenceLanes: ['laptop', 'ntp', 'media'],
  steps: [
    {
      id: 'ntp-request',
      phase: 'ntp',
      title: 'NTP request: one datagram, no setup',
      summary:
        'The laptop sends one 56-byte UDP datagram to port 123. There is no handshake: the first packet already carries the question.',
      body: [
        {
          type: 'p',
          text: 'UDP does nothing before the first byte of data. The client already knows the server’s address and port, so it builds a datagram and sends it. The NTP message is 48 bytes, and UDP adds an **8-byte** header.',
        },
        {
          type: 'code',
          caption: 'The whole UDP header',
          text: `Source port       ${NTP_CLIENT_PORT}   (ephemeral)\nDestination port  ${PORT.ntp}     (NTP)\nLength            ${8 + NTP_BYTES}      (8 header + ${NTP_BYTES} data)\nChecksum          computed`,
        },
        {
          type: 'p',
          text: 'The length field counts the header as well as the data. The checksum is optional over IPv4 and mandatory over IPv6. The request carries one time value, T1, the client’s clock at transmission.',
        },
      ],
      packets: [
        {
          id: 'p-ntp-request',
          from: 'laptop',
          via: ['router', 'cloud'],
          to: 'ntp',
          protocol: 'ntp',
          label: 'NTP request',
          summary: 'NTP Version 4, client',
          headers: [
            ethernet({ src: MAC.laptop, dst: MAC.routerLan, etherType: 'IPv4' }),
            ntpRequestIp.group,
            udp({ srcPort: NTP_CLIENT_PORT, dstPort: PORT.ntp, length: 8 + NTP_BYTES }),
            ntpMessage({ mode: 'client' }),
          ],
          payload: 'Client mode request; only the transmit timestamp (T1) is filled in.',
          sizeBytes: 20 + 8 + NTP_BYTES + 14,
          at: 0,
          wireTimeMs: 0,
          meta: { ipv4: ntpRequestIp.meta },
        },
      ],
      focus: ['laptop', 'ntp'],
      simplifications: [
        NAT_NOTE,
        PATH_NOTE,
        'NTP authentication, extension fields and the algorithms that select and filter servers are left out.',
      ],
      references: [REF.udp, REF.ntpFormat],
    },
    {
      id: 'ntp-response',
      phase: 'ntp',
      title: 'NTP response: the server answers',
      summary:
        'The server fills in T2 and T3 and sends the answer back to the client’s source port. Nothing acknowledges the request itself.',
      body: [
        {
          type: 'p',
          text: 'The server copies the client’s transmit time into the **origin** field and adds its own **receive** (T2) and **transmit** (T3) timestamps. It replies to the source address and port of the request. With no connection, the return path is simply the port the client wrote in its header.',
        },
        {
          type: 'p',
          text: 'The request is not acknowledged separately; the response is the application’s answer. If either datagram were lost, the client would just ask again at its next poll.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'This server reports stratum 2: its clock follows a stratum 1 source, whose address appears as the reference ID.',
        },
      ],
      packets: [
        {
          id: 'p-ntp-response',
          from: 'ntp',
          via: ['cloud', 'router'],
          to: 'laptop',
          protocol: 'ntp',
          label: 'NTP response',
          summary: 'NTP Version 4, server',
          headers: [
            ethernet({ src: NTP_SERVER_MAC, dst: NTP_GATEWAY_MAC, etherType: 'IPv4' }),
            ntpResponseIp.group,
            udp({ srcPort: PORT.ntp, dstPort: NTP_CLIENT_PORT, length: 8 + NTP_BYTES }),
            ntpMessage({ mode: 'server' }),
          ],
          payload: 'Server mode reply carrying T1 (copied), T2 and T3.',
          sizeBytes: 20 + 8 + NTP_BYTES + 14,
          at: 0,
          wireTimeMs: 13,
          meta: { ipv4: ntpResponseIp.meta },
        },
      ],
      focus: ['ntp', 'laptop'],
      simplifications: [NAT_NOTE, PATH_NOTE],
      references: [REF.ntpOnWire, REF.udp],
    },
    {
      id: 'ntp-math',
      phase: 'ntp',
      title: 'Four timestamps give offset and delay',
      summary:
        'From T1 to T4 the client computes its clock offset (+38 ms) and the round-trip delay (24 ms). That arithmetic is NTP’s work; UDP only moved the bytes.',
      body: [
        {
          type: 'code',
          caption: 'Times on 2026-11-13 (UTC)',
          text: 'T1 client send     09:15:02.100\nT2 server receive  09:15:02.150\nT3 server send     09:15:02.151\nT4 client receive  09:15:02.125\n\noffset = ((T2-T1) + (T3-T4)) / 2 = (50 + 26) / 2 = +38 ms\ndelay  = (T4-T1) - (T3-T2)       = 25 - 1       =  24 ms',
        },
        {
          type: 'p',
          text: 'A positive offset means the client’s clock is behind the server’s. The delay formula subtracts the time the server spent processing. Both results assume the two directions take equally long; any asymmetry shows up as offset error.',
        },
      ],
      packets: [],
      actions: [
        {
          id: 'a-ntp-math',
          node: 'laptop',
          kind: 'process',
          label: 'Offset +38 ms · delay 24 ms',
          at: 0,
          durationMs: 1800,
        },
      ],
      focus: ['laptop'],
      simplifications: [
        'A real client combines several samples and servers and slews its clock gradually rather than stepping it by one measurement.',
      ],
      references: [REF.ntpOnWire],
      tailMs: 900,
    },
    {
      id: 'stream-loss',
      phase: 'stream',
      title: 'A media stream: datagram 2 is lost',
      summary:
        'A media server sends 20 ms audio frames as UDP datagrams, each with an application sequence number. Datagram 2 is dropped in the network.',
      body: [
        {
          type: 'p',
          text: 'Media streams value timeliness over completeness. Each datagram holds one 20 ms audio frame (160 bytes) behind a small application header with a sequence number and timestamp, as RTP does. UDP itself numbers and tracks nothing.',
        },
        {
          type: 'p',
          text: 'Datagram 2 vanishes in a congested queue. The sender gets no signal: no ACK is expected, no timer runs and nothing is resent. The receiver simply sees datagram 1, then datagram 3.',
        },
      ],
      packets: [
        mediaDatagram(1, { at: 0, wireTimeMs: 1200 }),
        mediaDatagram(
          2,
          { at: 400, wireTimeMs: 1220 },
          {
            outcome: {
              kind: 'lost',
              afterNode: 'cloud',
              note: 'Dropped by a congested queue; UDP neither notices nor retries.',
            },
          },
        ),
        mediaDatagram(3, { at: 800, wireTimeMs: 1240 }),
      ],
      focus: ['media', 'laptop'],
      simplifications: [
        'The 12-byte application header is shown as text rather than decoded as RTP.',
        'On the wire the datagrams are 20 ms apart; the animation spaces them further so they can be told apart.',
        NAT_NOTE,
      ],
      references: [REF.udp, REF.rtp, REF.usage],
    },
    {
      id: 'stream-gap',
      phase: 'stream',
      title: 'The receiver copes without retransmission',
      summary:
        'The gap is visible only through the application’s sequence numbers. The player conceals the missing 20 ms, because a late retransmission would be too late to play.',
      body: [
        {
          type: 'p',
          text: 'UDP delivers each datagram that arrives and says nothing about those that do not, so detecting loss is the application’s job. Here the jump from sequence 1 to 3 reveals it. A voice or video player usually hides the hole by repeating or interpolating audio, because a retransmission would arrive after its playout time.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'RTP’s companion protocol, RTCP, reports loss statistics back to the sender so it can adapt its bitrate. Any retransmission scheme is something an application adds on top.',
        },
      ],
      packets: [],
      actions: [
        {
          id: 'a-conceal',
          node: 'laptop',
          kind: 'process',
          label: 'Gap at seq 2: conceal',
          at: 0,
          durationMs: 1600,
        },
      ],
      focus: ['laptop'],
      references: [REF.rtp, REF.usage],
      tailMs: 900,
    },
    {
      id: 'stream-reorder',
      phase: 'stream',
      title: 'Reordering: datagram 4 arrives last',
      summary:
        'Datagrams 4, 5 and 6 are sent in order, but 4 waits in a queue and arrives after 5 and 6. UDP hands datagrams over in arrival order.',
      body: [
        {
          type: 'p',
          text: 'IP can deliver packets out of order, for example when they take different paths or one waits longer in a queue. TCP would hold 5 and 6 back until 4 arrived. UDP gives every datagram to the application the moment it arrives, so the receiver sees 5, 6, 4.',
        },
        {
          type: 'p',
          text: 'The application restores order with its sequence numbers, typically through a small jitter buffer that waits a few tens of milliseconds. A datagram that arrives after its slot has passed is discarded.',
        },
      ],
      packets: [
        mediaDatagram(4, { at: 0, wireTimeMs: 1260 }, { dwellMs: 1000 }),
        mediaDatagram(5, { at: 400, wireTimeMs: 1280 }),
        mediaDatagram(6, { at: 800, wireTimeMs: 1300 }),
      ],
      actions: [
        {
          id: 'a-jitter-buffer',
          node: 'laptop',
          kind: 'store',
          label: 'Jitter buffer reorders',
          at: 4400,
          durationMs: 900,
        },
      ],
      focus: ['media', 'laptop'],
      simplifications: [
        'Table rows follow send order because headers are captured at the sender. The reordering shows in the animation and in the sequence view, where datagram 4’s arrow ends last.',
        NAT_NOTE,
      ],
      references: [REF.udp, REF.rtp],
    },
    {
      id: 'vs-tcp',
      phase: 'compare',
      title: 'UDP versus TCP at a glance',
      summary:
        'Everything the TCP scenario built, namely handshake, acknowledgments, ordering and retransmission, is absent from UDP on purpose.',
      body: [
        {
          type: 'list',
          items: [
            '**No handshake**: the first datagram already carries data.',
            '**No acknowledgments**: the sender never learns whether a datagram arrived.',
            '**No ordering**: each datagram is delivered, or not, on its own.',
            '**No retransmission or congestion control**: any reliability or rate control belongs to the application.',
            '**Message boundaries are kept**: one send is one datagram, not part of a byte stream.',
          ],
        },
        {
          type: 'callout',
          tone: 'tip',
          text: 'UDP is the base for DNS, DHCP, NTP, real-time media and QUIC. Each adds only the reliability it needs, such as a DNS retry or QUIC’s own acknowledgments.',
        },
      ],
      packets: [],
      focus: ['laptop', 'ntp', 'media'],
      references: [REF.udp, REF.usage, REF.tcp, REF.quic],
      tailMs: 1500,
    },
  ],
});
