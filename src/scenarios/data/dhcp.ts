import { defineScenario } from '../../model/types';
import type { HeaderGroup, PacketDef, Reference } from '../../model/types';
import { IP, LAN, MAC, MAC_BROADCAST, PORT } from '../lib/addresses';
import { dhcp, dhcpMessageType, dhcpOption, ethernet, ipv4, udp } from '../lib/builders';

/**
 * DHCP: the four-message DORA exchange through a switch that floods broadcasts, then a unicast
 * renewal at T1. The client is the laptop; the DHCP server is the home router.
 */

// A BOOTP-format message is 236 bytes plus the 4-byte cookie and options. Clients and servers
// commonly pad it to the 300-byte BOOTP minimum, which makes every frame below 342 bytes.
const DHCP_BYTES = 300;
const UDP_LENGTH = 8 + DHCP_BYTES; // 308
const IP_TOTAL_LENGTH = 20 + UDP_LENGTH; // 328
const FRAME_BYTES = 14 + IP_TOTAL_LENGTH; // 342

const XID = 0x5f3a9c21; // DORA transaction
const RENEW_XID = 0x2c71e0b4; // a new transaction for the renewal

const LEASED_IP = IP.laptop;
const CLIENT_ID = dhcpOption(61, `01:${MAC.laptop}`); // hardware type 1 (Ethernet) + MAC
const HOST_NAME = dhcpOption(12, 'laptop');
const PARAMETERS = dhcpOption(55, '1, 3, 6, 15, 51');

// Lease 24 h: T1 = 50% = 12 h, T2 = 87.5% = 21 h (RFC 2131, section 4.4.5).
const LEASE_OPTIONS = [
  dhcpOption(51, '86400 s (24 h)'),
  dhcpOption(58, '43200 s (12 h)'),
  dhcpOption(59, '75600 s (21 h)'),
  dhcpOption(1, LAN.netmask),
  dhcpOption(3, LAN.gateway),
  dhcpOption(6, LAN.dns),
] as const;
const SERVER_ID = dhcpOption(54, IP.routerLan);

const REF_2131_EXCHANGE: Reference = {
  label: 'RFC 2131, section 3.1: client-server interaction',
  url: 'https://www.rfc-editor.org/rfc/rfc2131#section-3.1',
};
const REF_2131_BROADCAST: Reference = {
  label: 'RFC 2131, section 4.1: broadcast flag and addressing',
  url: 'https://www.rfc-editor.org/rfc/rfc2131#section-4.1',
};

interface DhcpDatagram {
  srcMac: string;
  dstMac: string;
  srcIp: string;
  dstIp: string;
  srcPort: number;
  dstPort: number;
  ipId: number;
  message: HeaderGroup;
}

/** Ethernet, IPv4 and UDP around one DHCP message. */
function datagram(d: DhcpDatagram): Pick<PacketDef, 'headers' | 'sizeBytes' | 'meta'> {
  const ip = ipv4({
    src: d.srcIp,
    dst: d.dstIp,
    ttl: 64,
    id: d.ipId,
    protocol: 'UDP',
    totalLength: IP_TOTAL_LENGTH,
  });

  return {
    headers: [
      ethernet({ src: d.srcMac, dst: d.dstMac, etherType: 'IPv4' }),
      ip.group,
      udp({ srcPort: d.srcPort, dstPort: d.dstPort, length: UDP_LENGTH }),
      d.message,
    ],
    sizeBytes: FRAME_BYTES,
    meta: { ipv4: ip.meta },
  };
}

/** Client-to-server broadcast while the client has no address (Discover and Request). */
const fromUnconfiguredClient = (ipId: number, message: HeaderGroup) =>
  datagram({
    srcMac: MAC.laptop,
    dstMac: MAC_BROADCAST,
    srcIp: IP.unspecified,
    dstIp: IP.limitedBroadcast,
    srcPort: PORT.dhcpClient,
    dstPort: PORT.dhcpServer,
    ipId,
    message,
  });

/** Server-to-client broadcast, used because the client set the broadcast flag (Offer and ACK). */
const fromServerBroadcast = (ipId: number, message: HeaderGroup) =>
  datagram({
    srcMac: MAC.routerLan,
    dstMac: MAC_BROADCAST,
    srcIp: IP.routerLan,
    dstIp: IP.limitedBroadcast,
    srcPort: PORT.dhcpServer,
    dstPort: PORT.dhcpClient,
    ipId,
    message,
  });

