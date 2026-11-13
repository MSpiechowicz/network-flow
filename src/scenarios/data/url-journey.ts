import { defineScenario } from '../../model/types';
import type {
  ContentBlock,
  HeaderGroup,
  PacketMeta,
  Reference,
  StepDef,
  TcpMeta,
} from '../../model/types';
import { ADDRESS_ALLOWLIST, HOST, IP, ISN, MAC, REAL_INFRA, mac } from '../lib/addresses';
import {
  dns,
  ethernet,
  http1Request,
  http1Response,
  http2Request,
  http2Response,
  ipv4,
  tcp,
  tcpSynOptions,
  tlsHandshake,
  udp,
} from '../lib/builders';

/**
 * The flagship journey: typing `www.example.com` and ending with a rendered page.
 *
 * Capture conventions used throughout:
 * - Headers are shown as captured at the sender (initial TTL, private source address).
 * - `wireTimeMs` is the moment the sender emits the packet, in simulated milliseconds.
 * - Pure ACKs on the laptop-to-edge connection are left out and flagged in `simplifications`;
 *   sequence numbers count only the bytes that are shown.
 */

// ---------------------------------------------------------------------------
// Local helpers (content authoring only)
// ---------------------------------------------------------------------------

const ETHERNET_HEADER = 14;
const IPV4_HEADER = 20;
const UDP_HEADER = 8;
/** TCP header with the timestamps option, as on every non-SYN segment: 20 + 12 bytes. */
const TCP_HEADER = 32;
/** TCP header on SYN and SYN-ACK: 20 bytes plus MSS, SACK permitted, timestamps, window scale. */
const TCP_SYN_HEADER = 40;

const para = (text: string): ContentBlock => ({ type: 'p', text });
const note = (text: string): ContentBlock => ({ type: 'callout', tone: 'note', text });
const tip = (text: string): ContentBlock => ({ type: 'callout', tone: 'tip', text });
const warning = (text: string): ContentBlock => ({ type: 'callout', tone: 'warning', text });

const ref = (label: string, url: string): Reference => ({ label, url });

interface FrameAddresses {
  eth: { src: string; dst: string };
  ip: { src: string; dst: string; ttl: number; id: number; df?: boolean };
}

interface Frame {
  /** Ethernet, IPv4 and transport headers, outermost first. */
  lower: HeaderGroup[];
  meta: PacketMeta;
  sizeBytes: number;
}

/** Ethernet + IPv4 + UDP for a datagram carrying `payloadLen` bytes of application data. */
function udpFrame(
  addresses: FrameAddresses,
  ports: { src: number; dst: number },
  payloadLen: number,
): Frame {
  const totalLength = IPV4_HEADER + UDP_HEADER + payloadLen;
  const ip = ipv4({ ...addresses.ip, protocol: 'UDP', totalLength });

  return {
    lower: [
      ethernet({ ...addresses.eth, etherType: 'IPv4' }),
      ip.group,
      udp({ srcPort: ports.src, dstPort: ports.dst, length: UDP_HEADER + payloadLen }),
    ],
    meta: { ipv4: ip.meta },
    sizeBytes: ETHERNET_HEADER + totalLength,
  };
}

interface TcpFrameOptions {
  /** SYN or SYN-ACK: adds the four handshake options and the longer header. */
  handshake?: boolean;
  /** When false the segment shows TCP headers but carries no `meta.tcp` (mid-connection, not checked). */
  tracked?: boolean;
}

/** Ethernet + IPv4 + TCP for one segment. */
function tcpFrame(
  addresses: FrameAddresses,
  segment: TcpMeta,
  options: TcpFrameOptions = {},
): Frame {
  const handshake = options.handshake === true;
  const headerLength = handshake ? TCP_SYN_HEADER : TCP_HEADER;
  const totalLength = IPV4_HEADER + headerLength + segment.len;
  const ip = ipv4({ ...addresses.ip, protocol: 'TCP', totalLength });
  const seg = tcp(segment, handshake ? { options: tcpSynOptions() } : {});
  const tracked = options.tracked !== false;

  return {
    lower: [ethernet({ ...addresses.eth, etherType: 'IPv4' }), ip.group, seg.group],
    meta: tracked ? { ipv4: ip.meta, tcp: seg.meta } : { ipv4: ip.meta },
    sizeBytes: ETHERNET_HEADER + totalLength,
  };
}

/** The TLS record wrapper around encrypted application data (one record per segment here). */
function tlsAppData(tcpPayloadLen: number): HeaderGroup {
  return tlsHandshake({
    message: 'ApplicationData',
    fields: [
      {
        name: 'Record Length',
        value: String(tcpPayloadLen - 5),
        note: 'ciphertext plus the 16-byte authentication tag',
      },
    ],
  });
}

// ---------------------------------------------------------------------------
// Addresses, ports and connection state
// ---------------------------------------------------------------------------

/**
 * MACs of remote hosts and of their first-hop routers: synthetic documentation-range addresses
 * (RFC 7042). `*Nic` is the host's own interface, `*Gw` the router it sends frames to.
 */
const REMOTE_MAC = {
  rootNic: mac(0x50),
  rootGw: mac(0x51),
  tldNic: mac(0x52),
  tldGw: mac(0x53),
  authNic: mac(0x54),
  authGw: mac(0x55),
  edgeGw: mac(0x56),
  apiNic: mac(0x57),
  apiGw: mac(0x58),
} as const;

/** Ephemeral client ports (RFC 6335 range 49152-65535), one per socket. */
const PORT_OF = {
  stubDns: 53998,
  rootQuery: 49321,
  tldQuery: 58012,
  authQuery: 55120,
  web: 51234,
  api: 60771,
  edgeToOrigin: 52816,
} as const;

const HTTPS = 443;
const DNS_PORT = 53;

/** Laptop-to-edge connection: absolute sequence numbers from the shared ISNs. */
const CONN = 'laptop-edge';
const C = ISN.client;
const S = ISN.server;

/** TCP payload sizes on the laptop-to-edge connection (record or frame bytes shown). */
const LEN = {
  clientHello: 217,
  serverHello: 133, // ServerHello record 127 + ChangeCipherSpec record 6
  serverFlight1: 1448, // full segment: 1460 MSS minus 12 bytes of timestamps; EncryptedExtensions 37 + first 1411 bytes of the 1930-byte Certificate record
  serverFlight2: 679, // last 519 bytes of Certificate + CertificateVerify 102 + Finished 58
  clientFinished: 64, // ChangeCipherSpec 6 + Finished 58
  getIndex: 191,
  indexResponse: 1234,
  getCss: 71,
  cssResponse: 1180,
} as const;

/** Next sequence numbers, written out so the arithmetic is visible. */
const SEQ = {
  // client -> server
  clientHello: C + 1,
  clientFinished: C + 1 + LEN.clientHello, // C + 218
  getIndex: C + 1 + LEN.clientHello + LEN.clientFinished, // C + 282
  getCss: C + 1 + LEN.clientHello + LEN.clientFinished + LEN.getIndex, // C + 473
  clientEnd: C + 1 + LEN.clientHello + LEN.clientFinished + LEN.getIndex + LEN.getCss, // C + 544
  // server -> client
  serverHello: S + 1,
  serverFlight1: S + 1 + LEN.serverHello, // S + 134
  serverFlight2: S + 1 + LEN.serverHello + LEN.serverFlight1, // S + 1582
  indexResponse: S + 1 + LEN.serverHello + LEN.serverFlight1 + LEN.serverFlight2, // S + 2261
  cssResponse: S + 1 + LEN.serverHello + LEN.serverFlight1 + LEN.serverFlight2 + LEN.indexResponse, // S + 3495
} as const;

const laptopFrame = (dstIp: string, id: number): FrameAddresses => ({
  eth: { src: MAC.laptop, dst: MAC.routerLan },
  ip: { src: IP.laptop, dst: dstIp, ttl: 64, id, df: true },
});

const edgeFrame = (): FrameAddresses => ({
  eth: { src: MAC.cdnEdge, dst: REMOTE_MAC.edgeGw },
  ip: { src: IP.cdnEdge, dst: IP.routerPublic, ttl: 64, id: 0, df: true },
});

/** Client-side segment on the tracked laptop-to-edge connection. */
const clientSegment = (
  seq: number,
  ack: number,
  len: number,
  flags: TcpMeta['flags'],
): TcpMeta => ({
  conn: CONN,
  srcPort: PORT_OF.web,
  dstPort: HTTPS,
  seq,
  ack,
  flags,
  len,
  window: 502,
});

/** Server-side segment on the tracked laptop-to-edge connection. */
const serverSegment = (
  seq: number,
  ack: number,
  len: number,
  flags: TcpMeta['flags'],
): TcpMeta => ({
  conn: CONN,
  srcPort: HTTPS,
  dstPort: PORT_OF.web,
  seq,
  ack,
  flags,
  len,
  window: 509,
});

/** Route from the laptop to anything beyond the ISP: Wi-Fi, WAN, then two backbone hops. */
const viaInternet = (): string[] => ['home-router', 'isp-router', 'internet'];

const NAT_NOTE =
  'The home router rewrites the source address to its public address (NAT); the headers show the packet as the laptop sent it.';

const NAT_INBOUND_NOTE =
  'Replies are addressed to the router’s public address, as the sender captured them; the home router translates the destination back to the laptop (NAT).';

const ACK_NOTE =
  'The client’s pure ACK segments are not drawn; sequence and acknowledgment numbers count only the bytes shown.';

// ---------------------------------------------------------------------------
// References reused across steps
// ---------------------------------------------------------------------------

