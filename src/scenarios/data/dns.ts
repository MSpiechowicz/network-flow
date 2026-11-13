import { defineScenario } from '../../model/types';
import type { HeaderGroup, PacketDef, Reference } from '../../model/types';
import { ADDRESS_ALLOWLIST, HOST, IP, MAC, PORT, REAL_INFRA } from '../lib/addresses';
import { dns, ethernet, ipv4, udp } from '../lib/builders';

/**
 * Full DNS resolution of www.example.com: stub to recursive resolver, then the resolver walks
 * root, TLD and authoritative servers iteratively, then a second client hits the resolver's cache.
 */

// DNS message sizes in bytes (no EDNS0), counting name compression as a real server would use it.
const QUERY_BYTES = 33; // 12 header + 17 QNAME (3www7example3com0) + 4 type/class
const ROOT_REFERRAL_BYTES = 81; // + NS com. (32) + glue A (16)
const TLD_REFERRAL_BYTES = 67; // + NS example.com. (18) + glue A (16)
const ANSWER_BYTES = 49; // + one A record (16)

// Transaction IDs: the stub's, and one per upstream query (each reply repeats its query's ID).
const STUB_ID = 0x3a7c;
const ROOT_ID = 0x5b21;
const TLD_ID = 0xc40d;
const AUTH_ID = 0x27f8;
const PHONE_ID = 0x7d02;

// Ephemeral source ports (RFC 6335). Resolvers randomise theirs per query (RFC 5452).
const LAPTOP_PORT = 51234;
const PHONE_PORT = 49321;
const ROOT_PORT = 58012;
const TLD_PORT = 60771;
const AUTH_PORT = 53998;

// Placeholder frames for the Internet side: each real hop would carry different MAC addresses.
const MAC_ROOT = MAC.spare[0];
const MAC_TLD = MAC.spare[1];
const MAC_AUTH = MAC.spare[2];
const MAC_INTERNET_GATEWAY = MAC.spare[3];

const QUESTION = { name: HOST.www, type: 'A' } as const;

const REF_1035_MESSAGE: Reference = {
  label: 'RFC 1035, section 4.1: message format',
  url: 'https://www.rfc-editor.org/rfc/rfc1035#section-4.1',
};
const REF_1034_RESOLUTION: Reference = {
  label: 'RFC 1034, section 5.3.3: resolver algorithm',
  url: 'https://www.rfc-editor.org/rfc/rfc1034#section-5.3.3',
};

interface DatagramInput {
  srcMac: string;
  dstMac: string;
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  ipId: number;
  message: HeaderGroup;
  dnsBytes: number;
}

/** Ethernet, IPv4 and UDP around one DNS message, with consistent length fields and frame size. */
function datagram(d: DatagramInput): Pick<PacketDef, 'headers' | 'sizeBytes' | 'meta'> {
  const udpLength = 8 + d.dnsBytes;
  const ip = ipv4({
    src: d.srcIp,
    dst: d.dstIp,
    ttl: 64,
    id: d.ipId,
    protocol: 'UDP',
    totalLength: 20 + udpLength,
  });

  return {
    headers: [
      ethernet({ src: d.srcMac, dst: d.dstMac, etherType: 'IPv4' }),
      ip.group,
      udp({ srcPort: d.srcPort, dstPort: d.dstPort, length: udpLength }),
      d.message,
    ],
    sizeBytes: 14 + 20 + udpLength,
    meta: { ipv4: ip.meta },
  };
}

const answerA = (ttl: number) => [{ name: HOST.www, type: 'A', ttl, data: IP.cdnEdge }];

