import { defineScenario } from '../../model/types';
import type {
  HeaderGroup,
  NodeId,
  PacketDef,
  PacketMeta,
  PacketOutcome,
  Reference,
  StepDef,
} from '../../model/types';
import { EPHEMERAL_PORTS, HOST, IP, ISN, MAC, PORT, mac } from '../lib/addresses';
import { ethernet, http2Request, http2Response, ipv4, tcp, tlsHandshake } from '../lib/builders';
import type { HeaderList } from '../lib/builders';

/**
 * CORS: a page on https://example.com calls https://api.example.net.
 *
 * Every exchange rides on one long-lived HTTP/2 connection (plus a separate curl connection in
 * the last step). TCP and TLS setup is collapsed, so the first segment in each direction of a
 * connection carries `resync` and the sequence numbers already include the handshake bytes.
 */

// ---------------------------------------------------------------------------
// Addressing for this scenario
// ---------------------------------------------------------------------------

const PAGE_ORIGIN = 'https://example.com';
const USER_AGENT = 'ExampleBrowser/1.0';
const MAC_API = mac(0x42);
const MAC_API_GW = mac(0x43);

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

const START_UTC = Date.UTC(2026, 10, 13, 9, 30, 0);

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
  body?: string;
  label: string;
  summary: string;
  at: number;
  /** Capture time in milliseconds since the scenario started. */
  wireMs: number;
  outcome?: PacketOutcome;
}

function h2Packet(spec: H2PacketSpec): PacketDef {
  const len = recordLength(spec.app, spec.body?.length ?? 0);
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
    ...(spec.body === undefined ? {} : { payload: spec.body }),
    sizeBytes: segment.sizeBytes,
    encrypted: true,
    at: spec.at,
    wireTimeMs: wireTo(spec.wireMs),
    ...(spec.outcome === undefined ? {} : { outcome: spec.outcome }),
    meta: segment.meta,
  };
}

// ---------------------------------------------------------------------------
// Connections
// ---------------------------------------------------------------------------

const laptop = (port: number): Endpoint => ({
  node: 'laptop',
  ip: IP.laptop,
  seenAs: IP.routerPublic,
  mac: MAC.laptop,
  nextHopMac: MAC.routerLan,
  via: ['router', 'cloud'],
  port,
  seq: 0,
});

const apiServer = (seq: number): Endpoint => ({
  node: 'api',
  ip: IP.api,
  mac: MAC_API,
  nextHopMac: MAC_API_GW,
  via: ['cloud', 'router'],
  port: PORT.https,
  seq,
});

/** The browser's HTTP/2 connection to the API, reused by every step except the last. */
const browserFlow = createFlow(
  'laptop-api-browser',
  { ...laptop(EPHEMERAL_PORTS[0]), seq: ISN.client + 1 + HANDSHAKE_BYTES.client },
  apiServer(ISN.server + 1 + HANDSHAKE_BYTES.server),
  0x4a10,
);

/** A separate connection opened by curl in the last step. */
const curlFlow = createFlow(
  'laptop-api-curl',
  { ...laptop(EPHEMERAL_PORTS[1]), seq: ISN.client + 7_000_000 + 1 + HANDSHAKE_BYTES.client },
  apiServer(ISN.server + 5_000_000 + 1 + HANDSHAKE_BYTES.server),
  0x6b02,
);

// ---------------------------------------------------------------------------
// HTTP content
// ---------------------------------------------------------------------------

const browserHeaders = (extra: HeaderList = []): HeaderList => [
  ['accept', '*/*'],
  ['accept-language', 'en'],
  ['origin', PAGE_ORIGIN],
  ['referer', `${PAGE_ORIGIN}/`],
  ['sec-fetch-dest', 'empty'],
  ['sec-fetch-mode', 'cors'],
  ['sec-fetch-site', 'cross-site'],
  ['user-agent', USER_AGENT],
  ...extra,
];

const jsonResponse = (body: string, seconds: number, extra: HeaderList = []): HeaderList => [
  ['content-type', 'application/json'],
  ['content-length', String(body.length)],
  ['date', httpDate(seconds)],
  ...extra,
];

