import { defineScenario } from '../../model/types';
import type {
  HeaderGroup,
  NodeId,
  PacketDef,
  PacketMeta,
  Reference,
  StepDef,
} from '../../model/types';
import { EPHEMERAL_PORTS, HOST, IP, ISN, MAC, MAILBOX, PORT, mac } from '../lib/addresses';
import { dns, ethernet, ipv4, mailLine, tcp, tlsHandshake, udp } from '../lib/builders';

/**
 * Email: Alice's client submits a message on port 587, her provider's MTA looks up the MX of
 * example.org and relays it on port 25, and Bob reads it over POP3 (995) and then IMAP (993).
 *
 * TCP and TLS handshakes are collapsed. The first segment in each direction of a connection (and
 * the first after a collapsed STARTTLS handshake) carries `resync`, and sequence numbers already
 * include the bytes of the collapsed handshake.
 */

// ---------------------------------------------------------------------------
// Addressing for this scenario
// ---------------------------------------------------------------------------

const MAC_MSA = mac(0x50);
const MAC_MSA_GW = mac(0x51);
const MAC_MX = mac(0x52);
const MAC_MX_GW = mac(0x53);
const MAC_RESOLVER = mac(0x54);
const MAC_BOB_GW = mac(0x60);
const MAC_POP = mac(0x61);
const MAC_POP_GW = mac(0x62);
const MAC_IMAP = mac(0x63);
const MAC_IMAP_GW = mac(0x64);

/** The sender's DNS resolver, next to the mail server in 192.0.2.0/24. */
const IP_RESOLVER = '192.0.2.53';
/** The backup MX named in the MX answer; it is not drawn. */
const IP_MX2 = '203.0.113.26';
/** Bob's public address after his home router's NAT. */
const IP_BOB_PUBLIC = '198.51.100.99';

/** Bytes the collapsed TLS 1.3 handshake consumes in each direction. */
const TLS_BYTES = { client: 597, server: 3980 } as const;

// ---------------------------------------------------------------------------
// Local helpers: one TCP flow per connection, mail-line packets, a wire clock
// ---------------------------------------------------------------------------

type Dir = 'c2s' | 's2c';

interface Endpoint {
  node: NodeId;
  /** The address the host puts in the IP header when it sends. */
  ip: string;
  /** The address the peer sees (after NAT); defaults to `ip`. */
  seenAs?: string;
  mac: string;
  /** Destination MAC of frames this host sends: its next-hop router. */
  nextHopMac: string;
  /** Transit nodes on the way to the other end. */
  via: NodeId[];
  port: number;
  /** First sequence number after the collapsed handshake. */
  seq: number;
}

interface Segment {
  from: NodeId;
  to: NodeId;
  via: NodeId[];
  headers: HeaderGroup[];
  meta: PacketMeta;
  sizeBytes: number;
}

/**
 * TCP data segments with timestamps (32-byte TCP header). Pure ACKs are not drawn.
 * `skip()` advances both directions by the bytes of a collapsed TLS handshake and marks the next
 * segment in each direction as a documented resync.
 */
function createFlow(conn: string, client: Endpoint, server: Endpoint, firstIpId: number) {
  const nextSeq: Record<Dir, number> = { c2s: client.seq, s2c: server.seq };
  const started: Record<Dir, boolean> = { c2s: false, s2c: false };
  let clientIpId = firstIpId;

  return {
    skip(clientBytes: number, serverBytes: number): void {
      nextSeq.c2s += clientBytes;
      nextSeq.s2c += serverBytes;
      started.c2s = false;
      started.s2c = false;
    },
    segment(dir: Dir, len: number): Segment {
      const sender = dir === 'c2s' ? client : server;
      const receiver = dir === 'c2s' ? server : client;
      const peerDir: Dir = dir === 'c2s' ? 's2c' : 'c2s';

      const seq = nextSeq[dir];
      const ack = nextSeq[peerDir];
      nextSeq[dir] += len;

      const resync = !started[dir];
      started[dir] = true;

      const ipId = dir === 'c2s' ? clientIpId++ : 0;
      const ip = ipv4({
        src: sender.ip,
        dst: receiver.seenAs ?? receiver.ip,
        ttl: 64,
        id: ipId,
        df: true,
        protocol: 'TCP',
        totalLength: 52 + len,
      });
      const segment = tcp(
        {
          conn,
          srcPort: sender.port,
          dstPort: receiver.port,
          seq,
          ack,
          flags: len > 0 ? ['PSH', 'ACK'] : ['ACK'],
          len,
          window: dir === 'c2s' ? 502 : 509,
          ...(resync ? { resync: true } : {}),
        },
        { options: [{ name: 'Option: Timestamps', value: 'TSval/TSecr' }] },
      );

      return {
        from: sender.node,
        to: receiver.node,
        via: sender.via,
        headers: [
          ethernet({ src: sender.mac, dst: sender.nextHopMac, etherType: 'IPv4' }),
          ip.group,
          segment.group,
        ],
        meta: { ipv4: ip.meta, tcp: segment.meta },
        sizeBytes: 66 + len,
      };
    },
  };
}

let wireClock = 0;

/** Moves the simulated capture clock to `timeMs` since scenario start; it never runs backwards. */
function wireTo(timeMs: number): number {
  if (timeMs < wireClock) {
    throw new RangeError(`wire time ${timeMs} is before ${wireClock}`);
  }
  wireClock = timeMs;

  return wireClock;
}

type Flow = ReturnType<typeof createFlow>;
type MailProtocol = 'smtp' | 'pop3' | 'imap';

interface MailPacketSpec {
  id: string;
  flow: Flow;
  dir: Dir;
  protocol: MailProtocol;
  /** The lines exactly as on the wire, without CRLF. */
  lines: string[];
  /** True inside TLS (after STARTTLS, or on an implicit-TLS port). */
  encrypted?: boolean;
  label: string;
  /** Table Info text; defaults to the first line. */
  summary?: string;
  at: number;
  /** Capture time in milliseconds since the scenario started. */
  wireMs: number;
}

/** Each line is followed by CRLF on the wire. */
function lineBytes(lines: readonly string[]): number {
  return lines.reduce((sum, line) => sum + line.length + 2, 0);
}

function mailPacket(spec: MailPacketSpec): PacketDef {
  const plainBytes = lineBytes(spec.lines);
  const len = spec.encrypted === true ? 5 + plainBytes + 1 + 16 : plainBytes;
  const segment = spec.flow.segment(spec.dir, len);
  const who = spec.dir === 'c2s' ? 'C' : 'S';
  const first = spec.lines[0] ?? '';
  const info =
    spec.summary ?? (spec.lines.length > 1 ? `${first} (+${spec.lines.length - 1} lines)` : first);

  const tlsGroups: HeaderGroup[] =
    spec.encrypted === true
      ? [
          tlsHandshake({
            message: 'ApplicationData',
            fields: [
              { name: 'Record Length', value: String(len - 5) },
              {
                name: 'Protection',
                value: 'TLS_AES_128_GCM_SHA256',
                note: 'the protocol lines are encrypted',
              },
            ],
          }),
        ]
      : [];

  return {
    id: spec.id,
    from: segment.from,
    to: segment.to,
    via: segment.via,
    protocol: spec.protocol,
    label: spec.label,
    summary: `${who}: ${info}`,
    headers: [
      ...segment.headers,
      ...tlsGroups,
      mailLine({ protocol: spec.protocol, direction: who, lines: spec.lines }),
    ],
    sizeBytes: segment.sizeBytes,
    ...(spec.encrypted === true ? { encrypted: true } : {}),
    at: spec.at,
    wireTimeMs: wireTo(spec.wireMs),
    meta: segment.meta,
  };
}

interface DnsPacketSpec {
  id: string;
  dir: Dir;
  label: string;
  summary: string;
  at: number;
  wireMs: number;
}

