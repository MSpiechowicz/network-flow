import { defineScenario } from '../../model/types';
import type { HeaderField, HeaderGroup, PacketMeta, TcpFlag } from '../../model/types';
import { HOST, ISN, IP, MAC, PORT } from '../lib/addresses';
import {
  ethernet,
  http1Request,
  http1Response,
  ipv4,
  tcp,
  tcpSynOptions,
  tlsHandshake,
} from '../lib/builders';
import type { HeaderList } from '../lib/builders';

/**
 * HTTP/1.1 in plaintext, then the same exchange over HTTPS, on a café Wi-Fi network with an
 * eavesdropper. The eavesdropper is passive: it overhears frames, so it has actions but no packets.
 */

// ---------------------------------------------------------------------------
// The HTTP exchange (identical bytes in plaintext and inside TLS)
// ---------------------------------------------------------------------------

const PATH = '/account/orders';
const ETAG = '"a91c4e"';
const BODY_BYTES = 612;

const GET_FIELDS: HeaderList = [
  ['User-Agent', 'ExampleBrowser/1.0'],
  ['Accept', 'text/html'],
  ['Accept-Language', 'en'],
  ['Cookie', 'session=7f3a9c1e5b'],
];
const CONDITIONAL_FIELDS: HeaderList = [...GET_FIELDS, ['If-None-Match', ETAG]];

const OK_FIELDS: HeaderList = [
  ['Date', 'Fri, 13 Nov 2026 10:15:02 GMT'],
  ['Content-Type', 'text/html; charset=utf-8'],
  ['Content-Length', String(BODY_BYTES)],
  ['ETag', ETAG],
  ['Cache-Control', 'private, no-cache'],
];
const NOT_MODIFIED_FIELDS: HeaderList = [
  ['Date', 'Fri, 13 Nov 2026 10:15:41 GMT'],
  ['ETag', ETAG],
  ['Cache-Control', 'private, no-cache'],
];

/** Bytes of a start line plus header lines plus the blank line, all ASCII with CRLF endings. */
function headBytes(startLine: string, fields: HeaderList): number {
  const lines = [startLine, ...fields.map(([name, value]) => `${name}: ${value}`)];

  return lines.reduce((sum, line) => sum + line.length + 2, 0) + 2;
}

const requestBytes = (fields: HeaderList) =>
  headBytes(`GET ${PATH} HTTP/1.1`, [['Host', HOST.www], ...fields]);

const GET_BYTES = requestBytes(GET_FIELDS);
const CONDITIONAL_BYTES = requestBytes(CONDITIONAL_FIELDS);
const OK_BYTES = headBytes('HTTP/1.1 200 OK', OK_FIELDS) + BODY_BYTES;
const NOT_MODIFIED_BYTES = headBytes('HTTP/1.1 304 Not Modified', NOT_MODIFIED_FIELDS);

const getRequest = () =>
  http1Request({ method: 'GET', path: PATH, host: HOST.www, headers: GET_FIELDS });
const conditionalRequest = () =>
  http1Request({ method: 'GET', path: PATH, host: HOST.www, headers: CONDITIONAL_FIELDS });
const okResponse = () => http1Response({ status: 200, headers: OK_FIELDS });
const notModifiedResponse = () => http1Response({ status: 304, headers: NOT_MODIFIED_FIELDS });

/** TLS 1.3 record overhead on application data: 5-byte header, 1-byte inner type, 16-byte tag. */
const TLS_OVERHEAD = 22;
const sealed = (plainBytes: number) => plainBytes + TLS_OVERHEAD;

// ---------------------------------------------------------------------------
// TCP plumbing
// ---------------------------------------------------------------------------

/** Tracks the next sequence number of one direction of a connection. */
function stream(start: number) {
  let next = start;

  return {
    take(length: number): number {
      const seq = next;
      next += length;

      return seq;
    },
    peek(): number {
      return next;
    },
  };
}

// Placeholder frame for the server side: the real next hop and its MAC address are not modelled.
const MAC_INTERNET_GATEWAY = MAC.spare[3];

interface Connection {
  conn: string;
  clientPort: number;
  serverPort: number;
}

const PLAIN: Connection = { conn: 'http-plain', clientPort: 51236, serverPort: PORT.http };
const SECURE: Connection = { conn: 'https', clientPort: 58012, serverPort: PORT.https };

type Direction = 'up' | 'down';

interface SegmentInput {
  connection: Connection;
  direction: Direction;
  seq: number;
  ack: number;
  len: number;
  ipId: number;
  flags?: TcpFlag[];
  resync?: boolean;
}

interface Segment {
  headers: HeaderGroup[];
  meta: PacketMeta;
  sizeBytes: number;
}

/**
 * Ethernet, IPv4 and TCP for one data segment, as captured at the sender. Upstream segments leave
 * the laptop with its private address; downstream segments are addressed to the café router’s
 * public address, because that is the only address the server ever sees (NAT).
 */