const BODY_PRICES = '{"currency":"EUR","items":[{"sku":"A-100","price":12.5}]}';
const BODY_LIMITS = '{"remaining":42,"resetSeconds":3600}';
const BODY_PUT_1 = '{"displayName":"Alice"}';
const BODY_PUT_1_OK = '{"displayName":"Alice","updated":true}';
const BODY_PUT_2 = '{"displayName":"Alice B."}';
const BODY_PUT_2_OK = '{"displayName":"Alice B.","updated":true}';
const BODY_SESSION = '{"user":"alice","plan":"pro"}';
const COOKIE = 'sid=example-session-4821';

/** Time for a packet to cross wifi, wan and wan with two 150 ms stops at transit nodes. */
const TRAVEL_MS = 2650;

const blockedNote =
  'No usable Access-Control-Allow-Origin: the browser withholds the response from the page.';

// ---------------------------------------------------------------------------
// Step references
// ---------------------------------------------------------------------------

const FETCH_CORS: Reference = {
  label: 'Fetch Standard: CORS protocol',
  url: 'https://fetch.spec.whatwg.org/#http-cors-protocol',
};
const FETCH_ORIGIN: Reference = {
  label: 'Fetch Standard: Origin header',
  url: 'https://fetch.spec.whatwg.org/#origin-header',
};
const FETCH_SAFELIST: Reference = {
  label: 'Fetch Standard: CORS-safelisted request-header',
  url: 'https://fetch.spec.whatwg.org/#cors-safelisted-request-header',
};
const FETCH_RESPONSE_SAFELIST: Reference = {
  label: 'Fetch Standard: CORS-safelisted response-header name',
  url: 'https://fetch.spec.whatwg.org/#cors-safelisted-response-header-name',
};
const FETCH_PREFLIGHT: Reference = {
  label: 'Fetch Standard: CORS-preflight request',
  url: 'https://fetch.spec.whatwg.org/#cors-preflight-request',
};
const FETCH_CREDENTIALS: Reference = {
  label: 'Fetch Standard: CORS protocol and credentials',
  url: 'https://fetch.spec.whatwg.org/#cors-protocol-and-credentials',
};
const FETCH_PREFLIGHT_CACHE: Reference = {
  label: 'Fetch Standard: CORS-preflight cache',
  url: 'https://fetch.spec.whatwg.org/#cors-preflight-cache',
};
const RFC_9110_VARY: Reference = {
  label: 'RFC 9110: Vary',
  url: 'https://www.rfc-editor.org/rfc/rfc9110#section-12.5.5',
};
const RFC_9110_OPTIONS: Reference = {
  label: 'RFC 9110: OPTIONS',
  url: 'https://www.rfc-editor.org/rfc/rfc9110#section-9.3.7',
};
const RFC_6454: Reference = {
  label: 'RFC 6454: The Web Origin Concept',
  url: 'https://www.rfc-editor.org/rfc/rfc6454',
};

// ---------------------------------------------------------------------------
// Steps (built in order: the wire clock and TCP sequence numbers advance as they are created)
// ---------------------------------------------------------------------------

const connectionSimplifications = [
  'DNS, TCP and TLS setup to api.example.net are not drawn: the HTTP/2 connection is already open. Sequence numbers include the handshake bytes, and the first segment in each direction is marked as a resync.',
  'The home router translates the laptop address (NAT). Headers show each packet as its sender put it on the wire; frame sizes are estimates.',
  'Pure TCP ACKs are left out of the animation.',
];