const DNS_ID = 0x7c1e;
const MX_QUESTION = { name: HOST.recipientDomain, type: 'MX' } as const;
const MX_ANSWERS = [
  { name: HOST.recipientDomain, type: 'MX', ttl: 3600, data: '10 mx1.example.org.' },
  { name: HOST.recipientDomain, type: 'MX', ttl: 3600, data: '20 mx2.example.org.' },
] as const;
const MX_ADDITIONAL = [
  { name: HOST.recipientMx, type: 'A', ttl: 3600, data: IP.recipientMx },
  { name: 'mx2.example.org', type: 'A', ttl: 3600, data: IP_MX2 },
] as const;

/** UDP DNS on the sender's data-centre LAN: query 29 bytes, response 101 bytes (compressed names). */
function dnsPacket(spec: DnsPacketSpec): PacketDef {
  const isQuery = spec.dir === 'c2s';
  const dnsBytes = isQuery ? 29 : 101;
  const src = isQuery ? IP.senderMail : IP_RESOLVER;
  const dst = isQuery ? IP_RESOLVER : IP.senderMail;
  const ip = ipv4({
    src,
    dst,
    ttl: 64,
    id: isQuery ? 0x5e21 : 0x0c3d,
    protocol: 'UDP',
    totalLength: 28 + dnsBytes,
  });

  return {
    id: spec.id,
    from: isQuery ? 'msa' : 'resolver',
    to: isQuery ? 'resolver' : 'msa',
    protocol: 'dns',
    label: spec.label,
    summary: spec.summary,
    headers: [
      ethernet({
        src: isQuery ? MAC_MSA : MAC_RESOLVER,
        dst: isQuery ? MAC_RESOLVER : MAC_MSA,
        etherType: 'IPv4',
      }),
      ip.group,
      udp({
        srcPort: isQuery ? EPHEMERAL_PORTS[7] : PORT.dns,
        dstPort: isQuery ? PORT.dns : EPHEMERAL_PORTS[7],
        length: 8 + dnsBytes,
      }),
      isQuery
        ? dns({ id: DNS_ID, qr: 'query', flags: { rd: true }, question: MX_QUESTION })
        : dns({
            id: DNS_ID,
            qr: 'response',
            flags: { rd: true, ra: true },
            question: MX_QUESTION,
            answer: MX_ANSWERS,
            additional: MX_ADDITIONAL,
          }),
    ],
    sizeBytes: 14 + 28 + dnsBytes,
    at: spec.at,
    wireTimeMs: wireTo(spec.wireMs),
    meta: { ipv4: ip.meta },
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const alice = (port: number, seq: number): Endpoint => ({
  node: 'alice',
  ip: IP.laptop,
  seenAs: IP.routerPublic,
  mac: MAC.laptop,
  nextHopMac: MAC.routerLan,
  via: [],
  port,
  seq,
});

const bob = (port: number, seq: number): Endpoint => ({
  node: 'bob',
  ip: IP.otherLaptop,
  seenAs: IP_BOB_PUBLIC,
  mac: MAC.otherLaptop,
  nextHopMac: MAC_BOB_GW,
  via: [],
  port,
  seq,
});

/** Alice to the submission server. Plain until STARTTLS, so no handshake bytes yet. */
const submissionFlow = createFlow(
  'alice-msa',
  alice(EPHEMERAL_PORTS[0], ISN.client + 1),
  {
    node: 'msa',
    ip: IP.senderMail,
    mac: MAC_MSA,
    nextHopMac: MAC_MSA_GW,
    via: [],
    port: PORT.smtpSubmission,
    seq: ISN.server + 1,
  },
  0x4a10,
);

/** The sending MTA to the recipient's MX on port 25. */
const relayFlow = createFlow(
  'msa-mx',
  {
    node: 'msa',
    ip: IP.senderMail,
    mac: MAC_MSA,
    nextHopMac: MAC_MSA_GW,
    via: [],
    port: EPHEMERAL_PORTS[4],
    seq: ISN.client + 2_000_000 + 1,
  },
  {
    node: 'mx',
    ip: IP.recipientMx,
    mac: MAC_MX,
    nextHopMac: MAC_MX_GW,
    via: [],
    port: PORT.smtp,
    seq: ISN.server + 2_000_000 + 1,
  },
  0x1b07,
);

/** Bob to the POP3 server on 995; implicit TLS, so the handshake is already behind us. */
const popFlow = createFlow(
  'bob-pop',
  bob(EPHEMERAL_PORTS[5], ISN.client + 4_000_000 + 1 + TLS_BYTES.client),
  {
    node: 'pop',
    ip: IP.recipientPop,
    mac: MAC_POP,
    nextHopMac: MAC_POP_GW,
    via: [],
    port: PORT.pop3s,
    seq: ISN.server + 4_000_000 + 1 + TLS_BYTES.server,
  },
  0x33a8,
);

/** Bob to the IMAP server on 993; implicit TLS. */
const imapFlow = createFlow(
  'bob-imap',
  bob(EPHEMERAL_PORTS[6], ISN.client + 6_000_000 + 1 + TLS_BYTES.client),
  {
    node: 'imap',
    ip: IP.recipientImap,
    mac: MAC_IMAP,
    nextHopMac: MAC_IMAP_GW,
    via: [],
    port: PORT.imaps,
    seq: ISN.server + 6_000_000 + 1 + TLS_BYTES.server,
  },
  0x7e90,
);

// ---------------------------------------------------------------------------
// Message and dialogue content
// ---------------------------------------------------------------------------

const CLIENT_NAME = HOST.laptop;
const MSA_NAME = HOST.senderMail;
const MX_NAME = HOST.recipientMx;

/** What Alice's client sends in DATA: header fields, an empty line, then the body. */
const ORIGINAL_MESSAGE: string[] = [
  'From: Alice Example <alice@example.com>',
  'To: Bob Example <bob@example.org>',
  'Subject: Lunch on Friday?',
  'Date: Fri, 13 Nov 2026 10:02:11 +0000',
  'Message-ID: <20261113100211.7f3a@laptop.example.com>',
  'MIME-Version: 1.0',
  'Content-Type: text/plain; charset=utf-8',
  '',
  'Hi Bob, are you free for lunch on Friday?',
  'Alice',
];

/** Trace line the submission server prepends. */
const RECEIVED_BY_MSA: string[] = [
  'Received: from laptop.example.com ([198.51.100.7])',
  ' by mail.example.com (Example MTA) with ESMTPSA id 4F2A91',
  ' for <bob@example.org>; Fri, 13 Nov 2026 10:02:11 +0000',
];

/** Trace lines the receiving MX adds when it delivers the message. */
const ADDED_BY_MX: string[] = [
  `Return-Path: <${MAILBOX.sender}>`,
  'Received: from mail.example.com (mail.example.com [192.0.2.25])',
  ' by mx1.example.org (Example MTA) with ESMTPS id D81C0E',
  ' for <bob@example.org>; Fri, 13 Nov 2026 10:02:13 +0000',
];

/** The message as stored in Bob's mailbox and as POP3 and IMAP return it. */
const STORED_MESSAGE: string[] = [...ADDED_BY_MX, ...RECEIVED_BY_MSA, ...ORIGINAL_MESSAGE];
const STORED_OCTETS = lineBytes(STORED_MESSAGE);
const POP_UIDL = 'a1f94e7c02d3';

/** `AUTH PLAIN` carries `authzid NUL authcid NUL passwd`; the password is a placeholder. */
const AUTH_PLAIN = btoa(`\u0000${MAILBOX.sender}\u0000example-password`);

/** wan hop plus a pause for the receiver to answer. */
const EXCHANGE_MS = 1200;

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const RFC_5321: Reference = {
  label: 'RFC 5321: Simple Mail Transfer Protocol',
  url: 'https://www.rfc-editor.org/rfc/rfc5321',
};
const RFC_5321_MX: Reference = {
  label: 'RFC 5321: Locating the target host',
  url: 'https://www.rfc-editor.org/rfc/rfc5321#section-5.1',
};
const RFC_5321_ENVELOPE: Reference = {
  label: 'RFC 5321: Mail transactions',
  url: 'https://www.rfc-editor.org/rfc/rfc5321#section-3.3',
};
const RFC_5321_DATA: Reference = {
  label: 'RFC 5321: DATA and transparency',
  url: 'https://www.rfc-editor.org/rfc/rfc5321#section-4.5.2',
};
const RFC_5322: Reference = {
  label: 'RFC 5322: Internet Message Format',
  url: 'https://www.rfc-editor.org/rfc/rfc5322',
};
const RFC_6409: Reference = {
  label: 'RFC 6409: Message Submission for Mail',
  url: 'https://www.rfc-editor.org/rfc/rfc6409',
};
const RFC_3207: Reference = {
  label: 'RFC 3207: SMTP Service Extension for Secure SMTP over TLS',
  url: 'https://www.rfc-editor.org/rfc/rfc3207',
};
const RFC_8314: Reference = {
  label: 'RFC 8314: Cleartext considered obsolete',
  url: 'https://www.rfc-editor.org/rfc/rfc8314',
};
const RFC_4954: Reference = {
  label: 'RFC 4954: SMTP Authentication',
  url: 'https://www.rfc-editor.org/rfc/rfc4954',
};
const RFC_4616: Reference = {
  label: 'RFC 4616: The PLAIN SASL mechanism',
  url: 'https://www.rfc-editor.org/rfc/rfc4616',
};
const RFC_2920: Reference = {
  label: 'RFC 2920: SMTP command pipelining',
  url: 'https://www.rfc-editor.org/rfc/rfc2920',
};
const RFC_7435: Reference = {
  label: 'RFC 7435: Opportunistic security',
  url: 'https://www.rfc-editor.org/rfc/rfc7435',
};
const RFC_1035: Reference = {
  label: 'RFC 1035: Domain names, implementation and specification',
  url: 'https://www.rfc-editor.org/rfc/rfc1035',
};
const RFC_1939: Reference = {
  label: 'RFC 1939: Post Office Protocol, version 3',
  url: 'https://www.rfc-editor.org/rfc/rfc1939',
};
const RFC_2595: Reference = {
  label: 'RFC 2595: Using TLS with IMAP, POP3 and ACAP',
  url: 'https://www.rfc-editor.org/rfc/rfc2595',
};
const RFC_3501: Reference = {
  label: 'RFC 3501: IMAP4rev1',
  url: 'https://www.rfc-editor.org/rfc/rfc3501',
};
const RFC_9051: Reference = {
  label: 'RFC 9051: IMAP4rev2',
  url: 'https://www.rfc-editor.org/rfc/rfc9051',
};
const RFC_2177: Reference = {
  label: 'RFC 2177: IMAP4 IDLE command',
  url: 'https://www.rfc-editor.org/rfc/rfc2177',
};
const RFC_7208: Reference = {
  label: 'RFC 7208: SPF',
  url: 'https://www.rfc-editor.org/rfc/rfc7208',
};
const RFC_6376: Reference = {
  label: 'RFC 6376: DKIM signatures',
  url: 'https://www.rfc-editor.org/rfc/rfc6376',
};
const RFC_7489: Reference = {
  label: 'RFC 7489: DMARC',
  url: 'https://www.rfc-editor.org/rfc/rfc7489',
};

const collapsedSimplifications = [
  'The TCP handshake, the home router’s NAT and the Internet between the hosts are collapsed into one link. Sequence numbers include the handshake bytes, and the first segment in each direction is marked as a resync.',
  'Headers show each packet as its sender put it on the wire; frame sizes follow the line lengths. Pure TCP ACKs are left out.',
];

/**
 * Stands for a TLS handshake that is not drawn (after STARTTLS): moves the sequence numbers past
 * its bytes and returns no packets, so it can sit between packets in a list.
 */
function collapsedTlsHandshake(flow: Flow): PacketDef[] {
  flow.skip(TLS_BYTES.client, TLS_BYTES.server);

  return [];
}

// ---------------------------------------------------------------------------
// Steps (built in order: the wire clock and TCP sequence numbers advance as they are created)
// ---------------------------------------------------------------------------

const steps: StepDef[] = [
  // 1 ----------------------------------------------------------------------
  {
    id: 'submission-greeting',
    phase: 'submission',
    title: 'Submission: connect to port 587, say EHLO',
    summary:
      'Alice’s mail client opens TCP port 587, the message submission port. The server speaks first with `220`; the client answers `EHLO` and learns the extensions, including `STARTTLS`.',
    body: [
      {
        type: 'p',
        text: 'Mail travels in two halves. First, the sender’s client (a mail user agent) hands the message to its provider’s submission server, here `mail.example.com`, on port 587 (RFC 6409). Port 25 is for server-to-server relay, not for end-user clients.',
      },
      {
        type: 'p',
        text: 'SMTP is a line-based dialogue. The server opens with a three-digit reply code, and the client sends commands. `EHLO` gives the client’s name and asks for the extension list. Every line of a multi-line reply starts with `250-` except the last, which starts with `250 `.',
      },
      {
        type: 'callout',
        tone: 'note',
        text: 'Nothing is encrypted yet, and the server has not offered `AUTH`. Providers commonly insist on TLS before they accept credentials.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-sub-220',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: [`220 ${MSA_NAME} ESMTP ready`],
        label: '220 greeting',
        at: 600,
        wireMs: 0,
      }),
      mailPacket({
        id: 'p-sub-ehlo',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [`EHLO ${CLIENT_NAME}`],
        label: 'EHLO',
        at: 600 + EXCHANGE_MS,
        wireMs: 18.4,
      }),
      mailPacket({
        id: 'p-sub-250-ehlo',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: [
          `250-${MSA_NAME}`,
          '250-PIPELINING',
          '250-SIZE 35882577',
          '250-ENHANCEDSTATUSCODES',
          '250-8BITMIME',
          '250 STARTTLS',
        ],
        label: '250 + STARTTLS',
        at: 600 + 2 * EXCHANGE_MS,
        wireMs: 36.8,
      }),
    ],
    actions: [
      {
        id: 'a-sub-accept',
        node: 'msa',
        kind: 'process',
        label: 'Accept connection',
        at: 0,
        durationMs: 500,
      },
    ],
    focus: ['alice', 'msa'],
    simplifications: [
      ...collapsedSimplifications,
      'Port 465 with implicit TLS (RFC 8314) is an alternative that skips `STARTTLS`; it is not shown.',
    ],
    references: [RFC_6409, RFC_5321],
  },
  // 2 ----------------------------------------------------------------------
  {
    id: 'submission-starttls',
    phase: 'submission',
    title: 'STARTTLS, then EHLO again',
    summary:
      'The client sends `STARTTLS`, the server answers `220`, and both run a TLS handshake on the same connection. The client repeats `EHLO` inside TLS and now sees `AUTH`.',
    body: [
      {
        type: 'p',
        text: '`STARTTLS` upgrades the existing TCP connection. After `220 2.0.0 Ready to start TLS`, the next bytes are a TLS handshake instead of SMTP text, and everything after it is encrypted.',
      },
      {
        type: 'p',
        text: 'The client must forget what it learned and send `EHLO` again, because anything seen before TLS could have been tampered with. The second reply no longer lists `STARTTLS` and now offers `AUTH`.',
      },
      {
        type: 'callout',
        tone: 'tip',
        text: 'RFC 8314 prefers implicit TLS on port 465. With `STARTTLS`, a network attacker can strip the upgrade offer unless the client refuses to continue without TLS.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-sub-starttls',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: ['STARTTLS'],
        label: 'STARTTLS',
        at: 0,
        wireMs: 55.2,
      }),
      mailPacket({
        id: 'p-sub-220-tls',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['220 2.0.0 Ready to start TLS'],
        label: '220 start TLS',
        at: EXCHANGE_MS,
        wireMs: 73.6,
      }),
      ...collapsedTlsHandshake(submissionFlow),
      mailPacket({
        id: 'p-sub-ehlo-tls',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [`EHLO ${CLIENT_NAME}`],
        encrypted: true,
        label: 'EHLO (in TLS)',
        at: 3700,
        wireMs: 129,
      }),
      mailPacket({
        id: 'p-sub-250-auth',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: [
          `250-${MSA_NAME}`,
          '250-PIPELINING',
          '250-SIZE 35882577',
          '250-ENHANCEDSTATUSCODES',
          '250-8BITMIME',
          '250 AUTH PLAIN LOGIN',
        ],
        encrypted: true,
        label: '250 + AUTH',
        at: 3700 + EXCHANGE_MS,
        wireMs: 147.4,
      }),
    ],
    actions: [
      {
        id: 'a-sub-tls-client',
        node: 'alice',
        kind: 'encrypt',
        label: 'TLS handshake',
        at: 2100,
        durationMs: 1400,
      },
      {
        id: 'a-sub-tls-server',
        node: 'msa',
        kind: 'encrypt',
        label: 'TLS handshake',
        at: 2100,
        durationMs: 1400,
      },
    ],
    focus: ['alice', 'msa'],
    simplifications: [
      'The TLS 1.3 handshake is not drawn; the sequence numbers skip its bytes, and the next segment in each direction is marked as a resync.',
    ],
    references: [RFC_3207, RFC_8314, RFC_5321],
  },
  // 3 ----------------------------------------------------------------------
  {
    id: 'submission-auth',
    phase: 'submission',
    title: 'AUTH: Alice proves who she is',
    summary:
      'Inside TLS, the client sends `AUTH PLAIN`. The server sends an empty `334` challenge, the client sends base64-encoded credentials, and the server accepts with `235`.',
    body: [
      {
        type: 'p',
        text: 'Submission requires authentication, so the provider only relays mail for known users. With `AUTH PLAIN`, the client sends `authzid NUL authcid NUL password`, base64-encoded. The `334` reply means the server is waiting for that data, and `235` means authentication succeeded.',
      },
      {
        type: 'p',
        text: 'Base64 is an encoding, not encryption. The TLS layer is what protects the password, which is why servers offer `AUTH` only after `STARTTLS`. Other SASL mechanisms and token-based logins exist as well.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-sub-auth',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: ['AUTH PLAIN'],
        encrypted: true,
        label: 'AUTH PLAIN',
        at: 0,
        wireMs: 165.9,
      }),
      mailPacket({
        id: 'p-sub-334',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['334 '],
        encrypted: true,
        label: '334 challenge',
        at: EXCHANGE_MS,
        wireMs: 184.2,
      }),
      mailPacket({
        id: 'p-sub-auth-data',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [AUTH_PLAIN],
        encrypted: true,
        label: 'Credentials',
        summary: 'base64 credentials (authzid, authcid, password)',
        at: 2 * EXCHANGE_MS,
        wireMs: 202.6,
      }),
      mailPacket({
        id: 'p-sub-235',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['235 2.7.0 Authentication successful'],
        encrypted: true,
        label: '235 accepted',
        at: 3 * EXCHANGE_MS,
        wireMs: 221.4,
      }),
    ],
    actions: [
      {
        id: 'a-sub-verify',
        node: 'msa',
        kind: 'verify',
        label: 'Check credentials',
        at: 2 * EXCHANGE_MS + 900,
        durationMs: 300,
      },
    ],
    focus: ['alice', 'msa'],
    simplifications: [
      'The username and password are placeholders. The base64 text decodes to `NUL alice@example.com NUL example-password`.',
    ],
    references: [RFC_4954, RFC_4616],
  },
  // 4 ----------------------------------------------------------------------
  {
    id: 'submission-envelope',
    phase: 'submission',
    title: 'Envelope: MAIL FROM and RCPT TO',
    summary:
      'The envelope names sender and recipient with `MAIL FROM` and `RCPT TO`. These addresses drive delivery and are separate from the `From:` and `To:` headers inside the message.',
    body: [
      {
        type: 'p',
        text: 'The SMTP envelope is what servers use to route and bounce mail, like the address on a paper envelope. `MAIL FROM` gives the return path for bounces; each `RCPT TO` names one recipient. The server accepts each with `250`.',
      },
      {
        type: 'p',
        text: 'Header fields such as `From:` and `To:` are part of the content, sent later in `DATA`. They can differ from the envelope. A `Bcc` recipient appears only in `RCPT TO`, and mailing lists often use their own envelope sender while the author stays in `From:`.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-sub-mail-from',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [`MAIL FROM:<${MAILBOX.sender}>`],
        encrypted: true,
        label: 'MAIL FROM',
        at: 0,
        wireMs: 240,
      }),
      mailPacket({
        id: 'p-sub-250-from',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['250 2.1.0 Ok'],
        encrypted: true,
        label: '250 sender OK',
        at: EXCHANGE_MS,
        wireMs: 258.4,
      }),
      mailPacket({
        id: 'p-sub-rcpt-to',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [`RCPT TO:<${MAILBOX.recipient}>`],
        encrypted: true,
        label: 'RCPT TO',
        at: 2 * EXCHANGE_MS,
        wireMs: 276.9,
      }),
      mailPacket({
        id: 'p-sub-250-rcpt',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['250 2.1.5 Ok'],
        encrypted: true,
        label: '250 recipient OK',
        at: 3 * EXCHANGE_MS,
        wireMs: 295.3,
      }),
    ],
    focus: ['alice', 'msa'],
    simplifications: [
      'Only one recipient is shown. A client may send `RCPT TO` several times, once per recipient.',
    ],
    references: [RFC_5321_ENVELOPE, RFC_5322],
  },
  // 5 ----------------------------------------------------------------------
  {
    id: 'submission-data',
    phase: 'submission',
    title: 'DATA: the message, then QUIT',
    summary:
      '`DATA` starts the message. After `354` the client sends headers, a blank line and the body, then a line holding only `.`. The server queues it with `250`; `QUIT` ends the session.',
    body: [
      {
        type: 'p',
        text: 'After `354`, the server reads message lines until it sees `<CRLF>.<CRLF>`, a line that contains only a dot. A body line that starts with a dot is sent with an extra dot (dot-stuffing) so it cannot be mistaken for the end. The `250` means the server has accepted responsibility for delivery, not that Bob has the message.',
      },
      {
        type: 'p',
        text: 'The message is defined by RFC 5322: header fields, an empty line, then the body. `QUIT` closes the session and the server confirms with `221`.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-sub-data',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: ['DATA'],
        encrypted: true,
        label: 'DATA',
        at: 0,
        wireMs: 313.8,
      }),
      mailPacket({
        id: 'p-sub-354',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['354 End data with <CR><LF>.<CR><LF>'],
        encrypted: true,
        label: '354 go ahead',
        at: EXCHANGE_MS,
        wireMs: 332.1,
      }),
      mailPacket({
        id: 'p-sub-message',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [...ORIGINAL_MESSAGE, '.'],
        encrypted: true,
        label: 'message + "."',
        summary: 'message headers and body, ended by a line with a single "."',
        at: 2 * EXCHANGE_MS,
        wireMs: 350.6,
      }),
      mailPacket({
        id: 'p-sub-250-queued',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['250 2.0.0 Ok: queued as 4F2A91'],
        encrypted: true,
        label: '250 queued',
        at: 3 * EXCHANGE_MS,
        wireMs: 369.4,
      }),
      mailPacket({
        id: 'p-sub-quit',
        flow: submissionFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: ['QUIT'],
        encrypted: true,
        label: 'QUIT',
        at: 4 * EXCHANGE_MS,
        wireMs: 388,
      }),
      mailPacket({
        id: 'p-sub-221',
        flow: submissionFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['221 2.0.0 Bye'],
        encrypted: true,
        label: '221 Bye',
        at: 5 * EXCHANGE_MS,
        wireMs: 406.3,
      }),
    ],
    actions: [
      {
        id: 'a-sub-queue',
        node: 'msa',
        kind: 'store',
        label: 'Queue message',
        at: 2 * EXCHANGE_MS + 900,
        durationMs: 300,
      },
    ],
    focus: ['alice', 'msa'],
    references: [RFC_5321_DATA, RFC_5322],
  },
  // 6 ----------------------------------------------------------------------
  {
    id: 'mx-lookup',
    phase: 'mx-lookup',
    title: 'MX lookup: who accepts mail for example.org?',
    summary:
      'The provider’s server now acts as the sending MTA. It asks its DNS resolver for the `MX` records of `example.org` and learns which hosts accept mail, with priorities and addresses.',
    body: [
      {
        type: 'p',
        text: 'Mail routing uses DNS. An `MX` record holds a preference number and a host name. The sender tries the lowest preference first and falls back to higher numbers if it cannot connect. The additional section often carries the hosts’ `A` records, which saves a second lookup.',
      },
      {
        type: 'p',
        text: 'If a domain has no `MX` record, SMTP falls back to the domain’s own address records. The MTA, not Alice’s client, does this lookup, and it may happen long after she pressed Send, for example when a first attempt has to be retried.',
      },
    ],
    packets: [
      dnsPacket({
        id: 'p-dns-mx-query',
        dir: 'c2s',
        label: 'MX example.org?',
        summary: 'Standard query 0x7c1e MX example.org',
        at: 600,
        wireMs: 2000,
      }),
      dnsPacket({
        id: 'p-dns-mx-response',
        dir: 's2c',
        label: 'MX answer',
        summary: 'Standard query response 0x7c1e MX 10 mx1.example.org, MX 20 mx2.example.org',
        at: 1900,
        wireMs: 2041.7,
      }),
    ],
    actions: [
      {
        id: 'a-mx-queue-run',
        node: 'msa',
        kind: 'process',
        label: 'Queue run: look up MX',
        at: 0,
        durationMs: 500,
      },
      {
        id: 'a-mx-resolve',
        node: 'resolver',
        kind: 'process',
        label: 'Resolve MX',
        at: 600 + 450,
        durationMs: 700,
      },
      {
        id: 'a-mx-choose',
        node: 'msa',
        kind: 'process',
        label: 'Try lowest preference',
        at: 1900 + 450,
        durationMs: 600,
      },
    ],
    focus: ['msa', 'resolver'],
    simplifications: [
      'The resolver’s own iterative lookups (root, `.org`, example.org’s name servers) are omitted; the DNS scenario shows that process.',
      'The backup host mx2.example.org is named in the answer but not drawn.',
    ],
    references: [RFC_5321_MX, RFC_1035],
  },
  // 7 ----------------------------------------------------------------------
  {
    id: 'relay-greeting',
    phase: 'relay',
    title: 'Relay: the MTA calls the MX on port 25',
    summary:
      'The MTA connects to `mx1.example.org` on port 25. Server-to-server SMTP uses the same commands but no login: an MX accepts mail for its own users from anyone.',
    body: [
      {
        type: 'p',
        text: 'Port 25 is where mail servers talk to each other. Unlike submission, there is no `AUTH`: an MX accepts mail for the recipients it hosts from any sender, and relies on spam filtering and other sender checks rather than a login.',
      },
      {
        type: 'p',
        text: 'The MTA introduces itself with its own name, `mail.example.com`, not the name of Alice’s laptop. The MX advertises `STARTTLS`, and whether to use it is the sending MTA’s decision.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-relay-220',
        flow: relayFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: [`220 ${MX_NAME} ESMTP ready`],
        label: '220 greeting',
        at: 600,
        wireMs: 2117.4,
      }),
      mailPacket({
        id: 'p-relay-ehlo',
        flow: relayFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [`EHLO ${MSA_NAME}`],
        label: 'EHLO',
        at: 600 + EXCHANGE_MS,
        wireMs: 2142.6,
      }),
      mailPacket({
        id: 'p-relay-250-ehlo',
        flow: relayFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: [
          `250-${MX_NAME}`,
          '250-PIPELINING',
          '250-SIZE 52428800',
          '250-ENHANCEDSTATUSCODES',
          '250 STARTTLS',
        ],
        label: '250 + STARTTLS',
        at: 600 + 2 * EXCHANGE_MS,
        wireMs: 2168,
      }),
    ],
    actions: [
      {
        id: 'a-relay-connect',
        node: 'msa',
        kind: 'process',
        label: 'Connect to mx1:25',
        at: 0,
        durationMs: 500,
      },
    ],
    focus: ['msa', 'mx'],
    simplifications: [
      'The TCP handshake and the Internet path between the two data centres are collapsed into one link.',
    ],
    references: [RFC_5321, RFC_5321_MX],
  },
  // 8 ----------------------------------------------------------------------
  {
    id: 'relay-starttls',
    phase: 'relay',
    title: 'Relay: opportunistic STARTTLS',
    summary:
      'The MTA sends `STARTTLS` and, after the TLS handshake, repeats `EHLO`. TLS between MTAs is opportunistic: it is used when offered, and certificates are often not strictly checked.',
    body: [
      {
        type: 'p',
        text: 'Opportunistic means the sending MTA uses TLS if the MX offers it and falls back to plaintext if not. Because there is no way to know in advance whether a domain supports TLS, a network attacker could strip the `STARTTLS` offer. Mechanisms such as MTA-STS and DANE let a domain demand TLS.',
      },
      {
        type: 'p',
        text: 'As in submission, the second `EHLO` is mandatory after the handshake, and the reply no longer lists `STARTTLS`.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-relay-starttls',
        flow: relayFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: ['STARTTLS'],
        label: 'STARTTLS',
        at: 0,
        wireMs: 2193.2,
      }),
      mailPacket({
        id: 'p-relay-220-tls',
        flow: relayFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['220 2.0.0 Ready to start TLS'],
        label: '220 start TLS',
        at: EXCHANGE_MS,
        wireMs: 2218.5,
      }),
      ...collapsedTlsHandshake(relayFlow),
      mailPacket({
        id: 'p-relay-ehlo-tls',
        flow: relayFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [`EHLO ${MSA_NAME}`],
        encrypted: true,
        label: 'EHLO (in TLS)',
        at: 3700,
        wireMs: 2295,
      }),
      mailPacket({
        id: 'p-relay-250-tls',
        flow: relayFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: [`250-${MX_NAME}`, '250-PIPELINING', '250-SIZE 52428800', '250 ENHANCEDSTATUSCODES'],
        encrypted: true,
        label: '250 (no STARTTLS)',
        at: 3700 + EXCHANGE_MS,
        wireMs: 2320.4,
      }),
    ],
    actions: [
      {
        id: 'a-relay-tls-client',
        node: 'msa',
        kind: 'encrypt',
        label: 'TLS handshake',
        at: 2100,
        durationMs: 1400,
      },
      {
        id: 'a-relay-tls-server',
        node: 'mx',
        kind: 'encrypt',
        label: 'TLS handshake',
        at: 2100,
        durationMs: 1400,
      },
    ],
    focus: ['msa', 'mx'],
    simplifications: [
      'The TLS handshake is not drawn, and the certificate check is not modelled; opportunistic senders often accept any certificate.',
    ],
    references: [RFC_3207, RFC_7435],
  },
  // 9 ----------------------------------------------------------------------
  {
    id: 'relay-data',
    phase: 'relay',
    title: 'Relay: envelope, DATA and acceptance',
    summary:
      'The MTA sends the envelope and the message again, this time MTA to MTA. Pipelining batches `MAIL FROM`, `RCPT TO` and `DATA`; the MX accepts the message and delivers it to Bob’s mailbox.',
    body: [
      {
        type: 'p',
        text: '`PIPELINING` lets the client send several commands without waiting for each reply, so three commands travel in one packet and three replies return in one. The message now begins with a `Received:` trace line that the submission server added.',
      },
      {
        type: 'p',
        text: 'After the final `250`, the message is in the MX’s queue and is handed to Bob’s mailbox. The delivery step adds `Return-Path:`, which records the envelope sender. The `From:` header is untouched.',
      },
      {
        type: 'callout',
        tone: 'note',
        text: 'SPF, DKIM and DMARC are checks, not extra SMTP commands. SPF asks whether the connecting host may send for the envelope domain, DKIM verifies a signature header, and DMARC ties both to the `From:` domain. All use DNS records and leave only headers behind.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-relay-pipelined',
        flow: relayFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [`MAIL FROM:<${MAILBOX.sender}>`, `RCPT TO:<${MAILBOX.recipient}>`, 'DATA'],
        encrypted: true,
        label: 'MAIL · RCPT · DATA',
        summary: 'MAIL FROM, RCPT TO and DATA in one packet (PIPELINING)',
        at: 0,
        wireMs: 2345.7,
      }),
      mailPacket({
        id: 'p-relay-replies',
        flow: relayFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['250 2.1.0 Ok', '250 2.1.5 Ok', '354 End data with <CR><LF>.<CR><LF>'],
        encrypted: true,
        label: '250 · 250 · 354',
        summary: '250 sender OK, 250 recipient OK, 354 go ahead',
        at: EXCHANGE_MS,
        wireMs: 2371.2,
      }),
      mailPacket({
        id: 'p-relay-message',
        flow: relayFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: [...RECEIVED_BY_MSA, ...ORIGINAL_MESSAGE, '.'],
        encrypted: true,
        label: 'message + "."',
        summary: 'message with Received trace line, ended by a line with a single "."',
        at: 2 * EXCHANGE_MS,
        wireMs: 2396.6,
      }),
      mailPacket({
        id: 'p-relay-250-queued',
        flow: relayFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['250 2.0.0 Ok: queued as D81C0E'],
        encrypted: true,
        label: '250 queued',
        at: 3900,
        wireMs: 2422.5,
      }),
      mailPacket({
        id: 'p-relay-quit',
        flow: relayFlow,
        dir: 'c2s',
        protocol: 'smtp',
        lines: ['QUIT'],
        encrypted: true,
        label: 'QUIT',
        at: 5100,
        wireMs: 2447.9,
      }),
      mailPacket({
        id: 'p-relay-221',
        flow: relayFlow,
        dir: 's2c',
        protocol: 'smtp',
        lines: ['221 2.0.0 Bye'],
        encrypted: true,
        label: '221 Bye',
        at: 5100 + EXCHANGE_MS,
        wireMs: 2473.3,
      }),
    ],
    actions: [
      {
        id: 'a-relay-checks',
        node: 'mx',
        kind: 'verify',
        label: 'Spam and policy checks',
        at: 2 * EXCHANGE_MS + 900,
        durationMs: 500,
      },
      {
        id: 'a-relay-deliver',
        node: 'mx',
        kind: 'store',
        label: 'Deliver to Bob’s mailbox',
        at: 4800,
        durationMs: 800,
      },
    ],
    focus: ['msa', 'mx'],
    simplifications: [
      'The mailbox store behind the MX is shared by the POP3 and IMAP servers; they are drawn as separate hosts for clarity, and the internal delivery is not animated.',
      'A real MX applies many more checks and may reject at `RCPT TO` or after `DATA`; only the successful path is shown.',
    ],
    references: [RFC_5321_ENVELOPE, RFC_2920, RFC_7208, RFC_6376, RFC_7489],
  },
  // 10 ---------------------------------------------------------------------
  {
    id: 'pop3-login',
    phase: 'pop3',
    title: 'POP3: connect on 995 and log in',
    summary:
      'Later, Bob’s client connects to `pop.example.org` on port 995, POP3 over TLS from the first byte. The server greets with `+OK`; `USER` and `PASS` log in.',
    body: [
      {
        type: 'p',
        text: 'POP3 replies are `+OK` or `-ERR` followed by text. Port 995 uses implicit TLS: the handshake happens before any POP3 text, so there is no `STARTTLS` step. Port 110 offers the `STLS` command for an upgrade instead.',
      },
      {
        type: 'p',
        text: '`USER` and `PASS` identify Bob. POP3 gives access to one maildrop. A client usually downloads from it, but whether messages stay on the server afterwards is the client’s choice, not a property of the protocol.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-pop-greeting',
        flow: popFlow,
        dir: 's2c',
        protocol: 'pop3',
        lines: ['+OK POP3 server ready'],
        encrypted: true,
        label: '+OK greeting',
        at: 600,
        wireMs: 60000,
      }),
      mailPacket({
        id: 'p-pop-user',
        flow: popFlow,
        dir: 'c2s',
        protocol: 'pop3',
        lines: [`USER ${MAILBOX.recipient}`],
        encrypted: true,
        label: 'USER',
        at: 600 + EXCHANGE_MS,
        wireMs: 60020.6,
      }),
      mailPacket({
        id: 'p-pop-ok-user',
        flow: popFlow,
        dir: 's2c',
        protocol: 'pop3',
        lines: ['+OK'],
        encrypted: true,
        label: '+OK',
        at: 600 + 2 * EXCHANGE_MS,
        wireMs: 60041,
      }),
      mailPacket({
        id: 'p-pop-pass',
        flow: popFlow,
        dir: 'c2s',
        protocol: 'pop3',
        lines: ['PASS example-password'],
        encrypted: true,
        label: 'PASS',
        at: 600 + 3 * EXCHANGE_MS,
        wireMs: 60061.6,
      }),
      mailPacket({
        id: 'p-pop-ok-pass',
        flow: popFlow,
        dir: 's2c',
        protocol: 'pop3',
        lines: ['+OK Logged in.'],
        encrypted: true,
        label: '+OK logged in',
        at: 600 + 4 * EXCHANGE_MS,
        wireMs: 60083,
      }),
    ],
    actions: [
      {
        id: 'a-pop-accept',
        node: 'pop',
        kind: 'process',
        label: 'Accept connection',
        at: 0,
        durationMs: 500,
      },
      {
        id: 'a-pop-verify',
        node: 'pop',
        kind: 'verify',
        label: 'Check password',
        at: 600 + 3 * EXCHANGE_MS + 900,
        durationMs: 300,
      },
    ],
    focus: ['bob', 'pop'],
    simplifications: [
      'Bob’s home router (NAT) and the TLS handshake are collapsed; he reaches the server over one drawn link. The password is a placeholder.',
    ],
    references: [RFC_1939, RFC_8314, RFC_2595],
  },
  // 11 ---------------------------------------------------------------------
  {
    id: 'pop3-stat-uidl',
    phase: 'pop3',
    title: 'POP3: STAT and UIDL',
    summary:
      '`STAT` reports how many messages the maildrop holds and their total size. `UIDL` lists a unique id per message, so a client can tell which ones it has already downloaded.',
    body: [
      {
        type: 'p',
        text: '`STAT` answers `+OK <count> <octets>`. `LIST`, not shown here, returns the size of each message. `UIDL` returns an identifier that stays the same across sessions, unlike the message number, which can change.',
      },
      {
        type: 'p',
        text: 'Clients that leave mail on the server use `UIDL` to skip messages they already have. A multi-line reply ends with a line holding a single dot, the same terminator idea as in SMTP.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-pop-stat',
        flow: popFlow,
        dir: 'c2s',
        protocol: 'pop3',
        lines: ['STAT'],
        encrypted: true,
        label: 'STAT',
        at: 0,
        wireMs: 60103.5,
      }),
      mailPacket({
        id: 'p-pop-ok-stat',
        flow: popFlow,
        dir: 's2c',
        protocol: 'pop3',
        lines: [`+OK 1 ${STORED_OCTETS}`],
        encrypted: true,
        label: '+OK 1 message',
        at: EXCHANGE_MS,
        wireMs: 60124,
      }),
      mailPacket({
        id: 'p-pop-uidl',
        flow: popFlow,
        dir: 'c2s',
        protocol: 'pop3',
        lines: ['UIDL'],
        encrypted: true,
        label: 'UIDL',
        at: 2 * EXCHANGE_MS,
        wireMs: 60144.6,
      }),
      mailPacket({
        id: 'p-pop-ok-uidl',
        flow: popFlow,
        dir: 's2c',
        protocol: 'pop3',
        lines: ['+OK', `1 ${POP_UIDL}`, '.'],
        encrypted: true,
        label: '+OK + UID list',
        at: 3 * EXCHANGE_MS,
        wireMs: 60165,
      }),
    ],
    actions: [
      {
        id: 'a-pop-count',
        node: 'pop',
        kind: 'process',
        label: 'Count messages',
        at: 900,
        durationMs: 300,
      },
    ],
    focus: ['bob', 'pop'],
    references: [RFC_1939],
  },
  // 12 ---------------------------------------------------------------------
  {
    id: 'pop3-retr',
    phase: 'pop3',
    title: 'POP3: RETR the message, then QUIT',
    summary:
      '`RETR 1` returns the message, ending with a lone `.`; `QUIT` closes the session. Whether the client first sends `DELE` is its choice, so POP3 does not always remove mail from the server.',
    body: [
      {
        type: 'p',
        text: '`RETR 1` returns the message as stored, including the trace headers added on the way: `Return-Path:` and two `Received:` lines. A client that wants it removed sends `DELE 1`; the server marks it and deletes it when the session ends with `QUIT`.',
      },
      {
        type: 'p',
        text: 'Many clients are set to leave a copy on the server, as this one is, so it sends no `DELE`. POP3 has no folders and no per-message flags beyond that deletion mark, which is the main contrast with IMAP in the next steps.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-pop-retr',
        flow: popFlow,
        dir: 'c2s',
        protocol: 'pop3',
        lines: ['RETR 1'],
        encrypted: true,
        label: 'RETR 1',
        at: 0,
        wireMs: 60185.7,
      }),
      mailPacket({
        id: 'p-pop-message',
        flow: popFlow,
        dir: 's2c',
        protocol: 'pop3',
        lines: [`+OK ${STORED_OCTETS} octets`, ...STORED_MESSAGE, '.'],
        encrypted: true,
        label: '+OK + message',
        summary: `+OK ${STORED_OCTETS} octets, message headers and body, ended by "."`,
        at: EXCHANGE_MS,
        wireMs: 60206.3,
      }),
      mailPacket({
        id: 'p-pop-quit',
        flow: popFlow,
        dir: 'c2s',
        protocol: 'pop3',
        lines: ['QUIT'],
        encrypted: true,
        label: 'QUIT',
        at: 2 * EXCHANGE_MS,
        wireMs: 60226.9,
      }),
      mailPacket({
        id: 'p-pop-ok-quit',
        flow: popFlow,
        dir: 's2c',
        protocol: 'pop3',
        lines: ['+OK Logging out.'],
        encrypted: true,
        label: '+OK bye',
        at: 3 * EXCHANGE_MS,
        wireMs: 60247.2,
      }),
    ],
    actions: [
      {
        id: 'a-pop-read',
        node: 'pop',
        kind: 'process',
        label: 'Read message',
        at: 900,
        durationMs: 300,
      },
      {
        id: 'a-bob-store',
        node: 'bob',
        kind: 'store',
        label: 'Keep a local copy',
        at: EXCHANGE_MS + 900,
        durationMs: 300,
      },
    ],
    focus: ['bob', 'pop'],
    simplifications: [
      '`DELE` is not sent here on purpose, which keeps the message in the mailbox for the IMAP steps.',
    ],
    references: [RFC_1939],
  },
  // 13 ---------------------------------------------------------------------
  {
    id: 'imap-login',
    phase: 'imap',
    title: 'IMAP: connect on 993 and LOGIN',
    summary:
      'Bob’s client now uses IMAP on port 993 for the same mailbox. The server greets with an untagged `* OK`; each client command carries a tag, here `a001 LOGIN`, and gets a tagged status.',
    body: [
      {
        type: 'p',
        text: 'IMAP keeps the mailbox on the server. Every client command starts with a tag (`a001`, `a002`, and so on) that the server repeats in its final reply, so several commands can be outstanding. Lines that start with `*` are untagged server data; the tagged `OK`, `NO` or `BAD` line ends a command.',
      },
      {
        type: 'p',
        text: 'Port 993 is IMAP with implicit TLS. The `CAPABILITY` list in the greeting tells the client what the server supports, such as `IDLE`.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-imap-greeting',
        flow: imapFlow,
        dir: 's2c',
        protocol: 'imap',
        lines: [`* OK [CAPABILITY IMAP4rev1 IDLE UIDPLUS AUTH=PLAIN] ${HOST.recipientImap} ready`],
        encrypted: true,
        label: '* OK greeting',
        at: 600,
        wireMs: 120000,
      }),
      mailPacket({
        id: 'p-imap-login',
        flow: imapFlow,
        dir: 'c2s',
        protocol: 'imap',
        lines: [`a001 LOGIN ${MAILBOX.recipient} example-password`],
        encrypted: true,
        label: 'a001 LOGIN',
        at: 600 + EXCHANGE_MS,
        wireMs: 120020.5,
      }),
      mailPacket({
        id: 'p-imap-ok-login',
        flow: imapFlow,
        dir: 's2c',
        protocol: 'imap',
        lines: ['a001 OK Logged in'],
        encrypted: true,
        label: 'a001 OK',
        at: 600 + 2 * EXCHANGE_MS,
        wireMs: 120041.5,
      }),
    ],
    actions: [
      {
        id: 'a-imap-accept',
        node: 'imap',
        kind: 'process',
        label: 'Accept connection',
        at: 0,
        durationMs: 500,
      },
      {
        id: 'a-imap-verify',
        node: 'imap',
        kind: 'verify',
        label: 'Check password',
        at: 600 + EXCHANGE_MS + 900,
        durationMs: 300,
      },
    ],
    focus: ['bob', 'imap'],
    simplifications: [
      'IMAP is shown from the same client for simplicity; in practice it is often a second device. The newer IMAP4rev2 (RFC 9051) keeps the same tagged model.',
    ],
    references: [RFC_3501, RFC_9051, RFC_8314],
  },
  // 14 ---------------------------------------------------------------------
  {
    id: 'imap-select-fetch',
    phase: 'imap',
    title: 'IMAP: SELECT the Inbox, FETCH the message',
    summary:
      '`SELECT INBOX` opens the folder and returns its flags, size and UID data as untagged lines. `FETCH` then downloads the message, and reading it sets the `\\Seen` flag on the server.',
    body: [
      {
        type: 'p',
        text: '`SELECT` makes a folder the current one and answers with untagged `FLAGS`, `EXISTS` and `UIDVALIDITY` data before the tagged `OK`. UIDs are stable numbers a client can cache; `UIDVALIDITY` tells it when its cache is no longer valid.',
      },
      {
        type: 'p',
        text: '`FETCH 1 (FLAGS BODY[])` asks for the whole message. Fetching the body this way implicitly sets `\\Seen`, which the server reports in the `FETCH` response; `BODY.PEEK[]` would fetch without setting it. The flag lives on the server, so every device sees the message as read.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-imap-select',
        flow: imapFlow,
        dir: 'c2s',
        protocol: 'imap',
        lines: ['a002 SELECT INBOX'],
        encrypted: true,
        label: 'a002 SELECT',
        at: 0,
        wireMs: 120062,
      }),
      mailPacket({
        id: 'p-imap-select-resp',
        flow: imapFlow,
        dir: 's2c',
        protocol: 'imap',
        lines: [
          '* FLAGS (\\Answered \\Flagged \\Deleted \\Seen \\Draft)',
          '* 1 EXISTS',
          '* 1 RECENT',
          '* OK [UNSEEN 1] First unseen message',
          '* OK [UIDVALIDITY 1731488000] UIDs valid',
          '* OK [UIDNEXT 2] Predicted next UID',
          'a002 OK [READ-WRITE] SELECT completed',
        ],
        encrypted: true,
        label: '* data · a002 OK',
        summary: '* FLAGS, * 1 EXISTS, ..., a002 OK [READ-WRITE] SELECT completed',
        at: EXCHANGE_MS,
        wireMs: 120082.6,
      }),
      mailPacket({
        id: 'p-imap-fetch',
        flow: imapFlow,
        dir: 'c2s',
        protocol: 'imap',
        lines: ['a003 FETCH 1 (FLAGS BODY[])'],
        encrypted: true,
        label: 'a003 FETCH',
        at: 2 * EXCHANGE_MS,
        wireMs: 120103.2,
      }),
      mailPacket({
        id: 'p-imap-fetch-resp',
        flow: imapFlow,
        dir: 's2c',
        protocol: 'imap',
        lines: [
          `* 1 FETCH (FLAGS (\\Seen \\Recent) BODY[] {${STORED_OCTETS}}`,
          ...STORED_MESSAGE,
          ')',
          'a003 OK Fetch completed',
        ],
        encrypted: true,
        label: '* 1 FETCH',
        summary: '* 1 FETCH (FLAGS (\\Seen \\Recent) BODY[] {...}), a003 OK Fetch completed',
        at: 3 * EXCHANGE_MS,
        wireMs: 120124,
      }),
    ],
    actions: [
      {
        id: 'a-imap-seen',
        node: 'imap',
        kind: 'process',
        label: 'Set \\Seen flag',
        at: 2 * EXCHANGE_MS + 900,
        durationMs: 300,
      },
    ],
    focus: ['bob', 'imap'],
    simplifications: [
      'A real client would first FETCH only envelopes and flags for the whole folder; here it asks for the one message directly. `\\Recent` is a per-session flag and is dropped in IMAP4rev2.',
    ],
    references: [RFC_3501, RFC_9051],
  },
  // 15 ---------------------------------------------------------------------
  {
    id: 'imap-idle',
    phase: 'imap',
    title: 'IMAP: flags, IDLE and multi-device sync',
    summary:
      '`IDLE` asks the server to push changes. A new message arrives, the server sends `* 2 EXISTS`, and the client ends IDLE with `DONE`. Server-side flags and folders keep several devices in sync.',
    body: [
      {
        type: 'p',
        text: 'After `IDLE` the server answers `+ idling` and keeps the connection open. When the mailbox changes, it sends an untagged response at once, so the client does not have to poll. `DONE`, sent without a tag, ends IDLE, and the server closes it with the tagged `OK`.',
      },
      {
        type: 'p',
        text: 'Contrast with POP3: IMAP keeps messages, folders and flags (`\\Seen`, `\\Flagged`, `\\Deleted`) on the server, so a phone and a laptop share one view of the mailbox. A POP3 client typically keeps its own local copy, and what it does with the server’s copy is up to its settings.',
      },
    ],
    packets: [
      mailPacket({
        id: 'p-imap-idle',
        flow: imapFlow,
        dir: 'c2s',
        protocol: 'imap',
        lines: ['a004 IDLE'],
        encrypted: true,
        label: 'a004 IDLE',
        at: 0,
        wireMs: 120144.5,
      }),
      mailPacket({
        id: 'p-imap-idling',
        flow: imapFlow,
        dir: 's2c',
        protocol: 'imap',
        lines: ['+ idling'],
        encrypted: true,
        label: '+ idling',
        at: EXCHANGE_MS,
        wireMs: 120165,
      }),
      mailPacket({
        id: 'p-imap-exists',
        flow: imapFlow,
        dir: 's2c',
        protocol: 'imap',
        lines: ['* 2 EXISTS'],
        encrypted: true,
        label: '* 2 EXISTS',
        at: 2600,
        wireMs: 150000,
      }),
      mailPacket({
        id: 'p-imap-done',
        flow: imapFlow,
        dir: 'c2s',
        protocol: 'imap',
        lines: ['DONE'],
        encrypted: true,
        label: 'DONE',
        at: 3800,
        wireMs: 150020.5,
      }),
      mailPacket({
        id: 'p-imap-ok-idle',
        flow: imapFlow,
        dir: 's2c',
        protocol: 'imap',
        lines: ['a004 OK IDLE terminated'],
        encrypted: true,
        label: 'a004 OK',
        at: 3800 + EXCHANGE_MS,
        wireMs: 150041.2,
      }),
    ],
    actions: [
      {
        id: 'a-imap-new-mail',
        node: 'imap',
        kind: 'process',
        label: 'New message arrives',
        at: 2000,
        durationMs: 500,
      },
    ],
    focus: ['bob', 'imap'],
    simplifications: [
      'The second message reaches the mailbox by the same path as steps 7 to 9; it is not drawn again. The 30 seconds spent idle are not animated.',
    ],
    references: [RFC_2177, RFC_3501, RFC_9051],
  },
];