const REF = {
  url: ref('WHATWG URL Standard: URL parsing', 'https://url.spec.whatwg.org/#url-parsing'),
  hsts: ref(
    'RFC 6797 section 8.3: HSTS URI loading',
    'https://www.rfc-editor.org/rfc/rfc6797#section-8.3',
  ),
  fetchHsts: ref('WHATWG Fetch: main fetch', 'https://fetch.spec.whatwg.org/#main-fetch'),
  fetchCache: ref(
    'WHATWG Fetch: HTTP-network-or-cache fetch',
    'https://fetch.spec.whatwg.org/#http-network-or-cache-fetch',
  ),
  httpCache: ref('RFC 9111: HTTP caching', 'https://www.rfc-editor.org/rfc/rfc9111'),
  serviceWorker: ref('Service Workers (W3C)', 'https://www.w3.org/TR/service-workers/'),
  stub: ref(
    'RFC 1034 section 5.3.1: stub resolvers',
    'https://www.rfc-editor.org/rfc/rfc1034#section-5.3.1',
  ),
  dnsTerms: ref('RFC 8499: DNS terminology', 'https://www.rfc-editor.org/rfc/rfc8499'),
  dnsMessage: ref(
    'RFC 1035 section 4.1: DNS message format',
    'https://www.rfc-editor.org/rfc/rfc1035#section-4.1',
  ),
  dnsAlgorithm: ref(
    'RFC 1034 section 4.3.2: resolution algorithm',
    'https://www.rfc-editor.org/rfc/rfc1034#section-4.3.2',
  ),
  qnameMin: ref('RFC 9156: QNAME minimisation', 'https://www.rfc-editor.org/rfc/rfc9156'),
  glue: ref('RFC 9471: Glue in referral responses', 'https://www.rfc-editor.org/rfc/rfc9471'),
  dnsTcp: ref('RFC 7766: DNS over TCP', 'https://www.rfc-editor.org/rfc/rfc7766'),
  dnsTtl: ref('RFC 2181 section 8: TTL', 'https://www.rfc-editor.org/rfc/rfc2181#section-8'),
  tcpOpen: ref(
    'RFC 9293 section 3.5: establishing a connection',
    'https://www.rfc-editor.org/rfc/rfc9293#section-3.5',
  ),
  tcpMss: ref(
    'RFC 9293 section 3.7.1: maximum segment size',
    'https://www.rfc-editor.org/rfc/rfc9293#section-3.7.1',
  ),
  tcpOptions: ref(
    'RFC 7323: window scale and timestamps',
    'https://www.rfc-editor.org/rfc/rfc7323',
  ),
  sack: ref('RFC 2018: selective acknowledgments', 'https://www.rfc-editor.org/rfc/rfc2018'),
  nat: ref('RFC 3022: traditional NAT', 'https://www.rfc-editor.org/rfc/rfc3022'),
  tlsOverview: ref(
    'RFC 8446 section 2: TLS 1.3 protocol overview',
    'https://www.rfc-editor.org/rfc/rfc8446#section-2',
  ),
  clientHello: ref(
    'RFC 8446 section 4.1.2: ClientHello',
    'https://www.rfc-editor.org/rfc/rfc8446#section-4.1.2',
  ),
  serverHello: ref(
    'RFC 8446 section 4.1.3: ServerHello',
    'https://www.rfc-editor.org/rfc/rfc8446#section-4.1.3',
  ),
  keyShare: ref(
    'RFC 8446 section 4.2.8: key share',
    'https://www.rfc-editor.org/rfc/rfc8446#section-4.2.8',
  ),
  keySchedule: ref(
    'RFC 8446 section 7.1: key schedule',
    'https://www.rfc-editor.org/rfc/rfc8446#section-7.1',
  ),
  tlsCertificate: ref(
    'RFC 8446 section 4.4.2: Certificate',
    'https://www.rfc-editor.org/rfc/rfc8446#section-4.4.2',
  ),
  certVerify: ref(
    'RFC 8446 section 4.4.3: CertificateVerify',
    'https://www.rfc-editor.org/rfc/rfc8446#section-4.4.3',
  ),
  finished: ref(
    'RFC 8446 section 4.4.4: Finished',
    'https://www.rfc-editor.org/rfc/rfc8446#section-4.4.4',
  ),
  middlebox: ref(
    'RFC 8446 appendix D.4: middlebox compatibility mode',
    'https://www.rfc-editor.org/rfc/rfc8446#appendix-D.4',
  ),
  ticket: ref(
    'RFC 8446 section 4.6.1: NewSessionTicket',
    'https://www.rfc-editor.org/rfc/rfc8446#section-4.6.1',
  ),
  sni: ref(
    'RFC 6066 section 3: server name indication',
    'https://www.rfc-editor.org/rfc/rfc6066#section-3',
  ),
  alpn: ref('RFC 7301: ALPN', 'https://www.rfc-editor.org/rfc/rfc7301'),
  pathValidation: ref(
    'RFC 5280 section 6: certification path validation',
    'https://www.rfc-editor.org/rfc/rfc5280#section-6',
  ),
  serviceIdentity: ref(
    'RFC 9525: service identity in TLS',
    'https://www.rfc-editor.org/rfc/rfc9525',
  ),
  h2Preface: ref(
    'RFC 9113 section 3.4: connection preface',
    'https://www.rfc-editor.org/rfc/rfc9113#section-3.4',
  ),
  h2Request: ref(
    'RFC 9113 section 8.3.1: request pseudo-header fields',
    'https://www.rfc-editor.org/rfc/rfc9113#section-8.3.1',
  ),
  h2Streams: ref(
    'RFC 9113 section 5: streams and multiplexing',
    'https://www.rfc-editor.org/rfc/rfc9113#section-5',
  ),
  hpack: ref('RFC 7541: HPACK', 'https://www.rfc-editor.org/rfc/rfc7541'),
  httpGet: ref(
    'RFC 9110 section 9.3.1: GET',
    'https://www.rfc-editor.org/rfc/rfc9110#section-9.3.1',
  ),
  http200: ref(
    'RFC 9110 section 15.3.1: 200 OK',
    'https://www.rfc-editor.org/rfc/rfc9110#section-15.3.1',
  ),
  http204: ref(
    'RFC 9110 section 15.3.5: 204 No Content',
    'https://www.rfc-editor.org/rfc/rfc9110#section-15.3.5',
  ),
  etag: ref('RFC 9110 section 8.8.3: ETag', 'https://www.rfc-editor.org/rfc/rfc9110#section-8.8.3'),
  via: ref('RFC 9110 section 7.6.3: Via', 'https://www.rfc-editor.org/rfc/rfc9110#section-7.6.3'),
  persistent: ref(
    'RFC 9112 section 9.3: persistent connections',
    'https://www.rfc-editor.org/rfc/rfc9112#section-9.3',
  ),
  cacheKey: ref(
    'RFC 9111 section 4.1: cache keys and Vary',
    'https://www.rfc-editor.org/rfc/rfc9111#section-4.1',
  ),
  maxAge: ref(
    'RFC 9111 section 5.2.2.1: max-age',
    'https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.1',
  ),
  sMaxAge: ref(
    'RFC 9111 section 5.2.2.10: s-maxage',
    'https://www.rfc-editor.org/rfc/rfc9111#section-5.2.2.10',
  ),
  age: ref('RFC 9111 section 5.1: Age', 'https://www.rfc-editor.org/rfc/rfc9111#section-5.1'),
  cacheStatus: ref('RFC 9211: Cache-Status', 'https://www.rfc-editor.org/rfc/rfc9211'),
  htmlParsing: ref(
    'HTML Standard: parsing HTML documents',
    'https://html.spec.whatwg.org/multipage/parsing.html',
  ),
  origin: ref(
    'HTML Standard: origin',
    'https://html.spec.whatwg.org/multipage/browsers.html#origin',
  ),
  cors: ref('WHATWG Fetch: CORS protocol', 'https://fetch.spec.whatwg.org/#http-cors-protocol'),
  corsPreflight: ref(
    'WHATWG Fetch: CORS-preflight request',
    'https://fetch.spec.whatwg.org/#cors-preflight-request',
  ),
  corsCredentials: ref(
    'WHATWG Fetch: CORS protocol and credentials',
    'https://fetch.spec.whatwg.org/#cors-protocol-and-credentials',
  ),
  rendering: ref(
    'HTML Standard: event loop processing model (update the rendering)',
    'https://html.spec.whatwg.org/multipage/webappapis.html#event-loop-processing-model',
  ),
  cssom: ref('CSSOM (W3C)', 'https://www.w3.org/TR/cssom-1/'),
} as const;

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------

const PHASES = [
  { id: 'parse', label: 'Parse the URL' },
  { id: 'cache', label: 'Local caches' },
  { id: 'dns', label: 'DNS lookup' },
  { id: 'tcp', label: 'TCP handshake' },
  { id: 'tls', label: 'TLS 1.3 handshake' },
  { id: 'http-cdn', label: 'HTTP request and CDN' },
  { id: 'subresources', label: 'Subresources' },
  { id: 'cors', label: 'Cross-origin request' },
  { id: 'render', label: 'Render' },
];

// ---------------------------------------------------------------------------
// Steps by phase
// ---------------------------------------------------------------------------

/** Step 1: parse. */
const parseSteps: StepDef[] = [
  {
    id: 'parse-url',
    title: 'Parse what you typed into a URL',
    phase: 'parse',
    summary:
      'The browser decides the text is a web address, fills in a scheme, splits it into parts and applies **HSTS** so a remembered HTTPS-only site is never contacted over plain HTTP.',
    body: [
      para(
        'You type `www.example.com`. Before any packet exists, the browser must decide whether this is a web address or a search query. Text that looks like a host name is treated as an address, and a missing scheme is filled in: some browsers try `https://` first, others begin with `http://`.',
      ),
      para(
        'The URL parser then splits the result into a **scheme** (`https`), a **host** (`www.example.com`), a **port** (443, the default for HTTPS, so it is not written) and a **path** (`/`). Scheme, host and port together form the **origin**, which later decides what scripts may read.',
      ),
      note(
        'If the host is in the browser’s HSTS list, because an earlier response carried `Strict-Transport-Security` or the site is preloaded, an `http://` URL is switched to `https://` internally, before any connection is made.',
      ),
    ],
    packets: [],
    actions: [
      {
        id: 'a-parse-1',
        node: 'laptop',
        kind: 'process',
        label: 'URL or search?',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-parse-2',
        node: 'laptop',
        kind: 'process',
        label: 'Pick a scheme',
        at: 800,
        durationMs: 700,
      },
      {
        id: 'a-parse-3',
        node: 'laptop',
        kind: 'process',
        label: 'HSTS: use https',
        at: 1600,
        durationMs: 800,
      },
    ],
    focus: ['laptop'],
    simplifications: [
      'Browsers differ in how they guess a missing scheme and when they fall back to HTTP.',
      'Internationalised host names (punycode), percent-encoding, search suggestions and safe-browsing checks are not shown.',
    ],
    references: [REF.url, REF.hsts, REF.fetchHsts, REF.origin],
  },
];

/** Steps 2-3: local caches. */
const cacheSteps: StepDef[] = [
  {
    id: 'http-cache-miss',
    title: 'Service worker and HTTP cache: miss',
    phase: 'cache',
    summary:
      'Before touching the network, the browser asks any service worker and its own HTTP cache for a stored response. On a first visit both come up empty, so the request goes on.',
    body: [
      para(
        'The navigation becomes a fetch. A **service worker**, if the site had registered one earlier, could answer from its own storage or rewrite the request. None is installed here, so the request carries on.',
      ),
      para(
        'Next is the **HTTP cache**. A stored response may be reused without contacting the server while it is still fresh, and the entry is found by a key built from the method and the URL, plus any request headers the response listed in `Vary`. Nothing is stored for `https://www.example.com/`, so this is a **miss**.',
      ),
      tip(
        'A stale entry is not always wasted: the browser can revalidate it with `If-None-Match` and receive a tiny `304 Not Modified` instead of the whole page.',
      ),
    ],
    packets: [],
    actions: [
      {
        id: 'a-cache-1',
        node: 'laptop',
        kind: 'cache-lookup',
        label: 'Service worker?',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-cache-2',
        node: 'laptop',
        kind: 'cache-lookup',
        label: 'HTTP cache',
        at: 800,
        durationMs: 700,
      },
      {
        id: 'a-cache-3',
        node: 'laptop',
        kind: 'cache-miss',
        label: 'MISS',
        at: 1600,
        durationMs: 800,
      },
    ],
    focus: ['laptop'],
    simplifications: [
      'Other browser-internal caches (memory cache, back/forward cache, prefetch) are not drawn.',
    ],
    references: [REF.fetchCache, REF.httpCache, REF.cacheKey, REF.serviceWorker],
  },
  {
    id: 'dns-local-miss',
    title: 'Browser, OS and hosts-file lookups: miss',
    phase: 'cache',
    summary:
      'To connect, the browser needs an IP address. It checks its own host cache, then asks the operating system, which looks at the hosts file and any local resolver cache. Nothing matches.',
    body: [
      para(
        'TCP connects to addresses, not names, so `www.example.com` must be resolved first. The browser looks in its own DNS cache, then hands the name to the operating system’s resolver library.',
      ),
      para(
        'The OS consults the **hosts file**, where a manually written line would win outright without any query, and any cache it keeps. Both are empty for this name. The OS then falls back to its **stub resolver**: a minimal client that knows one or two server addresses (here the ISP’s resolver, learned from the network configuration) and forwards the question to them.',
      ),
      note(
        'The stub does no searching itself. All the work of walking the DNS hierarchy is delegated to a **recursive resolver**.',
      ),
    ],
    packets: [],
    actions: [
      {
        id: 'a-dnslocal-1',
        node: 'laptop',
        kind: 'cache-lookup',
        label: 'Browser DNS cache',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-dnslocal-2',
        node: 'laptop',
        kind: 'cache-lookup',
        label: 'Hosts file + OS',
        at: 800,
        durationMs: 700,
      },
      {
        id: 'a-dnslocal-3',
        node: 'laptop',
        kind: 'cache-miss',
        label: 'MISS',
        at: 1600,
        durationMs: 800,
      },
    ],
    focus: ['laptop'],
    simplifications: [
      'Where DNS caching lives differs by operating system: some have a system-wide cache, others rely on the browser or a background service.',
      'Browsers usually ask for AAAA (IPv6) records in parallel with A; only the A lookup is drawn.',
    ],
    references: [REF.stub, REF.dnsTerms],
  },
];

/** Steps 4-8: DNS. */
const QUESTION = { name: HOST.www, type: 'A' } as const;

