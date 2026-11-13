/**
 * Header builders. Each returns a `HeaderGroup` (one layer of a packet's header stack) with
 * correct field names and wire formatting; `ipv4()` and `tcp()` also return the matching
 * machine-checkable `meta` so the header and the validated numbers cannot drift apart.
 *
 * A packet's `headers` is the stack from the outside in, and `meta` carries the checked values:
 *
 * @example
 * const ip = ipv4({ src: IP.laptop, dst: IP.cdnEdge, ttl: 64, df: true, protocol: 'TCP', totalLength: 60 });
 * const seg = tcp({ conn: 'c1', srcPort: 51234, dstPort: 443, seq: ISN.client, flags: ['SYN'], len: 0 });
 * const packet = {
 *   // ...id, from, to, protocol: 'tcp', label: 'SYN', summary, at, wireTimeMs...
 *   headers: [ethernet({ src: MAC.laptop, dst: MAC.routerLan, etherType: 'IPv4' }), ip.group, seg.group],
 *   meta: { ipv4: ip.meta, tcp: seg.meta },
 * };
 *
 * Builders throw a `RangeError`/`Error` for values that cannot exist on the wire (a port above
 * 65535, `ACK` flag without `ack`, a DNS query with `aa`, ...), so mistakes surface when the
 * scenario module loads rather than as wrong content.
 */
import type { HeaderField, HeaderGroup, Ipv4Meta, TcpFlag, TcpMeta } from '../../model/types';

// ---------------------------------------------------------------------------
// Small pure helpers
// ---------------------------------------------------------------------------

/**
 * Formats a number as `0x`-prefixed lowercase hex, zero-padded to `digits`.
 * `hex(0x1a2b)` returns `"0x1a2b"`; `hex(255, 2)` returns `"0xff"`.
 */
export function hex(value: number, digits = 4): string {
  return `0x${value.toString(16).padStart(digits, '0')}`;
}

function assertInt(what: string, value: number, min: number, max: number): void {
  if (!Number.isInteger(value) || value < min || value > max) {
    throw new RangeError(`${what} must be an integer in ${min}..${max}, got ${value}`);
  }
}

/** A header list: ordered `[name, value]` pairs (order and duplicates, such as `Set-Cookie`, are kept). */
export type HeaderList = readonly (readonly [name: string, value: string])[];

// ---------------------------------------------------------------------------
// Ethernet
// ---------------------------------------------------------------------------

const ETHER_TYPES = { IPv4: 0x0800, ARP: 0x0806, IPv6: 0x86dd } as const;

export interface EthernetInput {
  /** Source MAC, for example `MAC.laptop`. */
  src: string;
  /** Destination MAC, for example `MAC.routerLan` or `MAC_BROADCAST`. */
  dst: string;
  /** Payload type; the builder writes the numeric value, for example `0x0800 (IPv4)`. */
  etherType: keyof typeof ETHER_TYPES;
}

/**
 * Ethernet II header (link layer). The MACs are those of the hop the frame is on, so use one
 * packet per hop when the MAC rewrite is the lesson.
 *
 * @example
 * ethernet({ src: MAC.laptop, dst: MAC.routerLan, etherType: 'IPv4' })
 */
export function ethernet(input: EthernetInput): HeaderGroup {
  return {
    layer: 'link',
    protocol: 'ethernet',
    title: 'Ethernet II',
    fields: [
      { name: 'Destination', value: input.dst },
      { name: 'Source', value: input.src },
      { name: 'Type', value: `${hex(ETHER_TYPES[input.etherType])} (${input.etherType})` },
    ],
  };
}

// ---------------------------------------------------------------------------
// IPv4
// ---------------------------------------------------------------------------

const IP_PROTOCOL_NUMBERS = { ICMP: 1, TCP: 6, UDP: 17 } as const;

/** `Ipv4Meta` plus the carried protocol and an optional literal checksum. */
export type Ipv4Input = Ipv4Meta & {
  /** Payload protocol, written as `6 (TCP)` in the Protocol field. */
  protocol: keyof typeof IP_PROTOCOL_NUMBERS;
  /** Literal checksum text such as `"0xb1e6"`; defaults to `"computed"`. */
  checksum?: string;
};

