# Authoring scenarios

A scenario is one TypeScript file that describes a network, the packets that cross it and the
explanation of each step. The app, the packet table, the sequence diagram and the validator all read
the same data, so adding a scenario needs no component code.

- [Add a scenario](#add-a-scenario)
- [Add a protocol](#add-a-protocol)
- [Add a node kind](#add-a-node-kind)
- [The validator and its error codes](#the-validator-and-its-error-codes)
- [Layout guidance](#layout-guidance)
- [Accuracy guardrails](#accuracy-guardrails)
- [Copy and limits](#copy-and-limits)

The data model lives in `src/model/types.ts`. Read it first; this guide explains how to use it, not
every field.

## Add a scenario

1. Create `src/scenarios/data/<scenario-id>.ts`. The id is kebab-case and **must equal the file name**.
2. Default-export `defineScenario({ ... })`.
3. Run `pnpm test`. The validator checks every file in `data/` automatically, so no registration step
   exists. Run `pnpm dev` to look at it.

`src/scenarios/index.ts` collects `data/*.ts` with `import.meta.glob`, sorts by category and then
`order`, and the sidebar groups them under the category headings (Journey, Foundations, Network
services, Web, Email). A step link looks like `#/<scenario-id>/<step, 1-based>?view=sequence`.

A minimal skeleton (see `src/scenarios/__fixtures__/minimal.ts` for a complete one):

```ts
import { defineScenario } from '../../model/types';
import { IP, ISN, MAC, PORT } from '../lib/addresses';
import { ethernet, ipv4, tcp, tcpSynOptions } from '../lib/builders';

export default defineScenario({
  id: 'my-topic',
  title: 'My topic',
  tagline: 'One line under the title.',
  category: 'web',
  order: 5, // position inside the category
  protocols: ['ethernet', 'ipv4', 'tcp'], // every protocol the packets use
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
    // ...
  ],
  links: [{ id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' }],
  zones: [
    {
      id: 'home',
      label: 'Home LAN',
      from: { col: -1, row: 1 },
      to: { col: 3, row: 4 },
      tone: 'lan',
    },
  ],
  steps: [
    {
      id: 'syn',
      title: 'SYN: the client proposes a connection', // at most 48 characters
      summary: 'One or two sentences.', // at most 200 characters
      body: [{ type: 'p', text: 'Explanation with `code` and **bold** only.' }],
      packets: [/* PacketDef[] sorted by `at` */],
      simplifications: ['What this step leaves out.'],
      references: [
        {
          label: 'RFC 9293, section 3.5',
          url: 'https://www.rfc-editor.org/rfc/rfc9293#section-3.5',
        },
      ],
    },
  ],
});
```

Things that save time:

- **Use the shared addressing plan** in `src/scenarios/lib/addresses.ts` (`IP`, `MAC`, `HOST`, `PORT`,
  `ISN`, `EPHEMERAL_PORTS`, `ADDRESS_ALLOWLIST`) instead of inventing addresses. The whole app then
  tells one consistent story.
- **Build headers with `src/scenarios/lib/builders.ts`** (`ethernet`, `ipv4`, `tcp`, `udp`, `icmp`,
  `dns`, `dhcp`, `http1Request`/`http1Response`, `http2Request`/`http2Response`, `tlsHandshake`,
  `mailLine`). They produce correct field names, and `ipv4()` and `tcp()` also return the `meta` the
  validator checks. Put `meta` on the packet: `meta: { tcp: syn.meta, ipv4: ip.meta }`.
- **A packet's route** is `[from, ...via, to]` and every consecutive pair needs a link. A packet shows
  the headers as captured at the sender; one packet per hop is only needed when a per-hop change is
  the lesson (TTL, MAC rewrite).
- **Timing.** `at` is the offset in milliseconds from the step start; `wireTimeMs` is the simulated
  capture time since the scenario start and must never decrease. Hops take 450 to 1100 ms by link
  medium (`DEFAULT_HOP_MS` in `src/engine/compile.ts`); override with `hopMs` and `dwellMs` only when
  needed. Time shown in the table adapts: `+12.4 ms`, `+1.203 s`, `+2:05`, `+12:00:00`.
- **Outcomes.** `outcome: { kind: 'lost', afterNode, note }` fades out on the hop leaving `afterNode`;
  `dropped` stops at a node with an X; `blocked` is delivered on the wire and then blocked by the
  browser. `encrypted: true` shows a lock and labels the protocol "HTTP (in TLS)".
- **Local work** (cache lookup, certificate check, render) is a `NodeAction` on the step, not a packet.
- **Broadcasts** set `delivery: 'broadcast'` and list `floodTo` (neighbours of `to`).
- **Sequence diagram.** Nodes of kind `router`, `switch` and `cloud` have no lane by default. Set
  `sequence: 'lane'` or `'hidden'` on a node, or list `sequenceLanes` to fix the lane order.

## Add a protocol

Adding a protocol needs two small data edits and no component changes.

1. Add an entry to `PROTOCOLS` in `src/protocols/registry.ts` (`label`, `fullName`, `layer`, `color`,
   optional `ports` and `references`). `ProtocolId` is derived from the keys, so `protocol: 'x'` is a
   type error until the entry exists.
2. Mirror the colour as `--proto-<id>` in `src/styles/tokens.css`. The colour needs at least 3:1
   contrast against the canvas (`--bg`, `#0b0d12`).
3. List the protocol in the scenario's `protocols` array. Forgetting this is only a warning
   (`protocol-not-declared`), but the legend in the scene header is built from that array.

If the protocol needs a header builder, write a small local helper in the scenario file that returns a
`HeaderGroup` (`{ layer, protocol, title?, fields }`). Move it to `lib/builders.ts` when a second
scenario needs it.

## Add a node kind

1. Add an entry to `NODE_KINDS` in `src/protocols/nodeKinds.ts`:
   `{ label, defaultSequence: 'lane' | 'hidden', sprite, badge? }`. A kind without its own artwork
   reuses `sprite: 'server'` and is told apart by `badge` (a short text such as `'DHCP'`).
2. Add its accent colour to `KIND_TINT` in `src/ui/scene/devices/tints.ts` (a `Record<NodeKind, string>`,
   so the compiler reminds you) and mirror it as `--kind-<id>` in `src/styles/tokens.css`.

A genuinely new drawing is the only case that needs a component: add it under
`src/ui/scene/devices/`, add its id to `SpriteId` in `src/protocols/nodeKinds.ts` and register it in
`devices/sprites.ts`. Keep a sprite under 40 SVG elements
and do not give it its own filter.

## The validator and its error codes

`validateScenario(def)` in `src/scenarios/validate.ts` returns `ValidationIssue[]`
(`{ severity, code, path, message }`). `validateScenarioSet` adds the checks that need all files.
`src/scenarios/validate.test.ts` runs both over every registered scenario and expects **zero errors**;
that test is what keeps a data-only change structurally correct. Scenario files are still
TypeScript modules that run in the browser and in the test runner, so review them like any other
code change; the validator checks only the exported object. The `path` points into the scenario, for example
`steps[2].packets[0].via`. Match on `code`, never on `message`. The codes are defined in
`src/scenarios/checks/issue.ts`.

| Group               | Codes (all errors unless noted)                                                                                                                                                                                                                                                                              |
| ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Identity            | `scenario-id-not-kebab-case`, `scenario-id-file-mismatch`, `scenario-id-duplicate`, `node-id-duplicate`, `link-id-duplicate`, `zone-id-duplicate`, `phase-id-duplicate`, `step-id-duplicate`, `packet-id-duplicate`, `action-id-duplicate`                                                                   |
| Registries          | `node-kind-unknown`, `protocol-unknown`, `protocol-not-declared` (warning)                                                                                                                                                                                                                                   |
| Topology            | `link-endpoint-missing`, `link-self`, `link-duplicate-pair`, `node-shared-cell`, `node-zone-unknown`, `step-phase-unknown`, `step-focus-unknown`, `sequence-lane-unknown`, `action-node-unknown`                                                                                                             |
| Routes and outcomes | `packet-from-unknown`, `packet-to-unknown`, `packet-via-unknown`, `route-unlinked-hop`, `flood-target-unknown`, `flood-target-not-neighbour`, `flood-without-broadcast`, `outcome-node-off-route`, `outcome-lost-after-destination`, `outcome-dropped-at-source`                                             |
| Timing and limits   | `packet-at-negative`, `packets-not-sorted-by-at`, `wire-time-decreasing`, `timing-invalid`, `concurrent-packets-exceeded` (more than 12 on screen at once), `step-title-empty`, `step-title-too-long` (over 48), `step-summary-empty`, `step-summary-too-long` (over 200), `packet-label-too-long` (over 18) |
| Addresses           | `address-ipv4-malformed`, `address-ipv4-outside-documentation`, `address-ipv6-malformed`, `address-ipv6-outside-documentation`, `address-hostname-not-reserved`                                                                                                                                              |
| TCP                 | `tcp-first-not-syn`, `tcp-second-not-syn-ack`, `tcp-syn-ack-wrong-ack`, `tcp-seq-mismatch`, `tcp-ack-missing`, `tcp-ack-beyond-peer`, `tcp-endpoint-mismatch`                                                                                                                                                |
| IPv4 fragments      | `ip-fragment-length-missing`, `ip-fragment-gap`, `ip-fragment-length-not-multiple-of-8`, `ip-fragment-mf-flag`, `ip-fragment-total-mismatch`                                                                                                                                                                 |

What the accuracy checks accept:

- **Addresses.** IPv4 only in `192.0.2.0/24`, `198.51.100.0/24`, `203.0.113.0/24`, RFC 1918, `0.0.0.0`,
  `255.255.255.255`, `127.0.0.0/8` or the scenario's `addressAllowlist` (for example
  `ADDRESS_ALLOWLIST` for the real root and gTLD servers). IPv6 only in `2001:db8::/32`. Hostnames end
  in `example.com`, `.net`, `.org`, `.example` or `.test`, except `*.root-servers.net` and
  `*.gtld-servers.net`.
- **TCP, per `conn` and direction.** The first segment is a SYN; the next expected `seq` is
  `seq + len` plus one for SYN and one for FIN; a segment must start there unless it sets
  `retransmission` (reuses an old `seq`) or `resync` (a documented omission, such as dropped pure
  ACKs, which also needs a `simplifications` entry); an ACK may equal or trail the peer's next
  sequence number but never exceed it; the second segment of a handshake is a SYN+ACK with
  `ack = clientISN + 1`.
- **Fragments.** For packets sharing `meta.ipv4.id` with MF or a fragment offset: offsets (in 8-byte
  units) are contiguous, every fragment but the last carries a multiple of 8 data bytes, and the
  lengths add up to the original.

Run one scenario's checks quickly with `pnpm vitest run src/scenarios`.

## Layout guidance

Positions are isometric grid coordinates (`GridPoint`, `.5` allowed). The mapping to screen space is
in `src/engine/geometry.ts`:

```
x = (col - row) * 64        y = (col + row) * 32      (a 128 x 64 diamond per tile)
```

So moving `+col` goes right and down, `+row` goes left and down. Equal `col + row` means the same
screen height.

- **One node per cell.** Two nodes in the same cell are the error `node-shared-cell`. Leave at least
  2 cells between neighbours: a device sprite is about 128 wide and 96 tall on screen, plus its label
  below.
- **Zones** are rectangles in grid space (`from` and `to` are opposite corners) drawn as labelled
  plates. Keep zones **non-overlapping**, put every node inside its own zone and leave about one cell
  of margin around the nodes. Zones are not validated, so look at them in `pnpm dev`.
- **Aim for a bounding box of about 1.5:1** (wider than tall). The scene fits the box of nodes, zones
  and `via` points (`sceneBounds`) into the panel with `meet` scaling, so a very tall or very flat
  scenario shrinks to leave empty bands on the sides. Below a rendered scale of 0.75 address lines are
  hidden, so spread devices out rather than packing them.
- **Links** are straight between nodes. Use `via` points to route around other devices; a packet
  follows the same polyline. Keep link crossings to a minimum.
- **Order the topology like the story**: the client on the left of the screen (low `col`, high `row`)
  and the server on the right, so packets read left to right.
- **Check three sizes**: 1440 px, 1024 px and 768 px wide, both views, with the largest step open.
  The packet table, the playhead and the legend change width, and the labels need to stay readable.
- **Budgets.** At most 12 packets on screen at once, at most 1500 scene DOM elements (the largest
  scenario uses about 460) and no more than about 28 steps for the flagship journey, 6 to 14 for a
  protocol scenario.

## Accuracy guardrails

The validator enforces the machine-checkable ones; the rest are review points.

**Addresses and names**

- Public addresses only from RFC 5737 ranges; LAN addresses from `192.168.1.0/24`; IPv6 from
  `2001:db8::/32`; MACs `00:00:5e:00:53:xx` (RFC 7042); domains `example.com`, `.net`, `.org`.
- Client ports come from 49152 to 65535 (not checked by the validator).

**Capture point and timing**

- Headers are shown as captured at the sender. Otherwise add a simplification such as "NAT rewrites the
  source address at the home router."
- Plausible `wireTimeMs`: under 1 ms on a LAN, 5 to 15 ms to an ISP resolver, 20 to 40 ms to root and
  TLD servers, 10 to 20 ms round trip to a CDN edge, 60 to 120 ms from edge to origin.

**TCP**

- Explicit absolute ISNs (client `1204331000`, server `3877120400`; the UI also shows relative values).
- SYN `seq=x`; SYN-ACK `seq=y ack=x+1`; ACK `seq=x+1 ack=y+1`. Data advances `seq` by its length;
  SYN and FIN each consume one. The SYN carries MSS, SACK permitted, window scale and timestamps.
- A retransmission reuses the original `seq`. The active closer enters TIME_WAIT.

**UDP.** 8-byte header, and the length field includes it. No handshake, ordering or retransmission.

**IP.** Routers decrement TTL and recompute the header checksum. At TTL 0 the router drops the packet
and sends ICMP type 11, code 0. IP addresses stay the same end to end (without NAT) while Ethernet
addresses change at every hop. Fragment offsets count 8-byte units: a 1500-byte packet over MTU 1400
gives fragment 1 with `totalLength=1396`, 1376 data bytes, offset 0, MF=1 and fragment 2 with
`totalLength=124`, 104 data bytes, offset 172, MF=0. With DF set the router drops it and sends ICMP
type 3, code 4 with the next-hop MTU. IPv6 routers never fragment.

**DNS.** Stub to recursive resolver is recursive (RD=1) and the reply carries RA=1. The resolver
queries iteratively (RD=0); referrals carry NS records in the authority section and glue in the
additional section; the authoritative answer sets AA=1. The ID matches between query and reply. UDP 53,
TCP when TC=1. A root server only refers. Show the full QNAME and mention QNAME minimisation
(RFC 9156) in a callout.

**DHCP.** Client port 68, server port 67. Discover: `0.0.0.0` to `255.255.255.255`, broadcast, with
`xid` and `chaddr`. Request: still from `0.0.0.0`, with option 50 (requested IP) and option 54 (server
identifier). ACK: options 51, 1, 3, 6. Renewal at T1 (50%) is unicast; rebinding at T2 (87.5%) is
broadcast. Relays use `giaddr`.

**HTTP.** HTTP/1.1 needs `Host` and keeps connections alive. h2 uses `:method :scheme :authority
:path` and lower-case names. A conditional request with `If-None-Match` gets `304` with no body. HTTPS
hides path, headers, cookies and body, but not IP addresses, ports, the SNI hostname (without ECH),
sizes or timing.

**TLS 1.3.** ClientHello: `legacy_version 0x0303`, `supported_versions` with `0x0304`, `random`,
cipher suites, `supported_groups x25519`, `key_share`, `signature_algorithms`, SNI, ALPN. After
ServerHello the server's EncryptedExtensions, Certificate, CertificateVerify and Finished are
encrypted with handshake keys; the client then sends Finished (1-RTT). The certificate is encrypted;
there is no RSA key exchange; forward secrecy comes from ephemeral ECDHE. Chain validation goes leaf,
intermediate, trust-store root (the root is not sent); the hostname is checked against the SAN, not the
CN. Never write "the server encrypts with its public key".

**CORS.** Same origin means same scheme, host and port. No preflight for GET, HEAD or POST with only
safelisted headers and a form or plain-text `Content-Type`. A preflight is `OPTIONS` with `Origin`,
`Access-Control-Request-Method` and `Access-Control-Request-Headers`, sent without credentials, and
needs a 2xx. With credentials `Access-Control-Allow-Origin` names the exact origin (never `*`) and
`Access-Control-Allow-Credentials: true` is required; add `Vary: Origin`. The browser enforces CORS:
a blocked response still reached the server, and CORS is not CSRF protection.

**CDN.** The cache key is the URL plus `Vary`. `s-maxage` applies to shared caches, `private` is not
stored by a CDN, `no-store` is never stored, `no-cache` means revalidate. `Age` reports seconds in
cache. Prefer `Cache-Status` (RFC 9211); `X-Cache` is vendor-specific. TLS terminates at the edge.
Revalidation uses `If-None-Match` and `304`.

**Email.** Submission on 587 with STARTTLS (or 465, RFC 8314); AUTH is required and EHLO is re-issued
after STARTTLS. The sending MTA looks up MX records and relays on port 25 with opportunistic STARTTLS.
Codes: 220, 250, 354, 221, 334/235; DATA ends with `<CRLF>.<CRLF>`. The envelope `MAIL FROM` differs
from the `From:` header. POP3 (110/995) usually downloads mail but deleting is optional. IMAP
(143/993) keeps mail on the server and supports flags and IDLE. SPF, DKIM and DMARC appear only in a
callout.

## Copy and limits

- All text is original. Phrase claims carefully and avoid version-specific browser trivia.
- Rich text supports only `` `code` `` and `**bold**`.
- Step title at most 48 characters; summary at most 200; packet label at most 18; step body about 180
  words.
- Every step cites its RFC or WHATWG section in `references`. Use the exact fragment for the section
  (`#section-4.2.1` on `rfc-editor.org`, the heading id on WHATWG specs) and open the link before
  committing it.
- Add a `simplifications` entry wherever the step leaves something out.
- Not in scope for v1 scenarios: ARP, NAT, ICMP, SSH, FTP, QUIC/HTTP/3, DNSSEC, the full TLS 1.2 flow,
  IPv6, and the SPF/DKIM/DMARC mechanics. They may appear in callouts.
