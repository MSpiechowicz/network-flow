/**
 * Shared addressing plan. Every scenario uses these constants instead of inventing addresses,
 * so the whole app tells one consistent story and the address validator stays happy.
 *
 * Only documentation ranges appear: RFC 5737 (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24),
 * RFC 1918 for the home LAN, RFC 3849 (2001:db8::/32) for IPv6, RFC 7042 MACs
 * (00:00:5e:00:53:xx) and RFC 2606 domains. The only real addresses are the root and gTLD
 * servers; a scenario that uses them must set `addressAllowlist: ADDRESS_ALLOWLIST`
 * (or a subset).
 *
 * @example
 * nodes: [{ id: 'laptop', kind: 'laptop', label: 'Your laptop', sublabel: IP.laptop,
 *           position: { col: 0, row: 2 }, addresses: { ipv4: IP.laptop, mac: MAC.laptop } }]
 */

/** Builds an RFC 7042 documentation MAC `00:00:5e:00:53:xx`. `n` is 0..255. */
export function mac(n: number): string {
  if (!Number.isInteger(n) || n < 0 || n > 255) {
    throw new RangeError(`mac(${n}): expected an integer 0..255`);
  }

  return `00:00:5e:00:53:${n.toString(16).padStart(2, '0')}`;
}

/** Ethernet broadcast address. */
export const MAC_BROADCAST = 'ff:ff:ff:ff:ff:ff';

/** Ethernet frame sources and destinations. */
export const MAC = {
  laptop: mac(0x01),
  phone: mac(0x02),
  /** A second LAN client, for scenarios with two users. */
  otherLaptop: mac(0x03),
  /** Home router, LAN-facing port. */
  routerLan: mac(0x10),
  /** Home router, WAN-facing port. */
  routerWan: mac(0x11),
  /** ISP router, port facing the home router. */
  ispRouterDown: mac(0x20),
  /** ISP router, port facing the ISP resolver. */
  ispRouterResolver: mac(0x21),
  /** ISP recursive resolver. */
  ispResolver: mac(0x22),
  /** CDN edge (203.0.113.10). */
  cdnEdge: mac(0x40),
  /** Origin server (192.0.2.80). */
  origin: mac(0x41),
  /** Spare MACs for extra routers or hosts (for example a multi-router IP scenario). */
  spare: [mac(0x30), mac(0x31), mac(0x32), mac(0x33), mac(0x34), mac(0x35), mac(0x36), mac(0x37)],
} as const;

/** IPv4 addresses. */
export const IP = {
  // Home LAN: 192.168.1.0/24 (RFC 1918).
  laptop: '192.168.1.23',
  phone: '192.168.1.42',
  /** A second LAN client, for scenarios with two users. */
  otherLaptop: '192.168.1.57',
  /** Home router, LAN side. Default gateway, DHCP server and LAN DNS forwarder. */
  routerLan: '192.168.1.1',

  // Home router, public side (RFC 5737 TEST-NET-2).
  routerPublic: '198.51.100.7',
  /** ISP router, next hop beyond the home router. Normally a hidden node. */
  ispRouter: '198.51.100.1',
  /** ISP recursive resolver. */
  ispResolver: '198.51.100.53',

  // Real root and gTLD servers, allowed only through `addressAllowlist`.
  /** a.root-servers.net */
  root: '198.41.0.4',
  /** a.gtld-servers.net, the `.com` TLD server. */
  tldCom: '192.5.6.30',

  // example.com infrastructure (RFC 5737 TEST-NET-3).
  /** ns1.example.com, authoritative for example.com. */
  authoritativeNs: '203.0.113.53',
  /** CDN edge that serves www.example.com. */
  cdnEdge: '203.0.113.10',

  // example.com origin and API (RFC 5737 TEST-NET-1).
  /** origin.example.com, the origin server behind the CDN. */
  origin: '192.0.2.80',
  /** api.example.net, a cross-origin API. */
  api: '192.0.2.120',

  // Mail hosts. Sender domain example.com in TEST-NET-1, recipient domain example.org in TEST-NET-3.
  /** mail.example.com: the sender's submission server (MSA) and outbound MTA. */
  senderMail: '192.0.2.25',
  /** mx1.example.org: the recipient's inbound MTA (MX target). */
  recipientMx: '203.0.113.25',
  /** pop.example.org: the recipient's POP3 server. */
  recipientPop: '203.0.113.110',
  /** imap.example.org: the recipient's IMAP server. */
  recipientImap: '203.0.113.143',

  // Special addresses.
  unspecified: '0.0.0.0',
  limitedBroadcast: '255.255.255.255',
  loopback: '127.0.0.1',
} as const;

/** The home LAN's subnet parameters. */
export const LAN = {
  cidr: '192.168.1.0/24',
  netmask: '255.255.255.0',
  gateway: IP.routerLan,
  broadcast: '192.168.1.255',
  /** Resolver handed out by DHCP: the home router forwards to the ISP resolver. */
  dns: IP.routerLan,
} as const;

/** IPv6 documentation addresses (2001:db8::/32). */
export const IPV6 = {
  laptop: '2001:db8:1::23',
  router: '2001:db8:1::1',
  server: '2001:db8:2::80',
} as const;

/** Real hostnames that need `addressAllowlist` / name allowlisting. */
export const REAL_INFRA = {
  root: { name: 'a.root-servers.net', ip: IP.root },
  tldCom: { name: 'a.gtld-servers.net', ip: IP.tldCom },
} as const;

/** Pass as `ScenarioDef.addressAllowlist` in any scenario that uses the real root/gTLD servers. */
export const ADDRESS_ALLOWLIST: string[] = [IP.root, IP.tldCom];

/** Hostnames (RFC 2606 domains only, except the real infrastructure names above). */
export const HOST = {
  /** The site the user browses to. Served by the CDN edge. */
  site: 'example.com',
  www: 'www.example.com',
  /** Origin server behind the CDN. */
  origin: 'origin.example.com',
  /** Authoritative name server for example.com. */
  ns: 'ns1.example.com',
  /** Cross-origin API used by the CORS steps. */
  api: 'api.example.net',
  /** A second domain used where a scenario needs a remote domain. */
  otherSite: 'www.example.org',
  /** Sender's mail host. */
  senderMail: 'mail.example.com',
  /** Recipient domain and its hosts. */
  recipientDomain: 'example.org',
  recipientMx: 'mx1.example.org',
  recipientPop: 'pop.example.org',
  recipientImap: 'imap.example.org',
  /** Client machine names. */
  laptop: 'laptop.example.com',
} as const;

/** Mailboxes for the email scenario. */
export const MAILBOX = {
  sender: 'alice@example.com',
  recipient: 'bob@example.org',
} as const;

/** TCP initial sequence numbers (absolute). The UI also shows relative numbers. */
export const ISN = {
  client: 1204331000,
  server: 3877120400,
} as const;

/** Well-known server ports. */
export const PORT = {
  dns: 53,
  dhcpServer: 67,
  dhcpClient: 68,
  http: 80,
  ntp: 123,
  https: 443,
  smtp: 25,
  smtpSubmission: 587,
  smtpsImplicit: 465,
  pop3: 110,
  pop3s: 995,
  imap: 143,
  imaps: 993,
} as const;

/** Ephemeral client ports, from the 49152-65535 range (RFC 6335). Pick a different one per connection. */
export const EPHEMERAL_PORTS = [51234, 51236, 49321, 58012, 60771, 53998, 55120, 62344] as const;