/**
 * IPv4 header (internet layer).
 *
 * Returns `{ group, meta }`: `group` goes into `headers`, `meta` (the same numbers without
 * `protocol`/`checksum`) goes into `packet.meta.ipv4` where the fragment and address checks read it.
 * `fragOffset` is in 8-byte units; `df` and `mf` cannot both be set. `totalLength` is optional;
 * when given it is shown and checked.
 *
 * @example
 * const ip = ipv4({ src: IP.laptop, dst: IP.cdnEdge, ttl: 64, df: true, protocol: 'TCP', totalLength: 60 });
 * // headers: [..., ip.group, ...]   meta: { ipv4: ip.meta }
 */
export function ipv4(input: Ipv4Input): { group: HeaderGroup; meta: Ipv4Meta } {
  const { protocol, checksum, ...meta } = input;

  assertInt('IPv4 ttl', meta.ttl, 0, 255);
  if (meta.df && meta.mf) {
    throw new Error('IPv4 flags: DF and MF cannot both be set');
  }
  if (meta.fragOffset !== undefined) {
    assertInt('IPv4 fragOffset', meta.fragOffset, 0, 8191);
  }
  if (meta.id !== undefined) {
    assertInt('IPv4 id', meta.id, 0, 65535);
  }
  if (meta.totalLength !== undefined) {
    assertInt('IPv4 totalLength', meta.totalLength, 20, 65535);
  }

  const offset = meta.fragOffset ?? 0;
  const fields: HeaderField[] = [
    { name: 'Version', value: '4' },
    { name: 'Header Length', value: '20 bytes', note: 'IHL = 5; no options' },
  ];

  if (meta.totalLength !== undefined) {
    fields.push({ name: 'Total Length', value: String(meta.totalLength), note: 'header + data' });
  }
  if (meta.id !== undefined) {
    fields.push({ name: 'Identification', value: hex(meta.id) });
  }

  fields.push(
    {
      name: 'Flags',
      value: meta.df ? 'DF (Don’t Fragment)' : meta.mf ? 'MF (More Fragments)' : 'none',
    },
    {
      name: 'Fragment Offset',
      value: String(offset),
      note: offset > 0 ? `byte offset ${offset * 8} (counted in 8-byte units)` : undefined,
    },
    { name: 'Time to Live', value: String(meta.ttl) },
    { name: 'Protocol', value: `${IP_PROTOCOL_NUMBERS[protocol]} (${protocol})` },
    {
      name: 'Header Checksum',
      value: checksum ?? 'computed',
      note: 'recomputed by every router that decrements TTL',
    },
    { name: 'Source Address', value: meta.src },
    { name: 'Destination Address', value: meta.dst },
  );

  return {
    group: {
      layer: 'internet',
      protocol: 'ipv4',
      title: 'Internet Protocol Version 4',
      fields: stripUndefinedNotes(fields),
    },
    meta,
  };
}

/** Removes `note: undefined` keys so header objects stay clean. */
function stripUndefinedNotes(fields: HeaderField[]): HeaderField[] {
  return fields.map((f) => (f.note === undefined ? { name: f.name, value: f.value } : f));
}

// ---------------------------------------------------------------------------
// TCP
// ---------------------------------------------------------------------------

/** Canonical display order for flags: `SYN, ACK`, `PSH, ACK`, `FIN, ACK`. */
const TCP_FLAG_ORDER: readonly TcpFlag[] = ['SYN', 'FIN', 'RST', 'PSH', 'ACK'];

export interface TcpExtra {
  /** TCP options, shown after the fixed fields. See `tcpSynOptions()`. */
  options?: HeaderField[];
  /** Literal checksum text; defaults to `"computed"`. */
  checksum?: string;
}

/**
 * Standard options a modern client sends on a SYN: MSS 1460, SACK permitted, timestamps, window
 * scale. Pass the result as `tcp(meta, { options: tcpSynOptions() })`.
 *
 * @example
 * tcp(synMeta, { options: tcpSynOptions({ windowScale: 7 }) })
 */
export function tcpSynOptions(opts: { mss?: number; windowScale?: number } = {}): HeaderField[] {
  return [
    { name: 'Option: MSS', value: String(opts.mss ?? 1460), note: 'maximum segment size' },
    { name: 'Option: SACK permitted', value: 'yes' },
    { name: 'Option: Timestamps', value: 'TSval/TSecr' },
    {
      name: 'Option: Window scale',
      value: String(opts.windowScale ?? 7),
      note: `window is multiplied by 2^${opts.windowScale ?? 7}`,
    },
  ];
}

