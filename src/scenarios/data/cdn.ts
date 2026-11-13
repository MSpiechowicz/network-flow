import { defineScenario } from '../../model/types';
import type {
  HeaderGroup,
  NodeId,
  PacketDef,
  PacketMeta,
  Reference,
  StepDef,
} from '../../model/types';
import { EPHEMERAL_PORTS, HOST, IP, ISN, MAC, PORT, mac } from '../lib/addresses';
import { ethernet, http2Request, http2Response, ipv4, tcp, tlsHandshake } from '../lib/builders';
import type { HeaderList } from '../lib/builders';

/**
 * CDN: user A misses at the edge, user B hits, the edge revalidates with the origin, and a
 * `private` response is forwarded but not stored.
 *
 * Every HTTP exchange rides on HTTP/2 over TLS. TCP and TLS setup is collapsed, so the first
 * segment in each direction of a connection carries `resync` and the sequence numbers already
 * include the handshake bytes.
 */

// ---------------------------------------------------------------------------
// Addressing for this scenario
// ---------------------------------------------------------------------------

const USER_AGENT = 'ExampleBrowser/1.0';
/** Next-hop router MACs on the CDN edge and origin sides. */
const MAC_EDGE_GW = mac(0x44);
const MAC_ORIGIN_GW = mac(0x45);

/** Bytes the collapsed TCP and TLS 1.3 handshake already consumed in each direction. */
const HANDSHAKE_BYTES = { client: 597, server: 3980 } as const;

// ---------------------------------------------------------------------------
// Local helpers: one TCP flow per connection, HTTP/2-in-TLS packets, a wire clock
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