export default defineScenario({
  id: 'dns',
  title: 'DNS',
  tagline: 'How a name becomes an address: recursion, referrals and caching.',
  category: 'network-services',
  order: 2,
  protocols: ['ethernet', 'ipv4', 'udp', 'dns'],
  addressAllowlist: ADDRESS_ALLOWLIST,
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'Your laptop',
      sublabel: IP.laptop,
      position: { col: 0.5, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.laptop, mac: MAC.laptop },
    },
    {
      id: 'phone',
      kind: 'phone',
      label: 'Phone',
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
      id: 'resolver',
      kind: 'dns-resolver',
      label: 'ISP resolver',
      sublabel: IP.ispResolver,
      position: { col: 5.5, row: 2 },
      zone: 'isp',
      addresses: { ipv4: IP.ispResolver, mac: MAC.ispResolver },
    },
    {
      id: 'cloud',
      kind: 'cloud',
      label: 'Internet',
      position: { col: 5.5, row: -0.75 },
      zone: 'internet',
    },
    {
      id: 'root',
      kind: 'dns-root',
      label: 'Root server',
      sublabel: IP.root,
      position: { col: 5.5, row: -3.75 },
      zone: 'internet',
      addresses: { ipv4: IP.root, mac: MAC_ROOT, hostname: REAL_INFRA.root.name },
    },
    {
      id: 'tld',
      kind: 'dns-tld',
      label: '.com TLD server',
      sublabel: IP.tldCom,
      position: { col: 8.5, row: -3.75 },
      zone: 'internet',
      addresses: { ipv4: IP.tldCom, mac: MAC_TLD, hostname: REAL_INFRA.tldCom.name },
    },
    {
      id: 'auth',
      kind: 'dns-authoritative',
      label: 'example.com server',
      sublabel: IP.authoritativeNs,
      position: { col: 9, row: -0.25 },
      zone: 'internet',
      addresses: { ipv4: IP.authoritativeNs, mac: MAC_AUTH, hostname: HOST.ns },
    },
  ],
  links: [
    { id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' },
    { id: 'phone-router', a: 'phone', b: 'router', medium: 'wifi' },
    { id: 'router-resolver', a: 'router', b: 'resolver', medium: 'wan' },
    { id: 'resolver-cloud', a: 'resolver', b: 'cloud', medium: 'wan' },
    { id: 'cloud-root', a: 'cloud', b: 'root', medium: 'backbone' },
    { id: 'cloud-tld', a: 'cloud', b: 'tld', medium: 'backbone' },
    { id: 'cloud-auth', a: 'cloud', b: 'auth', medium: 'backbone' },
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
      id: 'isp',
      label: 'ISP',
      from: { col: 4, row: 0.5 },
      to: { col: 7, row: 3.5 },
      tone: 'isp',
    },
    {
      id: 'internet',
      label: 'Internet',
      from: { col: 4.25, row: -4.25 },
      to: { col: 9.5, row: 0.25 },
      tone: 'internet',
    },
  ],
  phases: [
    { id: 'resolve', label: 'Full resolution' },
    { id: 'cache', label: 'Cache' },
  ],
  sequenceLanes: ['laptop', 'phone', 'resolver', 'root', 'tld', 'auth'],
  steps: [
    {
      id: 'stub-query',
      title: 'Stub resolver sends a recursive query',
      phase: 'resolve',
      summary:
        'The laptop’s stub resolver asks the ISP’s recursive resolver for the `A` record of `www.example.com`, with **RD=1** and a fresh transaction ID.',
      body: [
        {
          type: 'p',
          text: 'A stub resolver is the small DNS client inside the operating system. It does not chase referrals: it sends one question to a recursive resolver and sets the **RD** (recursion desired) flag, which means “do the whole lookup for me”.',
        },
        {
          type: 'p',
          text: 'The message is a UDP datagram from an ephemeral port to port 53. The 16-bit transaction ID `0x3a7c` lets the stub recognise the matching reply. The question carries the full name, type `A` and class `IN`.',
        },
        {
          type: 'callout',
          tone: 'tip',
          text: 'Clients usually ask for `A` and `AAAA` in parallel, as two separate queries with different IDs, so that IPv4 and IPv6 connection attempts can start early (Happy Eyeballs, RFC 8305). This walkthrough follows the `A` query.',
        },
      ],
      packets: [
        {
          id: 'p-stub-query',
          from: 'laptop',
          to: 'resolver',
          via: ['router'],
          protocol: 'dns',
          label: 'A? www.example.com',
          summary: 'Standard query 0x3a7c A www.example.com',
          ...datagram({
            srcMac: MAC.laptop,
            dstMac: MAC.routerLan,
            srcIp: IP.laptop,
            dstIp: IP.ispResolver,
            srcPort: LAPTOP_PORT,
            dstPort: PORT.dns,
            ipId: 0x4f1a,
            message: dns({
              id: STUB_ID,
              qr: 'query',
              flags: { rd: true },
              question: QUESTION,
            }),
            dnsBytes: QUERY_BYTES,
          }),
          at: 600,
          wireTimeMs: 0,
        },
      ],
      actions: [
        {
          id: 'a-stub-miss',
          node: 'laptop',
          kind: 'cache-miss',
          label: 'Stub cache: miss',
          at: 0,
          durationMs: 500,
        },
      ],
      focus: ['laptop', 'resolver'],
      simplifications: [
        'The home router rewrites the source address with NAT; the header shows the packet as the laptop sent it.',
        'Many home networks point the stub at the router, which forwards to the ISP; here it asks the ISP resolver directly. ISP routers between the two are not drawn.',
        'The parallel `AAAA` query is not drawn.',
      ],
      references: [
        REF_1035_MESSAGE,
        {
          label: 'RFC 1034, section 5.3.1: stub resolvers',
          url: 'https://www.rfc-editor.org/rfc/rfc1034#section-5.3.1',
        },
        {
          label: 'RFC 8305: Happy Eyeballs version 2',
          url: 'https://www.rfc-editor.org/rfc/rfc8305',
        },
      ],
    },
    {
      id: 'root-query',
      title: 'Resolver misses its cache, asks a root server',
      phase: 'resolve',
      summary:
        'Nothing is cached, so the resolver starts at the top. It sends an iterative query (**RD=0**) for the full name to a root server, with a new ID and a random source port.',
      body: [
        {
          type: 'p',
          text: 'The resolver has no record for this name, nor a cached delegation for `com.` or `example.com.`, so it starts at the root. Every resolver ships with the addresses of the root servers, often called root hints.',
        },
        {
          type: 'p',
          text: 'Now the resolver is the client. Its query is **iterative**: RD is 0, because it does not ask the root to recurse on its behalf. The question is still the full name, but the transaction ID and the randomised source port are new, which makes blind spoofing harder.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'With QNAME minimisation (RFC 9156) a resolver reveals only as many labels as a server needs, here just `com.`, so the root never sees the full name. Many modern resolvers do this; the full name is shown to keep the lesson simple.',
        },
      ],
      packets: [
        {
          id: 'p-root-query',
          from: 'resolver',
          to: 'root',
          via: ['cloud'],
          protocol: 'dns',
          label: 'A? www.example.com',
          summary: 'Standard query 0x5b21 A www.example.com',
          ...datagram({
            srcMac: MAC.ispResolver,
            dstMac: MAC.ispRouterResolver,
            srcIp: IP.ispResolver,
            dstIp: IP.root,
            srcPort: ROOT_PORT,
            dstPort: PORT.dns,
            ipId: 0x9c03,
            message: dns({ id: ROOT_ID, qr: 'query', question: QUESTION }),
            dnsBytes: QUERY_BYTES,
          }),
          at: 700,
          wireTimeMs: 6.4,
        },
      ],
      actions: [
        {
          id: 'a-resolver-miss',
          node: 'resolver',
          kind: 'cache-miss',
          label: 'Cache: miss',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['resolver', 'root'],
      simplifications: [
        'The root server is drawn as one machine; the root server addresses are really anycast, answered by many sites.',
        'The Ethernet addresses of Internet-side devices are placeholders from the documentation range; every real hop rewrites them.',
      ],
      references: [
        {
          label: 'RFC 1034, section 4.3.2: iterative algorithm',
          url: 'https://www.rfc-editor.org/rfc/rfc1034#section-4.3.2',
        },
        REF_1034_RESOLUTION,
        { label: 'RFC 9156: QNAME minimisation', url: 'https://www.rfc-editor.org/rfc/rfc9156' },
        {
          label: 'RFC 5452: resilience to forged answers',
          url: 'https://www.rfc-editor.org/rfc/rfc5452',
        },
      ],
    },
    {
      id: 'root-referral',
      title: 'Root server refers the resolver to .com',
      phase: 'resolve',
      summary:
        'The root cannot answer; it returns a referral. NS records for `com.` sit in the authority section, glue addresses in the additional section, and AA is 0.',
      body: [
        {
          type: 'p',
          text: 'A root server is authoritative only for the root zone, which delegates each top-level domain. It cannot answer for `www.example.com`, so the **answer** section is empty and the **AA** flag is not set.',
        },
        {
          type: 'p',
          text: 'The **authority** section names the servers for `com.`, with a TTL of two days (172800 s). The **additional** section carries **glue**: an address for that name server, so the resolver does not need a separate lookup to learn where to ask next.',
        },
        {
          type: 'p',
          text: 'The reply repeats transaction ID `0x5b21` and the question, and its response code is `NOERROR`: a referral is a successful, partial answer.',
        },
      ],
      packets: [
        {
          id: 'p-root-referral',
          from: 'root',
          to: 'resolver',
          via: ['cloud'],
          protocol: 'dns',
          label: 'Referral: com.',
          summary:
            'Standard query response 0x5b21 NS com. a.gtld-servers.net (authority), A 192.5.6.30 (glue)',
          ...datagram({
            srcMac: MAC_ROOT,
            dstMac: MAC_INTERNET_GATEWAY,
            srcIp: IP.root,
            dstIp: IP.ispResolver,
            srcPort: PORT.dns,
            dstPort: ROOT_PORT,
            ipId: 0x1e72,
            message: dns({
              id: ROOT_ID,
              qr: 'response',
              question: QUESTION,
              authority: [
                { name: 'com', type: 'NS', ttl: 172800, data: `${REAL_INFRA.tldCom.name}.` },
              ],
              additional: [
                {
                  name: REAL_INFRA.tldCom.name,
                  type: 'A',
                  ttl: 172800,
                  data: IP.tldCom,
                },
              ],
            }),
            dnsBytes: ROOT_REFERRAL_BYTES,
          }),
          at: 700,
          wireTimeMs: 20.6,
        },
      ],
      actions: [
        {
          id: 'a-root-lookup',
          node: 'root',
          kind: 'process',
          label: 'Finds the com. delegation',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['root', 'resolver'],
      simplifications: [
        'A real root reply lists all of the `.com` name servers (a to m) with glue for each; one is shown.',
        'The Ethernet addresses of Internet-side devices are placeholders from the documentation range.',
      ],
      references: [
        {
          label: 'RFC 1034, section 4.3.2: referrals',
          url: 'https://www.rfc-editor.org/rfc/rfc1034#section-4.3.2',
        },
        REF_1035_MESSAGE,
      ],
    },
    {
      id: 'tld-query',
      title: 'Resolver asks a .com TLD server',
      phase: 'resolve',
      summary:
        'The resolver caches the delegation and sends the same iterative question (RD=0) to the `.com` server it just learned about, using the glue address.',
      body: [
        {
          type: 'p',
          text: 'The resolver keeps the NS and glue records it received, for their TTL. From now on a lookup for any `.com` name can skip the root entirely.',
        },
        {
          type: 'p',
          text: 'It then repeats the question, with a new transaction ID `0xc40d` and a new random source port, to the `.com` server at the glue address. RD is still 0 and the question is unchanged: only the destination moves one level down the hierarchy.',
        },
      ],
      packets: [
        {
          id: 'p-tld-query',
          from: 'resolver',
          to: 'tld',
          via: ['cloud'],
          protocol: 'dns',
          label: 'A? www.example.com',
          summary: 'Standard query 0xc40d A www.example.com',
          ...datagram({
            srcMac: MAC.ispResolver,
            dstMac: MAC.ispRouterResolver,
            srcIp: IP.ispResolver,
            dstIp: IP.tldCom,
            srcPort: TLD_PORT,
            dstPort: PORT.dns,
            ipId: 0xb7d5,
            message: dns({ id: TLD_ID, qr: 'query', question: QUESTION }),
            dnsBytes: QUERY_BYTES,
          }),
          at: 600,
          wireTimeMs: 34.9,
        },
      ],
      actions: [
        {
          id: 'a-cache-com',
          node: 'resolver',
          kind: 'store',
          label: 'Caches NS + glue for com.',
          at: 0,
          durationMs: 500,
        },
      ],
      focus: ['resolver', 'tld'],
      simplifications: [
        'The Ethernet addresses of Internet-side devices are placeholders from the documentation range.',
      ],
      references: [
        REF_1034_RESOLUTION,
        {
          label: 'RFC 2181, section 5.2: TTL of a record set',
          url: 'https://www.rfc-editor.org/rfc/rfc2181#section-5.2',
        },
      ],
    },
    {
      id: 'tld-referral',
      title: 'TLD server refers to the example.com servers',
      phase: 'resolve',
      summary:
        'The `.com` zone delegates `example.com`: an NS record in the authority section plus glue for `ns1.example.com` in the additional section. Still AA=0.',
      body: [
        {
          type: 'p',
          text: 'The `.com` servers hold no host records for `www.example.com`. They know only that `example.com` is delegated to `ns1.example.com`, so the reply is another referral with an empty answer section.',
        },
        {
          type: 'p',
          text: 'Here the name server’s own name lies **inside** the zone it serves. Resolving `ns1.example.com` would require asking that very server, a circular dependency, so the parent zone must publish **glue**: the A record `203.0.113.53` in the additional section.',
        },
        {
          type: 'p',
          text: 'Transaction ID `0xc40d` matches the query sent in the previous step.',
        },
      ],
      packets: [
        {
          id: 'p-tld-referral',
          from: 'tld',
          to: 'resolver',
          via: ['cloud'],
          protocol: 'dns',
          label: 'NS example.com',
          summary:
            'Standard query response 0xc40d NS example.com ns1.example.com (authority), A 203.0.113.53 (glue)',
          ...datagram({
            srcMac: MAC_TLD,
            dstMac: MAC_INTERNET_GATEWAY,
            srcIp: IP.tldCom,
            dstIp: IP.ispResolver,
            srcPort: PORT.dns,
            dstPort: TLD_PORT,
            ipId: 0x6a40,
            message: dns({
              id: TLD_ID,
              qr: 'response',
              question: QUESTION,
              authority: [{ name: HOST.site, type: 'NS', ttl: 172800, data: `${HOST.ns}.` }],
              additional: [{ name: HOST.ns, type: 'A', ttl: 172800, data: IP.authoritativeNs }],
            }),
            dnsBytes: TLD_REFERRAL_BYTES,
          }),
          at: 700,
          wireTimeMs: 49.6,
        },
      ],
      actions: [
        {
          id: 'a-tld-lookup',
          node: 'tld',
          kind: 'process',
          label: 'Finds the example.com delegation',
          at: 0,
          durationMs: 600,
        },
      ],
      focus: ['tld', 'resolver'],
      simplifications: [
        'A real delegation usually lists two or more name servers; one is shown.',
        'The Ethernet addresses of Internet-side devices are placeholders from the documentation range.',
      ],
      references: [
        {
          label: 'RFC 1034, section 4.2.1: delegation and glue',
          url: 'https://www.rfc-editor.org/rfc/rfc1034#section-4.2.1',
        },
        REF_1035_MESSAGE,
      ],
    },
    {
      id: 'auth-query',
      title: 'Resolver asks the authoritative server',
      phase: 'resolve',
      summary:
        'With the glue address for `ns1.example.com`, the resolver sends its third iterative query, this time to the server that actually holds the zone.',
      body: [
        {
          type: 'p',
          text: 'The resolver stores the `example.com` delegation and uses the glue address `203.0.113.53` to reach `ns1.example.com` directly. Without glue it would have to resolve that name first, and nothing could resolve it without asking this server.',
        },
        {
          type: 'p',
          text: 'The question is the same one the laptop asked, under a third transaction ID, `0x27f8`. This is the last hop of the walk: the next reply comes from a server with the answer.',
        },
      ],
      packets: [
        {
          id: 'p-auth-query',
          from: 'resolver',
          to: 'auth',
          via: ['cloud'],
          protocol: 'dns',
          label: 'A? www.example.com',
          summary: 'Standard query 0x27f8 A www.example.com',
          ...datagram({
            srcMac: MAC.ispResolver,
            dstMac: MAC.ispRouterResolver,
            srcIp: IP.ispResolver,
            dstIp: IP.authoritativeNs,
            srcPort: AUTH_PORT,
            dstPort: PORT.dns,
            ipId: 0xd218,
            message: dns({ id: AUTH_ID, qr: 'query', question: QUESTION }),
            dnsBytes: QUERY_BYTES,
          }),
          at: 600,
          wireTimeMs: 64.4,
        },
      ],
      actions: [
        {
          id: 'a-cache-example',
          node: 'resolver',
          kind: 'store',
          label: 'Caches NS + glue for example.com',
          at: 0,
          durationMs: 500,
        },
      ],
      focus: ['resolver', 'auth'],
      simplifications: [
        'The Ethernet addresses of Internet-side devices are placeholders from the documentation range.',
      ],
      references: [
        REF_1034_RESOLUTION,
        {
          label: 'RFC 1035, section 7: resolver implementation',
          url: 'https://www.rfc-editor.org/rfc/rfc1035#section-7',
        },
      ],
    },
    {
      id: 'auth-answer',
      title: 'Authoritative server answers, AA=1, TTL 300',
      phase: 'resolve',
      summary:
        '`ns1.example.com` holds the zone, so its reply sets **AA** and returns `www.example.com A 203.0.113.10` with a TTL of 300 s. The resolver caches the record.',
      body: [
        {
          type: 'p',
          text: 'The question finally reaches a server that holds the data. The answer section contains the A record, and the **AA** (authoritative answer) flag is set. The TTL of 300 seconds tells every cache how long it may reuse the record.',
        },
        {
          type: 'p',
          text: 'RD and RA stay 0: an authoritative server answers only from its own zones and does not recurse for clients.',
        },
        {
          type: 'callout',
          tone: 'warning',
          text: 'If a reply does not fit the UDP size the query allowed (512 bytes by default, more with EDNS0), the server sets **TC=1** and sends what fits. The client then repeats the query over TCP port 53. This 49-byte answer needs no fallback.',
        },
      ],
      packets: [
        {
          id: 'p-auth-answer',
          from: 'auth',
          to: 'resolver',
          via: ['cloud'],
          protocol: 'dns',
          label: 'A 203.0.113.10',
          summary: 'Standard query response 0x27f8 A www.example.com A 203.0.113.10 (AA, TTL 300)',
          ...datagram({
            srcMac: MAC_AUTH,
            dstMac: MAC_INTERNET_GATEWAY,
            srcIp: IP.authoritativeNs,
            dstIp: IP.ispResolver,
            srcPort: PORT.dns,
            dstPort: AUTH_PORT,
            ipId: 0x35bc,
            message: dns({
              id: AUTH_ID,
              qr: 'response',
              flags: { aa: true },
              question: QUESTION,
              answer: answerA(300),
            }),
            dnsBytes: ANSWER_BYTES,
          }),
          at: 700,
          wireTimeMs: 75.7,
        },
      ],
      actions: [
        {
          id: 'a-auth-lookup',
          node: 'auth',
          kind: 'process',
          label: 'Reads zone: A record',
          at: 0,
          durationMs: 600,
        },
        {
          id: 'a-cache-answer',
          node: 'resolver',
          kind: 'store',
          label: 'Caches A for 300 s',
          at: 2900,
          durationMs: 600,
        },
      ],
      focus: ['auth', 'resolver'],
      simplifications: [
        'The Ethernet addresses of Internet-side devices are placeholders from the documentation range.',
        'EDNS0 and DNSSEC records are left out; with DNSSEC the answer would be larger and more likely to need TCP.',
      ],
      references: [
        {
          label: 'RFC 1035, section 4.2: transport, UDP size and TCP',
          url: 'https://www.rfc-editor.org/rfc/rfc1035#section-4.2',
        },
        {
          label: 'RFC 7766: DNS transport over TCP',
          url: 'https://www.rfc-editor.org/rfc/rfc7766',
        },
        {
          label: 'RFC 6891: extension mechanisms for DNS (EDNS0)',
          url: 'https://www.rfc-editor.org/rfc/rfc6891',
        },
      ],
    },
    {
      id: 'stub-answer',
      title: 'Resolver returns the answer with RA=1',
      phase: 'resolve',
      summary:
        'The resolver replies to the laptop under the original ID `0x3a7c`: flags QR RD RA, the A record, TTL 300. About 90 ms passed since the first query.',
      body: [
        {
          type: 'p',
          text: 'The walk is over, and the resolver answers the stub’s original question under the stub’s own transaction ID. It echoes **RD** and sets **RA** (recursion available) to confirm it offers recursive service. **AA** is 0, because the resolver is not the authoritative source.',
        },
        {
          type: 'p',
          text: 'The TTL is still 300 s, as just received. The laptop saw one question and one answer; the three iterative exchanges stayed between the resolver and the DNS servers.',
        },
      ],
      packets: [
        {
          id: 'p-stub-answer',
          from: 'resolver',
          to: 'laptop',
          via: ['router'],
          protocol: 'dns',
          label: 'A 203.0.113.10',
          summary: 'Standard query response 0x3a7c A www.example.com A 203.0.113.10 (TTL 300)',
          ...datagram({
            srcMac: MAC.ispResolver,
            dstMac: MAC.ispRouterResolver,
            srcIp: IP.ispResolver,
            dstIp: IP.routerPublic,
            srcPort: PORT.dns,
            dstPort: LAPTOP_PORT,
            ipId: 0x80e9,
            message: dns({
              id: STUB_ID,
              qr: 'response',
              flags: { rd: true, ra: true },
              question: QUESTION,
              answer: answerA(300),
            }),
            dnsBytes: ANSWER_BYTES,
          }),
          at: 0,
          wireTimeMs: 87,
        },
      ],
      actions: [
        {
          id: 'a-stub-store',
          node: 'laptop',
          kind: 'store',
          label: 'Stub caches the answer',
          at: 2000,
          durationMs: 600,
        },
      ],
      focus: ['resolver', 'laptop'],
      simplifications: [
        'The reply is addressed to the home router’s public address, as the resolver sees it; the router’s NAT translates it back to the laptop.',
      ],
      references: [
        {
          label: 'RFC 1035, section 4.1.1: header flags (RD, RA)',
          url: 'https://www.rfc-editor.org/rfc/rfc1035#section-4.1.1',
        },
        {
          label: 'RFC 1034, section 4.3.1: recursive service',
          url: 'https://www.rfc-editor.org/rfc/rfc1034#section-4.3.1',
        },
      ],
    },
    {
      id: 'cached-answer',
      title: 'A second client is answered from the cache',
      phase: 'cache',
      summary:
        'The phone asks for the same name 57 s later. The resolver answers at once from its cache with TTL 243, the remaining lifetime, and sends no upstream query.',
      body: [
        {
          type: 'p',
          text: 'The resolver stored the A record with a 300-second TTL. When the phone asks 57 seconds later, a cache hit answers immediately and the reply carries the **remaining** lifetime: 300 − 57 = 243 seconds. **AA** is 0, because the resolver only repeats what the authoritative server said.',
        },
        {
          type: 'p',
          text: 'When the TTL reaches zero the record expires and the next query walks the hierarchy again, although the cached delegations (TTL 172800) let it skip the root and `.com` steps. A long TTL saves traffic; a short TTL lets changes spread quickly.',
        },
      ],
      packets: [
        {
          id: 'p-cached-query',
          from: 'phone',
          to: 'resolver',
          via: ['router'],
          protocol: 'dns',
          label: 'A? www.example.com',
          summary: 'Standard query 0x7d02 A www.example.com',
          ...datagram({
            srcMac: MAC.phone,
            dstMac: MAC.routerLan,
            srcIp: IP.phone,
            dstIp: IP.ispResolver,
            srcPort: PHONE_PORT,
            dstPort: PORT.dns,
            ipId: 0xa7f1,
            message: dns({
              id: PHONE_ID,
              qr: 'query',
              flags: { rd: true },
              question: QUESTION,
            }),
            dnsBytes: QUERY_BYTES,
          }),
          at: 0,
          wireTimeMs: 57320,
        },
        {
          id: 'p-cached-answer',
          from: 'resolver',
          to: 'phone',
          via: ['router'],
          protocol: 'dns',
          label: 'A 203.0.113.10',
          summary: 'Standard query response 0x7d02 A www.example.com A 203.0.113.10 (TTL 243)',
          ...datagram({
            srcMac: MAC.ispResolver,
            dstMac: MAC.ispRouterResolver,
            srcIp: IP.ispResolver,
            dstIp: IP.routerPublic,
            srcPort: PORT.dns,
            dstPort: PHONE_PORT,
            ipId: 0x2b94,
            message: dns({
              id: PHONE_ID,
              qr: 'response',
              flags: { rd: true, ra: true },
              question: QUESTION,
              answer: answerA(243),
            }),
            dnsBytes: ANSWER_BYTES,
          }),
          at: 2300,
          wireTimeMs: 57326.4,
        },
      ],
      actions: [
        {
          id: 'a-cache-hit',
          node: 'resolver',
          kind: 'cache-hit',
          label: 'Cache hit: TTL 243',
          at: 1700,
          durationMs: 500,
        },
      ],
      focus: ['phone', 'resolver'],
      simplifications: [
        'The reply is addressed to the home router’s public address; NAT translates it back to the phone.',
        'The 57 seconds between the two lookups are skipped on the animation clock; the packet table shows the real gap.',
      ],
      references: [
        {
          label: 'RFC 1034, section 5.3.2: resolver cache',
          url: 'https://www.rfc-editor.org/rfc/rfc1034#section-5.3.2',
        },
        {
          label: 'RFC 2181, section 8: time to live',
          url: 'https://www.rfc-editor.org/rfc/rfc2181#section-8',
        },
      ],
    },
  ],
});