/**
 * TCP header (transport layer). Sequence and acknowledgment numbers are absolute; the UI derives
 * relative numbers itself.
 *
 * Returns `{ group, meta }` where `meta` is the input unchanged: use it as `packet.meta.tcp`, the
 * TCP checker verifies it (SYN first, seq/ack arithmetic). The `ACK` flag requires `ack`.
 * `len` is the payload length in bytes (SYN and FIN each consume one extra sequence number).
 *
 * @example
 * const syn = tcp({ conn: 'c1', srcPort: 51234, dstPort: 80, seq: ISN.client, flags: ['SYN'], len: 0, window: 64240 },
 *                 { options: tcpSynOptions() });
 * const synAck = tcp({ conn: 'c1', srcPort: 80, dstPort: 51234, seq: ISN.server, ack: ISN.client + 1,
 *                      flags: ['SYN', 'ACK'], len: 0 });
 */
export function tcp(m: TcpMeta, extra: TcpExtra = {}): { group: HeaderGroup; meta: TcpMeta } {
  assertInt('TCP srcPort', m.srcPort, 0, 65535);
  assertInt('TCP dstPort', m.dstPort, 0, 65535);
  assertInt('TCP seq', m.seq, 0, 0xffffffff);
  assertInt('TCP len', m.len, 0, 65535);

  const hasAck = m.flags.includes('ACK');
  if (hasAck && m.ack === undefined) {
    throw new Error('TCP segment with the ACK flag needs an `ack` value');
  }
  if (m.ack !== undefined) {
    assertInt('TCP ack', m.ack, 0, 0xffffffff);
  }

  const flags = TCP_FLAG_ORDER.filter((f) => m.flags.includes(f));
  const seqNotes: string[] = [];
  if (m.flags.includes('SYN')) seqNotes.push('initial sequence number; SYN consumes one number');
  if (m.flags.includes('FIN')) seqNotes.push('FIN consumes one number');
  if (m.retransmission) seqNotes.push('retransmission reuses the original sequence number');

  const fields: HeaderField[] = [
    { name: 'Source Port', value: String(m.srcPort) },
    { name: 'Destination Port', value: String(m.dstPort) },
    { name: 'Sequence Number', value: String(m.seq), note: seqNotes.join('; ') || undefined },
    hasAck && m.ack !== undefined
      ? {
          name: 'Acknowledgment Number',
          value: String(m.ack),
          note: 'next byte the sender expects',
        }
      : { name: 'Acknowledgment Number', value: '0', note: 'not used (ACK flag not set)' },
    { name: 'Flags', value: flags.length > 0 ? flags.join(', ') : 'none' },
  ];

  if (m.window !== undefined) {
    fields.push({ name: 'Window', value: String(m.window) });
  }

  fields.push(
    { name: 'Checksum', value: extra.checksum ?? 'computed' },
    { name: 'Payload Length', value: `${m.len} bytes` },
    ...(extra.options ?? []),
  );

  return {
    group: {
      layer: 'transport',
      protocol: 'tcp',
      title: 'Transmission Control Protocol',
      fields: stripUndefinedNotes(fields),
    },
    meta: m,
  };
}

// ---------------------------------------------------------------------------
// UDP
// ---------------------------------------------------------------------------

export interface UdpInput {
  srcPort: number;
  dstPort: number;
  /** UDP length field: header (8 bytes) plus data, so at least 8. */
  length: number;
  /** Literal checksum text; defaults to `"computed"` (optional over IPv4, mandatory over IPv6). */
  checksum?: string;
}

/**
 * UDP header (transport layer, 8 bytes). `length` includes the header, so a 48-byte NTP message
 * has `length: 56`.
 *
 * @example
 * udp({ srcPort: 49321, dstPort: 123, length: 56 })
 */