/** TCP data segments with timestamps (32-byte TCP header). Pure ACKs are not drawn. */
function createFlow(conn: string, client: Endpoint, server: Endpoint, firstIpId: number) {
  const nextSeq: Record<Dir, number> = { c2s: client.seq, s2c: server.seq };
  const started: Record<Dir, boolean> = { c2s: false, s2c: false };
  let clientIpId = firstIpId;

  return {
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

/** Rough HPACK size of a header block: Huffman coding and the dynamic table shrink it. */
function hpackBytes(app: HeaderGroup): number {
  const raw = app.fields.reduce((sum, f) => sum + f.name.length + f.value.length, 0);

  return Math.round(raw * 0.6);
}

/** TLS record carrying a HEADERS frame and, when there is a body, one DATA frame. */
function recordLength(app: HeaderGroup, bodyBytes: number): number {
  const frames = 9 + hpackBytes(app) + (bodyBytes > 0 ? 9 + bodyBytes : 0);

  return 5 + frames + 1 + 16;
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

const START_UTC = Date.UTC(2026, 10, 13, 9, 0, 0);

/** `Date` header value `seconds` after the scenario's start. */
function httpDate(seconds: number): string {
  return new Date(START_UTC + seconds * 1000).toUTCString();
}

type Flow = ReturnType<typeof createFlow>;

interface H2PacketSpec {
  id: string;
  flow: Flow;
  dir: Dir;
  app: HeaderGroup;
  /** Size of the response or request body in bytes (as sent, after compression). */
  bodyBytes?: number;
  /** Human summary of the body shown in the inspector. */
  payload?: string;
  label: string;
  summary: string;
  at: number;
  /** Capture time in milliseconds since the scenario started. */
  wireMs: number;
}

function h2Packet(spec: H2PacketSpec): PacketDef {
  const len = recordLength(spec.app, spec.bodyBytes ?? 0);
  const segment = spec.flow.segment(spec.dir, len);

  return {
    id: spec.id,
    from: segment.from,
    to: segment.to,
    via: segment.via,
    protocol: 'http',
    label: spec.label,
    summary: spec.summary,
    headers: [
      ...segment.headers,
      tlsHandshake({
        message: 'ApplicationData',
        fields: [
          { name: 'Record Length', value: String(len - 5) },
          {
            name: 'Protection',
            value: 'TLS_AES_128_GCM_SHA256',
            note: 'HTTP/2 frames are encrypted',
          },
        ],
      }),
      spec.app,
    ],
    ...(spec.payload === undefined ? {} : { payload: spec.payload }),
    sizeBytes: segment.sizeBytes,
    encrypted: true,
    at: spec.at,
    wireTimeMs: wireTo(spec.wireMs),
    meta: segment.meta,
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const homeClient = (
  node: NodeId,
  ip: string,
  clientMac: string,
  port: number,
  seq: number,
): Endpoint => ({
  node,
  ip,
  seenAs: IP.routerPublic,
  mac: clientMac,
  nextHopMac: MAC.routerLan,
  via: ['router', 'cloud'],
  port,
  seq,
});

const edgeToUser = (seq: number): Endpoint => ({
  node: 'edge',
  ip: IP.cdnEdge,
  mac: MAC.cdnEdge,
  nextHopMac: MAC_EDGE_GW,
  via: ['cloud', 'router'],
  port: PORT.https,
  seq,
});

/** User A's HTTP/2 connection to the edge. */
const flowA = createFlow(
  'laptop-edge',
  homeClient(
    'laptop',
    IP.laptop,
    MAC.laptop,
    EPHEMERAL_PORTS[0],
    ISN.client + 1 + HANDSHAKE_BYTES.client,
  ),
  edgeToUser(ISN.server + 1 + HANDSHAKE_BYTES.server),
  0x4a10,
);

/** User B's HTTP/2 connection to the edge. */
const flowB = createFlow(
  'phone-edge',
  homeClient(
    'phone',
    IP.phone,
    MAC.phone,
    EPHEMERAL_PORTS[2],
    ISN.client + 3_000_000 + 1 + HANDSHAKE_BYTES.client,
  ),
  edgeToUser(ISN.server + 2_000_000 + 1 + HANDSHAKE_BYTES.server),
  0x2d51,
);

/** The edge's pooled HTTP/2 connection to the origin; earlier requests already used some bytes. */
const flowOrigin = createFlow(
  'edge-origin',
  {
    node: 'edge',
    ip: IP.cdnEdge,
    mac: MAC.cdnEdge,
    nextHopMac: MAC_EDGE_GW,
    via: [],
    port: EPHEMERAL_PORTS[3],
    seq: ISN.client + 9_000_000 + 1 + 15_000,
  },
  {
    node: 'origin',
    ip: IP.origin,
    mac: MAC.origin,
    nextHopMac: MAC_ORIGIN_GW,
    via: [],
    port: PORT.https,
    seq: ISN.server + 8_000_000 + 1 + 90_000,
  },
  0x91c0,
);

// ---------------------------------------------------------------------------
// HTTP content
// ---------------------------------------------------------------------------

const ETAG = '"v1-3f9a"';
const CACHE_CONTROL = 'public, max-age=0, s-maxage=60';
const HTML_BYTES = 1184;
const ACCOUNT_BYTES = 642;
const COOKIE = 'sid=example-session-4821';
const HTML_PAYLOAD = 'HTML document, 1184 bytes (gzip)';
const ACCOUNT_PAYLOAD = 'HTML document with account details, 642 bytes (gzip)';

const userHeaders = (extra: HeaderList = []): HeaderList => [
  ['accept', 'text/html'],
  ['accept-encoding', 'gzip, br'],
  ['accept-language', 'en'],
  ['user-agent', USER_AGENT],
  ...extra,
];

/** What the edge sends upstream: `Accept-Encoding` normalised, plus `Via` and `X-Forwarded-For`. */
const upstreamHeaders = (extra: HeaderList = []): HeaderList => [
  ['accept', 'text/html'],
  ['accept-encoding', 'gzip'],
  ['user-agent', 'ExampleCDN/1.0'],
  ['via', '2.0 examplecdn'],
  ['x-forwarded-for', IP.routerPublic],
  ...extra,
];

/** Headers of the page's `200` response; `seconds` is the origin's `Date`. */
const pageHeaders = (extra: HeaderList = []): HeaderList => [
  ['content-type', 'text/html; charset=utf-8'],
  ['content-encoding', 'gzip'],
  ['content-length', String(HTML_BYTES)],
  ['vary', 'Accept-Encoding'],
  ['etag', ETAG],
  ['cache-control', CACHE_CONTROL],
  ['date', httpDate(0)],
  ...extra,
];

const validatorHeaders = (seconds: number, extra: HeaderList = []): HeaderList => [
  ['etag', ETAG],
  ['cache-control', CACHE_CONTROL],
  ['vary', 'Accept-Encoding'],
  ['date', httpDate(seconds)],
  ...extra,
];

const accountHeaders = (extra: HeaderList = []): HeaderList => [
  ['content-type', 'text/html; charset=utf-8'],
  ['content-encoding', 'gzip'],
  ['content-length', String(ACCOUNT_BYTES)],
  ['vary', 'Accept-Encoding, Cookie'],
  ['cache-control', 'private, max-age=60'],
  ['date', httpDate(125)],
  ...extra,
];

/** wifi + wan + wan with two 150 ms stops at transit nodes. */
const TRAVEL_MS = 2650;
/** One backbone hop between edge and origin. */
const BACKBONE_MS = 1100;

// ---------------------------------------------------------------------------
// References
// ---------------------------------------------------------------------------

const RFC_9111: Reference = {
  label: 'RFC 9111: HTTP caching',
  url: 'https://www.rfc-editor.org/rfc/rfc9111',
};
const RFC_9111_FRESHNESS: Reference = {
  label: 'RFC 9111: Freshness',
  url: 'https://www.rfc-editor.org/rfc/rfc9111#section-4.2',
};
const RFC_9111_VARY: Reference = {
  label: 'RFC 9111: Calculating cache keys with Vary',
  url: 'https://www.rfc-editor.org/rfc/rfc9111#section-4.1',
};
const RFC_9111_VALIDATION: Reference = {
  label: 'RFC 9111: Validation',
  url: 'https://www.rfc-editor.org/rfc/rfc9111#section-4.3',
};
const RFC_9111_AGE: Reference = {
  label: 'RFC 9111: Age',
  url: 'https://www.rfc-editor.org/rfc/rfc9111#section-5.1',
};
const RFC_9111_CACHE_CONTROL: Reference = {
  label: 'RFC 9111: Cache-Control',
  url: 'https://www.rfc-editor.org/rfc/rfc9111#section-5.2',
};
const RFC_9211: Reference = {
  label: 'RFC 9211: The Cache-Status HTTP response header field',
  url: 'https://www.rfc-editor.org/rfc/rfc9211',
};
const RFC_9110_CONDITIONAL: Reference = {
  label: 'RFC 9110: If-None-Match',
  url: 'https://www.rfc-editor.org/rfc/rfc9110#section-13.1.2',
};
const RFC_9110_304: Reference = {
  label: 'RFC 9110: 304 Not Modified',
  url: 'https://www.rfc-editor.org/rfc/rfc9110#section-15.4.5',
};
const RFC_9113: Reference = {
  label: 'RFC 9113: HTTP/2',
  url: 'https://www.rfc-editor.org/rfc/rfc9113',
};
const RFC_8446: Reference = {
  label: 'RFC 8446: TLS 1.3',
  url: 'https://www.rfc-editor.org/rfc/rfc8446',
};
const RFC_4786: Reference = {
  label: 'RFC 4786: Operation of anycast services',
  url: 'https://www.rfc-editor.org/rfc/rfc4786',
};

// ---------------------------------------------------------------------------
// Steps (built in order: the wire clock and TCP sequence numbers advance as they are created)
// ---------------------------------------------------------------------------

const steps: StepDef[] = [
  // 1 ----------------------------------------------------------------------
  {
    id: 'user-a-request',
    phase: 'miss',
    title: 'User A asks the edge for the page',
    summary:
      'User A’s browser sends `GET /` over HTTP/2 to the CDN edge for **www.example.com**. TLS ends at the edge, which looks in its cache and finds nothing: a **MISS**.',
    body: [
      {
        type: 'p',
        text: 'DNS or anycast has already steered the laptop to a nearby edge, `203.0.113.10`. The browser opens TCP and TLS to that edge, not to the origin. The edge holds the certificate for `www.example.com`, so TLS terminates there and the edge can read the request.',
      },
      {
        type: 'p',
        text: 'The edge builds a cache key from the host and path, plus the request headers that a stored response’s `Vary` names. For a first request there is no entry under that key, so the lookup is a miss.',
      },
      {
        type: 'callout',
        tone: 'note',
        text: 'Anycast announces one address from many sites and lets routing pick a nearby one. DNS steering instead answers each resolver with the address of a nearby edge. Neither is visible in this packet.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-a-get',
        flow: flowA,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.www,
          path: '/',
          headers: userHeaders(),
        }),
        label: 'GET /',
        summary: 'HEADERS[1]: GET /, :authority www.example.com',
        at: 0,
        wireMs: 0,
      }),
    ],
    actions: [
      {
        id: 'a-lookup-1',
        node: 'edge',
        kind: 'cache-lookup',
        label: 'Look up www.example.com/',
        at: TRAVEL_MS,
        durationMs: 600,
      },
      {
        id: 'a-miss-1',
        node: 'edge',
        kind: 'cache-miss',
        label: 'MISS',
        at: TRAVEL_MS + 600,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'edge'],
    simplifications: [
      'DNS resolution, the anycast or DNS steering decision, and TCP and TLS setup to the edge are not drawn. Sequence numbers include the handshake bytes, and the first segment in each direction is marked as a resync.',
      'The home router translates private addresses (NAT). Headers show each packet as its sender put it on the wire; frame sizes are estimates, and pure TCP ACKs are left out.',
    ],
    references: [RFC_9111, RFC_9111_VARY, RFC_4786, RFC_8446],
  },
  // 2 ----------------------------------------------------------------------
  {
    id: 'edge-to-origin',
    phase: 'miss',
    title: 'The edge forwards the request to the origin',
    summary:
      'The edge cannot answer from cache, so it sends its own request to the origin on an already-open connection, adding `X-Forwarded-For` and `Via`.',
    body: [
      {
        type: 'p',
        text: 'This is a second, separate HTTP exchange. The edge keeps long-lived connections to the origin, so no handshake is needed, and TLS on this leg is independent of the user’s TLS session.',
      },
      {
        type: 'p',
        text: 'The edge keeps the original `:authority` so the origin knows which site is wanted, and it normalises `Accept-Encoding` to `gzip` so one stored copy can serve most clients. The origin sees only the edge as its TCP peer, so `X-Forwarded-For` carries the user’s public address and `Via` marks the proxy hop.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-edge-get',
        flow: flowOrigin,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.www,
          path: '/',
          headers: upstreamHeaders(),
        }),
        label: 'GET / (to origin)',
        summary: 'HEADERS[41]: GET /, Via: 2.0 examplecdn, X-Forwarded-For: 198.51.100.7',
        at: 0,
        wireMs: 7.6,
      }),
    ],
    actions: [
      {
        id: 'a-origin-receive-1',
        node: 'origin',
        kind: 'process',
        label: 'Receive request',
        at: BACKBONE_MS,
        durationMs: 500,
      },
    ],
    focus: ['edge', 'origin'],
    simplifications: [
      'TCP and TLS setup between edge and origin is not drawn: the connection is pooled and already open.',
      'The route between edge and origin is drawn as one backbone link.',
    ],
    references: [RFC_9111, RFC_9113],
  },
  // 3 ----------------------------------------------------------------------
  {
    id: 'origin-response',
    phase: 'miss',
    title: 'Origin answers: public, s-maxage=60',
    summary:
      'The origin sends `200` with an `ETag` and `Cache-Control: public, max-age=0, s-maxage=60`. Browsers must revalidate at once, but shared caches may reuse the page for 60 seconds.',
    body: [
      {
        type: 'p',
        text: '`s-maxage` applies only to shared caches such as a CDN and overrides `max-age` for them. `max-age=0` lets a browser store the page but requires revalidation before reuse. `public` explicitly permits shared caches to store it.',
      },
      {
        type: 'p',
        text: '`Vary: Accept-Encoding` tells caches that a stored copy matches only requests with the same encoding preference. The `ETag` is a validator: later, the edge can send it back to ask whether the page has changed.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-origin-200',
        flow: flowOrigin,
        dir: 's2c',
        app: http2Response({ status: 200, headers: pageHeaders() }),
        bodyBytes: HTML_BYTES,
        payload: HTML_PAYLOAD,
        label: '200 s-maxage=60',
        summary:
          'HEADERS[41]: 200, DATA[41] text/html, Cache-Control: public, max-age=0, s-maxage=60',
        at: 600,
        wireMs: 53.6,
      }),
    ],
    actions: [
      {
        id: 'a-origin-render',
        node: 'origin',
        kind: 'process',
        label: 'Render page',
        at: 0,
        durationMs: 600,
      },
      {
        id: 'a-edge-read-cc',
        node: 'edge',
        kind: 'process',
        label: 'Read Cache-Control',
        at: 600 + BACKBONE_MS,
        durationMs: 600,
      },
    ],
    focus: ['origin', 'edge'],
    references: [RFC_9111_CACHE_CONTROL, RFC_9111_FRESHNESS, RFC_9111_VARY],
  },
  // 4 ----------------------------------------------------------------------
  {
    id: 'edge-stores',
    phase: 'miss',
    title: 'Edge stores the page and answers user A',
    summary:
      'The edge stores the response for 60 seconds and relays it to A with `Cache-Status: ExampleCDN; fwd=uri-miss; stored`: forwarded because of a URI miss, and stored.',
    body: [
      {
        type: 'p',
        text: '`Cache-Status` (RFC 9211) reports what each cache in the chain did. `fwd=uri-miss` says the request was forwarded because no stored response matched the URI, and `stored` says the response was saved. The first item names the cache, here the fictitious `ExampleCDN`.',
      },
      {
        type: 'p',
        text: 'User A’s browser gets the page as the origin sent it, plus `Cache-Status`. Because of `max-age=0`, the browser keeps its own copy but will revalidate it on the next visit.',
      },
      {
        type: 'callout',
        tone: 'note',
        text: '`X-Cache: MISS` is a vendor-specific header with no standard meaning. `Cache-Status` is the standardised form.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-edge-200-a',
        flow: flowA,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: pageHeaders([['cache-status', 'ExampleCDN; fwd=uri-miss; stored']]),
        }),
        bodyBytes: HTML_BYTES,
        payload: HTML_PAYLOAD,
        label: '200 MISS · stored',
        summary:
          'HEADERS[1]: 200, DATA[1] text/html, Cache-Status: ExampleCDN; fwd=uri-miss; stored',
        at: 800,
        wireMs: 96.6,
      }),
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
    ],
    focus: ['edge', 'laptop'],
    simplifications: [
      'The edge may also compress, rewrite or add headers; only the caching-relevant ones are shown.',
    ],
    references: [RFC_9211, RFC_9111],
  },
  // 5 ----------------------------------------------------------------------
  {
    id: 'user-b-request',
    phase: 'hit',
    title: 'User B asks for the same page',
    summary:
      'User B’s phone asks the same edge for the same URL over its own TCP and TLS connection. The edge finds a fresh stored copy: a **HIT**.',
    body: [
      {
        type: 'p',
        text: 'The edge computes the same key: host, path and the normalised `Accept-Encoding`. The entry was stored about 31 seconds ago and its freshness lifetime is 60 seconds, so it is still fresh and the edge can answer without contacting the origin.',
      },
      {
        type: 'p',
        text: 'Each user has a separate TLS connection to the edge, while the cache behind them is shared. One origin fetch can serve many users.',
      },
      {
        type: 'callout',
        tone: 'tip',
        text: 'The cache key is the URL plus whatever `Vary` lists. A request whose `Accept-Encoding` selects another variant would not match this entry, and the cache would report `fwd=vary-miss`.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-b-get',
        flow: flowB,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.www,
          path: '/',
          headers: userHeaders(),
        }),
        label: 'GET /',
        summary: 'HEADERS[1]: GET /, :authority www.example.com',
        at: 0,
        wireMs: 31050,
      }),
    ],
    actions: [
      {
        id: 'a-lookup-2',
        node: 'edge',
        kind: 'cache-lookup',
        label: 'Look up www.example.com/',
        at: TRAVEL_MS,
        durationMs: 500,
      },
      {
        id: 'a-hit-1',
        node: 'edge',
        kind: 'cache-hit',
        label: 'HIT: fresh (31 s old)',
        at: TRAVEL_MS + 500,
        durationMs: 700,
      },
    ],
    focus: ['phone', 'edge'],
    simplifications: [
      'User B is drawn on the same home network to keep the picture small; a client anywhere that this edge serves would hit the same entry. B’s DNS, TCP and TLS setup is collapsed like A’s, and the 31-second gap is not animated.',
    ],
    references: [RFC_9111, RFC_9111_VARY],
  },
  // 6 ----------------------------------------------------------------------
  {
    id: 'edge-hit',
    phase: 'hit',
    title: 'HIT: Age and Cache-Status: hit',
    summary:
      'The edge replies `200` straight from cache. `Age: 31` says how long the copy has been cached, and `Cache-Status: ExampleCDN; hit` confirms that no origin request was needed.',
    body: [
      {
        type: 'p',
        text: '`Age` is the cache’s estimate, in seconds, of the time since the response was generated or last validated. With a 60-second freshness lifetime, this copy has about 29 seconds left.',
      },
      {
        type: 'p',
        text: 'No packet went to the origin, which saves an 80 ms round trip and the origin’s work. The `Date` header is still the origin’s original timestamp, so it is older than the moment of delivery.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-edge-200-b',
        flow: flowB,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: pageHeaders([
            ['age', '31'],
            ['cache-status', 'ExampleCDN; hit'],
          ]),
        }),
        bodyBytes: HTML_BYTES,
        payload: HTML_PAYLOAD,
        label: '200 (HIT)',
        summary: 'HEADERS[1]: 200, DATA[1] text/html, Age: 31, Cache-Status: ExampleCDN; hit',
        at: 300,
        wireMs: 31057.4,
      }),
    ],
    actions: [
      {
        id: 'a-serve-cache',
        node: 'edge',
        kind: 'process',
        label: 'Serve from cache',
        at: 0,
        durationMs: 300,
      },
    ],
    focus: ['edge', 'phone'],
    references: [RFC_9111_AGE, RFC_9211],
  },
  // 7 ----------------------------------------------------------------------
  {
    id: 'stale-request',
    phase: 'revalidate',
    title: 'Entry expired: B asks with If-None-Match',
    summary:
      'About 95 seconds in, B asks again. Its browser kept the page but stored it with `max-age=0`, so it sends `If-None-Match`. The edge’s copy is now stale: age 95 s, lifetime 60 s.',
    body: [
      {
        type: 'p',
        text: 'A stored response is fresh while its age is below its freshness lifetime. Age 95 s exceeds the 60 s `s-maxage`, so the copy is stale. A stale copy is not simply discarded: it can still be validated, which is usually cheaper than a full fetch.',
      },
      {
        type: 'p',
        text: 'B’s request is itself conditional. Because of `max-age=0`, the browser must check that its own copy is current, and its `If-None-Match` carries the `ETag` it saw earlier.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-b-get-conditional',
        flow: flowB,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.www,
          path: '/',
          headers: userHeaders([['if-none-match', ETAG]]),
        }),
        label: 'GET If-None-Match',
        summary: 'HEADERS[3]: GET /, If-None-Match: "v1-3f9a"',
        at: 0,
        wireMs: 95000,
      }),
    ],
    actions: [
      {
        id: 'a-lookup-3',
        node: 'edge',
        kind: 'cache-lookup',
        label: 'Look up www.example.com/',
        at: TRAVEL_MS,
        durationMs: 500,
      },
      {
        id: 'a-stale-1',
        node: 'edge',
        kind: 'cache-miss',
        label: 'STALE: 95 s > 60 s',
        at: TRAVEL_MS + 500,
        durationMs: 700,
      },
    ],
    focus: ['phone', 'edge'],
    simplifications: ['The 95-second gap is not animated; wire times in the packet table show it.'],
    references: [RFC_9111_FRESHNESS, RFC_9111_VALIDATION, RFC_9110_CONDITIONAL],
  },
  // 8 ----------------------------------------------------------------------
  {
    id: 'edge-revalidates',
    phase: 'revalidate',
    title: 'Edge revalidates with the origin',
    summary:
      'The edge asks the origin whether its stored copy is still good, sending `If-None-Match` with the stored `ETag`. This is a conditional GET, not a full fetch.',
    body: [
      {
        type: 'p',
        text: 'Revalidation means: here is the validator of what I have; send a new body only if it changed. The edge uses the `ETag` stored with its own copy. That is separate from the `If-None-Match` in B’s request, although the values happen to match.',
      },
      {
        type: 'p',
        text: 'A conditional request is cheap for the origin: it can compare validators and often skip rebuilding the page. B waits meanwhile, but the edge does not need to re-download a body that has not changed.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-edge-get-conditional',
        flow: flowOrigin,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.www,
          path: '/',
          headers: upstreamHeaders([['if-none-match', ETAG]]),
        }),
        label: 'GET If-None-Match',
        summary: 'HEADERS[43]: GET /, If-None-Match: "v1-3f9a"',
        at: 0,
        wireMs: 95007.6,
      }),
    ],
    actions: [
      {
        id: 'a-compare-etag',
        node: 'origin',
        kind: 'verify',
        label: 'Compare ETag',
        at: BACKBONE_MS,
        durationMs: 500,
      },
    ],
    focus: ['edge', 'origin'],
    references: [RFC_9111_VALIDATION, RFC_9110_CONDITIONAL],
  },
  // 9 ----------------------------------------------------------------------
  {
    id: 'origin-304',
    phase: 'revalidate',
    title: 'Origin replies 304 Not Modified',
    summary:
      'The origin finds the `ETag` unchanged and replies `304 Not Modified` with no body. Only headers cross the backbone link.',
    body: [
      {
        type: 'p',
        text: 'A `304` repeats the header fields that matter for caching, such as `ETag`, `Cache-Control` and `Vary`, plus a fresh `Date`, but carries no content. It tells the cache that the stored body is still the current representation.',
      },
      {
        type: 'p',
        text: 'The origin only had to compare validators. A `200` would have meant that the stored copy was out of date and had to be replaced.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-origin-304',
        flow: flowOrigin,
        dir: 's2c',
        app: http2Response({ status: 304, headers: validatorHeaders(95) }),
        label: '304 Not Modified',
        summary: 'HEADERS[43]: 304, ETag: "v1-3f9a" (no body)',
        at: 400,
        wireMs: 95052.6,
      }),
    ],
    actions: [
      {
        id: 'a-etag-match',
        node: 'origin',
        kind: 'process',
        label: 'ETag matches',
        at: 0,
        durationMs: 400,
      },
    ],
    focus: ['origin', 'edge'],
    references: [RFC_9110_304, RFC_9111_VALIDATION],
  },
  // 10 ---------------------------------------------------------------------
  {
    id: 'edge-refreshes',
    phase: 'revalidate',
    title: 'Edge refreshes the entry and answers B',
    summary:
      'The edge freshens its stored entry from the `304`, so it is fresh for another 60 seconds, and relays `304` to B. `Cache-Status` shows `fwd=stale; fwd-status=304`.',
    body: [
      {
        type: 'p',
        text: 'Freshening updates the stored copy’s `Date` and `Cache-Control` from the `304` and restarts its 60-second lifetime, without downloading the body again. B receives a `304` too, because its own `If-None-Match` matched, so its browser reuses the page it already has.',
      },
      {
        type: 'p',
        text: 'A client with no validator, such as user A on a first visit, would now get a `200` with `Age` near 0, served from the refreshed entry. In `Cache-Status`, `fwd=stale` records that a request was forwarded because the stored copy was stale, and `fwd-status=304` is what the next hop answered.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-edge-304-b',
        flow: flowB,
        dir: 's2c',
        app: http2Response({
          status: 304,
          headers: validatorHeaders(95, [
            ['age', '0'],
            ['cache-status', 'ExampleCDN; fwd=stale; fwd-status=304'],
          ]),
        }),
        label: '304 (refreshed)',
        summary: 'HEADERS[3]: 304, Age: 0, Cache-Status: ExampleCDN; fwd=stale; fwd-status=304',
        at: 700,
        wireMs: 95095.8,
      }),
    ],
    actions: [
      {
        id: 'a-refresh',
        node: 'edge',
        kind: 'store',
        label: 'Refresh: +60 s',
        at: 0,
        durationMs: 700,
      },
    ],
    focus: ['edge', 'phone'],
    simplifications: [
      'The exact `Cache-Status` parameters for a revalidated response vary between caches; the value shown is one valid way to report it.',
    ],
    references: [RFC_9111_VALIDATION, RFC_9211, RFC_9110_304],
  },
  // 11 ---------------------------------------------------------------------
  {
    id: 'private-request',
    phase: 'private',
    title: 'Personal page: the edge forwards it',
    summary:
      'User A opens a personal page with a session cookie. Nothing is stored for `/account`, so the edge forwards the request to the origin.',
    body: [
      {
        type: 'p',
        text: 'Personal pages must not be shared between users. The origin says so in its response, not in the request, so the edge cannot know in advance and has to ask. Many CDNs also bypass the cache for requests that carry a cookie unless they are configured otherwise.',
      },
      {
        type: 'p',
        text: 'Here the edge finds no stored entry and forwards the request, cookie included, so the origin can identify the user.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-a-get-account',
        flow: flowA,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.www,
          path: '/account',
          headers: userHeaders([['cookie', COOKIE]]),
        }),
        label: 'GET /account',
        summary: 'HEADERS[3]: GET /account, Cookie: sid=...',
        at: 0,
        wireMs: 125000,
      }),
      h2Packet({
        id: 'p-edge-get-account',
        flow: flowOrigin,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.www,
          path: '/account',
          headers: upstreamHeaders([['cookie', COOKIE]]),
        }),
        label: 'GET /account',
        summary: 'HEADERS[45]: GET /account, Cookie: sid=..., Via: 2.0 examplecdn',
        at: 3500,
        wireMs: 125007.6,
      }),
    ],
    actions: [
      {
        id: 'a-lookup-4',
        node: 'edge',
        kind: 'cache-lookup',
        label: 'Look up /account',
        at: TRAVEL_MS,
        durationMs: 450,
      },
      {
        id: 'a-miss-4',
        node: 'edge',
        kind: 'cache-miss',
        label: 'MISS: nothing stored',
        at: TRAVEL_MS + 450,
        durationMs: 400,
      },
    ],
    focus: ['laptop', 'edge', 'origin'],
    simplifications: [
      'Cache-bypass rules for cookies depend on CDN configuration and are not shown.',
    ],
    references: [RFC_9111, RFC_9111_VARY],
  },
  // 12 ---------------------------------------------------------------------
  {
    id: 'private-response',
    phase: 'private',
    title: 'private: relayed to A, never stored',
    summary:
      'The origin marks the page `Cache-Control: private`. The edge relays it to A but does not store it, so `Cache-Status` shows `fwd=uri-miss` and no `stored`.',
    body: [
      {
        type: 'p',
        text: '`private` means only a single user’s cache, such as the browser, may store the response. A shared cache such as a CDN must not, so the next request for `/account`, from anyone, is forwarded again. `Vary: Cookie` adds a second reason to keep variants apart.',
      },
      {
        type: 'callout',
        tone: 'warning',
        text: '`no-store` is stronger: no cache may store the response, browser included. `no-cache` allows storing but requires revalidation before every reuse. They are often confused.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-origin-private',
        flow: flowOrigin,
        dir: 's2c',
        app: http2Response({ status: 200, headers: accountHeaders() }),
        bodyBytes: ACCOUNT_BYTES,
        payload: ACCOUNT_PAYLOAD,
        label: '200 private',
        summary: 'HEADERS[45]: 200, DATA[45] text/html, Cache-Control: private, max-age=60',
        at: 700,
        wireMs: 125055.6,
      }),
      h2Packet({
        id: 'p-edge-private-a',
        flow: flowA,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: accountHeaders([['cache-status', 'ExampleCDN; fwd=uri-miss']]),
        }),
        bodyBytes: ACCOUNT_BYTES,
        payload: ACCOUNT_PAYLOAD,
        label: '200 (not stored)',
        summary: 'HEADERS[3]: 200, DATA[3] text/html, Cache-Status: ExampleCDN; fwd=uri-miss',
        at: 700 + BACKBONE_MS + 1000,
        wireMs: 125098.6,
      }),
    ],
    actions: [
      {
        id: 'a-build-account',
        node: 'origin',
        kind: 'process',
        label: 'Build account page',
        at: 0,
        durationMs: 600,
      },
      {
        id: 'a-skip-store',
        node: 'edge',
        kind: 'cache-miss',
        label: 'private: do not store',
        at: 700 + BACKBONE_MS,
        durationMs: 800,
      },
    ],
    focus: ['origin', 'edge', 'laptop'],
    references: [RFC_9111_CACHE_CONTROL, RFC_9211],
  },
];