function segment(s: SegmentInput): Segment {
  const up = s.direction === 'up';
  const header = tcp({
    conn: s.connection.conn,
    srcPort: up ? s.connection.clientPort : s.connection.serverPort,
    dstPort: up ? s.connection.serverPort : s.connection.clientPort,
    seq: s.seq,
    ack: s.ack,
    flags: s.flags ?? ['PSH', 'ACK'],
    len: s.len,
    window: up ? 502 : 509,
    resync: s.resync,
  });
  // 20-byte IPv4 header + 20-byte TCP header + 12 bytes of timestamp options.
  const ip = ipv4({
    src: up ? IP.laptop : IP.cdnEdge,
    dst: up ? IP.cdnEdge : IP.routerPublic,
    ttl: 64,
    id: s.ipId,
    df: true,
    protocol: 'TCP',
    totalLength: 52 + s.len,
  });

  return {
    headers: [
      ethernet({
        src: up ? MAC.laptop : MAC.cdnEdge,
        dst: up ? MAC.routerLan : MAC_INTERNET_GATEWAY,
        etherType: 'IPv4',
      }),
      ip.group,
      header.group,
    ],
    meta: { ipv4: ip.meta, tcp: header.meta },
    sizeBytes: 66 + s.len,
  };
}

// ---------------------------------------------------------------------------
// Plain HTTP connection (port 80), ISNs from the shared plan
// ---------------------------------------------------------------------------

const plainClient = stream(ISN.client + 1); // the SYN used one number
const plainServer = stream(ISN.server + 1);

const syn = tcp(
  {
    conn: PLAIN.conn,
    srcPort: PLAIN.clientPort,
    dstPort: PLAIN.serverPort,
    seq: ISN.client,
    flags: ['SYN'],
    len: 0,
    window: 64240,
  },
  { options: tcpSynOptions({ windowScale: 7 }) },
);
const synAck = tcp(
  {
    conn: PLAIN.conn,
    srcPort: PLAIN.serverPort,
    dstPort: PLAIN.clientPort,
    seq: ISN.server,
    ack: ISN.client + 1,
    flags: ['SYN', 'ACK'],
    len: 0,
    window: 65160,
  },
  { options: tcpSynOptions({ windowScale: 7 }) },
);
const handshakeAck = tcp({
  conn: PLAIN.conn,
  srcPort: PLAIN.clientPort,
  dstPort: PLAIN.serverPort,
  seq: ISN.client + 1,
  ack: ISN.server + 1,
  flags: ['ACK'],
  len: 0,
  window: 502,
});

const synIp = ipv4({
  src: IP.laptop,
  dst: IP.cdnEdge,
  ttl: 64,
  id: 0x1c46,
  df: true,
  protocol: 'TCP',
  totalLength: 60,
});
const synAckIp = ipv4({
  src: IP.cdnEdge,
  dst: IP.routerPublic,
  ttl: 64,
  id: 0x0000,
  df: true,
  protocol: 'TCP',
  totalLength: 60,
});
const handshakeAckIp = ipv4({
  src: IP.laptop,
  dst: IP.cdnEdge,
  ttl: 64,
  id: 0x1c47,
  df: true,
  protocol: 'TCP',
  totalLength: 52,
});

// The request/response pairs. Evaluation order matters: `seq` takes from the sender's stream and
// `ack` peeks at the peer's, so each segment is built in the order it is sent.
const getSegment = segment({
  connection: PLAIN,
  direction: 'up',
  seq: plainClient.take(GET_BYTES),
  ack: plainServer.peek(),
  len: GET_BYTES,
  ipId: 0x1c48,
});
const okSegment = segment({
  connection: PLAIN,
  direction: 'down',
  seq: plainServer.take(OK_BYTES),
  ack: plainClient.peek(),
  len: OK_BYTES,
  ipId: 0x5b02,
});
const conditionalSegment = segment({
  connection: PLAIN,
  direction: 'up',
  seq: plainClient.take(CONDITIONAL_BYTES),
  ack: plainServer.peek(),
  len: CONDITIONAL_BYTES,
  ipId: 0x1c9d,
});
const notModifiedSegment = segment({
  connection: PLAIN,
  direction: 'down',
  seq: plainServer.take(NOT_MODIFIED_BYTES),
  ack: plainClient.peek(),
  len: NOT_MODIFIED_BYTES,
  ipId: 0x5b3f,
});

// ---------------------------------------------------------------------------
// HTTPS connection (port 443): a second connection whose handshake is not drawn
// ---------------------------------------------------------------------------

const TLS_CLIENT_ISN = 2749110036;
const TLS_SERVER_ISN = 912660750;

// TLS 1.3 record sizes on the wire (see the `tls` scenario for how they add up).
const CLIENT_HELLO_RECORD = 215;
const SERVER_HELLO_AND_CCS = 127 + 6;
const SERVER_FLIGHT_RECORD = 1201; // EncryptedExtensions, Certificate, CertificateVerify, Finished
const CLIENT_CCS_AND_FINISHED = 6 + 58;

const secureClient = stream(TLS_CLIENT_ISN + 1);
const secureServer = stream(TLS_SERVER_ISN + 1);