export function udp(input: UdpInput): HeaderGroup {
  assertInt('UDP srcPort', input.srcPort, 0, 65535);
  assertInt('UDP dstPort', input.dstPort, 0, 65535);
  assertInt('UDP length', input.length, 8, 65535);

  return {
    layer: 'transport',
    protocol: 'udp',
    title: 'User Datagram Protocol',
    fields: [
      { name: 'Source Port', value: String(input.srcPort) },
      { name: 'Destination Port', value: String(input.dstPort) },
      {
        name: 'Length',
        value: String(input.length),
        note: `8-byte header + ${input.length - 8} bytes of data`,
      },
      {
        name: 'Checksum',
        value: input.checksum ?? 'computed',
        note: 'optional over IPv4, mandatory over IPv6',
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// ICMP
// ---------------------------------------------------------------------------

const ICMP_TYPE_NAMES: Readonly<Record<number, string>> = {
  0: 'Echo Reply',
  3: 'Destination Unreachable',
  8: 'Echo Request',
  11: 'Time Exceeded',
};

const ICMP_CODE_NAMES: Readonly<Record<string, string>> = {
  '0/0': 'no code',
  '8/0': 'no code',
  '3/0': 'net unreachable',
  '3/1': 'host unreachable',
  '3/3': 'port unreachable',
  '3/4': 'fragmentation needed and DF set',
  '11/0': 'TTL exceeded in transit',
  '11/1': 'fragment reassembly time exceeded',
};

export interface IcmpInput {
  /** ICMP type: 0 echo reply, 3 destination unreachable, 8 echo request, 11 time exceeded. */
  type: number;
  /** ICMP code, for example type 11 code 0 (TTL exceeded) or type 3 code 4 (fragmentation needed). */
  code: number;
  /** One-line explanation shown as a note on the Code field. */
  note: string;
  /** Type 3 code 4 only: the next-hop MTU, written to the Next-Hop MTU field (RFC 1191). */
  nextHopMtu?: number;
  /** For error messages: the quoted original datagram (`"IPv4 header + first 8 bytes"` text). */
  original?: string;
}

/**
 * ICMP header (internet layer, carried inside IPv4 with protocol 1).
 *
 * @example
 * icmp({ type: 11, code: 0, note: 'The router dropped the packet because its TTL reached 0.',
 *        original: 'IPv4 header of the dropped packet + first 8 bytes' })
 * icmp({ type: 3, code: 4, nextHopMtu: 1400, note: 'Packet too big and DF was set.' })
 */
export function icmp(input: IcmpInput): HeaderGroup {
  assertInt('ICMP type', input.type, 0, 255);
  assertInt('ICMP code', input.code, 0, 255);

  const typeName = ICMP_TYPE_NAMES[input.type];
  const codeName = ICMP_CODE_NAMES[`${input.type}/${input.code}`];
  const fields: HeaderField[] = [
    { name: 'Type', value: typeName ? `${input.type} (${typeName})` : String(input.type) },
    {
      name: 'Code',
      value: codeName ? `${input.code} (${codeName})` : String(input.code),
      note: input.note,
    },
    { name: 'Checksum', value: 'computed' },
  ];

  if (input.nextHopMtu !== undefined) {
    assertInt('ICMP nextHopMtu', input.nextHopMtu, 68, 65535);
    fields.push({ name: 'Next-Hop MTU', value: String(input.nextHopMtu), note: 'RFC 1191' });
  }
  if (input.original !== undefined) {
    fields.push({ name: 'Original datagram', value: input.original });
  }

  return {
    layer: 'internet',
    protocol: 'icmp',
    title: 'Internet Control Message Protocol',
    fields: stripUndefinedNotes(fields),
  };
}

// ---------------------------------------------------------------------------
// DNS
// ---------------------------------------------------------------------------

const DNS_RCODES = {
  NOERROR: 0,
  FORMERR: 1,
  SERVFAIL: 2,
  NXDOMAIN: 3,
  NOTIMP: 4,
  REFUSED: 5,
} as const;

/** A resource record in the answer, authority or additional section. */
export interface DnsRecord {
  name: string;
  /** Record type text: `A`, `AAAA`, `NS`, `CNAME`, `MX`, `TXT`, `SOA`, ... */
  type: string;
  ttl: number;
  /** Record data as presented, for example `203.0.113.10` or `ns1.example.com.`. */
  data: string;
}

export interface DnsInput {
  /** Transaction id; the reply must repeat the query's id. Shown as hex. */
  id: number;
  qr: 'query' | 'response';
  /** Header flag bits. `aa`, `tc` and `ra` are only valid on responses. Omitted flags are 0. */
  flags?: { aa?: boolean; tc?: boolean; rd?: boolean; ra?: boolean };
  /** Response code; defaults to `NOERROR`. */
  rcode?: keyof typeof DNS_RCODES;
  question: { name: string; type: string };
  answer?: readonly DnsRecord[];
  authority?: readonly DnsRecord[];
  additional?: readonly DnsRecord[];
}

/**
 * DNS message header plus sections (application layer). The Flags field lists the set bits in
 * the order `QR AA TC RD RA`. Class is always IN.
 *
 * @example
 * dns({ id: 0x3a7c, qr: 'query', flags: { rd: true }, question: { name: 'www.example.com', type: 'A' } })
 * dns({ id: 0x3a7c, qr: 'response', flags: { rd: true, ra: true },
 *       question: { name: 'www.example.com', type: 'A' },
 *       answer: [{ name: 'www.example.com', type: 'A', ttl: 300, data: IP.cdnEdge }] })
 */
export function dns(input: DnsInput): HeaderGroup {
  assertInt('DNS id', input.id, 0, 65535);

  const flags = input.flags ?? {};
  const isResponse = input.qr === 'response';
  if (!isResponse && (flags.aa || flags.tc || flags.ra)) {
    throw new Error('DNS query cannot set aa, tc or ra: those flags exist only on responses');
  }

  const answer = input.answer ?? [];
  const authority = input.authority ?? [];
  const additional = input.additional ?? [];
  const rcode = input.rcode ?? 'NOERROR';

  const setFlags = [
    isResponse && 'QR',
    flags.aa && 'AA',
    flags.tc && 'TC',
    flags.rd && 'RD',
    flags.ra && 'RA',
  ].filter((f): f is string => typeof f === 'string');

  const record = (r: DnsRecord): string => `${r.name}.  ${r.ttl}  IN  ${r.type}  ${r.data}`;
  const fields: HeaderField[] = [
    { name: 'Transaction ID', value: hex(input.id) },
    {
      name: 'Flags',
      value: setFlags.length > 0 ? setFlags.join(' ') : 'none',
      note: 'QR response, AA authoritative answer, TC truncated, RD recursion desired, RA recursion available',
    },
    { name: 'Opcode', value: '0 (QUERY)' },
    { name: 'Response Code', value: `${DNS_RCODES[rcode]} (${rcode})` },
    { name: 'Questions', value: '1' },
    { name: 'Answer RRs', value: String(answer.length) },
    { name: 'Authority RRs', value: String(authority.length) },
    { name: 'Additional RRs', value: String(additional.length) },
    { name: 'Question', value: `${input.question.name}.  IN  ${input.question.type}` },
    ...answer.map((r) => ({ name: 'Answer', value: record(r) })),
    ...authority.map((r) => ({ name: 'Authority', value: record(r) })),
    ...additional.map((r) => ({ name: 'Additional', value: record(r) })),
  ];

  return {
    layer: 'application',
    protocol: 'dns',
    title: isResponse ? 'DNS response' : 'DNS query',
    fields: stripUndefinedNotes(fields),
  };
}

// ---------------------------------------------------------------------------
// DHCP
// ---------------------------------------------------------------------------

/** A DHCP option as `[code, name, value]`. Build with `dhcpOption()` / `dhcpMessageType()`. */
export type DhcpOption = readonly [code: number, name: string, value: string];

const DHCP_OPTION_NAMES = {
  1: 'Subnet Mask',
  3: 'Router',
  6: 'Domain Name Server',
  12: 'Host Name',
  15: 'Domain Name',
  28: 'Broadcast Address',
  50: 'Requested IP Address',
  51: 'IP Address Lease Time',
  53: 'DHCP Message Type',
  54: 'DHCP Server Identifier',
  55: 'Parameter Request List',
  58: 'Renewal Time Value (T1)',
  59: 'Rebinding Time Value (T2)',
  61: 'Client Identifier',
  255: 'End',
} as const;

export type DhcpOptionCode = keyof typeof DHCP_OPTION_NAMES;

const DHCP_MESSAGE_TYPES = {
  DISCOVER: 1,
  OFFER: 2,
  REQUEST: 3,
  DECLINE: 4,
  ACK: 5,
  NAK: 6,
  RELEASE: 7,
  INFORM: 8,
} as const;

export type DhcpMessageType = keyof typeof DHCP_MESSAGE_TYPES;

/**
 * Builds a DHCP option tuple with the standard option name for `code`.
 * Codes: 1 mask, 3 router, 6 DNS, 12 host name, 15 domain, 28 broadcast, 50 requested IP,
 * 51 lease time, 54 server id, 55 parameter request list, 58 T1, 59 T2, 61 client id.
 *
 * @example
 * dhcpOption(51, '86400 s (24 h)')   // [51, 'IP Address Lease Time', '86400 s (24 h)']
 */
export function dhcpOption(code: DhcpOptionCode, value: string): DhcpOption {
  return [code, DHCP_OPTION_NAMES[code], value];
}

/**
 * Option 53 for a message type, for example `dhcpMessageType('OFFER')` gives
 * `[53, 'DHCP Message Type', 'DHCPOFFER (2)']`.
 */
export function dhcpMessageType(type: DhcpMessageType): DhcpOption {
  return [53, DHCP_OPTION_NAMES[53], `DHCP${type} (${DHCP_MESSAGE_TYPES[type]})`];
}

export interface DhcpInput {
  /** `BOOTREQUEST` (op 1, client to server) or `BOOTREPLY` (op 2, server to client). */
  op: 'BOOTREQUEST' | 'BOOTREPLY';
  /** Transaction id chosen by the client; shown as hex. */
  xid: number;
  /** Client address, only when the client already has one (renewal). Default `0.0.0.0`. */
  ciaddr?: string;
  /** "Your" address: the address being offered or acknowledged. Default `0.0.0.0`. */
  yiaddr?: string;
  /** Server address (next server). Default `0.0.0.0`. */
  siaddr?: string;
  /** Relay agent address. Default `0.0.0.0`. */
  giaddr?: string;
  /** Client hardware address, for example `MAC.laptop`. */
  chaddr: string;
  /** Broadcast flag (bit 15). `'broadcast'` asks for broadcast replies; default `'unicast'`. */
  flags?: 'broadcast' | 'unicast';
  /** Options in wire order, built with `dhcpMessageType()` / `dhcpOption()`. */
  options: readonly DhcpOption[];
}

/**
 * DHCP (BOOTP-format) message (application layer), UDP ports 68 (client) and 67 (server).
 * Each option becomes a field named `Option <code>: <name>`.
 *
 * @example
 * dhcp({ op: 'BOOTREQUEST', xid: 0x5f3a9c21, chaddr: MAC.laptop, flags: 'broadcast',
 *        options: [dhcpMessageType('DISCOVER'), dhcpOption(55, '1, 3, 6, 15, 51')] })
 */
export function dhcp(input: DhcpInput): HeaderGroup {
  assertInt('DHCP xid', input.xid, 0, 0xffffffff);

  const broadcast = input.flags === 'broadcast';
  const fields: HeaderField[] = [
    { name: 'Message Type', value: `${input.op === 'BOOTREQUEST' ? 1 : 2} (${input.op})` },
    { name: 'Hardware Type', value: '1 (Ethernet)' },
    { name: 'Hardware Address Length', value: '6' },
    { name: 'Hops', value: '0' },
    { name: 'Transaction ID', value: hex(input.xid, 8) },
    { name: 'Flags', value: broadcast ? '0x8000 (broadcast)' : '0x0000 (unicast)' },
    { name: 'Client IP Address', value: input.ciaddr ?? '0.0.0.0' },
    { name: 'Your IP Address', value: input.yiaddr ?? '0.0.0.0' },
    { name: 'Next Server IP Address', value: input.siaddr ?? '0.0.0.0' },
    { name: 'Relay Agent IP Address', value: input.giaddr ?? '0.0.0.0' },
    { name: 'Client MAC Address', value: input.chaddr },
    { name: 'Magic Cookie', value: '0x63825363' },
    ...input.options.map(([code, name, value]) => ({ name: `Option ${code}: ${name}`, value })),
  ];

  return {
    layer: 'application',
    protocol: 'dhcp',
    title: 'Dynamic Host Configuration Protocol',
    fields,
  };
}

// ---------------------------------------------------------------------------
// HTTP
// ---------------------------------------------------------------------------

const HTTP_REASONS: Readonly<Record<number, string>> = {
  200: 'OK',
  204: 'No Content',
  301: 'Moved Permanently',
  302: 'Found',
  304: 'Not Modified',
  307: 'Temporary Redirect',
  308: 'Permanent Redirect',
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
};

/** Connection-specific fields that HTTP/2 forbids (RFC 9113 section 8.2.2). */
const H2_FORBIDDEN = [
  'connection',
  'keep-alive',
  'proxy-connection',
  'transfer-encoding',
  'upgrade',
];

const httpFields = (headers: HeaderList): HeaderField[] =>
  headers.map(([name, value]) => ({ name, value }));

export interface Http1RequestInput {
  method: string;
  /** Request target, for example `/index.html`. */
  path: string;
  /** `Host` header value (required in HTTP/1.1). Emitted first. */
  host: string;
  /** Further headers in order, in conventional Title-Case. */
  headers?: HeaderList;
}

/**
 * HTTP/1.1 request head (application layer): the request line, `Host`, then `headers`.
 * The body, if any, belongs in `PacketDef.payload`.
 *
 * @example
 * http1Request({ method: 'GET', path: '/', host: HOST.www,
 *                headers: [['Accept', 'text/html'], ['Connection', 'keep-alive']] })
 */
export function http1Request(input: Http1RequestInput): HeaderGroup {
  return {
    layer: 'application',
    protocol: 'http',
    title: 'HTTP/1.1 request',
    fields: [
      { name: 'Request line', value: `${input.method} ${input.path} HTTP/1.1` },
      { name: 'Host', value: input.host },
      ...httpFields(input.headers ?? []),
    ],
  };
}

export interface Http1ResponseInput {
  status: number;
  /** Reason phrase; defaults to the standard phrase for common codes. */
  reason?: string;
  headers?: HeaderList;
}

/**
 * HTTP/1.1 response head (application layer): the status line, then `headers`.
 *
 * @example
 * http1Response({ status: 304, headers: [['ETag', '"v7"'], ['Cache-Control', 'max-age=60']] })
 */
export function http1Response(input: Http1ResponseInput): HeaderGroup {
  assertInt('HTTP status', input.status, 100, 599);
  const reason = input.reason ?? HTTP_REASONS[input.status] ?? '';

  return {
    layer: 'application',
    protocol: 'http',
    title: 'HTTP/1.1 response',
    fields: [
      { name: 'Status line', value: `HTTP/1.1 ${input.status}${reason ? ` ${reason}` : ''}` },
      ...httpFields(input.headers ?? []),
    ],
  };
}

function h2Fields(headers: HeaderList): HeaderField[] {
  return headers.map(([name, value]) => {
    const lower = name.toLowerCase();
    if (H2_FORBIDDEN.includes(lower)) {
      throw new Error(`HTTP/2 does not allow the connection-specific header "${name}"`);
    }

    return { name: lower, value };
  });
}

export interface Http2RequestInput {
  method: string;
  /** Pseudo-header `:scheme`; default `https`. */
  scheme?: string;
  /** Pseudo-header `:authority` (replaces `Host`), for example `www.example.com`. */
  authority: string;
  /** Pseudo-header `:path`. */
  path: string;
  /** Further headers; names are lower-cased. Connection-specific headers throw. */
  headers?: HeaderList;
}

/**
 * HTTP/2 request headers as decoded from a HEADERS frame (application layer): the pseudo-headers
 * `:method :scheme :authority :path` first, then lower-case header names. Mark the packet
 * `encrypted: true` and `protocol: 'http'`.
 *
 * @example
 * http2Request({ method: 'GET', authority: HOST.www, path: '/', headers: [['Accept', 'text/html']] })
 */
export function http2Request(input: Http2RequestInput): HeaderGroup {
  return {
    layer: 'application',
    protocol: 'http',
    title: 'HTTP/2 request (HEADERS)',
    fields: [
      { name: ':method', value: input.method },
      { name: ':scheme', value: input.scheme ?? 'https' },
      { name: ':authority', value: input.authority },
      { name: ':path', value: input.path },
      ...h2Fields(input.headers ?? []),
    ],
  };
}

export interface Http2ResponseInput {
  status: number;
  /** Further headers; names are lower-cased. Connection-specific headers throw. */
  headers?: HeaderList;
}

/**
 * HTTP/2 response headers as decoded from a HEADERS frame: `:status`, then lower-case names.
 *
 * @example
 * http2Response({ status: 200, headers: [['Content-Type', 'text/html'], ['Cache-Status', 'ExampleCDN; hit']] })
 */
export function http2Response(input: Http2ResponseInput): HeaderGroup {
  assertInt('HTTP status', input.status, 100, 599);

  return {
    layer: 'application',
    protocol: 'http',
    title: 'HTTP/2 response (HEADERS)',
    fields: [{ name: ':status', value: String(input.status) }, ...h2Fields(input.headers ?? [])],
  };
}

// ---------------------------------------------------------------------------
// TLS
// ---------------------------------------------------------------------------

/**
 * TLS 1.3 handshake record types. `ChangeCipherSpec` is the middlebox-compatibility record;
 * `ApplicationData` is protected data after the handshake.
 */
export type TlsMessage =
  | 'ClientHello'
  | 'ServerHello'
  | 'EncryptedExtensions'
  | 'Certificate'
  | 'CertificateVerify'
  | 'Finished'
  | 'NewSessionTicket'
  | 'ChangeCipherSpec'
  | 'ApplicationData';

const TLS_HANDSHAKE_TYPES: Partial<Record<TlsMessage, number>> = {
  ClientHello: 1,
  ServerHello: 2,
  NewSessionTicket: 4,
  EncryptedExtensions: 8,
  Certificate: 11,
  CertificateVerify: 15,
  Finished: 20,
};

export interface TlsInput {
  message: TlsMessage;
  /** Message-specific fields, for example `[{ name: 'cipher_suites', value: 'TLS_AES_128_GCM_SHA256' }]`. */
  fields: HeaderField[];
}

/**
 * One TLS 1.3 record/message (application layer). The builder prepends the record-layer fields:
 * the legacy record version (`0x0303`), the outer content type (`22 handshake` for ClientHello
 * and ServerHello, `23 application_data` for everything that is encrypted, `20` for
 * ChangeCipherSpec) and, for handshake messages, the handshake type number.
 * Set `encrypted: true` on the packet for every message except ClientHello and ServerHello.
 *
 * @example
 * tlsHandshake({ message: 'ClientHello', fields: [
 *   { name: 'legacy_version', value: '0x0303' },
 *   { name: 'supported_versions', value: '0x0304 (TLS 1.3)' },
 *   { name: 'server_name', value: HOST.www },
 *   { name: 'alpn', value: 'h2, http/1.1' },
 * ] })
 */
export function tlsHandshake(input: TlsInput): HeaderGroup {
  const { message } = input;
  const handshakeType = TLS_HANDSHAKE_TYPES[message];

  let outerType: string;
  let outerNote: string | undefined;
  if (message === 'ClientHello' || message === 'ServerHello') {
    outerType = '22 (handshake)';
  } else if (message === 'ChangeCipherSpec') {
    outerType = '20 (change_cipher_spec)';
    outerNote = 'compatibility only; ignored by TLS 1.3 peers';
  } else {
    outerType = '23 (application_data)';
    outerNote = 'record is encrypted; the real content type is inside';
  }

  const fields: HeaderField[] = [
    {
      name: 'Record Version',
      value: '0x0303',
      note: 'legacy value, kept for middlebox compatibility',
    },
    { name: 'Record Content Type', value: outerType, note: outerNote },
  ];

  if (handshakeType !== undefined) {
    fields.push({ name: 'Handshake Type', value: `${handshakeType} (${message})` });
  }

  fields.push(...input.fields);

  return {
    layer: 'application',
    protocol: 'tls',
    title: message === 'ApplicationData' ? 'TLS Application Data' : `TLS 1.3 ${message}`,
    fields: stripUndefinedNotes(fields),
  };
}

// ---------------------------------------------------------------------------
// Mail (SMTP, POP3, IMAP)
// ---------------------------------------------------------------------------

export interface MailLineInput {
  protocol: 'smtp' | 'pop3' | 'imap';
  /** `C` for lines the client sends, `S` for lines the server sends. */
  direction: 'C' | 'S';
  /** The text lines exactly as on the wire, without CRLF. Multi-line replies are several entries. */
  lines: readonly string[];
}

/**
 * A burst of line-oriented protocol text (application layer), one field per line, named `C` or
 * `S`. Use it for SMTP, POP3 and IMAP dialogue.
 *
 * @example
 * mailLine({ protocol: 'smtp', direction: 'C', lines: ['EHLO laptop.example.com'] })
 * mailLine({ protocol: 'smtp', direction: 'S', lines: ['250-mail.example.com', '250 STARTTLS'] })
 */
export function mailLine(input: MailLineInput): HeaderGroup {
  const who = input.direction === 'C' ? 'client' : 'server';

  return {
    layer: 'application',
    protocol: input.protocol,
    title: `${input.protocol.toUpperCase()} ${who} lines`,
    fields: input.lines.map((line) => ({ name: input.direction, value: line })),
  };
}