const steps: StepDef[] = [
  // 1 ----------------------------------------------------------------------
  {
    id: 'simple-get',
    phase: 'simple',
    title: 'Simple GET: the browser adds Origin',
    summary:
      'A script on **https://example.com** calls `fetch()` on **https://api.example.net**. The browser sends the GET at once and adds an `Origin` header naming the calling page.',
    body: [
      {
        type: 'p',
        text: 'An origin is scheme, host and port, here `https://example.com`. The API sits on a different site, so the request is cross-origin and CORS applies. A GET with only safelisted headers is a simple request: the browser sends it directly, with no preflight.',
      },
      {
        type: 'p',
        text: 'The browser, not the script, adds `Origin`, `Sec-Fetch-Site` and `Sec-Fetch-Mode`. Page code cannot forge or remove these, so a server can see which origin a browser request came from.',
      },
      {
        type: 'callout',
        tone: 'note',
        text: 'The server receives this request whatever happens next. CORS decides what the browser lets the page read, not whether the request is sent.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-simple-get',
        flow: browserFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.api,
          path: '/v1/prices',
          headers: browserHeaders(),
        }),
        label: 'GET + Origin',
        summary: 'HEADERS[1]: GET /v1/prices, Origin: https://example.com',
        at: 0,
        wireMs: 0,
      }),
    ],
    actions: [
      {
        id: 'a-cross-origin',
        node: 'laptop',
        kind: 'process',
        label: 'Cross-origin fetch()',
        at: 0,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: connectionSimplifications,
    references: [FETCH_CORS, FETCH_ORIGIN, RFC_6454],
  },
  // 2 ----------------------------------------------------------------------
  {
    id: 'simple-allowed',
    phase: 'simple',
    title: 'Server opts in with Allow-Origin',
    summary:
      'The reply carries `Access-Control-Allow-Origin: *`. The browser’s CORS check passes, so the page can read the JSON body and the exposed `X-Request-Id` header.',
    body: [
      {
        type: 'p',
        text: 'The server decides whether browsers may share this response with other origins. `*` means any origin, which suits public data that needs no cookies or other credentials. Naming one origin, such as `https://example.com`, also passes the check.',
      },
      {
        type: 'p',
        text: 'When the response arrives, the browser compares `Access-Control-Allow-Origin` with the request’s origin. A match hands the response to the page; anything else turns the fetch into a network error.',
      },
      {
        type: 'callout',
        tone: 'tip',
        text: 'Only a short list of response headers, such as `Content-Type` and `Cache-Control`, is readable by default. `Access-Control-Expose-Headers: x-request-id` adds `X-Request-Id`; without it, `response.headers.get("x-request-id")` returns null.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-simple-ok',
        flow: browserFlow,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: jsonResponse(BODY_PRICES, 0, [
            ['access-control-allow-origin', '*'],
            ['access-control-expose-headers', 'x-request-id'],
            ['x-request-id', '9c41e2'],
          ]),
        }),
        body: BODY_PRICES,
        label: '200 + Allow-Origin',
        summary: 'HEADERS[1]: 200, DATA[1] application/json, Access-Control-Allow-Origin: *',
        at: 400,
        wireMs: 24,
      }),
    ],
    actions: [
      {
        id: 'a-build-prices',
        node: 'api',
        kind: 'process',
        label: 'Build response',
        at: 0,
        durationMs: 400,
      },
      {
        id: 'a-cors-pass-1',
        node: 'laptop',
        kind: 'verify',
        label: 'CORS check passes',
        at: 400 + TRAVEL_MS,
        durationMs: 700,
      },
    ],
    focus: ['api', 'laptop'],
    references: [FETCH_CORS, FETCH_RESPONSE_SAFELIST],
  },
  // 3 ----------------------------------------------------------------------
  {
    id: 'missing-header',
    phase: 'simple',
    title: 'Missing header: sent, answered, blocked',
    summary:
      'A GET to an endpoint that never sends `Access-Control-Allow-Origin`. Request and `200` reply both cross the wire, yet the browser blocks the page from reading the response.',
    body: [
      {
        type: 'p',
        text: 'Nothing here looks wrong on the network. The server handled the request, ran its code and answered `200`. The failure happens inside the browser: its CORS check finds no `Access-Control-Allow-Origin` header, so `fetch()` rejects with a network error and the page sees neither status nor body.',
      },
      {
        type: 'p',
        text: 'A packet capture shows the complete response, because the check happens after delivery.',
      },
      {
        type: 'callout',
        tone: 'warning',
        text: 'A blocked response still reached the server. If the request had a side effect, such as a form-style `POST`, that effect already happened. CORS is not CSRF protection.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-missing-get',
        flow: browserFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.api,
          path: '/v1/account/limits',
          headers: browserHeaders(),
        }),
        label: 'GET + Origin',
        summary: 'HEADERS[3]: GET /v1/account/limits, Origin: https://example.com',
        at: 0,
        wireMs: 1850,
      }),
      h2Packet({
        id: 'p-missing-resp',
        flow: browserFlow,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: jsonResponse(BODY_LIMITS, 2, [['x-request-id', '4b07aa']]),
        }),
        body: BODY_LIMITS,
        label: '200 · no ACAO',
        summary: 'HEADERS[3]: 200, DATA[3] application/json (no Access-Control-Allow-Origin)',
        at: 3000,
        wireMs: 1874.2,
        outcome: { kind: 'blocked', note: blockedNote },
      }),
    ],
    actions: [
      {
        id: 'a-handle-limits',
        node: 'api',
        kind: 'process',
        label: 'Handle request',
        at: TRAVEL_MS,
        durationMs: 350,
      },
      {
        id: 'a-cors-fail-1',
        node: 'laptop',
        kind: 'verify',
        label: 'CORS check fails',
        at: 3000 + TRAVEL_MS,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: [
      'The browser reports the failure to the page as a generic network error on purpose, so scripts cannot learn anything about the blocked response.',
    ],
    references: [FETCH_CORS, FETCH_CREDENTIALS],
  },
  // 4 ----------------------------------------------------------------------
  {
    id: 'preflight-request',
    phase: 'preflight',
    title: 'Preflight: OPTIONS before the real request',
    summary:
      'The page wants to send `PUT` with an `Authorization` header and a JSON body. That is not a simple request, so the browser first asks permission with an `OPTIONS` preflight.',
    body: [
      {
        type: 'p',
        text: 'Three things force a preflight: `PUT` is not a CORS-safelisted method, `Authorization` is not a safelisted header, and `Content-Type: application/json` is not a safelisted type (only `application/x-www-form-urlencoded`, `multipart/form-data` and `text/plain` are).',
      },
      {
        type: 'p',
        text: 'The preflight asks three questions: which origin is asking (`Origin`), which method will follow (`Access-Control-Request-Method`) and which non-safelisted headers will be sent (`Access-Control-Request-Headers`). It carries no body, no cookies and no `Authorization` value.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-preflight',
        flow: browserFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'OPTIONS',
          authority: HOST.api,
          path: '/v1/profile',
          headers: [
            ['accept', '*/*'],
            ['accept-language', 'en'],
            ['access-control-request-headers', 'authorization,content-type'],
            ['access-control-request-method', 'PUT'],
            ['origin', PAGE_ORIGIN],
            ['referer', `${PAGE_ORIGIN}/`],
            ['sec-fetch-dest', 'empty'],
            ['sec-fetch-mode', 'cors'],
            ['sec-fetch-site', 'cross-site'],
            ['user-agent', USER_AGENT],
          ],
        }),
        label: 'OPTIONS preflight',
        summary: 'HEADERS[5]: OPTIONS /v1/profile, Access-Control-Request-Method: PUT',
        at: 0,
        wireMs: 4200,
      }),
    ],
    actions: [
      {
        id: 'a-needs-preflight',
        node: 'laptop',
        kind: 'process',
        label: 'Not simple: preflight',
        at: 0,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'api'],
    references: [FETCH_PREFLIGHT, FETCH_SAFELIST, RFC_9110_OPTIONS],
  },
  // 5 ----------------------------------------------------------------------
  {
    id: 'preflight-response',
    phase: 'preflight',
    title: 'Preflight reply: 204 with allow headers',
    summary:
      'The server answers `204` with `Access-Control-Allow-Origin`, `-Methods`, `-Headers` and `Access-Control-Max-Age`. A 2xx status and a matching policy let the real request go out.',
    body: [
      {
        type: 'p',
        text: 'The preflight response needs a 2xx status. The browser then checks that the origin is allowed, that `PUT` is in `Access-Control-Allow-Methods`, and that every requested header (`authorization`, `content-type`) is in `Access-Control-Allow-Headers`. If any check fails, the real request is never sent.',
      },
      {
        type: 'p',
        text: '`Vary: Origin` tells shared caches that the answer depends on the request’s `Origin` header.',
      },
      {
        type: 'callout',
        tone: 'note',
        text: 'A `*` in `Access-Control-Allow-Headers` does not cover `Authorization`. List it by name.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-preflight-resp',
        flow: browserFlow,
        dir: 's2c',
        app: http2Response({
          status: 204,
          headers: [
            ['access-control-allow-origin', PAGE_ORIGIN],
            ['access-control-allow-methods', 'GET, PUT'],
            ['access-control-allow-headers', 'authorization, content-type'],
            ['access-control-max-age', '600'],
            ['vary', 'Origin'],
            ['date', httpDate(4)],
          ],
        }),
        label: '204 preflight',
        summary: 'HEADERS[5]: 204, Access-Control-Allow-Methods: GET, PUT, Max-Age: 600',
        at: 400,
        wireMs: 4224.1,
      }),
    ],
    actions: [
      {
        id: 'a-preflight-policy',
        node: 'api',
        kind: 'process',
        label: 'Apply CORS policy',
        at: 0,
        durationMs: 400,
      },
      {
        id: 'a-preflight-pass',
        node: 'laptop',
        kind: 'verify',
        label: 'Preflight passes',
        at: 400 + TRAVEL_MS,
        durationMs: 600,
      },
      {
        id: 'a-preflight-store',
        node: 'laptop',
        kind: 'store',
        label: 'Cache preflight 600 s',
        at: 400 + TRAVEL_MS + 600,
        durationMs: 600,
      },
    ],
    focus: ['api', 'laptop'],
    simplifications: [
      'The browser keys its preflight cache by origin, URL and credentials mode; the animation shows it as one store action.',
    ],
    references: [FETCH_PREFLIGHT, FETCH_PREFLIGHT_CACHE, RFC_9110_VARY],
  },
  // 6 ----------------------------------------------------------------------
  {
    id: 'actual-put',
    phase: 'preflight',
    title: 'The real PUT with Authorization',
    summary:
      'With permission granted, the browser sends the `PUT`. `Origin` and the script’s `Authorization` header travel together with a small JSON body.',
    body: [
      {
        type: 'p',
        text: 'The real request follows on the same connection. The `Authorization` header here was set by the script, so it is an ordinary request header and not a CORS credential. In CORS, credentials means cookies, HTTP authentication and TLS client certificates, which `fetch()` sends cross-origin only when the page opts in with `credentials: "include"`.',
      },
      {
        type: 'p',
        text: 'The server must still authenticate the caller. A passed preflight only shows that a page from an allowed origin may try; it grants no access.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-put-1',
        flow: browserFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'PUT',
          authority: HOST.api,
          path: '/v1/profile',
          headers: browserHeaders([
            ['authorization', 'Bearer example-token-7f3a'],
            ['content-type', 'application/json'],
            ['content-length', String(BODY_PUT_1.length)],
          ]),
        }),
        body: BODY_PUT_1,
        label: 'PUT + Auth',
        summary: 'HEADERS[7]: PUT /v1/profile, DATA[7] application/json',
        at: 0,
        wireMs: 4244,
      }),
    ],
    actions: [
      {
        id: 'a-handle-put-1',
        node: 'api',
        kind: 'process',
        label: 'Authenticate · update',
        at: TRAVEL_MS,
        durationMs: 500,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: [
      'The bearer token is a placeholder; real tokens are opaque or signed strings issued earlier.',
    ],
    references: [FETCH_CREDENTIALS, FETCH_SAFELIST],
  },
  // 7 ----------------------------------------------------------------------
  {
    id: 'put-response',
    phase: 'preflight',
    title: 'The PUT reply needs Allow-Origin too',
    summary:
      'The response to the actual request must also carry `Access-Control-Allow-Origin`. Passing the preflight does not carry over to the response.',
    body: [
      {
        type: 'p',
        text: 'The two phases are checked independently. The preflight approved the request; the real response must again include an `Access-Control-Allow-Origin` that matches the page, or the script gets a network error even though the update succeeded on the server.',
      },
      {
        type: 'p',
        text: 'The header can name only one origin (or `*`). A server that supports several origins compares the request’s `Origin` with an allow-list and echoes the match, which is why `Vary: Origin` appears again.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-put-1-resp',
        flow: browserFlow,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: jsonResponse(BODY_PUT_1_OK, 4, [
            ['access-control-allow-origin', PAGE_ORIGIN],
            ['vary', 'Origin'],
            ['x-request-id', 'c8d2f0'],
          ]),
        }),
        body: BODY_PUT_1_OK,
        label: '200 + Allow-Origin',
        summary:
          'HEADERS[7]: 200, DATA[7] application/json, Access-Control-Allow-Origin: https://example.com',
        at: 400,
        wireMs: 4269.5,
      }),
    ],
    actions: [
      {
        id: 'a-build-put-1',
        node: 'api',
        kind: 'process',
        label: 'Build response',
        at: 0,
        durationMs: 400,
      },
      {
        id: 'a-cors-pass-2',
        node: 'laptop',
        kind: 'verify',
        label: 'CORS check passes',
        at: 400 + TRAVEL_MS,
        durationMs: 700,
      },
    ],
    focus: ['api', 'laptop'],
    references: [FETCH_CORS, RFC_9110_VARY],
  },
  // 8 ----------------------------------------------------------------------
  {
    id: 'credentialed-wildcard',
    phase: 'credentials',
    title: 'Credentials: a wildcard origin is rejected',
    summary:
      'With `credentials: "include"` the browser attaches the cookie. The reply says `Access-Control-Allow-Origin: *`, and even with credentials allowed the browser refuses it.',
    body: [
      {
        type: 'p',
        text: '`fetch(url, { credentials: "include" })` makes the browser send cookies cross-origin, and the rules get stricter. The response must name the exact origin in `Access-Control-Allow-Origin` and send `Access-Control-Allow-Credentials: true`. A `*` is rejected, because it would let any site read a response made for one signed-in user.',
      },
      {
        type: 'p',
        text: 'This GET is still a simple request, so there is no preflight. The server received the cookie and answered, but the page cannot read the reply.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-cred-get-1',
        flow: browserFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.api,
          path: '/v1/session',
          headers: browserHeaders([['cookie', COOKIE]]),
        }),
        label: 'GET + cookie',
        summary: 'HEADERS[9]: GET /v1/session, Cookie: sid=..., Origin: https://example.com',
        at: 0,
        wireMs: 9000,
      }),
      h2Packet({
        id: 'p-cred-resp-1',
        flow: browserFlow,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: jsonResponse(BODY_SESSION, 9, [
            ['access-control-allow-origin', '*'],
            ['access-control-allow-credentials', 'true'],
            ['cache-control', 'private'],
          ]),
        }),
        body: BODY_SESSION,
        label: '200 ACAO: *',
        summary:
          'HEADERS[9]: 200, Access-Control-Allow-Origin: *, Access-Control-Allow-Credentials: true',
        at: 3000,
        wireMs: 9024.8,
        outcome: {
          kind: 'blocked',
          note: 'A wildcard Access-Control-Allow-Origin is not accepted for a credentialed request.',
        },
      }),
    ],
    actions: [
      {
        id: 'a-credentials-mode',
        node: 'laptop',
        kind: 'process',
        label: 'credentials: include',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-handle-session-1',
        node: 'api',
        kind: 'process',
        label: 'Look up session',
        at: TRAVEL_MS,
        durationMs: 350,
      },
      {
        id: 'a-cors-fail-2',
        node: 'laptop',
        kind: 'verify',
        label: 'Wildcard rejected',
        at: 3000 + TRAVEL_MS,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: [
      'The cookie must also pass the browser’s cookie rules for cross-site requests (for example `SameSite=None; Secure`); how it was set is not shown.',
    ],
    references: [FETCH_CREDENTIALS, FETCH_CORS],
  },
  // 9 ----------------------------------------------------------------------
  {
    id: 'credentialed-fixed',
    phase: 'credentials',
    title: 'Fix: exact origin, credentials, Vary',
    summary:
      'The server echoes the exact origin and adds `Access-Control-Allow-Credentials: true` and `Vary: Origin`. The same credentialed request now succeeds.',
    body: [
      {
        type: 'p',
        text: 'The server compares the request’s `Origin` with an allow-list and echoes the match. It must not reflect any origin it is given while also sending `Allow-Credentials: true`: that would let every site read private data.',
      },
      {
        type: 'p',
        text: '`Vary: Origin` matters because the value changes per requester. Without it, a shared cache could store the reply for `https://example.com` and replay its `Access-Control-Allow-Origin` to a different origin.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-cred-get-2',
        flow: browserFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.api,
          path: '/v1/session',
          headers: browserHeaders([['cookie', COOKIE]]),
        }),
        label: 'GET + cookie',
        summary: 'HEADERS[11]: GET /v1/session, Cookie: sid=..., Origin: https://example.com',
        at: 0,
        wireMs: 11000,
      }),
      h2Packet({
        id: 'p-cred-resp-2',
        flow: browserFlow,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: jsonResponse(BODY_SESSION, 11, [
            ['access-control-allow-origin', PAGE_ORIGIN],
            ['access-control-allow-credentials', 'true'],
            ['vary', 'Origin'],
            ['cache-control', 'private'],
          ]),
        }),
        body: BODY_SESSION,
        label: '200 exact origin',
        summary:
          'HEADERS[11]: 200, Access-Control-Allow-Origin: https://example.com, Allow-Credentials: true',
        at: 3000,
        wireMs: 11024.6,
      }),
    ],
    actions: [
      {
        id: 'a-handle-session-2',
        node: 'api',
        kind: 'process',
        label: 'Echo allowed origin',
        at: TRAVEL_MS,
        durationMs: 350,
      },
      {
        id: 'a-cors-pass-3',
        node: 'laptop',
        kind: 'verify',
        label: 'Credentialed check passes',
        at: 3000 + TRAVEL_MS,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'api'],
    references: [FETCH_CREDENTIALS, RFC_9110_VARY],
  },
  // 10 ---------------------------------------------------------------------
  {
    id: 'preflight-cache',
    phase: 'limits',
    title: 'Max-Age: a later PUT skips the preflight',
    summary:
      'The browser remembers the preflight result for `Access-Control-Max-Age` seconds. A matching `PUT` about 90 seconds later goes out directly, with no `OPTIONS`.',
    body: [
      {
        type: 'p',
        text: 'The preflight cache is keyed by origin, URL and credentials mode. While an entry is fresh and covers the method and headers, the browser skips the `OPTIONS` request. Without `Access-Control-Max-Age`, the Fetch standard falls back to 5 seconds, and browsers may cap large values.',
      },
      {
        type: 'p',
        text: 'Max-Age governs only the preflight. The actual response is still checked for `Access-Control-Allow-Origin` every time, and ordinary HTTP caching of that response is a separate matter.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-put-2',
        flow: browserFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'PUT',
          authority: HOST.api,
          path: '/v1/profile',
          headers: browserHeaders([
            ['authorization', 'Bearer example-token-7f3a'],
            ['content-type', 'application/json'],
            ['content-length', String(BODY_PUT_2.length)],
          ]),
        }),
        body: BODY_PUT_2,
        label: 'PUT (cached OK)',
        summary: 'HEADERS[13]: PUT /v1/profile, DATA[13] application/json (no preflight)',
        at: 800,
        wireMs: 94244,
      }),
      h2Packet({
        id: 'p-put-2-resp',
        flow: browserFlow,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: jsonResponse(BODY_PUT_2_OK, 94, [
            ['access-control-allow-origin', PAGE_ORIGIN],
            ['vary', 'Origin'],
            ['x-request-id', 'e51b9d'],
          ]),
        }),
        body: BODY_PUT_2_OK,
        label: '200 + Allow-Origin',
        summary:
          'HEADERS[13]: 200, DATA[13] application/json, Access-Control-Allow-Origin: https://example.com',
        at: 800 + TRAVEL_MS + 350,
        wireMs: 94269.2,
      }),
    ],
    actions: [
      {
        id: 'a-preflight-hit',
        node: 'laptop',
        kind: 'cache-hit',
        label: 'Preflight cache hit',
        at: 0,
        durationMs: 700,
      },
      {
        id: 'a-handle-put-2',
        node: 'api',
        kind: 'process',
        label: 'Authenticate · update',
        at: 800 + TRAVEL_MS,
        durationMs: 350,
      },
      {
        id: 'a-cors-pass-4',
        node: 'laptop',
        kind: 'verify',
        label: 'CORS check passes',
        at: 800 + TRAVEL_MS + 350 + TRAVEL_MS,
        durationMs: 700,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: [
      'The 90-second gap is not animated; the wire times in the packet table show it.',
    ],
    references: [FETCH_PREFLIGHT_CACHE, FETCH_PREFLIGHT],
  },
  // 11 ---------------------------------------------------------------------
  {
    id: 'curl-ignores-cors',
    phase: 'limits',
    title: 'curl ignores CORS',
    summary:
      '`curl` asks the same endpoint as step 3, sends no `Origin`, and reads the response that the browser blocked. CORS limits what a page may read, not what a client may ask.',
    body: [
      {
        type: 'p',
        text: '`curl`, scripts and other servers do not enforce CORS; they have no page origin to protect. The endpoint from step 3 answers exactly as before, and this time the whole response is readable.',
      },
      {
        type: 'p',
        text: 'So CORS is not access control for the API: authentication and authorisation belong on the server. It is not CSRF protection either. A cross-site form `POST` is a simple request that the browser sends anyway, so use `SameSite` cookies, CSRF tokens or server-side `Origin` checks.',
      },
      {
        type: 'callout',
        tone: 'note',
        text: 'The `Origin` header is useful to the server, but only browsers are obliged to set it truthfully.',
      },
    ],
    packets: [
      h2Packet({
        id: 'p-curl-get',
        flow: curlFlow,
        dir: 'c2s',
        app: http2Request({
          method: 'GET',
          authority: HOST.api,
          path: '/v1/account/limits',
          headers: [
            ['user-agent', 'curl/8.9.1'],
            ['accept', '*/*'],
          ],
        }),
        label: 'curl GET',
        summary: 'HEADERS[1]: GET /v1/account/limits (no Origin header)',
        at: 0,
        wireMs: 130000,
      }),
      h2Packet({
        id: 'p-curl-resp',
        flow: curlFlow,
        dir: 's2c',
        app: http2Response({
          status: 200,
          headers: jsonResponse(BODY_LIMITS, 130, [['x-request-id', '71d0c3']]),
        }),
        body: BODY_LIMITS,
        label: '200 (readable)',
        summary:
          'HEADERS[1]: 200, DATA[1] application/json (no Access-Control-Allow-Origin needed)',
        at: 3000,
        wireMs: 130024.5,
      }),
    ],
    actions: [
      {
        id: 'a-curl-run',
        node: 'laptop',
        kind: 'process',
        label: 'curl: no Origin',
        at: 0,
        durationMs: 600,
      },
      {
        id: 'a-handle-limits-2',
        node: 'api',
        kind: 'process',
        label: 'Handle request',
        at: TRAVEL_MS,
        durationMs: 350,
      },
    ],
    focus: ['laptop', 'api'],
    simplifications: [
      'curl opens its own TCP and TLS connection, which is collapsed like the browser’s.',
    ],
    references: [FETCH_CORS, FETCH_ORIGIN],
  },
];

export default defineScenario({
  id: 'cors',
  title: 'CORS',
  tagline: 'How a browser decides whether a page may read a response from another origin.',
  category: 'web',
  order: 3,
  protocols: ['ethernet', 'ipv4', 'tcp', 'tls', 'http'],
  phases: [
    { id: 'simple', label: 'Simple requests' },
    { id: 'preflight', label: 'Preflight' },
    { id: 'credentials', label: 'Credentials' },
    { id: 'limits', label: 'Caching and limits' },
  ],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'Your browser',
      sublabel: IP.laptop,
      position: { col: 0, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop, hostname: HOST.laptop },
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
      id: 'api',
      kind: 'api-server',
      label: 'API server',
      sublabel: HOST.api,
      position: { col: 8.25, row: 2 },
      zone: 'datacenter',
      addresses: { ipv4: IP.api, mac: MAC_API, hostname: HOST.api },
    },
  ],
  links: [
    { id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' },
    { id: 'router-cloud', a: 'router', b: 'cloud', medium: 'wan' },
    { id: 'cloud-api', a: 'cloud', b: 'api', medium: 'wan' },
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
  steps,
});