export default defineScenario({
  id: 'email',
  title: 'Email: SMTP, POP3 and IMAP',
  tagline: 'From Alice’s Send button to Bob’s inbox: submission, relay and two ways to read mail.',
  category: 'email',
  order: 1,
  protocols: ['ethernet', 'ipv4', 'tcp', 'udp', 'dns', 'tls', 'smtp', 'pop3', 'imap'],
  phases: [
    { id: 'submission', label: 'Submission' },
    { id: 'mx-lookup', label: 'MX lookup' },
    { id: 'relay', label: 'Relay' },
    { id: 'pop3', label: 'POP3' },
    { id: 'imap', label: 'IMAP' },
  ],
  nodes: [
    {
      id: 'alice',
      kind: 'laptop',
      label: 'Alice’s laptop',
      sublabel: IP.laptop,
      position: { col: 0, row: 3 },
      zone: 'alice-home',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop, hostname: HOST.laptop },
    },
    {
      id: 'msa',
      kind: 'mail-server',
      label: 'Sender’s mail server',
      sublabel: IP.senderMail,
      position: { col: 3, row: 3 },
      zone: 'sender',
      addresses: { ipv4: IP.senderMail, mac: MAC_MSA, hostname: HOST.senderMail },
    },
    {
      id: 'resolver',
      kind: 'dns-resolver',
      label: 'DNS resolver',
      sublabel: IP_RESOLVER,
      position: { col: 3, row: 0.2 },
      zone: 'sender',
      addresses: { ipv4: IP_RESOLVER, mac: MAC_RESOLVER },
    },
    {
      id: 'mx',
      kind: 'mail-server',
      label: 'MX for example.org',
      sublabel: IP.recipientMx,
      position: { col: 6.5, row: 3 },
      zone: 'recipient',
      addresses: { ipv4: IP.recipientMx, mac: MAC_MX, hostname: HOST.recipientMx },
    },
    {
      id: 'pop',
      kind: 'mail-server',
      label: 'POP3 server',
      sublabel: IP.recipientPop,
      position: { col: 6.5, row: 0.2 },
      zone: 'recipient',
      addresses: { ipv4: IP.recipientPop, mac: MAC_POP, hostname: HOST.recipientPop },
    },
    {
      id: 'imap',
      kind: 'mail-server',
      label: 'IMAP server',
      sublabel: IP.recipientImap,
      position: { col: 9.2, row: 3 },
      zone: 'recipient',
      addresses: { ipv4: IP.recipientImap, mac: MAC_IMAP, hostname: HOST.recipientImap },
    },
    {
      id: 'bob',
      kind: 'laptop',
      label: 'Bob’s laptop',
      sublabel: IP.otherLaptop,
      position: { col: 11.7, row: 1.2 },
      zone: 'bob-home',
      addresses: { ipv4: IP.otherLaptop, mac: MAC.otherLaptop },
    },
  ],
  links: [
    { id: 'alice-msa', a: 'alice', b: 'msa', medium: 'wan', label: 'Internet' },
    { id: 'msa-resolver', a: 'msa', b: 'resolver', medium: 'ethernet' },
    { id: 'msa-mx', a: 'msa', b: 'mx', medium: 'wan', label: 'Internet' },
    { id: 'mx-pop', a: 'mx', b: 'pop', medium: 'ethernet', label: 'mailbox store' },
    { id: 'mx-imap', a: 'mx', b: 'imap', medium: 'ethernet', label: 'mailbox store' },
    { id: 'pop-bob', a: 'pop', b: 'bob', medium: 'wan', label: 'Internet' },
    { id: 'imap-bob', a: 'imap', b: 'bob', medium: 'wan', label: 'Internet' },
  ],
  zones: [
    {
      id: 'alice-home',
      label: 'Alice’s network',
      from: { col: -1, row: 1.9 },
      to: { col: 1, row: 4.1 },
      tone: 'lan',
    },
    {
      id: 'sender',
      label: 'example.com mail',
      from: { col: 1.8, row: -0.9 },
      to: { col: 4.6, row: 4.1 },
      tone: 'datacenter',
    },
    {
      id: 'recipient',
      label: 'example.org mail',
      from: { col: 5.5, row: -0.7 },
      to: { col: 10.2, row: 3.9 },
      tone: 'remote',
    },
    {
      id: 'bob-home',
      label: 'Bob’s network',
      from: { col: 10.8, row: 0.3 },
      to: { col: 12.6, row: 2.1 },
      tone: 'lan',
    },
  ],
  sequenceLanes: ['alice', 'msa', 'resolver', 'mx', 'bob', 'pop', 'imap'],
  steps,
});