export default defineScenario({
  id: 'cdn',
  title: 'CDN',
  tagline: 'How an edge cache answers, stores, revalidates and refuses to store.',
  category: 'web',
  order: 4,
  protocols: ['ethernet', 'ipv4', 'tcp', 'tls', 'http'],
  phases: [
    { id: 'miss', label: 'Cache miss' },
    { id: 'hit', label: 'Cache hit' },
    { id: 'revalidate', label: 'Revalidation' },
    { id: 'private', label: 'Private responses' },
  ],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'User A’s laptop',
      sublabel: IP.laptop,
      position: { col: 0.5, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop, hostname: HOST.laptop },
    },
    {
      id: 'phone',
      kind: 'phone',
      label: 'User B’s phone',
      sublabel: IP.phone,
      position: { col: 3, row: 4.5 },
      zone: 'home',
      addresses: { ipv4: IP.phone, mac: MAC.phone },
    },
    {
      id: 'router',
      kind: 'router',
      label: 'Home router',
      sublabel: IP.routerLan,
      position: { col: 3, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.routerLan, mac: MAC.routerLan },
    },
    {
      id: 'cloud',
      kind: 'cloud',
      label: 'Internet',
      position: { col: 5.6, row: 2 },
      zone: 'internet',
    },
    {
      id: 'edge',
      kind: 'cdn-edge',
      label: 'CDN edge',
      sublabel: IP.cdnEdge,
      position: { col: 8.35, row: 2 },
      zone: 'internet',
      addresses: { ipv4: IP.cdnEdge, mac: MAC.cdnEdge, hostname: HOST.www },
    },
    {
      id: 'origin',
      kind: 'origin-server',
      label: 'Origin server',
      sublabel: IP.origin,
      position: { col: 11.35, row: 2 },
      zone: 'datacenter',
      addresses: { ipv4: IP.origin, mac: MAC.origin, hostname: HOST.origin },
    },
  ],
  links: [
    { id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' },
    { id: 'phone-router', a: 'phone', b: 'router', medium: 'wifi' },
    { id: 'router-cloud', a: 'router', b: 'cloud', medium: 'wan' },
    { id: 'cloud-edge', a: 'cloud', b: 'edge', medium: 'wan' },
    { id: 'edge-origin', a: 'edge', b: 'origin', medium: 'backbone', label: 'private backbone' },
  ],
  zones: [
    {
      id: 'home',
      label: 'Home LAN',
      from: { col: -0.1, row: 1.4 },
      to: { col: 3.6, row: 5.1 },
      tone: 'lan',
    },
    {
      id: 'internet',
      label: 'Internet and CDN',
      from: { col: 4.1, row: 0.5 },
      to: { col: 9.1, row: 3.5 },
      tone: 'internet',
    },
    {
      id: 'datacenter',
      label: 'Data centre',
      from: { col: 9.85, row: 0.5 },
      to: { col: 12.85, row: 3.5 },
      tone: 'datacenter',
    },
  ],
  steps,
});