const stubQueryFrame = udpFrame(
  {
    eth: { src: MAC.laptop, dst: MAC.routerLan },
    ip: { src: IP.laptop, dst: IP.ispResolver, ttl: 64, id: 0x5d21 },
  },
  { src: PORT_OF.stubDns, dst: DNS_PORT },
  33,
);
const rootQueryFrame = udpFrame(
  {
    eth: { src: MAC.ispResolver, dst: MAC.ispRouterResolver },
    ip: { src: IP.ispResolver, dst: IP.root, ttl: 64, id: 0x20a4 },
  },
  { src: PORT_OF.rootQuery, dst: DNS_PORT },
  33,
);
const rootReferralFrame = udpFrame(
  {
    eth: { src: REMOTE_MAC.rootNic, dst: REMOTE_MAC.rootGw },
    ip: { src: IP.root, dst: IP.ispResolver, ttl: 64, id: 0x71c3 },
  },
  { src: DNS_PORT, dst: PORT_OF.rootQuery },
  81,
);
const tldQueryFrame = udpFrame(
  {
    eth: { src: MAC.ispResolver, dst: MAC.ispRouterResolver },
    ip: { src: IP.ispResolver, dst: IP.tldCom, ttl: 64, id: 0x20a5 },
  },
  { src: PORT_OF.tldQuery, dst: DNS_PORT },
  33,
);
const tldReferralFrame = udpFrame(
  {
    eth: { src: REMOTE_MAC.tldNic, dst: REMOTE_MAC.tldGw },
    ip: { src: IP.tldCom, dst: IP.ispResolver, ttl: 64, id: 0x3e90 },
  },
  { src: DNS_PORT, dst: PORT_OF.tldQuery },
  78,
);
const authQueryFrame = udpFrame(
  {
    eth: { src: MAC.ispResolver, dst: MAC.ispRouterResolver },
    ip: { src: IP.ispResolver, dst: IP.authoritativeNs, ttl: 64, id: 0x20a6 },
  },
  { src: PORT_OF.authQuery, dst: DNS_PORT },
  33,
);
const authAnswerFrame = udpFrame(
  {
    eth: { src: REMOTE_MAC.authNic, dst: REMOTE_MAC.authGw },
    ip: { src: IP.authoritativeNs, dst: IP.ispResolver, ttl: 64, id: 0xa917 },
  },
  { src: DNS_PORT, dst: PORT_OF.authQuery },
  49,
);
const stubAnswerFrame = udpFrame(
  {
    eth: { src: MAC.ispResolver, dst: MAC.ispRouterResolver },
    ip: { src: IP.ispResolver, dst: IP.routerPublic, ttl: 64, id: 0x20a7 },
  },
  { src: DNS_PORT, dst: PORT_OF.stubDns },
  49,
);

const dnsSteps: StepDef[] = [
  {
    id: 'dns-stub-query',
    title: 'Ask the recursive resolver (RD=1)',
    phase: 'dns',
    summary:
      'The stub resolver sends one UDP query to the ISP’s recursive resolver, with the **RD** (recursion desired) flag set: “please find the final answer for me”.',
    body: [
      para(
        'The question is `www.example.com`, type `A`: which IPv4 address belongs to this name? It travels as a small UDP datagram from an ephemeral port to port 53. The message carries a 16-bit **ID** (`0x3a7c`) that the reply must repeat, so the stub can match answers to questions.',
      ),
      para(
        'The **RD** flag asks the server to do the whole search itself and return only the finished result. A stub sets it because it cannot follow referrals on its own.',
      ),
      para(
        'At the resolver, the first thing checked is its cache. It holds nothing for this name, so it will have to work its way down the DNS hierarchy.',
      ),
    ],
    packets: [
      {
        id: 'p-dns-stub-query',
        from: 'laptop',
        to: 'resolver',
        via: ['home-router', 'isp-router'],
        protocol: 'dns',
        label: 'A? www.example.com',
        summary: 'Standard query 0x3a7c A www.example.com',
        headers: [
          ...stubQueryFrame.lower,
          dns({ id: 0x3a7c, qr: 'query', flags: { rd: true }, question: QUESTION }),
        ],
        sizeBytes: stubQueryFrame.sizeBytes,
        at: 0,
        wireTimeMs: 0,
        meta: stubQueryFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-dnsq-1',
        node: 'resolver',
        kind: 'cache-miss',
        label: 'Resolver cache: miss',
        at: 2300,
        durationMs: 800,
      },
    ],
    focus: ['laptop', 'resolver'],
    simplifications: [
      NAT_NOTE,
      'The laptop queries the ISP resolver directly. Many home routers instead run a small DNS forwarder at 192.168.1.1 and relay the query.',
      'Optional EDNS(0) data (the OPT record) that real queries carry is not shown.',
    ],
    references: [REF.dnsMessage, REF.stub, REF.dnsTerms, REF.nat],
  },
  {
    id: 'dns-root-referral',
    title: 'Root server refers us to the .com servers',
    phase: 'dns',
    summary:
      'The resolver asks a root server, which cannot answer but knows who runs `com.`. It replies with a **referral**: NS records plus glue addresses.',
    body: [
      para(
        'The resolver now works **iteratively**: it asks one server, and each server either answers or points to a better one. These upstream queries have RD cleared, because the resolver does not want the other server to recurse for it. With a cold cache it starts at the **root**, whose addresses are built into the resolver as root hints.',
      ),
      para(
        'The root knows no website’s address. It only knows who runs each top-level domain, so it returns a **referral**: an NS record for `com.` in the authority section and an A record for that server in the additional section. AA is not set, because the root is not authoritative for `www.example.com`.',
      ),
      note(
        'The full name is sent here to keep the picture simple. Many resolvers use QNAME minimisation (RFC 9156) and ask the root only for `com.`.',
      ),
    ],
    packets: [
      {
        id: 'p-dns-root-query',
        from: 'resolver',
        to: 'root',
        via: ['isp-router', 'internet'],
        protocol: 'dns',
        label: 'A? www.example.com',
        summary: 'Standard query 0x9b21 A www.example.com',
        headers: [...rootQueryFrame.lower, dns({ id: 0x9b21, qr: 'query', question: QUESTION })],
        sizeBytes: rootQueryFrame.sizeBytes,
        at: 0,
        wireTimeMs: 6.4,
        meta: rootQueryFrame.meta,
      },
      {
        id: 'p-dns-root-referral',
        from: 'root',
        to: 'resolver',
        via: ['internet', 'isp-router'],
        protocol: 'dns',
        label: 'Refer to .com',
        summary: 'Standard query response 0x9b21 NS a.gtld-servers.net (referral to com.)',
        headers: [
          ...rootReferralFrame.lower,
          dns({
            id: 0x9b21,
            qr: 'response',
            question: QUESTION,
            authority: [
              { name: 'com', type: 'NS', ttl: 172800, data: `${REAL_INFRA.tldCom.name}.` },
            ],
            additional: [
              { name: REAL_INFRA.tldCom.name, type: 'A', ttl: 172800, data: REAL_INFRA.tldCom.ip },
            ],
          }),
        ],
        sizeBytes: rootReferralFrame.sizeBytes,
        at: 3400,
        wireTimeMs: 20.8,
        meta: rootReferralFrame.meta,
      },
    ],
    focus: ['resolver', 'root'],
    simplifications: [
      'The real root returns every `.com` name server (a to m) with IPv4 and IPv6 glue; one is shown.',
      'A busy resolver usually has the `com.` servers cached and skips the root; a cold cache is assumed.',
      'DNSSEC records (DS, RRSIG) are not shown.',
    ],
    references: [REF.dnsAlgorithm, REF.qnameMin, REF.dnsMessage],
  },
  {
    id: 'dns-tld-referral',
    title: 'The .com server refers us to example.com',
    phase: 'dns',
    summary:
      'A `.com` server does not hold the page’s address either. It names the servers for `example.com` and includes the address of one as **glue**.',
    body: [
      para(
        'The resolver repeats the same question, this time to `a.gtld-servers.net`, whose address came back as glue. The `.com` registry knows only which servers are responsible for `example.com`, not what is inside that zone, so it answers with another referral.',
      ),
      para(
        'The authority section names `ns1.example.com` as a name server for `example.com`. The additional section carries its address, `203.0.113.53`, as **glue**. Glue is necessary because the name server’s own name lives inside the zone it serves: without the address, the resolver would need to look up `ns1.example.com` in order to find `ns1.example.com`.',
      ),
    ],
    packets: [
      {
        id: 'p-dns-tld-query',
        from: 'resolver',
        to: 'tld',
        via: ['isp-router', 'internet'],
        protocol: 'dns',
        label: 'A? www.example.com',
        summary: 'Standard query 0x5c08 A www.example.com',
        headers: [...tldQueryFrame.lower, dns({ id: 0x5c08, qr: 'query', question: QUESTION })],
        sizeBytes: tldQueryFrame.sizeBytes,
        at: 0,
        wireTimeMs: 35.2,
        meta: tldQueryFrame.meta,
      },
      {
        id: 'p-dns-tld-referral',
        from: 'tld',
        to: 'resolver',
        via: ['internet', 'isp-router'],
        protocol: 'dns',
        label: 'NS ns1.example.com',
        summary: 'Standard query response 0x5c08 NS ns1.example.com (referral to example.com.)',
        headers: [
          ...tldReferralFrame.lower,
          dns({
            id: 0x5c08,
            qr: 'response',
            question: QUESTION,
            authority: [{ name: HOST.site, type: 'NS', ttl: 172800, data: `${HOST.ns}.` }],
            additional: [{ name: HOST.ns, type: 'A', ttl: 172800, data: IP.authoritativeNs }],
          }),
        ],
        sizeBytes: tldReferralFrame.sizeBytes,
        at: 3400,
        wireTimeMs: 50.5,
        meta: tldReferralFrame.meta,
      },
    ],
    focus: ['resolver', 'tld'],
    simplifications: [
      'A real delegation usually lists two to four name servers; one is shown.',
      'DNSSEC delegation-signer records are left out.',
    ],
    references: [REF.dnsAlgorithm, REF.glue, REF.dnsMessage],
  },
  {
    id: 'dns-authoritative-answer',
    title: 'The authoritative server answers (AA, TTL 300)',
    phase: 'dns',
    summary:
      'Finally a server that owns the zone answers: `www.example.com` is `203.0.113.10`, with the **AA** flag set and a **TTL of 300** seconds for caches.',
    body: [
      para(
        'The resolver asks `ns1.example.com`, which holds the zone data for `example.com`. The reply sets **AA** (authoritative answer): it comes from the zone’s owner, not from a cache.',
      ),
      para(
        'The A record maps `www.example.com` to `203.0.113.10`, the address of a CDN edge near the user. Its **TTL of 300** seconds tells every cache along the way how long the record may be reused before asking again.',
      ),
      note(
        'DNS normally runs over UDP port 53. If an answer were too big for a datagram it would come back with the **TC** (truncated) flag set, and the resolver would repeat the query over TCP.',
      ),
    ],
    packets: [
      {
        id: 'p-dns-auth-query',
        from: 'resolver',
        to: 'auth',
        via: ['isp-router', 'internet'],
        protocol: 'dns',
        label: 'A? www.example.com',
        summary: 'Standard query 0xe4d3 A www.example.com',
        headers: [...authQueryFrame.lower, dns({ id: 0xe4d3, qr: 'query', question: QUESTION })],
        sizeBytes: authQueryFrame.sizeBytes,
        at: 0,
        wireTimeMs: 65.8,
        meta: authQueryFrame.meta,
      },
      {
        id: 'p-dns-auth-answer',
        from: 'auth',
        to: 'resolver',
        via: ['internet', 'isp-router'],
        protocol: 'dns',
        label: 'A 203.0.113.10',
        summary: 'Standard query response 0xe4d3 A 203.0.113.10 (authoritative)',
        headers: [
          ...authAnswerFrame.lower,
          dns({
            id: 0xe4d3,
            qr: 'response',
            flags: { aa: true },
            question: QUESTION,
            answer: [{ name: HOST.www, type: 'A', ttl: 300, data: IP.cdnEdge }],
          }),
        ],
        sizeBytes: authAnswerFrame.sizeBytes,
        at: 3400,
        wireTimeMs: 78.4,
        meta: authAnswerFrame.meta,
      },
    ],
    focus: ['resolver', 'auth'],
    simplifications: [
      'Real sites often alias `www` to a CDN name with a CNAME record, adding a link to the chain; a direct A record is shown.',
      'The CDN chose this address for the client (for example by DNS location or anycast); how it chose is not drawn.',
      'The query and reply are small enough for UDP, so no TCP fallback occurs.',
    ],
    references: [REF.dnsAlgorithm, REF.dnsTtl, REF.dnsTcp, REF.dnsMessage],
  },
  {
    id: 'dns-stub-answer',
    title: 'The answer returns and is cached',
    phase: 'dns',
    summary:
      'The resolver relays the address to the laptop with **RA** set, and keeps a copy for 300 seconds. The browser now knows where to connect.',
    body: [
      para(
        'The reply repeats the transaction ID (`0x3a7c`) and the question. **RD** is echoed, and **RA** (recursion available) is set, telling the stub that this server does recursion. AA is clear, because the resolver is passing on data it does not own.',
      ),
      para(
        'The resolver stores the record for up to 300 seconds. The next customer to ask for `www.example.com` gets an answer in a few milliseconds, with a smaller TTL as the copy ages. The laptop caches the address as well and hands it to the browser.',
      ),
      tip(
        'This is why DNS is fast most of the time: the walk through the root, `.com` and authoritative servers in the last three steps happens only when no cache holds a fresh answer.',
      ),
    ],
    packets: [
      {
        id: 'p-dns-stub-answer',
        from: 'resolver',
        to: 'laptop',
        via: ['isp-router', 'home-router'],
        protocol: 'dns',
        label: 'A 203.0.113.10',
        summary: 'Standard query response 0x3a7c A 203.0.113.10',
        headers: [
          ...stubAnswerFrame.lower,
          dns({
            id: 0x3a7c,
            qr: 'response',
            flags: { rd: true, ra: true },
            question: QUESTION,
            answer: [{ name: HOST.www, type: 'A', ttl: 300, data: IP.cdnEdge }],
          }),
        ],
        sizeBytes: stubAnswerFrame.sizeBytes,
        at: 800,
        wireTimeMs: 91.2,
        meta: stubAnswerFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-dnsa-1',
        node: 'resolver',
        kind: 'store',
        label: 'Cache for 300 s',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-dnsa-2',
        node: 'laptop',
        kind: 'store',
        label: 'Cache the address',
        at: 3100,
        durationMs: 800,
      },
    ],
    focus: ['resolver', 'laptop'],
    simplifications: [
      NAT_INBOUND_NOTE,
      'Only the A answer is drawn; an AAAA lookup would run alongside it.',
    ],
    references: [REF.dnsMessage, REF.dnsTtl, REF.stub, REF.nat],
  },
];