const clientHelloSegment = segment({
  connection: SECURE,
  direction: 'up',
  seq: secureClient.take(CLIENT_HELLO_RECORD),
  ack: secureServer.peek(),
  len: CLIENT_HELLO_RECORD,
  ipId: 0x6e11,
  resync: true,
});
const serverHelloSegment = segment({
  connection: SECURE,
  direction: 'down',
  seq: secureServer.take(SERVER_HELLO_AND_CCS),
  ack: secureClient.peek(),
  len: SERVER_HELLO_AND_CCS,
  ipId: 0x7a20,
  resync: true,
});
const serverFlightSegment = segment({
  connection: SECURE,
  direction: 'down',
  seq: secureServer.take(SERVER_FLIGHT_RECORD),
  ack: secureClient.peek(),
  len: SERVER_FLIGHT_RECORD,
  ipId: 0x7a21,
});
const clientFinishedSegment = segment({
  connection: SECURE,
  direction: 'up',
  seq: secureClient.take(CLIENT_CCS_AND_FINISHED),
  ack: secureServer.peek(),
  len: CLIENT_CCS_AND_FINISHED,
  ipId: 0x6e12,
});
const secureGetSegment = segment({
  connection: SECURE,
  direction: 'up',
  seq: secureClient.take(sealed(GET_BYTES)),
  ack: secureServer.peek(),
  len: sealed(GET_BYTES),
  ipId: 0x6e13,
});
const secureOkSegment = segment({
  connection: SECURE,
  direction: 'down',
  seq: secureServer.take(sealed(OK_BYTES)),
  ack: secureClient.peek(),
  len: sealed(OK_BYTES),
  ipId: 0x7a22,
});
const secureConditionalSegment = segment({
  connection: SECURE,
  direction: 'up',
  seq: secureClient.take(sealed(CONDITIONAL_BYTES)),
  ack: secureServer.peek(),
  len: sealed(CONDITIONAL_BYTES),
  ipId: 0x6e9a,
});
const secureNotModifiedSegment = segment({
  connection: SECURE,
  direction: 'down',
  seq: secureServer.take(sealed(NOT_MODIFIED_BYTES)),
  ack: secureClient.peek(),
  len: sealed(NOT_MODIFIED_BYTES),
  ipId: 0x7a5c,
});

const CLIENT_HELLO_FIELDS: HeaderField[] = [
  { name: 'legacy_version', value: '0x0303' },
  { name: 'random', value: '32 random bytes' },
  { name: 'legacy_session_id', value: '32 bytes', note: 'compatibility value' },
  {
    name: 'cipher_suites',
    value: 'TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256',
  },
  { name: 'legacy_compression_methods', value: '0 (null)' },
  { name: 'supported_versions', value: '0x0304 (TLS 1.3), 0x0303 (TLS 1.2)' },
  { name: 'supported_groups', value: 'x25519, secp256r1' },
  {
    name: 'signature_algorithms',
    value:
      'ecdsa_secp256r1_sha256, rsa_pss_rsae_sha256, rsa_pkcs1_sha256, ecdsa_secp384r1_sha384, rsa_pss_rsae_sha384, ed25519',
  },
  { name: 'key_share', value: 'x25519, 32-byte public value' },
  { name: 'psk_key_exchange_modes', value: 'psk_dhe_ke' },
  {
    name: 'server_name',
    value: HOST.www,
    note: 'SNI: sent in clear text, so an eavesdropper reads the site name',
  },
  { name: 'alpn', value: 'h2, http/1.1' },
];

/** What the endpoints see inside an encrypted record, and what the wire shows instead. */
const sealedRecord = (plainBytes: number): HeaderGroup =>
  tlsHandshake({
    message: 'ApplicationData',
    fields: [
      {
        name: 'Encrypted Application Data',
        value: `${sealed(plainBytes)} bytes`,
        note: `${plainBytes} bytes of HTTP + 1 byte inner type + 16-byte tag: unreadable on the wire`,
      },
    ],
  });

// ---------------------------------------------------------------------------
// Scenario
// ---------------------------------------------------------------------------

const OBSERVER_HINT =
  'The eavesdropper is a passive device on the same Wi-Fi network; it overhears frames and sends nothing, so it has local actions but no packets.';