export default defineScenario({
  id: 'dhcp',
  title: 'DHCP',
  tagline: 'How a new device gets an address: Discover, Offer, Request, ACK.',
  category: 'network-services',
  order: 1,
  protocols: ['ethernet', 'ipv4', 'udp', 'dhcp'],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'New laptop',
      sublabel: 'no address yet',
      position: { col: 0, row: 0.5 },
      zone: 'home',
      addresses: { mac: MAC.laptop },
    },
    {
      id: 'phone',
      kind: 'phone',
      label: 'Phone',
      sublabel: IP.phone,
      position: { col: 3.5, row: 4 },
      zone: 'home',
      addresses: { ipv4: IP.phone, mac: MAC.phone },
    },
    {
      id: 'switch',
      kind: 'switch',
      label: 'Switch',
      position: { col: 3.5, row: 0.5 },
      zone: 'home',
    },
    {
      id: 'router',
      kind: 'dhcp-server',
      label: 'Home router',
      sublabel: IP.routerLan,
      position: { col: 6.5, row: 0 },
      zone: 'home',
      addresses: { ipv4: IP.routerLan, mac: MAC.routerLan },
    },
  ],
  links: [
    { id: 'laptop-switch', a: 'laptop', b: 'switch', medium: 'ethernet' },
    { id: 'phone-switch', a: 'phone', b: 'switch', medium: 'wifi' },
    { id: 'switch-router', a: 'switch', b: 'router', medium: 'ethernet' },
  ],
  zones: [
    {
      id: 'home',
      label: 'Home LAN',
      from: { col: -0.75, row: -0.75 },
      to: { col: 7.25, row: 4.75 },
      tone: 'lan',
    },
  ],
  phases: [
    { id: 'dora', label: 'Getting an address' },
    { id: 'renew', label: 'Renewing the lease' },
  ],
  sequenceLanes: ['laptop', 'phone', 'router'],
  steps: [
    {
      id: 'discover',
      title: 'Discover: a new client broadcasts for a server',
      phase: 'dora',
      summary:
        'With no address yet, the laptop broadcasts DHCPDISCOVER from `0.0.0.0` to `255.255.255.255`, UDP port 68 to 67. The switch floods the frame out of every other port.',
      body: [
        {
          type: 'p',
          text: 'A host that has just joined the network has no address and knows no server, so it uses the only addresses that always work: source `0.0.0.0` (“this host”) and destination `255.255.255.255` (limited broadcast), in a frame addressed to `ff:ff:ff:ff:ff:ff`.',
        },
        {
          type: 'p',
          text: 'The message carries a random transaction ID (`xid`) and the client’s hardware address (`chaddr`), which later replies use to find their way back. It also sets the **broadcast flag**: the client may not be able to accept unicast IP before it is configured. A switch has no table entry for a broadcast MAC, so it floods the frame.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'If the server is on another subnet, a **relay agent** (usually a router) turns the broadcast into a unicast and writes its own address into `giaddr`, so the server can pick the matching pool and reply to the relay.',
        },
      ],
      packets: [
        {
          id: 'p-discover',
          from: 'laptop',
          to: 'switch',
          protocol: 'dhcp',
          label: 'DHCPDISCOVER',
          summary: 'DHCP Discover - Transaction ID 0x5f3a9c21',
          ...fromUnconfiguredClient(
            0x9d2e,
            dhcp({
              op: 'BOOTREQUEST',
              xid: XID,
              chaddr: MAC.laptop,
              flags: 'broadcast',
              options: [dhcpMessageType('DISCOVER'), CLIENT_ID, HOST_NAME, PARAMETERS],
            }),
          ),
          at: 0,
          wireTimeMs: 0,
          delivery: 'broadcast',
          floodTo: ['phone', 'router'],
        },
      ],
      actions: [
        {
          id: 'a-phone-ignores-discover',
          node: 'phone',
          kind: 'process',
          label: 'Not a DHCP server: ignores',
          at: 1200,
          durationMs: 600,
        },
      ],
      focus: ['laptop', 'switch'],
      simplifications: [
        'Real clients wait a short random time before the first Discover and may repeat it; one is shown.',
        'The parameter request list is shortened to five options.',
      ],
      references: [
        REF_2131_EXCHANGE,
        REF_2131_BROADCAST,
        { label: 'RFC 1542: BOOTP relay agents', url: 'https://www.rfc-editor.org/rfc/rfc1542' },
      ],
    },
    {
      id: 'offer',
      title: 'Offer: the server proposes 192.168.1.23',
      phase: 'dora',
      summary:
        'The router’s DHCP server picks a free address, puts it in `yiaddr`, names itself in option 54 and, because the broadcast flag is set, broadcasts the Offer.',
      body: [
        {
          type: 'p',
          text: 'The server picks an address from its pool and writes it into `yiaddr` (“your address”). Option **54**, the server identifier, names the server, which matters when several answer. The lease time and the settings the client asked for (mask, router, DNS server) come along. An Offer is only a proposal: nothing is bound yet.',
        },
        {
          type: 'p',
          text: 'The Discover set the broadcast flag, so the server sends the Offer to `255.255.255.255` rather than to an address the client does not hold. The switch floods it again; the phone receives it and ignores it, since the `xid` and `chaddr` are not its own.',
        },
        {
          type: 'callout',
          tone: 'tip',
          text: 'A client that can accept unicast before it is configured leaves the flag clear. The server may then send the reply straight to the client’s MAC address.',
        },
      ],
      packets: [
        {
          id: 'p-offer',
          from: 'router',
          to: 'switch',
          protocol: 'dhcp',
          label: 'DHCPOFFER',
          summary: 'DHCP Offer - Transaction ID 0x5f3a9c21 - Your IP 192.168.1.23',
          ...fromServerBroadcast(
            0x40b6,
            dhcp({
              op: 'BOOTREPLY',
              xid: XID,
              yiaddr: LEASED_IP,
              chaddr: MAC.laptop,
              flags: 'broadcast',
              options: [dhcpMessageType('OFFER'), SERVER_ID, ...LEASE_OPTIONS],
            }),
          ),
          at: 800,
          wireTimeMs: 4.1,
          delivery: 'broadcast',
          floodTo: ['laptop', 'phone'],
        },
      ],
      actions: [
        {
          id: 'a-server-picks',
          node: 'router',
          kind: 'process',
          label: 'Picks 192.168.1.23 from pool',
          at: 0,
          durationMs: 700,
        },
        {
          id: 'a-phone-ignores-offer',
          node: 'phone',
          kind: 'process',
          label: 'Not its xid: ignores',
          at: 2000,
          durationMs: 600,
        },
        {
          id: 'a-laptop-takes-offer',
          node: 'laptop',
          kind: 'process',
          label: 'xid matches: takes offer',
          at: 1900,
          durationMs: 600,
        },
      ],
      focus: ['router', 'laptop'],
      simplifications: [
        'The server may check that the address is unused (for example with an ICMP echo) before offering it; not drawn.',
        'Only one server answers here. With several, the client may receive several Offers and picks one.',
      ],
      references: [
        {
          label: 'RFC 2131, section 4.3.1: server response to Discover',
          url: 'https://www.rfc-editor.org/rfc/rfc2131#section-4.3.1',
        },
        {
          label: 'RFC 2132, section 9.7: server identifier option',
          url: 'https://www.rfc-editor.org/rfc/rfc2132#section-9.7',
        },
        REF_2131_BROADCAST,
      ],
    },
    {
      id: 'request',
      title: 'Request: the client accepts the offer',
      phase: 'dora',
      summary:
        'Still unconfigured, the client sends DHCPREQUEST from `0.0.0.0` as a broadcast, with option 50 (requested address) and option 54 (the server it chose).',
      body: [
        {
          type: 'p',
          text: 'The client answers the Offer it prefers with DHCPREQUEST. It has no address until the server confirms, so the message again leaves from `0.0.0.0` as a broadcast, with the same `xid`. Option **50** names the address it wants and option **54** the server it chose.',
        },
        {
          type: 'p',
          text: 'Broadcasting is deliberate: every server that made an Offer hears the Request. Those not named in option 54 learn that their offer was declined and can return the address to their pool.',
        },
      ],
      packets: [
        {
          id: 'p-request',
          from: 'laptop',
          to: 'switch',
          protocol: 'dhcp',
          label: 'DHCPREQUEST',
          summary: 'DHCP Request - Transaction ID 0x5f3a9c21 - Requested IP 192.168.1.23',
          ...fromUnconfiguredClient(
            0x9d2f,
            dhcp({
              op: 'BOOTREQUEST',
              xid: XID,
              chaddr: MAC.laptop,
              flags: 'broadcast',
              options: [
                dhcpMessageType('REQUEST'),
                CLIENT_ID,
                dhcpOption(50, LEASED_IP),
                SERVER_ID,
                HOST_NAME,
                PARAMETERS,
              ],
            }),
          ),
          at: 0,
          wireTimeMs: 5.7,
          delivery: 'broadcast',
          floodTo: ['phone', 'router'],
        },
      ],
      actions: [
        {
          id: 'a-server-reserves',
          node: 'router',
          kind: 'process',
          label: 'Named in option 54: it is me',
          at: 1100,
          durationMs: 700,
        },
      ],
      focus: ['laptop', 'router'],
      simplifications: ['Only one Offer exists here, so no other server has to withdraw.'],
      references: [
        {
          label: 'RFC 2131, section 4.3.2: server response to Request',
          url: 'https://www.rfc-editor.org/rfc/rfc2131#section-4.3.2',
        },
        {
          label: 'RFC 2132, section 9.1: requested IP address option',
          url: 'https://www.rfc-editor.org/rfc/rfc2132#section-9.1',
        },
      ],
    },
    {
      id: 'ack',
      title: 'ACK: lease granted with the network settings',
      phase: 'dora',
      summary:
        'DHCPACK confirms 192.168.1.23 for 24 hours (option 51) with the mask (1), router (3) and DNS server (6). The client configures its interface and may now use IP.',
      body: [
        {
          type: 'p',
          text: 'The server records the binding and confirms it with DHCPACK. `yiaddr` holds the address; the options carry the lease time (option 51, 86 400 seconds) and the settings the client needs: subnet mask (1), default router (3) and DNS server (6). Only now may the client use `192.168.1.23`.',
        },
        {
          type: 'p',
          text: 'Two timers start with the lease: **T1** at 50% (12 hours) and **T2** at 87.5% (21 hours). This server states them in options 58 and 59; a client whose server omits them uses those defaults.',
        },
      ],
      packets: [
        {
          id: 'p-ack',
          from: 'router',
          to: 'switch',
          protocol: 'dhcp',
          label: 'DHCPACK',
          summary: 'DHCP ACK - Transaction ID 0x5f3a9c21 - Your IP 192.168.1.23',
          ...fromServerBroadcast(
            0x40b7,
            dhcp({
              op: 'BOOTREPLY',
              xid: XID,
              yiaddr: LEASED_IP,
              chaddr: MAC.laptop,
              flags: 'broadcast',
              options: [dhcpMessageType('ACK'), SERVER_ID, ...LEASE_OPTIONS],
            }),
          ),
          at: 800,
          wireTimeMs: 7,
          delivery: 'broadcast',
          floodTo: ['laptop', 'phone'],
        },
      ],
      actions: [
        {
          id: 'a-server-stores',
          node: 'router',
          kind: 'store',
          label: 'Records lease: 24 h',
          at: 0,
          durationMs: 700,
        },
        {
          id: 'a-laptop-configures',
          node: 'laptop',
          kind: 'process',
          label: 'Configures 192.168.1.23/24',
          at: 1900,
          durationMs: 800,
        },
      ],
      focus: ['router', 'laptop'],
      simplifications: [
        'A careful client also checks that nobody else uses the address (for example with ARP) and sends DHCPDECLINE if someone does; not drawn.',
      ],
      references: [
        {
          label: 'RFC 2131, section 4.4.1: initialization of the client',
          url: 'https://www.rfc-editor.org/rfc/rfc2131#section-4.4.1',
        },
        {
          label: 'RFC 2132, section 9.2: IP address lease time',
          url: 'https://www.rfc-editor.org/rfc/rfc2132#section-9.2',
        },
        {
          label: 'RFC 2131, section 4.4.5: lease renewal and expiration',
          url: 'https://www.rfc-editor.org/rfc/rfc2131#section-4.4.5',
        },
      ],
    },
    {
      id: 'renew-request',
      title: 'T1 reached: renew the lease by unicast',
      phase: 'renew',
      summary:
        'At 50% of the lease (12 h) the client asks the same server to extend it. It now owns an address, so DHCPREQUEST is unicast from `192.168.1.23` with `ciaddr` set.',
      body: [
        {
          type: 'p',
          text: 'After 12 hours the client reaches **T1** and enters the RENEWING state. It already owns an address, so it contacts its server directly: source `192.168.1.23`, destination `192.168.1.1`, an ordinary unicast that the switch forwards without flooding. `ciaddr` holds the current address, and options 50 and 54 are omitted because address and server are already known. The `xid` is new.',
        },
        {
          type: 'callout',
          tone: 'note',
          text: 'If the server stays silent, the client keeps retrying. At **T2** (87.5%, 21 hours) it enters REBINDING and broadcasts the Request to any server. If the lease expires with no ACK, the client must stop using the address and restart with Discover.',
        },
      ],
      packets: [
        {
          id: 'p-renew-request',
          from: 'laptop',
          to: 'router',
          via: ['switch'],
          protocol: 'dhcp',
          label: 'DHCPREQUEST',
          summary: 'DHCP Request (renew) - Transaction ID 0x2c71e0b4 - Client IP 192.168.1.23',
          ...datagram({
            srcMac: MAC.laptop,
            dstMac: MAC.routerLan,
            srcIp: LEASED_IP,
            dstIp: IP.routerLan,
            srcPort: PORT.dhcpClient,
            dstPort: PORT.dhcpServer,
            ipId: 0x9d30,
            message: dhcp({
              op: 'BOOTREQUEST',
              xid: RENEW_XID,
              ciaddr: LEASED_IP,
              chaddr: MAC.laptop,
              options: [dhcpMessageType('REQUEST'), CLIENT_ID, HOST_NAME, PARAMETERS],
            }),
          }),
          at: 800,
          wireTimeMs: 43200007.4,
        },
      ],
      actions: [
        {
          id: 'a-t1-fires',
          node: 'laptop',
          kind: 'process',
          label: 'T1 timer fires (12 h)',
          at: 0,
          durationMs: 700,
        },
      ],
      focus: ['laptop', 'router'],
      simplifications: [
        'The 12 hours between the lease and its renewal are skipped on the animation clock; the packet table shows the real gap.',
        'REBINDING at T2 is described but not drawn.',
      ],
      references: [
        {
          label: 'RFC 2131, section 4.4.5: reacquisition and expiration',
          url: 'https://www.rfc-editor.org/rfc/rfc2131#section-4.4.5',
        },
        {
          label: 'RFC 2132, sections 9.11 and 9.12: T1 and T2 options',
          url: 'https://www.rfc-editor.org/rfc/rfc2132#section-9.11',
        },
      ],
    },
    {
      id: 'renew-ack',
      title: 'Server extends the lease with a unicast ACK',
      phase: 'renew',
      summary:
        'The server answers DHCPACK to `192.168.1.23` with a fresh 24-hour lease, which restarts T1 and T2. The address does not change, so open connections survive.',
      body: [
        {
          type: 'p',
          text: 'The server confirms the renewal with a unicast DHCPACK sent to the client’s own address. The lease runs for another 86 400 seconds from now, and T1 and T2 are recomputed. Because the address stays the same, existing connections carry on without interruption.',
        },
        {
          type: 'p',
          text: 'Renewing halfway through gives the client 12 hours to reach a server before the address is at risk. If the server no longer agrees, it answers DHCPNAK and the client starts again with Discover.',
        },
      ],
      packets: [
        {
          id: 'p-renew-ack',
          from: 'router',
          to: 'laptop',
          via: ['switch'],
          protocol: 'dhcp',
          label: 'DHCPACK',
          summary: 'DHCP ACK - Transaction ID 0x2c71e0b4 - Your IP 192.168.1.23',
          ...datagram({
            srcMac: MAC.routerLan,
            dstMac: MAC.laptop,
            srcIp: IP.routerLan,
            dstIp: LEASED_IP,
            srcPort: PORT.dhcpServer,
            dstPort: PORT.dhcpClient,
            ipId: 0x40b8,
            message: dhcp({
              op: 'BOOTREPLY',
              xid: RENEW_XID,
              ciaddr: LEASED_IP,
              yiaddr: LEASED_IP,
              chaddr: MAC.laptop,
              options: [dhcpMessageType('ACK'), SERVER_ID, ...LEASE_OPTIONS],
            }),
          }),
          at: 800,
          wireTimeMs: 43200008.1,
        },
      ],
      actions: [
        {
          id: 'a-lease-extended',
          node: 'router',
          kind: 'store',
          label: 'Lease extended: 24 h',
          at: 0,
          durationMs: 700,
        },
        {
          id: 'a-timers-reset',
          node: 'laptop',
          kind: 'process',
          label: 'T1 and T2 restart',
          at: 2000,
          durationMs: 700,
        },
      ],
      focus: ['router', 'laptop'],
      references: [
        {
          label: 'RFC 2131, section 4.3.2: ACK to a renewing client',
          url: 'https://www.rfc-editor.org/rfc/rfc2131#section-4.3.2',
        },
        {
          label: 'RFC 2131, section 3.2: client-server interaction, reusing an address',
          url: 'https://www.rfc-editor.org/rfc/rfc2131#section-3.2',
        },
      ],
    },
  ],
});