/** Steps 9-11: TCP handshake. */
const synFrame = tcpFrame(
  laptopFrame(IP.cdnEdge, 0x7a31),
  {
    conn: CONN,
    srcPort: PORT_OF.web,
    dstPort: HTTPS,
    seq: C,
    flags: ['SYN'],
    len: 0,
    window: 64240,
  },
  { handshake: true },
);
const synAckFrame = tcpFrame(
  edgeFrame(),
  {
    conn: CONN,
    srcPort: HTTPS,
    dstPort: PORT_OF.web,
    seq: S,
    ack: C + 1,
    flags: ['SYN', 'ACK'],
    len: 0,
    window: 65160,
  },
  { handshake: true },
);
const ackFrame = tcpFrame(laptopFrame(IP.cdnEdge, 0x7a32), clientSegment(C + 1, S + 1, 0, ['ACK']));

const tcpSteps: StepDef[] = [
  {
    id: 'tcp-syn',
    title: 'SYN: ask to open a connection',
    phase: 'tcp',
    summary:
      'The browser asks the OS for a TCP connection to port 443. The laptop picks an ephemeral port and a random initial sequence number and sends a **SYN**.',
    body: [
      para(
        'The address `203.0.113.10` belongs to a CDN edge. The laptop chooses source port 51234, and an **initial sequence number** (here 1204331000, normally random) that numbers the first byte it will send. A SYN consumes one sequence number.',
      ),
      para(
        'The SYN also advertises options: **MSS** 1460 (the largest segment it will accept, from a 1500-byte MTU minus 40 bytes of headers), **SACK permitted**, **timestamps**, and a **window scale** of 7, which multiplies the window field by 128. DF is set so that routers do not fragment the connection’s packets.',
      ),
    ],
    packets: [
      {
        id: 'p-syn',
        from: 'laptop',
        to: 'edge',
        via: viaInternet(),
        protocol: 'tcp',
        label: 'SYN',
        summary: `${PORT_OF.web} → ${HTTPS} [SYN] Seq=${C} Win=64240 Len=0 MSS=1460 WS=128 SACK_PERM TSval`,
        headers: synFrame.lower,
        sizeBytes: synFrame.sizeBytes,
        at: 0,
        wireTimeMs: 97.6,
        meta: synFrame.meta,
      },
    ],
    focus: ['laptop'],
    simplifications: [
      NAT_NOTE,
      'Routers decrement TTL and recompute the IPv4 checksum at every hop; the header shows the packet as sent.',
      'The first frame on a LAN may need an ARP lookup for the router’s MAC address; that is skipped.',
      'Browsers may race IPv6 and IPv4 connection attempts; only IPv4 is drawn.',
    ],
    references: [REF.tcpOpen, REF.tcpMss, REF.tcpOptions, REF.sack],
  },
  {
    id: 'tcp-syn-ack',
    title: 'SYN-ACK: the edge agrees',
    phase: 'tcp',
    summary:
      'The edge replies with its own sequence number and acknowledges the SYN. Its acknowledgment number is the client’s sequence number plus one.',
    body: [
      para(
        'The edge has a listening socket on port 443. It answers with **SYN** and **ACK** both set. Its own initial sequence number is 3877120400, and its acknowledgment number is 1204331001: the client’s ISN plus one, because the SYN used up one sequence number.',
      ),
      para(
        'The reply repeats the option negotiation. Each side now knows the other’s MSS, whether SACK and timestamps are allowed, and the window scale, which only takes effect if both ends offered it.',
      ),
    ],
    packets: [
      {
        id: 'p-syn-ack',
        from: 'edge',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'tcp',
        label: 'SYN-ACK',
        summary: `${HTTPS} → ${PORT_OF.web} [SYN, ACK] Seq=${S} Ack=${C + 1} Win=65160 Len=0 MSS=1460 WS=128 SACK_PERM TSval`,
        headers: synAckFrame.lower,
        sizeBytes: synAckFrame.sizeBytes,
        at: 0,
        wireTimeMs: 104.7,
        meta: synAckFrame.meta,
      },
    ],
    focus: ['edge'],
    simplifications: [
      NAT_INBOUND_NOTE,
      'Server-side details such as SYN cookies and the accept queue are not shown.',
    ],
    references: [REF.tcpOpen, REF.tcpOptions, REF.nat],
  },
  {
    id: 'tcp-ack',
    title: 'ACK: the connection is established',
    phase: 'tcp',
    summary:
      'The laptop acknowledges the edge’s SYN. Both ends now consider the connection open, one round trip after the first SYN.',
    body: [
      para(
        'The final segment has only **ACK** set: sequence number 1204331001, acknowledging 3877120401 (the server’s ISN plus one). Both ends are now in the ESTABLISHED state, and the three-way handshake has cost exactly one round trip.',
      ),
      para(
        'This segment could already carry data, and the TLS handshake’s first message follows immediately after it. The handshake only created shared state; no application bytes have been exchanged yet.',
      ),
    ],
    packets: [
      {
        id: 'p-ack',
        from: 'laptop',
        to: 'edge',
        via: viaInternet(),
        protocol: 'tcp',
        label: 'ACK',
        summary: `${PORT_OF.web} → ${HTTPS} [ACK] Seq=${C + 1} Ack=${S + 1} Win=502 Len=0`,
        headers: ackFrame.lower,
        sizeBytes: ackFrame.sizeBytes,
        at: 0,
        wireTimeMs: 111.8,
        meta: ackFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-tcp-est-1',
        node: 'laptop',
        kind: 'process',
        label: 'ESTABLISHED',
        at: 200,
        durationMs: 800,
      },
      {
        id: 'a-tcp-est-2',
        node: 'edge',
        kind: 'process',
        label: 'ESTABLISHED',
        at: 4200,
        durationMs: 800,
      },
    ],
    focus: ['laptop', 'edge'],
    simplifications: [NAT_NOTE],
    references: [REF.tcpOpen],
  },
];

/** Steps 12-15: TLS 1.3 handshake. */
const clientHelloFrame = tcpFrame(
  laptopFrame(IP.cdnEdge, 0x7a33),
  clientSegment(SEQ.clientHello, S + 1, LEN.clientHello, ['PSH', 'ACK']),
);
const serverHelloFrame = tcpFrame(
  edgeFrame(),
  serverSegment(SEQ.serverHello, SEQ.clientFinished, LEN.serverHello, ['PSH', 'ACK']),
);
const serverFlight1Frame = tcpFrame(
  edgeFrame(),
  serverSegment(SEQ.serverFlight1, SEQ.clientFinished, LEN.serverFlight1, ['ACK']),
);
const serverFlight2Frame = tcpFrame(
  edgeFrame(),
  serverSegment(SEQ.serverFlight2, SEQ.clientFinished, LEN.serverFlight2, ['PSH', 'ACK']),
);
const clientFinishedFrame = tcpFrame(
  laptopFrame(IP.cdnEdge, 0x7a34),
  clientSegment(SEQ.clientFinished, SEQ.indexResponse, LEN.clientFinished, ['PSH', 'ACK']),
);