export default defineScenario({
  id: 'http',
  title: 'HTTP and HTTPS',
  tagline: 'The same request in plain text and inside TLS, and what an eavesdropper sees.',
  category: 'web',
  order: 1,
  protocols: ['ethernet', 'ipv4', 'tcp', 'http', 'tls'],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'Your laptop',
      sublabel: IP.laptop,
      position: { col: 0, row: 2 },
      zone: 'cafe',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop },
    },
    {
      id: 'ap',
      kind: 'router',
      label: 'Café router',
      sublabel: IP.routerLan,
      position: { col: 2.5, row: 2 },
      zone: 'cafe',
      addresses: { ipv4: IP.routerLan, mac: MAC.routerLan },
    },
    {
      id: 'observer',
      kind: 'observer',
      label: 'Eavesdropper',
      sublabel: 'same café Wi-Fi',
      position: { col: 3, row: -0.5 },
      zone: 'cafe',
      addresses: { mac: MAC.otherLaptop },
    },
    {
      id: 'server',
      kind: 'server',
      label: 'Web server',
      sublabel: IP.cdnEdge,
      position: { col: 6.25, row: 2 },
      zone: 'web',
      addresses: { ipv4: IP.cdnEdge, mac: MAC.cdnEdge, hostname: HOST.www },
    },
  ],
  links: [
    { id: 'laptop-ap', a: 'laptop', b: 'ap', medium: 'wifi' },
    { id: 'observer-ap', a: 'observer', b: 'ap', medium: 'wifi', label: 'overhears' },
    { id: 'ap-server', a: 'ap', b: 'server', medium: 'wan' },
  ],
  zones: [
    {
      id: 'cafe',
      label: 'Café Wi-Fi',
      from: { col: -0.75, row: -1.25 },
      to: { col: 3.75, row: 3.5 },
      tone: 'lan',
    },
    {
      id: 'web',
      label: 'Web host',
      from: { col: 4.75, row: 0.5 },
      to: { col: 7.75, row: 3.5 },
      tone: 'datacenter',
    },
  ],
  phases: [
    { id: 'plain', label: 'Plain HTTP' },
    { id: 'secure', label: 'HTTPS' },
  ],
  sequenceLanes: ['laptop', 'server', 'observer'],
  steps: [
    {
      id: 'tcp-handshake',
      title: 'TCP handshake to port 80',
      phase: 'plain',
      summary:
        'Before any HTTP, the laptop opens a TCP connection to port 80 with SYN, SYN-ACK, ACK. An eavesdropper on the Wi-Fi already sees both IP addresses and both ports.',
      body: [
        {
          type: 'p',
          text: 'HTTP runs on TCP, so a connection comes first. The laptop sends a SYN from an ephemeral port to port 80, the server answers SYN-ACK, and the laptop completes the handshake with an ACK. Each SYN consumes one sequence number, so the first data byte of each side is its initial sequence number plus one.',
        },
        {
          type: 'p',
          text: 'Nothing here is protected. Anyone who can capture frames reads the source and destination addresses and the ports, and port 80 announces “plain web traffic”.',
        },
        {
          type: 'callout',
          tone: 'warning',
          text: 'On an open or shared-password network, other devices can capture the radio traffic. That is the threat model for the rest of this scenario.',
        },
      ],
      packets: [
        {
          id: 'p-syn',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'tcp',
          label: 'SYN',
          summary: `${PLAIN.clientPort} → 80 [SYN] Seq=${ISN.client} Win=64240`,
          headers: [
            ethernet({ src: MAC.laptop, dst: MAC.routerLan, etherType: 'IPv4' }),
            synIp.group,
            syn.group,
          ],
          sizeBytes: 74,
          at: 0,
          wireTimeMs: 0,
          meta: { ipv4: synIp.meta, tcp: syn.meta },
        },
        {
          id: 'p-syn-ack',
          from: 'server',
          to: 'laptop',
          via: ['ap'],
          protocol: 'tcp',
          label: 'SYN-ACK',
          summary: `80 → ${PLAIN.clientPort} [SYN, ACK] Seq=${ISN.server} Ack=${ISN.client + 1}`,
          headers: [
            ethernet({ src: MAC.cdnEdge, dst: MAC_INTERNET_GATEWAY, etherType: 'IPv4' }),
            synAckIp.group,
            synAck.group,
          ],
          sizeBytes: 74,
          at: 1700,
          wireTimeMs: 7.1,
          meta: { ipv4: synAckIp.meta, tcp: synAck.meta },
        },
        {
          id: 'p-handshake-ack',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'tcp',
          label: 'ACK',
          summary: `${PLAIN.clientPort} → 80 [ACK] Seq=${ISN.client + 1} Ack=${ISN.server + 1}`,
          headers: [
            ethernet({ src: MAC.laptop, dst: MAC.routerLan, etherType: 'IPv4' }),
            handshakeAckIp.group,
            handshakeAck.group,
          ],
          sizeBytes: 66,
          at: 3400,
          wireTimeMs: 14.2,
          meta: { ipv4: handshakeAckIp.meta, tcp: handshakeAck.meta },
        },
      ],
      actions: [
        {
          id: 'a-obs-handshake',
          node: 'observer',
          kind: 'process',
          label: 'Sees IPs and ports',
          at: 550,
          durationMs: 900,
        },
      ],
      focus: ['laptop', 'server', 'observer'],
      simplifications: [
        OBSERVER_HINT,
        'The café router’s NAT rewrites the source address to its public address; each header is shown as its sender emitted it, so replies are addressed to `198.51.100.7`.',
        'Link-layer Wi-Fi encryption is not modelled; the eavesdropper is assumed to read the frames.',
        'Ethernet addresses on the server side are placeholders; every real hop rewrites them.',
      ],
      references: [
        {
          label: 'RFC 9293, section 3.5: establishing a connection',
          url: 'https://www.rfc-editor.org/rfc/rfc9293#section-3.5',
        },
        {
          label: 'RFC 9112, section 2.1: message format',
          url: 'https://www.rfc-editor.org/rfc/rfc9112#section-2.1',
        },
      ],
    },
    {
      id: 'get',
      title: 'HTTP/1.1 GET with a Host header',
      phase: 'plain',
      summary:
        'The browser sends `GET /account/orders` with `Host: www.example.com` and a session cookie as readable text. Anyone capturing the Wi-Fi reads every byte.',
      body: [
        {
          type: 'p',
          text: 'An HTTP/1.1 request is text: a request line, header fields, then an empty line. `Host` is mandatory in HTTP/1.1 because one IP address may serve many sites, and the server uses it to choose the right one. The request fits in one TCP segment with PSH and ACK set, and its sequence number continues straight after the handshake.',
        },
        {
          type: 'p',
          text: 'The eavesdropper reads the path, the language preference and the `Cookie` header, which holds the session token. With that token another device could act as the user on this site until the session ends.',
        },
        {
          type: 'p',
          text: 'HTTP/1.1 connections are persistent by default, so the same connection can carry further requests.',
        },
      ],
      packets: [
        {
          id: 'p-get',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'http',
          label: 'GET /account/…',
          summary: `GET ${PATH} HTTP/1.1`,
          headers: [...getSegment.headers, getRequest()],
          sizeBytes: getSegment.sizeBytes,
          at: 0,
          wireTimeMs: 14.6,
          meta: getSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-get',
          node: 'observer',
          kind: 'process',
          label: 'Reads path and cookie',
          at: 550,
          durationMs: 1000,
        },
      ],
      focus: ['laptop', 'observer'],
      simplifications: [
        'Pure ACK segments are left out; the server’s response acknowledges the request instead.',
        'The cookie value and user-agent string are made up.',
      ],
      references: [
        {
          label: 'RFC 9110, section 7.2: Host and :authority',
          url: 'https://www.rfc-editor.org/rfc/rfc9110#section-7.2',
        },
        {
          label: 'RFC 9112, section 9.3: persistence',
          url: 'https://www.rfc-editor.org/rfc/rfc9112#section-9.3',
        },
        {
          label: 'RFC 6265, section 4.2: the Cookie header',
          url: 'https://www.rfc-editor.org/rfc/rfc6265#section-4.2',
        },
      ],
    },
    {
      id: 'ok',
      title: '200 OK with an ETag validator',
      phase: 'plain',
      summary:
        'The server returns the page: `200 OK`, an HTML body, an `ETag` naming this version, and `Cache-Control: private, no-cache`. Every byte is readable on the wire.',
      body: [
        {
          type: 'p',
          text: `The response is a status line, headers, an empty line and then the body: ${BODY_BYTES} bytes of HTML, matching \`Content-Length\`. The \`ETag\` is a validator, an opaque label for this exact version of the page.`,
        },
        {
          type: 'p',
          text: '`Cache-Control: private, no-cache` has two effects. `private` keeps shared caches from storing a page meant for one user. `no-cache` lets the browser keep a copy but requires it to revalidate before reuse.',
        },
        {
          type: 'p',
          text: 'The segment’s acknowledgment number already covers the request, so no separate ACK is needed. The eavesdropper now reads the page too.',
        },
      ],
      packets: [
        {
          id: 'p-ok',
          from: 'server',
          to: 'laptop',
          via: ['ap'],
          protocol: 'http',
          label: '200 OK',
          summary: `HTTP/1.1 200 OK (text/html, ${BODY_BYTES} bytes)`,
          headers: [...okSegment.headers, okResponse()],
          payload: `<!doctype html> … your orders … (${BODY_BYTES}-byte HTML body)`,
          sizeBytes: okSegment.sizeBytes,
          at: 0,
          wireTimeMs: 22.4,
          meta: okSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-ok',
          node: 'observer',
          kind: 'process',
          label: 'Reads status · ETag · page',
          at: 1050,
          durationMs: 1000,
        },
      ],
      focus: ['server', 'observer'],
      simplifications: [
        'The page is a single TCP segment; a larger page would span several, each acknowledged.',
        'Pure ACK segments are left out.',
      ],
      references: [
        {
          label: 'RFC 9110, section 8.8.3: ETag',
          url: 'https://www.rfc-editor.org/rfc/rfc9110#section-8.8.3',
        },
        {
          label: 'RFC 9111, section 5.2.2: response Cache-Control directives',
          url: 'https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2',
        },
      ],
    },
    {
      id: 'conditional-get',
      title: 'Conditional GET with If-None-Match',
      phase: 'plain',
      summary:
        'On a later reload the browser repeats the request and adds `If-None-Match: "a91c4e"`, which means: send the page only if it has changed.',
      body: [
        {
          type: 'p',
          text: 'The browser holds a stored copy, but `no-cache` says it must check before using it. So it repeats the request and adds `If-None-Match` with the stored ETag. That makes it a **conditional request**: the server should send the page only if its current ETag differs.',
        },
        {
          type: 'p',
          text: 'The connection is still open, so the sequence number simply continues where the previous request ended. Revalidation costs one round trip but can save the whole body.',
        },
      ],
      packets: [
        {
          id: 'p-conditional-get',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'http',
          label: 'GET If-None-Match',
          summary: `GET ${PATH} HTTP/1.1 (If-None-Match: ${ETAG})`,
          headers: [...conditionalSegment.headers, conditionalRequest()],
          sizeBytes: conditionalSegment.sizeBytes,
          at: 0,
          wireTimeMs: 4812,
          meta: conditionalSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-conditional',
          node: 'observer',
          kind: 'process',
          label: 'Reads the ETag again',
          at: 550,
          durationMs: 1000,
        },
      ],
      focus: ['laptop', 'observer'],
      simplifications: [
        'The time between the two requests is skipped on the animation clock; the packet table shows the real gap.',
        'Pure ACK segments are left out.',
      ],
      references: [
        {
          label: 'RFC 9110, section 13.1.2: If-None-Match',
          url: 'https://www.rfc-editor.org/rfc/rfc9110#section-13.1.2',
        },
        {
          label: 'RFC 9111, section 4.3: validation',
          url: 'https://www.rfc-editor.org/rfc/rfc9111#section-4.3',
        },
      ],
    },
    {
      id: 'not-modified',
      title: '304 Not Modified: headers only',
      phase: 'plain',
      summary:
        'The ETag still matches, so the server answers `304 Not Modified` with no body. The browser reuses its stored copy.',
      body: [
        {
          type: 'p',
          text: `A 304 response carries headers but never a body. The server repeats the validator and cache policy, and the browser keeps using the stored page. Here the reply is ${NOT_MODIFIED_BYTES} bytes instead of ${OK_BYTES}.`,
        },
        {
          type: 'p',
          text: 'In plaintext HTTP the eavesdropper sees all of this, the status code included. The next steps show the same exchange over HTTPS, where almost all of it disappears.',
        },
      ],
      packets: [
        {
          id: 'p-not-modified',
          from: 'server',
          to: 'laptop',
          via: ['ap'],
          protocol: 'http',
          label: '304 Not Modified',
          summary: 'HTTP/1.1 304 Not Modified',
          headers: [...notModifiedSegment.headers, notModifiedResponse()],
          sizeBytes: notModifiedSegment.sizeBytes,
          at: 0,
          wireTimeMs: 4819.5,
          meta: notModifiedSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-304',
          node: 'observer',
          kind: 'process',
          label: 'Reads 304: page unchanged',
          at: 1050,
          durationMs: 1000,
        },
      ],
      focus: ['server', 'laptop'],
      simplifications: ['Pure ACK segments are left out.'],
      references: [
        {
          label: 'RFC 9110, section 15.4.5: 304 Not Modified',
          url: 'https://www.rfc-editor.org/rfc/rfc9110#section-15.4.5',
        },
      ],
    },
    {
      id: 'tls-handshake',
      title: 'HTTPS: TCP and TLS handshake (collapsed)',
      phase: 'secure',
      summary:
        'The same site over HTTPS needs a new connection to port 443 and a TLS 1.3 handshake. The ClientHello is readable, including the server name (SNI); the rest is encrypted.',
      body: [
        {
          type: 'p',
          text: 'HTTPS is HTTP inside TLS on port 443. TLS 1.3 needs one round trip. The ClientHello and ServerHello are plaintext, but ServerHello carries the server’s key share, so everything after it, the certificate included, is encrypted. The client then sends Finished, and application data can follow.',
        },
        {
          type: 'p',
          text: 'The ClientHello names the site in the **SNI** extension and lists its ALPN protocols, and the eavesdropper reads both. Only Encrypted Client Hello (ECH), where deployed, hides the name. The `tls` scenario walks through every message.',
        },
      ],
      packets: [
        {
          id: 'p-client-hello',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'tls',
          label: 'ClientHello',
          summary: `ClientHello (SNI ${HOST.www}, ALPN h2, http/1.1)`,
          headers: [
            ...clientHelloSegment.headers,
            tlsHandshake({ message: 'ClientHello', fields: CLIENT_HELLO_FIELDS }),
          ],
          sizeBytes: clientHelloSegment.sizeBytes,
          at: 0,
          wireTimeMs: 30000,
          meta: clientHelloSegment.meta,
        },
        {
          id: 'p-server-hello',
          from: 'server',
          to: 'laptop',
          via: ['ap'],
          protocol: 'tls',
          label: 'ServerHello',
          summary: 'ServerHello, Change Cipher Spec',
          headers: [
            ...serverHelloSegment.headers,
            tlsHandshake({
              message: 'ServerHello',
              fields: [
                { name: 'cipher_suite', value: 'TLS_AES_128_GCM_SHA256' },
                { name: 'supported_versions', value: '0x0304 (TLS 1.3)' },
                { name: 'key_share', value: 'x25519, 32-byte public value' },
                {
                  name: 'ChangeCipherSpec',
                  value: 'follows in the same segment',
                  note: 'compatibility record, carries no information in TLS 1.3',
                },
              ],
            }),
          ],
          sizeBytes: serverHelloSegment.sizeBytes,
          at: 1700,
          wireTimeMs: 30007.4,
          meta: serverHelloSegment.meta,
        },
        {
          id: 'p-server-flight',
          from: 'server',
          to: 'laptop',
          via: ['ap'],
          protocol: 'tls',
          label: 'Server flight',
          summary:
            'Application Data (EncryptedExtensions, Certificate, CertificateVerify, Finished)',
          headers: [
            ...serverFlightSegment.headers,
            tlsHandshake({
              message: 'EncryptedExtensions',
              fields: [
                {
                  name: 'alpn',
                  value: 'http/1.1',
                  note: 'server picks one of the client’s offers',
                },
                {
                  name: 'Same record also holds',
                  value: 'Certificate, CertificateVerify, Finished',
                  note: 'coalesced; all encrypted with handshake keys',
                },
              ],
            }),
          ],
          payload: 'Encrypted: certificate chain, signature and Finished. Unreadable on the wire.',
          sizeBytes: serverFlightSegment.sizeBytes,
          encrypted: true,
          at: 1850,
          wireTimeMs: 30007.6,
          meta: serverFlightSegment.meta,
        },
        {
          id: 'p-client-finished',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'tls',
          label: 'Finished',
          summary: 'Change Cipher Spec, Application Data (Finished)',
          headers: [
            ...clientFinishedSegment.headers,
            tlsHandshake({
              message: 'Finished',
              fields: [
                {
                  name: 'ChangeCipherSpec',
                  value: 'precedes the record',
                  note: 'compatibility record',
                },
                { name: 'verify_data', value: 'HMAC over the handshake transcript' },
              ],
            }),
          ],
          sizeBytes: clientFinishedSegment.sizeBytes,
          encrypted: true,
          at: 3550,
          wireTimeMs: 30015.5,
          meta: clientFinishedSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-sni',
          node: 'observer',
          kind: 'process',
          label: 'Reads SNI: www.example.com',
          at: 550,
          durationMs: 1000,
        },
        {
          id: 'a-obs-opaque',
          node: 'observer',
          kind: 'process',
          label: 'Certificate: opaque bytes',
          at: 3000,
          durationMs: 900,
        },
      ],
      focus: ['laptop', 'server', 'observer'],
      simplifications: [
        'The TCP handshake to port 443 works exactly as in step 1 and is not drawn; these segments carry the sequence numbers that follow it.',
        'A real ClientHello from a browser carries more extensions (and is larger). The server’s four encrypted messages are shown as one record; NewSessionTicket messages are left out.',
        'Pure ACK segments are left out.',
      ],
      references: [
        {
          label: 'RFC 8446, section 2: protocol overview (1-RTT handshake)',
          url: 'https://www.rfc-editor.org/rfc/rfc8446#section-2',
        },
        {
          label: 'RFC 6066, section 3: Server Name Indication',
          url: 'https://www.rfc-editor.org/rfc/rfc6066#section-3',
        },
        { label: 'RFC 7301: ALPN', url: 'https://www.rfc-editor.org/rfc/rfc7301' },
      ],
    },
    {
      id: 'secure-get',
      title: 'The same GET, now inside TLS',
      phase: 'secure',
      summary:
        'The identical request travels as an encrypted application-data record. The path, headers and cookie are hidden; only addresses, ports, size and timing remain visible.',
      body: [
        {
          type: 'p',
          text: `The browser writes the same ${GET_BYTES} bytes as in step 2. TLS wraps them in a record: a 5-byte header, the encrypted content with its hidden inner content type, and a 16-byte authentication tag. The segment grows to ${sealed(GET_BYTES)} bytes of payload.`,
        },
        {
          type: 'p',
          text: 'The eavesdropper can still see the IP addresses, the ports, the SNI from the handshake, the timing and the size. It cannot see the method, path, headers, cookie or body. The server picked `http/1.1` through ALPN, so the plaintext bytes match; browsers commonly use h2 instead, which changes the framing but not what is hidden.',
        },
      ],
      packets: [
        {
          id: 'p-secure-get',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'http',
          label: 'GET (encrypted)',
          summary: `Application Data, ${sealed(GET_BYTES)} bytes (HTTP request inside TLS)`,
          headers: [...secureGetSegment.headers, sealedRecord(GET_BYTES), getRequest()],
          payload: `On the wire: TLS record header + ${sealed(GET_BYTES) - 5} bytes of ciphertext.`,
          sizeBytes: secureGetSegment.sizeBytes,
          encrypted: true,
          at: 0,
          wireTimeMs: 30015.8,
          meta: secureGetSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-secure-get',
          node: 'observer',
          kind: 'process',
          label: 'Sees only size and timing',
          at: 550,
          durationMs: 1000,
        },
      ],
      focus: ['laptop', 'observer'],
      simplifications: [
        'The headers listed for this packet are what the endpoints see after decryption; the capture on the Wi-Fi shows only the TLS record.',
        'Pure ACK segments are left out.',
      ],
      references: [
        {
          label: 'RFC 8446, section 5.2: record payload protection',
          url: 'https://www.rfc-editor.org/rfc/rfc8446#section-5.2',
        },
        {
          label: 'RFC 9110, section 4.2.2: https URI scheme',
          url: 'https://www.rfc-editor.org/rfc/rfc9110#section-4.2.2',
        },
      ],
    },
    {
      id: 'secure-ok',
      title: 'The 200 response, encrypted',
      phase: 'secure',
      summary:
        'The reply is wrapped the same way. The eavesdropper sees that a response of about the same size arrived, but not the status, the headers or the HTML.',
      body: [
        {
          type: 'p',
          text: `The 200 response, its headers and its ${BODY_BYTES}-byte body all sit inside one encrypted record. The status code, the \`ETag\` and the \`Cache-Control\` policy are hidden, and so are any \`Set-Cookie\` headers a response might carry.`,
        },
        {
          type: 'p',
          text: 'Size is not hidden. An observer who knows the site can often guess which page was fetched from the response length and the pattern of requests. Padding and traffic shaping can blur this, but plain HTTPS does not.',
        },
      ],
      packets: [
        {
          id: 'p-secure-ok',
          from: 'server',
          to: 'laptop',
          via: ['ap'],
          protocol: 'http',
          label: '200 (encrypted)',
          summary: `Application Data, ${sealed(OK_BYTES)} bytes (HTTP response inside TLS)`,
          headers: [...secureOkSegment.headers, sealedRecord(OK_BYTES), okResponse()],
          payload: `On the wire: TLS record header + ${sealed(OK_BYTES) - 5} bytes of ciphertext.`,
          sizeBytes: secureOkSegment.sizeBytes,
          encrypted: true,
          at: 0,
          wireTimeMs: 30023.4,
          meta: secureOkSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-secure-ok',
          node: 'observer',
          kind: 'process',
          label: 'Sees a reply of this size',
          at: 1050,
          durationMs: 1000,
        },
      ],
      focus: ['server', 'observer'],
      simplifications: [
        'The headers listed for this packet are what the endpoints see after decryption.',
        'Pure ACK segments are left out.',
      ],
      references: [
        {
          label: 'RFC 8446, section 5.4: record padding',
          url: 'https://www.rfc-editor.org/rfc/rfc8446#section-5.4',
        },
        {
          label: 'RFC 9110, section 15.3.1: 200 OK',
          url: 'https://www.rfc-editor.org/rfc/rfc9110#section-15.3.1',
        },
      ],
    },
    {
      id: 'secure-conditional',
      title: 'Conditional GET and 304 over TLS',
      phase: 'secure',
      summary:
        'Revalidation also travels inside TLS. `If-None-Match` and the 304 status are hidden, but a small reply to a request hints that nothing changed.',
      body: [
        {
          type: 'p',
          text: 'The conditional request and its `304` answer are sealed like the others, on the same connection and with continuing sequence numbers. The observer cannot read the ETag or the status code.',
        },
        {
          type: 'p',
          text: `It can still compare sizes: this reply carries ${sealed(NOT_MODIFIED_BYTES)} bytes of payload where the earlier one carried ${sealed(OK_BYTES)}. Lengths and timing form a side channel that HTTPS does not close.`,
        },
      ],
      packets: [
        {
          id: 'p-secure-conditional-get',
          from: 'laptop',
          to: 'server',
          via: ['ap'],
          protocol: 'http',
          label: 'GET (encrypted)',
          summary: `Application Data, ${sealed(CONDITIONAL_BYTES)} bytes (conditional GET inside TLS)`,
          headers: [
            ...secureConditionalSegment.headers,
            sealedRecord(CONDITIONAL_BYTES),
            conditionalRequest(),
          ],
          payload: `On the wire: TLS record header + ${sealed(CONDITIONAL_BYTES) - 5} bytes of ciphertext.`,
          sizeBytes: secureConditionalSegment.sizeBytes,
          encrypted: true,
          at: 0,
          wireTimeMs: 61200,
          meta: secureConditionalSegment.meta,
        },
        {
          id: 'p-secure-not-modified',
          from: 'server',
          to: 'laptop',
          via: ['ap'],
          protocol: 'http',
          label: '304 (encrypted)',
          summary: `Application Data, ${sealed(NOT_MODIFIED_BYTES)} bytes (304 inside TLS)`,
          headers: [
            ...secureNotModifiedSegment.headers,
            sealedRecord(NOT_MODIFIED_BYTES),
            notModifiedResponse(),
          ],
          payload: `On the wire: TLS record header + ${sealed(NOT_MODIFIED_BYTES) - 5} bytes of ciphertext.`,
          sizeBytes: secureNotModifiedSegment.sizeBytes,
          encrypted: true,
          at: 2000,
          wireTimeMs: 61207.5,
          meta: secureNotModifiedSegment.meta,
        },
      ],
      actions: [
        {
          id: 'a-obs-secure-304',
          node: 'observer',
          kind: 'process',
          label: 'Sees a small reply',
          at: 3050,
          durationMs: 900,
        },
      ],
      focus: ['laptop', 'server', 'observer'],
      simplifications: [
        'The time between the exchanges is skipped on the animation clock; the packet table shows the real gap.',
        'Pure ACK segments are left out.',
      ],
      references: [
        {
          label: 'RFC 9110, section 13.1.2: If-None-Match',
          url: 'https://www.rfc-editor.org/rfc/rfc9110#section-13.1.2',
        },
        {
          label: 'RFC 8446, section 5.2: record payload protection',
          url: 'https://www.rfc-editor.org/rfc/rfc8446#section-5.2',
        },
      ],
    },
    {
      id: 'recap',
      title: 'Recap: what the eavesdropper can see',
      phase: 'secure',
      summary:
        'Plain HTTP exposes everything. HTTPS still reveals who talks to whom, the site name, sizes and timing, but hides the path, headers, cookies and body.',
      body: [
        {
          type: 'list',
          items: [
            '**Plain HTTP:** addresses, ports, method, path, all headers, cookies, status, body.',
            '**HTTPS, visible:** addresses, ports, the SNI name (unless ECH is used), TLS parameters, record sizes and timing.',
            '**HTTPS, hidden:** path and query, headers, cookies, status code, body.',
          ],
        },
        {
          type: 'p',
          text: 'TLS also detects tampering: a device that alters a record makes the authentication tag fail. Cookies marked `Secure` are never sent over plain HTTP, which closes the hijacking route shown in step 2.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'HTTPS protects the content of the conversation, not the fact of it. The DNS lookup before it is a separate exchange with its own exposure.',
        },
      ],
      packets: [],
      actions: [
        {
          id: 'a-obs-summary',
          node: 'observer',
          kind: 'process',
          label: 'Knows who · when · how much',
          at: 0,
          durationMs: 1500,
        },
      ],
      focus: ['observer'],
      references: [
        {
          label: 'RFC 6265, section 4.1.2.5: the Secure attribute',
          url: 'https://www.rfc-editor.org/rfc/rfc6265#section-4.1.2.5',
        },
        {
          label: 'RFC 8446, appendix E.3: traffic analysis',
          url: 'https://www.rfc-editor.org/rfc/rfc8446#appendix-E.3',
        },
      ],
    },
  ],
});
