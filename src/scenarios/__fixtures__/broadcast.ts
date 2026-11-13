import { defineScenario } from '../../model/types';
import { IP, MAC, MAC_BROADCAST, PORT } from '../lib/addresses';
import { dhcp, dhcpMessageType, dhcpOption, dns, ethernet, ipv4, udp } from '../lib/builders';

/** A switch flooding a DHCP Discover to every other port, then a lost and retried DNS query. */
const discoverIp = ipv4({
  src: IP.unspecified,
  dst: IP.limitedBroadcast,
  ttl: 64,
  protocol: 'UDP',
  totalLength: 328,
});

const queryIp = ipv4({
  src: IP.phone,
  dst: IP.routerLan,
  ttl: 64,
  id: 0x7a10,
  protocol: 'UDP',
  totalLength: 61,
});
const retryIp = ipv4({
  src: IP.phone,
  dst: IP.routerLan,
  ttl: 64,
  id: 0x7a11,
  protocol: 'UDP',
  totalLength: 61,
});

const question = { name: 'www.example.com', type: 'A' } as const;
const query = dns({ id: 0x3a7c, qr: 'query', flags: { rd: true }, question });

export default defineScenario({
  id: 'broadcast',
  title: 'Broadcast fixture',
  tagline: 'A switch flood and a lost packet.',
  category: 'foundations',
  order: 901,
  protocols: ['ethernet', 'ipv4', 'udp', 'dhcp', 'dns'],
  nodes: [
    {
      id: 'laptop',
      kind: 'laptop',
      label: 'New laptop',
      sublabel: 'no address yet',
      position: { col: 0, row: 1 },
      zone: 'home',
      addresses: { mac: MAC.laptop },
    },
    {
      id: 'phone',
      kind: 'phone',
      label: 'Phone',
      sublabel: IP.phone,
      position: { col: 0, row: 3 },
      zone: 'home',
      addresses: { ipv4: IP.phone, mac: MAC.phone },
    },
    {
      id: 'switch',
      kind: 'switch',
      label: 'Switch',
      position: { col: 2, row: 2 },
      zone: 'home',
    },
    {
      id: 'router',
      kind: 'dhcp-server',
      label: 'Home router',
      sublabel: IP.routerLan,
      position: { col: 4, row: 2 },
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
      from: { col: -1, row: 0 },
      to: { col: 5, row: 4 },
      tone: 'lan',
    },
  ],
  steps: [
    {
      id: 'discover',
      title: 'DHCP Discover is flooded by the switch',
      summary: 'A broadcast frame arrives at the switch, which copies it out of every other port.',
      body: [
        {
          type: 'p',
          text: 'The destination MAC is `ff:ff:ff:ff:ff:ff`, so the switch cannot look it up in its table and floods it to every port except the one it arrived on.',
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
          headers: [
            ethernet({ src: MAC.laptop, dst: MAC_BROADCAST, etherType: 'IPv4' }),
            discoverIp.group,
            udp({ srcPort: PORT.dhcpClient, dstPort: PORT.dhcpServer, length: 308 }),
            dhcp({
              op: 'BOOTREQUEST',
              xid: 0x5f3a9c21,
              chaddr: MAC.laptop,
              flags: 'broadcast',
              options: [
                dhcpMessageType('DISCOVER'),
                dhcpOption(61, `01:${MAC.laptop}`),
                dhcpOption(55, '1, 3, 6, 15, 51'),
              ],
            }),
          ],
          sizeBytes: 342,
          at: 0,
          wireTimeMs: 0,
          delivery: 'broadcast',
          floodTo: ['phone', 'router'],
          meta: { ipv4: discoverIp.meta },
        },
      ],
      focus: ['switch'],
    },
    {
      id: 'dns-lost',
      title: 'A DNS query is lost',
      summary:
        'The phone’s query vanishes after the switch. UDP will not notice or retry by itself.',
      body: [
        {
          type: 'p',
          text: 'UDP has no acknowledgments, so the sender only learns about the loss when its own timer fires.',
        },
      ],
      packets: [
        {
          id: 'p-dns-lost',
          from: 'phone',
          to: 'router',
          via: ['switch'],
          protocol: 'dns',
          label: 'A www.example.com',
          summary: 'Standard query 0x3a7c A www.example.com',
          headers: [
            ethernet({ src: MAC.phone, dst: MAC.routerLan, etherType: 'IPv4' }),
            queryIp.group,
            udp({ srcPort: 49321, dstPort: PORT.dns, length: 41 }),
            query,
          ],
          sizeBytes: 75,
          at: 0,
          wireTimeMs: 250,
          outcome: {
            kind: 'lost',
            afterNode: 'switch',
            note: 'Dropped on the wire between the switch and the router.',
          },
          meta: { ipv4: queryIp.meta },
        },
      ],
      focus: ['phone'],
    },
    {
      id: 'dns-retry',
      title: 'The phone retries the query',
      summary: 'After a timeout the stub resolver sends the same question again and it arrives.',
      body: [
        {
          type: 'p',
          text: 'Retrying is the application’s job here: the DNS client resends the same question after about a second.',
        },
      ],
      packets: [
        {
          id: 'p-dns-retry',
          from: 'phone',
          to: 'router',
          via: ['switch'],
          protocol: 'dns',
          label: 'A www.example.com',
          summary: 'Standard query 0x3a7c A www.example.com (retry)',
          headers: [
            ethernet({ src: MAC.phone, dst: MAC.routerLan, etherType: 'IPv4' }),
            retryIp.group,
            udp({ srcPort: 49321, dstPort: PORT.dns, length: 41 }),
            query,
          ],
          sizeBytes: 75,
          at: 0,
          wireTimeMs: 1250,
          meta: { ipv4: retryIp.meta },
        },
      ],
      focus: ['phone', 'router'],
    },
  ],
});