const tlsSteps: StepDef[] = [
  {
    id: 'tls-client-hello',
    title: 'ClientHello: offer algorithms and a key share',
    phase: 'tls',
    summary:
      'The first TLS message offers cipher suites, a fresh **x25519 key share**, the host name (**SNI**) and the protocols the browser speaks (**ALPN**). It is sent in the clear.',
    body: [
      para(
        'TLS 1.3 saves a round trip by guessing: the ClientHello already contains a **key share**, the public half of a one-off x25519 key pair. The `supported_versions` extension lists TLS 1.3, while the old `legacy_version` field says 1.2 for compatibility with middleboxes.',
      ),
      para(
        'The hello also lists cipher suites such as `TLS_AES_128_GCM_SHA256`, the signature algorithms the browser accepts, a 32-byte random value, the **server name** `www.example.com`, and **ALPN** `h2, http/1.1`, offering HTTP/2 first.',
      ),
      warning(
        'The server name travels unencrypted, so anyone on the path can see which site you are connecting to unless Encrypted Client Hello is in use.',
      ),
    ],
    packets: [
      {
        id: 'p-client-hello',
        from: 'laptop',
        to: 'edge',
        via: viaInternet(),
        protocol: 'tls',
        label: 'ClientHello',
        summary: 'Client Hello (SNI=www.example.com)',
        headers: [
          ...clientHelloFrame.lower,
          tlsHandshake({
            message: 'ClientHello',
            fields: [
              { name: 'legacy_version', value: '0x0303' },
              { name: 'random', value: '32 bytes' },
              { name: 'legacy_session_id', value: '32 bytes', note: 'compatibility mode' },
              {
                name: 'cipher_suites',
                value:
                  'TLS_AES_128_GCM_SHA256, TLS_AES_256_GCM_SHA384, TLS_CHACHA20_POLY1305_SHA256',
              },
              { name: 'compression_methods', value: 'null (0)' },
              { name: 'server_name', value: HOST.www, note: 'SNI, readable by observers' },
              { name: 'supported_groups', value: 'x25519, secp256r1' },
              {
                name: 'signature_algorithms',
                value:
                  'ecdsa_secp256r1_sha256, rsa_pss_rsae_sha256, rsa_pkcs1_sha256, ecdsa_secp384r1_sha384, rsa_pss_rsae_sha384, rsa_pkcs1_sha384, rsa_pss_rsae_sha512, rsa_pkcs1_sha512',
              },
              { name: 'key_share', value: 'x25519, 32-byte public value' },
              { name: 'supported_versions', value: '0x0304 (TLS 1.3)' },
              { name: 'alpn', value: 'h2, http/1.1' },
              { name: 'psk_key_exchange_modes', value: 'psk_dhe_ke' },
            ],
          }),
        ],
        payload: 'TLS record of 217 bytes, sent in plaintext.',
        sizeBytes: clientHelloFrame.sizeBytes,
        at: 0,
        wireTimeMs: 112,
        meta: clientHelloFrame.meta,
      },
    ],
    focus: ['laptop', 'edge'],
    simplifications: [
      NAT_NOTE,
      'Browser ClientHellos usually carry more extensions and can be larger than the 217-byte message drawn here.',
      'The edge’s ACK of this segment is not drawn; the server flight acknowledges it.',
    ],
    references: [REF.tlsOverview, REF.clientHello, REF.keyShare, REF.sni, REF.alpn],
  },
  {
    id: 'tls-server-flight',
    title: 'ServerHello, then an encrypted server flight',
    phase: 'tls',
    summary:
      'The edge picks a suite, returns its own key share and encrypts everything after the ServerHello: its extensions, certificate chain, signature and Finished MAC.',
    body: [
      para(
        'The **ServerHello** chooses `TLS_AES_128_GCM_SHA256` and x25519 and carries the server’s key share. Each side combines its own private key with the other’s public key and reaches the same secret, which an eavesdropper who sees both public values cannot compute. Both derive **handshake keys** from it.',
      ),
      para(
        'Everything after the ServerHello is encrypted with those keys: **EncryptedExtensions** (including ALPN `h2`), the **Certificate** chain, **CertificateVerify** (a signature over the handshake transcript) and **Finished** (a MAC over it). So in TLS 1.3 the certificate is no longer visible on the wire.',
      ),
      note(
        'The flight is about 2.3 KB, so it takes three segments. A meaningless ChangeCipherSpec record follows the ServerHello purely for compatibility with older middleboxes.',
      ),
    ],
    packets: [
      {
        id: 'p-server-hello',
        from: 'edge',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'tls',
        label: 'ServerHello',
        summary: 'Server Hello, Change Cipher Spec',
        headers: [
          ...serverHelloFrame.lower,
          tlsHandshake({
            message: 'ServerHello',
            fields: [
              { name: 'legacy_version', value: '0x0303' },
              { name: 'random', value: '32 bytes' },
              {
                name: 'legacy_session_id_echo',
                value: '32 bytes',
                note: 'copied from the ClientHello',
              },
              { name: 'cipher_suite', value: 'TLS_AES_128_GCM_SHA256' },
              { name: 'compression_method', value: 'null (0)' },
              { name: 'supported_versions', value: '0x0304 (TLS 1.3)' },
              { name: 'key_share', value: 'x25519, 32-byte public value' },
            ],
          }),
          tlsHandshake({
            message: 'ChangeCipherSpec',
            fields: [{ name: 'Payload', value: '0x01' }],
          }),
        ],
        payload: 'Two records: ServerHello (127 bytes) and ChangeCipherSpec (6 bytes).',
        sizeBytes: serverHelloFrame.sizeBytes,
        at: 0,
        wireTimeMs: 119.8,
        meta: serverHelloFrame.meta,
      },
      {
        id: 'p-server-flight-1',
        from: 'edge',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'tls',
        label: 'EE + Certificate',
        summary: 'Encrypted Extensions, Certificate (part 1 of 2, decoded)',
        headers: [
          ...serverFlight1Frame.lower,
          tlsHandshake({
            message: 'EncryptedExtensions',
            fields: [{ name: 'application_layer_protocol_negotiation', value: 'h2' }],
          }),
          tlsHandshake({
            message: 'Certificate',
            fields: [
              { name: 'certificate_request_context', value: '0 bytes' },
              {
                name: 'leaf certificate',
                value: 'subject www.example.com; SAN www.example.com, example.com; ECDSA P-256',
                note: 'about 1,010 bytes',
              },
              {
                name: 'intermediate certificate',
                value: 'Example Intermediate CA 1',
                note: 'about 880 bytes; the trust-store root is not sent',
              },
            ],
          }),
        ],
        payload:
          'Encrypted with handshake keys; shown decoded. The 1,930-byte Certificate record continues in the next segment.',
        sizeBytes: serverFlight1Frame.sizeBytes,
        encrypted: true,
        at: 250,
        wireTimeMs: 119.9,
        meta: serverFlight1Frame.meta,
      },
      {
        id: 'p-server-flight-2',
        from: 'edge',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'tls',
        label: 'CV + Finished',
        summary: 'Certificate (end), Certificate Verify, Finished (decoded)',
        headers: [
          ...serverFlight2Frame.lower,
          tlsHandshake({
            message: 'CertificateVerify',
            fields: [
              { name: 'signature_algorithm', value: 'ecdsa_secp256r1_sha256 (0x0403)' },
              { name: 'signature', value: 'about 72 bytes, over the handshake transcript hash' },
            ],
          }),
          tlsHandshake({
            message: 'Finished',
            fields: [{ name: 'verify_data', value: '32 bytes, HMAC-SHA-256 over the transcript' }],
          }),
        ],
        payload:
          'Encrypted with handshake keys; shown decoded. Starts with the last 519 bytes of the Certificate record.',
        sizeBytes: serverFlight2Frame.sizeBytes,
        encrypted: true,
        at: 500,
        wireTimeMs: 120,
        meta: serverFlight2Frame.meta,
      },
    ],
    actions: [
      {
        id: 'a-tlsflight-1',
        node: 'laptop',
        kind: 'decrypt',
        label: 'Handshake keys',
        at: 4900,
        durationMs: 800,
      },
    ],
    focus: ['edge', 'laptop'],
    simplifications: [
      ACK_NOTE,
      'The key schedule (HKDF extraction and expansion) is summarised as “derive keys”.',
      'Certificate sizes are illustrative; real chains vary. Headers show the decoded messages, whereas on the wire everything after the ServerHello is ciphertext.',
      NAT_INBOUND_NOTE,
    ],
    references: [
      REF.serverHello,
      REF.tlsCertificate,
      REF.certVerify,
      REF.finished,
      REF.keySchedule,
      REF.middlebox,
    ],
  },
  {
    id: 'tls-verify-certificate',
    title: 'Verify the certificate chain (local)',
    phase: 'tls',
    summary:
      'The browser decides whether to trust the server: chain to a trusted root, name match, validity dates, then the signature that proves the server holds the private key.',
    body: [
      para(
        'The browser walks the chain from the leaf towards a root it already trusts: the leaf was signed by the intermediate, and the intermediate by a root in the operating system or browser **trust store**. The root itself is never sent. Each signature and each validity date is checked.',
      ),
      para(
        'Then the **name**: `www.example.com` must match an entry in the certificate’s Subject Alternative Name list. The old Common Name field is not consulted.',
      ),
      para(
        'Finally **CertificateVerify** is checked. A certificate is public, so anyone could replay it; the signature over the handshake transcript proves that this server holds the matching private key. **Finished** then confirms that nobody altered the handshake.',
      ),
    ],
    packets: [],
    actions: [
      {
        id: 'a-verify-1',
        node: 'laptop',
        kind: 'verify',
        label: 'Chain to trusted root',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-verify-2',
        node: 'laptop',
        kind: 'verify',
        label: 'Name in SAN',
        at: 800,
        durationMs: 700,
      },
      {
        id: 'a-verify-3',
        node: 'laptop',
        kind: 'verify',
        label: 'Dates ok',
        at: 1600,
        durationMs: 700,
      },
      {
        id: 'a-verify-4',
        node: 'laptop',
        kind: 'verify',
        label: 'CertificateVerify',
        at: 2400,
        durationMs: 700,
      },
    ],
    focus: ['laptop'],
    simplifications: [
      'Revocation checks (OCSP stapling, CRLs), Certificate Transparency proofs, key-usage and name-constraint rules are not shown.',
      'Real validators also build the path from the certificates offered, which may arrive in a different order.',
    ],
    references: [REF.pathValidation, REF.serviceIdentity, REF.certVerify, REF.finished],
  },
  {
    id: 'tls-client-finished',
    title: 'Client Finished: switch to application keys',
    phase: 'tls',
    summary:
      'The client proves it saw the same handshake with its own **Finished** MAC. Both sides then switch to traffic keys, and application data can flow: one round trip in total.',
    body: [
      para(
        'The client derives its own handshake traffic key and sends a **Finished** record: a MAC over the entire transcript. When the edge verifies it, both sides agree on every byte exchanged so far.',
      ),
      para(
        'Both ends then compute **application traffic keys** from the same secret. Counting from the first SYN, the connection was ready to carry encrypted application data after the TCP handshake plus one TLS round trip, which is what “1-RTT” means.',
      ),
      note(
        'Because the keys came from ephemeral key shares, recording this connection and stealing the server’s long-term key later would not reveal the traffic. That property is **forward secrecy**.',
      ),
    ],
    packets: [
      {
        id: 'p-client-finished',
        from: 'laptop',
        to: 'edge',
        via: viaInternet(),
        protocol: 'tls',
        label: 'Finished',
        summary: 'Change Cipher Spec, Finished (decoded)',
        headers: [
          ...clientFinishedFrame.lower,
          tlsHandshake({
            message: 'ChangeCipherSpec',
            fields: [{ name: 'Payload', value: '0x01' }],
          }),
          tlsHandshake({
            message: 'Finished',
            fields: [{ name: 'verify_data', value: '32 bytes, HMAC-SHA-256 over the transcript' }],
          }),
        ],
        payload: 'Encrypted with the client handshake key; shown decoded.',
        sizeBytes: clientFinishedFrame.sizeBytes,
        encrypted: true,
        at: 700,
        wireTimeMs: 128.2,
        meta: clientFinishedFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-tlsfin-1',
        node: 'laptop',
        kind: 'process',
        label: 'Derive traffic keys',
        at: 0,
        durationMs: 600,
      },
      {
        id: 'a-tlsfin-2',
        node: 'edge',
        kind: 'verify',
        label: 'Check Finished',
        at: 4900,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'edge'],
    simplifications: [
      ACK_NOTE,
      'After this, the edge also sends a NewSessionTicket record for later resumption; it is omitted, as is the HTTP/2 SETTINGS exchange. Omitted bytes are not counted in sequence numbers.',
      NAT_NOTE,
    ],
    references: [REF.finished, REF.tlsOverview, REF.ticket],
  },
];

/** Steps 16-20: the HTTP request and the CDN. */
const getIndexFrame = tcpFrame(
  laptopFrame(IP.cdnEdge, 0x7a35),
  clientSegment(SEQ.getIndex, SEQ.indexResponse, LEN.getIndex, ['PSH', 'ACK']),
);

const ORIGIN_CLIENT_SEQ = 2210934502;
const ORIGIN_SERVER_SEQ = 718300227;
const ORIGIN_REQUEST_LEN = 143;
const ORIGIN_RESPONSE_LEN = 1281;

const originGetFrame = tcpFrame(
  {
    eth: { src: MAC.cdnEdge, dst: MAC.origin },
    ip: { src: IP.cdnEdge, dst: IP.origin, ttl: 64, id: 0x4b12, df: true },
  },
  {
    conn: 'edge-origin',
    srcPort: PORT_OF.edgeToOrigin,
    dstPort: HTTPS,
    seq: ORIGIN_CLIENT_SEQ,
    ack: ORIGIN_SERVER_SEQ,
    flags: ['PSH', 'ACK'],
    len: ORIGIN_REQUEST_LEN,
    window: 501,
  },
  { tracked: false },
);
const originResponseFrame = tcpFrame(
  {
    eth: { src: MAC.origin, dst: MAC.cdnEdge },
    ip: { src: IP.origin, dst: IP.cdnEdge, ttl: 64, id: 0, df: true },
  },
  {
    conn: 'edge-origin',
    srcPort: HTTPS,
    dstPort: PORT_OF.edgeToOrigin,
    seq: ORIGIN_SERVER_SEQ,
    ack: ORIGIN_CLIENT_SEQ + ORIGIN_REQUEST_LEN,
    flags: ['PSH', 'ACK'],
    len: ORIGIN_RESPONSE_LEN,
    window: 509,
  },
  { tracked: false },
);
const indexResponseFrame = tcpFrame(
  edgeFrame(),
  serverSegment(SEQ.indexResponse, SEQ.getCss, LEN.indexResponse, ['PSH', 'ACK']),
);

const CACHE_CONTROL_PAGE = 'public, max-age=0, s-maxage=60';

const httpCdnSteps: StepDef[] = [
  {
    id: 'http-get-index',
    title: 'GET / over HTTP/2, inside TLS',
    phase: 'http-cdn',
    summary:
      'The browser sends its request as an HTTP/2 HEADERS frame, encrypted in a TLS record. Only the sizes, timing and addresses are visible to anyone on the path.',
    body: [
      para(
        'ALPN settled on `h2`, so the request is an HTTP/2 **HEADERS** frame on stream 1. HTTP/2 replaces the `Host` header with the `:authority` pseudo-header, and puts `:method`, `:scheme` and `:path` beside it. Header names are lower-case and compressed with HPACK.',
      ),
      para(
        'The frame is wrapped in a TLS application-data record, so the path, the headers and any cookies are readable only by the browser and the edge. The same record also carries the HTTP/2 connection preface and SETTINGS, which a new connection must send first.',
      ),
    ],
    packets: [
      {
        id: 'p-get-index',
        from: 'laptop',
        to: 'edge',
        via: viaInternet(),
        protocol: 'http',
        label: 'GET /',
        summary: 'HEADERS[1]: GET /  (HTTP/2, inside TLS)',
        headers: [
          ...getIndexFrame.lower,
          tlsAppData(LEN.getIndex),
          http2Request({
            method: 'GET',
            authority: HOST.www,
            path: '/',
            headers: [
              ['Accept', 'text/html,application/xhtml+xml;q=0.9,*/*;q=0.8'],
              ['Accept-Encoding', 'gzip, br'],
              ['Accept-Language', 'en'],
              ['User-Agent', 'ExampleBrowser/1.0'],
            ],
          }),
        ],
        payload:
          'HTTP/2 connection preface, SETTINGS and the HEADERS frame (shown), encrypted in one TLS record.',
        sizeBytes: getIndexFrame.sizeBytes,
        encrypted: true,
        at: 500,
        wireTimeMs: 128.5,
        meta: getIndexFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-get-1',
        node: 'laptop',
        kind: 'encrypt',
        label: 'Encrypt request',
        at: 0,
        durationMs: 500,
      },
    ],
    focus: ['laptop', 'edge'],
    simplifications: [
      ACK_NOTE,
      'HPACK compression is not drawn; headers appear decoded. “ExampleBrowser/1.0” stands in for a real user-agent string.',
      'There are no cookies on a first visit. The preface and SETTINGS bytes count towards the segment size but are not itemised.',
      NAT_NOTE,
    ],
    references: [REF.h2Preface, REF.h2Request, REF.hpack, REF.httpGet],
  },
  {
    id: 'cdn-cache-miss',
    title: 'Edge cache lookup: MISS',
    phase: 'http-cdn',
    summary:
      'The edge ends the TLS session, decrypts the request, builds a cache key and looks it up. This edge holds no copy of the page, so it must go to the origin.',
    body: [
      para(
        'The CDN edge is where TLS **terminates**: the browser’s secure connection ends here, so the edge can read the request and answer it directly.',
      ),
      para(
        'It builds a **cache key** from the host and path, plus the request headers that the stored response would vary on. It looks this key up in its store. Another visitor may have fetched the page earlier, but not recently enough on this edge, so the result is a **MISS**.',
      ),
      note(
        'The edge is a **shared cache**: unlike the browser’s private cache it keeps one copy and serves it to many users, which is why it follows rules like `s-maxage`.',
      ),
    ],
    packets: [],
    actions: [
      {
        id: 'a-edge-1',
        node: 'edge',
        kind: 'decrypt',
        label: 'Terminate TLS',
        at: 0,
        durationMs: 600,
      },
      {
        id: 'a-edge-2',
        node: 'edge',
        kind: 'cache-lookup',
        label: 'Cache lookup',
        at: 700,
        durationMs: 700,
      },
      {
        id: 'a-edge-3',
        node: 'edge',
        kind: 'cache-miss',
        label: 'MISS',
        at: 1500,
        durationMs: 800,
      },
    ],
    focus: ['edge'],
    simplifications: [
      'Real CDNs normalise the cache key (query strings, cookies, headers) according to per-site settings.',
      'Load balancing inside the edge site and request collapsing (one origin fetch for many simultaneous misses) are not shown.',
    ],
    references: [REF.cacheKey, REF.httpCache],
  },
  {
    id: 'cdn-fetch-origin',
    title: 'Edge forwards the request to the origin',
    phase: 'http-cdn',
    summary:
      'The edge sends a `GET` to the origin over a connection it already keeps open, adding hints such as the client’s address. The origin is far away, so this leg is slow.',
    body: [
      para(
        'The edge asks the origin `origin.example.com` for the page. It does not open a new connection for each miss: it reuses a **pooled** connection that earlier requests already set up, so the TCP and TLS handshakes are skipped. This is one reason a CDN speeds up even uncacheable content.',
      ),
      para(
        'The request is HTTP/1.1 here. It repeats the original `Host`, adds `X-Forwarded-For` with the visitor’s public address `198.51.100.7` (the home router’s NAT address), and a `Via` header naming the cache. The origin sees the edge as its client, so it needs these headers to know who asked.',
      ),
    ],
    packets: [
      {
        id: 'p-origin-get',
        from: 'edge',
        to: 'origin',
        protocol: 'http',
        label: 'GET /',
        summary: 'GET / HTTP/1.1  (edge to origin, inside TLS)',
        headers: [
          ...originGetFrame.lower,
          tlsAppData(ORIGIN_REQUEST_LEN),
          http1Request({
            method: 'GET',
            path: '/',
            host: HOST.www,
            headers: [
              ['Accept-Encoding', 'gzip'],
              ['X-Forwarded-For', IP.routerPublic],
              ['Via', '1.1 ExampleCDN'],
            ],
          }),
        ],
        payload: 'Shown decoded; the edge-to-origin connection is usually TLS as well.',
        sizeBytes: originGetFrame.sizeBytes,
        encrypted: true,
        at: 0,
        wireTimeMs: 136.8,
        meta: originGetFrame.meta,
      },
    ],
    focus: ['edge', 'origin'],
    simplifications: [
      'The connection to the origin was opened earlier, so its handshakes are not drawn and its TCP numbers are not tracked.',
      'The edge-to-origin link is one hop here; real traffic crosses several networks.',
      'Real CDNs add their own request headers, and may use HTTP/2 or a private protocol towards the origin.',
    ],
    references: [REF.persistent, REF.via, REF.httpGet],
  },
  {
    id: 'origin-response',
    title: 'Origin answers 200 with caching rules',
    phase: 'http-cdn',
    summary:
      'The origin builds the page and replies `200 OK` with `Cache-Control: public, max-age=0, s-maxage=60`: browsers must revalidate, shared caches may keep it for a minute.',
    body: [
      para(
        'The origin generates the HTML and returns `200 OK`. The **Cache-Control** header tells each kind of cache what to do. `max-age=0` makes the response stale at once for the browser, so it must revalidate before reusing it. `s-maxage=60` overrides that for **shared caches** such as this CDN, allowing 60 seconds of reuse.',
      ),
      para(
        'The `ETag` is a validator for later conditional requests, and `Vary: Accept-Encoding` records that the body depends on the request’s `Accept-Encoding`, so the cache must key on it. The body is 1,024 bytes of gzip-compressed HTML.',
      ),
    ],
    packets: [
      {
        id: 'p-origin-200',
        from: 'origin',
        to: 'edge',
        protocol: 'http',
        label: '200 OK',
        summary: 'HTTP/1.1 200 OK (text/html, gzip)',
        headers: [
          ...originResponseFrame.lower,
          tlsAppData(ORIGIN_RESPONSE_LEN),
          http1Response({
            status: 200,
            headers: [
              ['Date', 'Fri, 13 Nov 2026 10:15:02 GMT'],
              ['Content-Type', 'text/html; charset=utf-8'],
              ['Content-Encoding', 'gzip'],
              ['Content-Length', '1024'],
              ['Cache-Control', CACHE_CONTROL_PAGE],
              ['ETag', '"a1b2c3"'],
              ['Vary', 'Accept-Encoding'],
            ],
          }),
        ],
        payload: '1,024 bytes of gzip-compressed HTML follow the headers.',
        sizeBytes: originResponseFrame.sizeBytes,
        encrypted: true,
        at: 700,
        wireTimeMs: 185.6,
        meta: originResponseFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-origin-1',
        node: 'origin',
        kind: 'process',
        label: 'Generate page',
        at: 0,
        durationMs: 600,
      },
    ],
    focus: ['origin', 'edge'],
    simplifications: [
      'The response is shown as one segment; a larger page would span many segments subject to congestion control.',
      'Origin processing is reduced to a label; real servers may query databases and caches.',
    ],
    references: [REF.sMaxAge, REF.maxAge, REF.etag, REF.http200, REF.cacheKey],
  },
  {
    id: 'cdn-store-and-reply',
    title: 'Edge stores the page and sends 200 to you',
    phase: 'http-cdn',
    summary:
      'The edge stores the response for 60 seconds, re-encrypts it for the browser and adds `Cache-Status: ExampleCDN; fwd=uri-miss; stored`.',
    body: [
      para(
        'Because `public` and `s-maxage=60` permit it, the edge **stores** the response and will serve it to other visitors for the next 60 seconds without bothering the origin.',
      ),
      para(
        'It then answers the browser inside the original TLS session, as an HTTP/2 HEADERS frame followed by a DATA frame. The **Cache-Status** header, defined by RFC 9211, records what the cache did: `fwd=uri-miss` means “no stored response for this URI, so I forwarded the request”, and `stored` means the new response was saved. No `Age` appears, because the copy is fresh from the origin.',
      ),
    ],
    packets: [
      {
        id: 'p-index-200',
        from: 'edge',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'http',
        label: '200 OK (MISS)',
        summary: 'HEADERS[1]: 200 OK, DATA[1] (text/html, 1,024 bytes)',
        headers: [
          ...indexResponseFrame.lower,
          tlsAppData(LEN.indexResponse),
          http2Response({
            status: 200,
            headers: [
              ['Date', 'Fri, 13 Nov 2026 10:15:02 GMT'],
              ['Content-Type', 'text/html; charset=utf-8'],
              ['Content-Encoding', 'gzip'],
              ['Content-Length', '1024'],
              ['Cache-Control', CACHE_CONTROL_PAGE],
              ['ETag', '"a1b2c3"'],
              ['Vary', 'Accept-Encoding'],
              ['Cache-Status', 'ExampleCDN; fwd=uri-miss; stored'],
            ],
          }),
        ],
        payload: 'DATA frame: 1,024 bytes of gzip-compressed HTML.',
        sizeBytes: indexResponseFrame.sizeBytes,
        encrypted: true,
        at: 1300,
        wireTimeMs: 232.8,
        meta: indexResponseFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-store-1',
        node: 'edge',
        kind: 'store',
        label: 'Store for 60 s',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-store-2',
        node: 'edge',
        kind: 'encrypt',
        label: 'Encrypt reply',
        at: 800,
        durationMs: 400,
      },
      {
        id: 'a-store-3',
        node: 'laptop',
        kind: 'decrypt',
        label: 'Decrypt + gunzip',
        at: 5500,
        durationMs: 700,
      },
    ],
    focus: ['edge', 'laptop'],
    simplifications: [
      ACK_NOTE,
      'The HTTP/2 SETTINGS acknowledgements and flow-control frames are omitted.',
      'The response fits one segment here; real pages are larger and are sent over many segments.',
      NAT_INBOUND_NOTE,
    ],
    references: [REF.cacheStatus, REF.httpCache, REF.sMaxAge, REF.age],
  },
];

/** Steps 21-23: subresources. */
const getCssFrame = tcpFrame(
  laptopFrame(IP.cdnEdge, 0x7a36),
  clientSegment(SEQ.getCss, SEQ.cssResponse, LEN.getCss, ['PSH', 'ACK']),
);
const cssResponseFrame = tcpFrame(
  edgeFrame(),
  serverSegment(SEQ.cssResponse, SEQ.clientEnd, LEN.cssResponse, ['PSH', 'ACK']),
);

const subresourceSteps: StepDef[] = [
  {
    id: 'html-parse',
    title: 'Parse the HTML and find subresources',
    phase: 'subresources',
    summary:
      'The browser decompresses and parses the HTML into a DOM tree and spots the stylesheet, script and image it still needs. The script will make a cross-origin request.',
    body: [
      para(
        'The response is decrypted, gunzipped and fed to the HTML parser as the bytes arrive. The parser builds the **DOM** tree and, on reaching `<link rel="stylesheet" href="/app.css">` in the head, discovers a render-blocking resource. A look-ahead scanner finds `<script defer src="/app.js">` and an `<img>` early, so their downloads can start sooner.',
      ),
      para(
        'All of these have the same origin as the page, so they reuse the existing HTTP/2 connection as separate **streams**: no new DNS, TCP or TLS handshakes are needed. Later, `app.js` will call `fetch()` on a different origin, `api.example.net`.',
      ),
    ],
    packets: [],
    actions: [
      {
        id: 'a-html-1',
        node: 'laptop',
        kind: 'process',
        label: 'Parse HTML',
        at: 0,
        durationMs: 800,
      },
      {
        id: 'a-html-2',
        node: 'laptop',
        kind: 'process',
        label: 'Build DOM',
        at: 900,
        durationMs: 800,
      },
      {
        id: 'a-html-3',
        node: 'laptop',
        kind: 'process',
        label: 'Find /app.css',
        at: 1800,
        durationMs: 800,
      },
    ],
    focus: ['laptop'],
    simplifications: [
      'Only the stylesheet request and the later API call are drawn. The script and the image would travel as further streams in the same way.',
      'The details of look-ahead scanning and request priorities differ between browsers.',
    ],
    references: [REF.htmlParsing, REF.h2Streams],
  },
  {
    id: 'get-css',
    title: 'GET /app.css on the same connection',
    phase: 'subresources',
    summary:
      'The browser requests the stylesheet as a new HTTP/2 stream on the existing TLS connection. The request is much smaller than the first because HPACK reuses earlier header fields.',
    body: [
      para(
        'This request needs no new connection. It goes out as stream 3 (client-initiated streams use odd numbers) on the same TCP connection and TLS session, so it benefits from the warm congestion window and avoids a new TCP and TLS handshake.',
      ),
      para(
        'HPACK keeps a dynamic table of header fields both sides have already seen. `:authority`, `accept-encoding` and `user-agent` are therefore sent as one- or two-byte references to table entries, so the request is only 71 bytes instead of 191.',
      ),
    ],
    packets: [
      {
        id: 'p-get-css',
        from: 'laptop',
        to: 'edge',
        via: viaInternet(),
        protocol: 'http',
        label: 'GET /app.css',
        summary: 'HEADERS[3]: GET /app.css  (HTTP/2, inside TLS)',
        headers: [
          ...getCssFrame.lower,
          tlsAppData(LEN.getCss),
          http2Request({
            method: 'GET',
            authority: HOST.www,
            path: '/app.css',
            headers: [
              ['Accept', 'text/css,*/*;q=0.1'],
              ['Accept-Encoding', 'gzip, br'],
              ['User-Agent', 'ExampleBrowser/1.0'],
              ['Referer', `https://${HOST.www}/`],
            ],
          }),
        ],
        payload: 'HTTP/2 stream 3, encrypted in one TLS record.',
        sizeBytes: getCssFrame.sizeBytes,
        encrypted: true,
        at: 0,
        wireTimeMs: 244.6,
        meta: getCssFrame.meta,
      },
    ],
    focus: ['laptop', 'edge'],
    simplifications: [
      ACK_NOTE,
      'Headers are shown decoded and in full; on the wire HPACK replaces most of them with table indexes.',
      NAT_NOTE,
    ],
    references: [REF.h2Streams, REF.hpack, REF.h2Request],
  },
  {
    id: 'css-cache-hit',
    title: 'Edge answers from cache: HIT',
    phase: 'subresources',
    summary:
      'This stylesheet is already stored at the edge, so it replies at once with `Age: 214` and `Cache-Status: ExampleCDN; hit`. The origin is never contacted.',
    body: [
      para(
        'A visitor earlier today caused this stylesheet to be stored. The edge finds the entry, sees that it is still fresh (it allows `max-age=3600` and has been stored for 214 seconds), and replies straight away. That is a **HIT**, and the long trip to the origin is skipped.',
      ),
      para(
        'The **Age** header reports how many seconds the response has spent in caches, and **Cache-Status** carries the verdict, `hit`. Because the browser may reuse it too, the stylesheet will be served from its HTTP cache on later visits until `max-age` runs out.',
      ),
    ],
    packets: [
      {
        id: 'p-css-200',
        from: 'edge',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'http',
        label: '200 OK (HIT)',
        summary: 'HEADERS[3]: 200 OK, DATA[3] (text/css, 1,000 bytes)',
        headers: [
          ...cssResponseFrame.lower,
          tlsAppData(LEN.cssResponse),
          http2Response({
            status: 200,
            headers: [
              ['Date', 'Fri, 13 Nov 2026 10:15:02 GMT'],
              ['Content-Type', 'text/css; charset=utf-8'],
              ['Content-Encoding', 'gzip'],
              ['Content-Length', '1000'],
              ['Cache-Control', 'public, max-age=3600'],
              ['Age', '214'],
              ['ETag', '"css-9f31"'],
              ['Cache-Status', 'ExampleCDN; hit'],
            ],
          }),
        ],
        payload: 'DATA frame: 1,000 bytes of gzip-compressed CSS.',
        sizeBytes: cssResponseFrame.sizeBytes,
        encrypted: true,
        at: 900,
        wireTimeMs: 252,
        meta: cssResponseFrame.meta,
      },
    ],
    actions: [
      { id: 'a-hit-1', node: 'edge', kind: 'cache-hit', label: 'HIT', at: 0, durationMs: 800 },
      {
        id: 'a-hit-2',
        node: 'laptop',
        kind: 'process',
        label: 'Build CSSOM',
        at: 5200,
        durationMs: 800,
      },
    ],
    focus: ['edge', 'laptop'],
    simplifications: [
      ACK_NOTE,
      'The stylesheet is far smaller than typical CSS so that it fits one segment.',
      'The `Date` header repeats the page’s value for brevity; a real HIT would show the time of this response.',
      NAT_INBOUND_NOTE,
    ],
    references: [REF.age, REF.cacheStatus, REF.maxAge, REF.httpCache],
  },
];

/** Steps 24-27: the cross-origin request. */
const OPTIONS_LEN = 164;
const OPTIONS_RESPONSE_LEN = 187;
const POST_LEN = 197;
const POST_RESPONSE_LEN = 205;
const API_CLIENT_SEQ = 3318450119;
const API_SERVER_SEQ = 905512776;
const PAGE_ORIGIN = `https://${HOST.www}`;
const PREFERENCES_PATH = '/v1/preferences';

const apiClientFrame = (id: number, seq: number, len: number): Frame =>
  tcpFrame(
    laptopFrame(IP.api, id),
    {
      conn: 'laptop-api',
      srcPort: PORT_OF.api,
      dstPort: HTTPS,
      seq,
      ack: API_SERVER_SEQ + (seq === API_CLIENT_SEQ ? 0 : OPTIONS_RESPONSE_LEN),
      flags: ['PSH', 'ACK'],
      len,
      window: 502,
    },
    { tracked: false },
  );
const apiServerFrame = (seq: number, ack: number, len: number): Frame =>
  tcpFrame(
    {
      eth: { src: REMOTE_MAC.apiNic, dst: REMOTE_MAC.apiGw },
      ip: { src: IP.api, dst: IP.routerPublic, ttl: 64, id: 0, df: true },
    },
    {
      conn: 'laptop-api',
      srcPort: HTTPS,
      dstPort: PORT_OF.api,
      seq,
      ack,
      flags: ['PSH', 'ACK'],
      len,
      window: 509,
    },
    { tracked: false },
  );

const optionsFrame = apiClientFrame(0x7a40, API_CLIENT_SEQ, OPTIONS_LEN);
const optionsResponseFrame = apiServerFrame(
  API_SERVER_SEQ,
  API_CLIENT_SEQ + OPTIONS_LEN,
  OPTIONS_RESPONSE_LEN,
);
const postFrame = apiClientFrame(0x7a41, API_CLIENT_SEQ + OPTIONS_LEN, POST_LEN);
const postResponseFrame = apiServerFrame(
  API_SERVER_SEQ + OPTIONS_RESPONSE_LEN,
  API_CLIENT_SEQ + OPTIONS_LEN + POST_LEN,
  POST_RESPONSE_LEN,
);

const API_CONNECTION_NOTE =
  'DNS lookup, TCP handshake and TLS handshake to api.example.net would run first, as in steps 4 to 15. They are collapsed, the connection is shown already open, and its TCP sequence numbers are not tracked.';

const corsSteps: StepDef[] = [
  {
    id: 'cors-preflight-request',
    title: 'Cross-origin POST: the browser sends a preflight',
    phase: 'cors',
    summary:
      'The page’s script calls `fetch()` on another origin with JSON and cookies. Before sending it, the browser asks the API with an `OPTIONS` **preflight** whether that is allowed.',
    body: [
      para(
        '`https://api.example.net` is a different origin from the page, so the browser enforces **CORS**. A POST with `Content-Type: application/json` is not a “simple” request, because only form-style content types are CORS-safelisted. The browser therefore first sends an `OPTIONS` request that asks permission.',
      ),
      para(
        'The preflight names the page’s `Origin`, the method in `Access-Control-Request-Method`, and the non-safelisted headers in `Access-Control-Request-Headers`. It is sent **without credentials**, so the cookie is not attached. The real request has not left the browser yet.',
      ),
      {
        type: 'code',
        caption: 'The script in app.js',
        text: `fetch('https://api.example.net${PREFERENCES_PATH}', {\n  method: 'POST',\n  credentials: 'include',\n  headers: { 'Content-Type': 'application/json' },\n  body: JSON.stringify({ theme: 'dark' }),\n});`,
      },
    ],
    packets: [
      {
        id: 'p-options',
        from: 'laptop',
        to: 'api',
        via: viaInternet(),
        protocol: 'http',
        label: 'OPTIONS',
        summary: `HEADERS[1]: OPTIONS ${PREFERENCES_PATH}  (CORS preflight)`,
        headers: [
          ...optionsFrame.lower,
          tlsAppData(OPTIONS_LEN),
          http2Request({
            method: 'OPTIONS',
            authority: HOST.api,
            path: PREFERENCES_PATH,
            headers: [
              ['Accept', '*/*'],
              ['Access-Control-Request-Method', 'POST'],
              ['Access-Control-Request-Headers', 'content-type'],
              ['Origin', PAGE_ORIGIN],
              ['Referer', `${PAGE_ORIGIN}/`],
              ['User-Agent', 'ExampleBrowser/1.0'],
            ],
          }),
        ],
        payload: 'No cookies are sent with a preflight.',
        sizeBytes: optionsFrame.sizeBytes,
        encrypted: true,
        at: 800,
        wireTimeMs: 331.9,
        meta: optionsFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-cors1-1',
        node: 'laptop',
        kind: 'process',
        label: 'fetch(): cross-origin',
        at: 0,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: [
      API_CONNECTION_NOTE,
      'The timestamps skip the time those handshakes would take.',
      NAT_NOTE,
    ],
    references: [REF.cors, REF.corsPreflight, REF.origin],
  },
  {
    id: 'cors-preflight-response',
    title: '204: the API grants permission',
    phase: 'cors',
    summary:
      'The API answers the preflight with `204` and `Access-Control-Allow-*` headers naming the page’s exact origin, the method, the header and `credentials: true`.',
    body: [
      para(
        'The preflight must succeed with a 2xx status. `204 No Content` is typical, since only the headers matter. `Access-Control-Allow-Origin` must name the page’s exact origin, never `*`, because the real request will carry credentials. `Access-Control-Allow-Credentials: true` permits that, and `Access-Control-Allow-Methods` and `Access-Control-Allow-Headers` list the method and header that were asked about.',
      ),
      para(
        '`Access-Control-Max-Age: 600` lets the browser remember the permission for ten minutes, skipping the preflight on repeats. `Vary: Origin` stops a shared cache from handing this answer to a different origin.',
      ),
    ],
    packets: [
      {
        id: 'p-options-204',
        from: 'api',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'http',
        label: '204 (preflight)',
        summary: 'HEADERS[1]: 204 No Content (CORS preflight response)',
        headers: [
          ...optionsResponseFrame.lower,
          tlsAppData(OPTIONS_RESPONSE_LEN),
          http2Response({
            status: 204,
            headers: [
              ['Access-Control-Allow-Origin', PAGE_ORIGIN],
              ['Access-Control-Allow-Credentials', 'true'],
              ['Access-Control-Allow-Methods', 'POST'],
              ['Access-Control-Allow-Headers', 'content-type'],
              ['Access-Control-Max-Age', '600'],
              ['Vary', 'Origin'],
            ],
          }),
        ],
        sizeBytes: optionsResponseFrame.sizeBytes,
        encrypted: true,
        at: 0,
        wireTimeMs: 341.7,
        meta: optionsResponseFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-cors2-1',
        node: 'laptop',
        kind: 'verify',
        label: 'Preflight allowed',
        at: 4300,
        durationMs: 800,
      },
    ],
    focus: ['api', 'laptop'],
    simplifications: [
      'The connection to the API is shown already open; its TCP numbers are not tracked.',
      'Real APIs often list several methods and headers, and may repeat the `Vary` values for the request headers.',
      NAT_INBOUND_NOTE,
    ],
    references: [REF.corsPreflight, REF.corsCredentials, REF.http204],
  },
  {
    id: 'cors-actual-request',
    title: 'The real POST, with the session cookie',
    phase: 'cors',
    summary:
      'With permission granted, the browser sends the actual `POST`: JSON body, an `Origin` header, and the cookie because `credentials: "include"` was asked for.',
    body: [
      para(
        'The browser now sends the request the script asked for. It carries `Origin: https://www.example.com`, `Content-Type: application/json` and a small JSON body. Because `credentials: "include"` was set, the browser also attaches the API’s cookie, if it is allowed to send one.',
      ),
      para(
        'The API sees the request exactly like any other POST. CORS did not change what the server receives; it only governed whether the browser was willing to send the request and, afterwards, whether the page may read the reply.',
      ),
      warning(
        'CORS is enforced by the browser alone. It does not stop `curl`, and it is not a defence against cross-site request forgery.',
      ),
    ],
    packets: [
      {
        id: 'p-post',
        from: 'laptop',
        to: 'api',
        via: viaInternet(),
        protocol: 'http',
        label: 'POST',
        summary: `HEADERS[3]: POST ${PREFERENCES_PATH}, DATA[3] (application/json)`,
        headers: [
          ...postFrame.lower,
          tlsAppData(POST_LEN),
          http2Request({
            method: 'POST',
            authority: HOST.api,
            path: PREFERENCES_PATH,
            headers: [
              ['Accept', '*/*'],
              ['Content-Type', 'application/json'],
              ['Content-Length', '16'],
              ['Cookie', 'sid=7f3a9c'],
              ['Origin', PAGE_ORIGIN],
              ['Referer', `${PAGE_ORIGIN}/`],
              ['User-Agent', 'ExampleBrowser/1.0'],
            ],
          }),
        ],
        payload: '{"theme":"dark"}',
        sizeBytes: postFrame.sizeBytes,
        encrypted: true,
        at: 0,
        wireTimeMs: 351.1,
        meta: postFrame.meta,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: [
      'Whether the cookie is actually attached also depends on its SameSite attribute and on the browser’s third-party cookie rules, which are not drawn.',
      'The connection to the API is shown already open; its TCP numbers are not tracked.',
      NAT_NOTE,
    ],
    references: [REF.cors, REF.corsCredentials, REF.httpGet],
  },
  {
    id: 'cors-actual-response',
    title: '200 with Allow-Origin: the page may read it',
    phase: 'cors',
    summary:
      'The API replies `200` with `Access-Control-Allow-Origin` and `Allow-Credentials`. The browser checks them and only then lets the script read the response.',
    body: [
      para(
        'The response reaches the browser, which runs the CORS check **before** handing the body to the script. `Access-Control-Allow-Origin` must match the page’s origin exactly. Because credentials were included, `Access-Control-Allow-Credentials: true` is needed too, and `*` would be rejected.',
      ),
      para(
        'The check passes, so `fetch()` resolves and the script can read `{"saved":true}`. Had the header been missing, the request would still have reached the API and changed its state, but the browser would have refused to show the page the response.',
      ),
    ],
    packets: [
      {
        id: 'p-post-200',
        from: 'api',
        to: 'laptop',
        via: ['internet', 'isp-router', 'home-router'],
        protocol: 'http',
        label: '200 + ACAO',
        summary: 'HEADERS[3]: 200 OK, DATA[3] (application/json)',
        headers: [
          ...postResponseFrame.lower,
          tlsAppData(POST_RESPONSE_LEN),
          http2Response({
            status: 200,
            headers: [
              ['Access-Control-Allow-Origin', PAGE_ORIGIN],
              ['Access-Control-Allow-Credentials', 'true'],
              ['Vary', 'Origin'],
              ['Content-Type', 'application/json'],
              ['Content-Length', '14'],
              ['Cache-Control', 'no-store'],
            ],
          }),
        ],
        payload: '{"saved":true}',
        sizeBytes: postResponseFrame.sizeBytes,
        encrypted: true,
        at: 0,
        wireTimeMs: 362.6,
        meta: postResponseFrame.meta,
      },
    ],
    actions: [
      {
        id: 'a-cors4-1',
        node: 'laptop',
        kind: 'verify',
        label: 'CORS check passed',
        at: 4300,
        durationMs: 800,
      },
    ],
    focus: ['api', 'laptop'],
    simplifications: [
      'The connection to the API is shown already open; its TCP numbers are not tracked.',
      'The browser also checks `Access-Control-Expose-Headers` when a script reads response headers; no extra headers are exposed here.',
      NAT_INBOUND_NOTE,
    ],
    references: [REF.cors, REF.corsCredentials, REF.http200],
  },
];

/** Step 28: render. */
const renderSteps: StepDef[] = [
  {
    id: 'render-pipeline',
    title: 'Render: DOM, CSSOM, layout, paint, composite',
    phase: 'render',
    summary:
      'The browser combines the DOM and CSS into a render tree, computes the geometry, paints it into layers and composites them onto the screen. The page appears.',
    body: [
      para(
        'The **DOM** comes from the HTML and the **CSSOM** from `app.css`. Combining them gives each visible element its computed style: the **render tree**. Elements with `display: none` are left out.',
      ),
      para(
        '**Layout** works out each box’s size and position. **Paint** turns boxes into drawing instructions, such as text, borders and backgrounds, in layers. **Composite** hands the layers to the GPU, which stacks them on screen. Animating `transform` or `opacity` can often skip layout and paint.',
      ),
      note(
        'Rendering is not a one-time event. When the API response changes the DOM, the browser runs the affected steps again.',
      ),
    ],
    packets: [],
    actions: [
      { id: 'a-render-1', node: 'laptop', kind: 'process', label: 'DOM', at: 0, durationMs: 600 },
      {
        id: 'a-render-2',
        node: 'laptop',
        kind: 'process',
        label: 'CSSOM',
        at: 700,
        durationMs: 600,
      },
      {
        id: 'a-render-3',
        node: 'laptop',
        kind: 'process',
        label: 'Render tree',
        at: 1400,
        durationMs: 600,
      },
      {
        id: 'a-render-4',
        node: 'laptop',
        kind: 'process',
        label: 'Layout',
        at: 2100,
        durationMs: 600,
      },
      {
        id: 'a-render-5',
        node: 'laptop',
        kind: 'render',
        label: 'Paint',
        at: 2800,
        durationMs: 600,
      },
      {
        id: 'a-render-6',
        node: 'laptop',
        kind: 'render',
        label: 'Composite',
        at: 3500,
        durationMs: 700,
      },
    ],
    focus: ['laptop'],
    simplifications: [
      'Real engines overlap and pipeline these stages and use more of them (style recalculation, layer tree, raster); the names vary between browsers.',
      'JavaScript execution, fonts and images are not drawn.',
    ],
    references: [REF.rendering, REF.cssom, REF.htmlParsing],
  },
];

// ---------------------------------------------------------------------------
// The scenario
// ---------------------------------------------------------------------------

const steps: StepDef[] = [
  ...parseSteps,
  ...cacheSteps,
  ...dnsSteps,
  ...tcpSteps,
  ...tlsSteps,
  ...httpCdnSteps,
  ...subresourceSteps,
  ...corsSteps,
  ...renderSteps,
];

export default defineScenario({
  id: 'url-journey',
  title: 'URL journey',
  tagline: 'From typing an address to a rendered page: DNS, TCP, TLS, a CDN, CORS and rendering.',
  category: 'journey',
  order: 1,
  protocols: ['ethernet', 'ipv4', 'udp', 'tcp', 'dns', 'tls', 'http'],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'Your laptop',
      sublabel: IP.laptop,
      position: { col: 0, row: 6 },
      zone: 'home',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop, hostname: HOST.laptop },
    },
    {
      id: 'home-router',
      kind: 'router',
      label: 'Home router',
      sublabel: `${IP.routerLan} · NAT`,
      position: { col: 2.5, row: 6 },
      zone: 'home',
      addresses: { ipv4: IP.routerLan, mac: MAC.routerLan },
    },
    {
      id: 'isp-router',
      kind: 'router',
      label: 'ISP router',
      sublabel: IP.ispRouter,
      position: { col: 5, row: 6 },
      zone: 'isp',
      addresses: { ipv4: IP.ispRouter, mac: MAC.ispRouterDown },
    },
    {
      id: 'resolver',
      kind: 'dns-resolver',
      label: 'ISP resolver',
      sublabel: IP.ispResolver,
      position: { col: 5, row: 8.6 },
      zone: 'isp',
      addresses: { ipv4: IP.ispResolver, mac: MAC.ispResolver },
    },
    {
      id: 'internet',
      kind: 'cloud',
      label: 'The internet',
      sublabel: 'many routers',
      position: { col: 7.5, row: 6 },
      zone: 'internet',
    },
    {
      id: 'root',
      kind: 'dns-root',
      label: REAL_INFRA.root.name,
      sublabel: IP.root,
      position: { col: 6.4, row: 1.9 },
      zone: 'dns',
      addresses: { ipv4: IP.root, hostname: REAL_INFRA.root.name },
    },
    {
      id: 'tld',
      kind: 'dns-tld',
      label: REAL_INFRA.tldCom.name,
      sublabel: IP.tldCom,
      position: { col: 8.7, row: 1.9 },
      zone: 'dns',
      addresses: { ipv4: IP.tldCom, hostname: REAL_INFRA.tldCom.name },
    },
    {
      id: 'auth',
      kind: 'dns-authoritative',
      label: HOST.ns,
      sublabel: IP.authoritativeNs,
      position: { col: 11.4, row: 2.3 },
      zone: 'dns',
      addresses: { ipv4: IP.authoritativeNs, hostname: HOST.ns },
    },
    {
      id: 'edge',
      kind: 'cdn-edge',
      label: 'CDN edge',
      sublabel: IP.cdnEdge,
      position: { col: 10, row: 6 },
      zone: 'edge',
      addresses: { ipv4: IP.cdnEdge, mac: MAC.cdnEdge, hostname: HOST.www },
    },
    {
      id: 'origin',
      kind: 'origin-server',
      label: 'Origin server',
      sublabel: IP.origin,
      position: { col: 12.5, row: 6 },
      zone: 'dc',
      addresses: { ipv4: IP.origin, mac: MAC.origin, hostname: HOST.origin },
    },
    {
      id: 'api',
      kind: 'api-server',
      label: 'API server',
      sublabel: IP.api,
      position: { col: 7.5, row: 8.8 },
      zone: 'api',
      addresses: { ipv4: IP.api, hostname: HOST.api },
    },
  ],
  links: [
    { id: 'laptop-home-router', a: 'laptop', b: 'home-router', medium: 'wifi' },
    { id: 'home-router-isp-router', a: 'home-router', b: 'isp-router', medium: 'wan' },
    { id: 'isp-router-resolver', a: 'isp-router', b: 'resolver', medium: 'ethernet' },
    { id: 'isp-router-internet', a: 'isp-router', b: 'internet', medium: 'backbone' },
    { id: 'internet-root', a: 'internet', b: 'root', medium: 'backbone' },
    { id: 'internet-tld', a: 'internet', b: 'tld', medium: 'backbone' },
    { id: 'internet-auth', a: 'internet', b: 'auth', medium: 'backbone' },
    { id: 'internet-edge', a: 'internet', b: 'edge', medium: 'backbone' },
    { id: 'internet-api', a: 'internet', b: 'api', medium: 'backbone' },
    { id: 'edge-origin', a: 'edge', b: 'origin', medium: 'backbone' },
  ],
  zones: [
    {
      id: 'home',
      label: 'Home LAN',
      from: { col: -0.9, row: 4.7 },
      to: { col: 3.4, row: 7.3 },
      tone: 'lan',
    },
    {
      id: 'isp',
      label: 'ISP',
      from: { col: 4.1, row: 4.7 },
      to: { col: 5.9, row: 9.6 },
      tone: 'isp',
    },
    {
      id: 'internet',
      label: 'Internet',
      from: { col: 6.6, row: 4.7 },
      to: { col: 8.4, row: 7.3 },
      tone: 'internet',
    },
    {
      id: 'dns',
      label: 'DNS hosts',
      from: { col: 5.5, row: 1.0 },
      to: { col: 12.3, row: 3.2 },
      tone: 'remote',
    },
    {
      id: 'edge',
      label: 'Edge PoP',
      from: { col: 9.1, row: 4.7 },
      to: { col: 10.9, row: 7.3 },
      tone: 'internet',
    },
    {
      id: 'dc',
      label: 'Data centre',
      from: { col: 11.5, row: 4.7 },
      to: { col: 13.6, row: 7.3 },
      tone: 'datacenter',
    },
    {
      id: 'api',
      label: 'API',
      from: { col: 6.6, row: 7.7 },
      to: { col: 8.4, row: 10 },
      tone: 'remote',
    },
  ],
  phases: PHASES,
  steps,
  sequenceLanes: ['laptop', 'resolver', 'root', 'tld', 'auth', 'edge', 'origin', 'api'],
  addressAllowlist: ADDRESS_ALLOWLIST,
});
