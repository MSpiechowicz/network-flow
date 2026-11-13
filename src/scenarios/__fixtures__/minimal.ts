import { defineScenario } from '../../model/types';
import { IP, ISN, MAC, PORT } from '../lib/addresses';
import { ethernet, ipv4, tcp, tcpSynOptions } from '../lib/builders';

/** A TCP handshake from a laptop through a router to a web server, with one local action. */
const CLIENT_PORT = 51234;
const CONN = 'laptop-web';

const syn = tcp(
  {
    conn: CONN,
    srcPort: CLIENT_PORT,
    dstPort: PORT.http,
    seq: ISN.client,
    flags: ['SYN'],
    len: 0,
    window: 64240,
  },
  { options: tcpSynOptions() },
);
const synAck = tcp(
  {
    conn: CONN,
    srcPort: PORT.http,
    dstPort: CLIENT_PORT,
    seq: ISN.server,
    ack: ISN.client + 1,
    flags: ['SYN', 'ACK'],
    len: 0,
    window: 65160,
  },
  { options: tcpSynOptions() },
);
const ack = tcp({
  conn: CONN,
  srcPort: CLIENT_PORT,
  dstPort: PORT.http,
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
  dst: IP.laptop,
  ttl: 58,
  id: 0x0000,
  df: true,
  protocol: 'TCP',
  totalLength: 60,
});
const ackIp = ipv4({
  src: IP.laptop,
  dst: IP.cdnEdge,
  ttl: 64,
  id: 0x1c47,
  df: true,
  protocol: 'TCP',
  totalLength: 52,
});

export default defineScenario({
  id: 'minimal',
  title: 'Minimal fixture',
  tagline: 'A TCP handshake across three nodes.',
  category: 'foundations',
  order: 900,
  protocols: ['ethernet', 'ipv4', 'tcp'],
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
    {
      id: 'router',
      kind: 'router',
      label: 'Home router',
      sublabel: IP.routerLan,
      position: { col: 2, row: 2 },
      zone: 'home',
      addresses: { ipv4: IP.routerLan, mac: MAC.routerLan },
    },
    {
      id: 'server',
      kind: 'server',
      label: 'Web server',
      sublabel: IP.cdnEdge,
      position: { col: 5, row: 2 },
      zone: 'internet',
      addresses: { ipv4: IP.cdnEdge },
    },
  ],
  links: [
    { id: 'laptop-router', a: 'laptop', b: 'router', medium: 'wifi' },
    { id: 'router-server', a: 'router', b: 'server', medium: 'wan' },
  ],
  zones: [
    {
      id: 'home',
      label: 'Home LAN',
      from: { col: -1, row: 0.5 },
      to: { col: 3, row: 3.5 },
      tone: 'lan',
    },
    {
      id: 'internet',
      label: 'Internet',
      from: { col: 4, row: 0.5 },
      to: { col: 6.5, row: 3.5 },
      tone: 'internet',
    },
  ],
  steps: [
    {
      id: 'syn',
      title: 'SYN: ask to open a connection',
      summary: 'The laptop picks an initial sequence number and sends a **SYN** to port 80.',
      body: [
        {
          type: 'p',
          text: 'The client chooses a random initial sequence number and an ephemeral source port, then asks the server to open a connection.',
        },
      ],
      packets: [
        {
          id: 'p-syn',
          from: 'laptop',
          to: 'server',
          via: ['router'],
          protocol: 'tcp',
          label: 'SYN',
          summary: `${CLIENT_PORT} → 80 [SYN] Seq=${ISN.client} Win=64240`,
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
      ],
      focus: ['laptop'],
      simplifications: [
        'The router rewrites the source address (NAT); the header shows the packet as the laptop sent it.',
      ],
    },
    {
      id: 'syn-ack',
      title: 'SYN-ACK: agree to open',
      summary: 'The server answers with its own sequence number and acknowledges the SYN.',
      body: [
        {
          type: 'p',
          text: 'The reply has both **SYN** and **ACK** set. Its acknowledgment number is the client sequence number plus one, because a SYN consumes one number.',
        },
      ],
      packets: [
        {
          id: 'p-syn-ack',
          from: 'server',
          to: 'laptop',
          via: ['router'],
          protocol: 'tcp',
          label: 'SYN-ACK',
          summary: `80 → ${CLIENT_PORT} [SYN, ACK] Seq=${ISN.server} Ack=${ISN.client + 1}`,
          headers: [
            ethernet({ src: MAC.cdnEdge, dst: MAC.routerWan, etherType: 'IPv4' }),
            synAckIp.group,
            synAck.group,
          ],
          sizeBytes: 74,
          at: 0,
          wireTimeMs: 14.2,
          meta: { ipv4: synAckIp.meta, tcp: synAck.meta },
        },
      ],
      focus: ['server'],
    },
    {
      id: 'ack',
      title: 'ACK: connection established',
      summary:
        'The laptop acknowledges the server’s SYN; both ends now consider the connection open.',
      body: [
        {
          type: 'callout',
          tone: 'note',
          text: 'This third segment can already carry data; here it is a pure **ACK**.',
        },
      ],
      packets: [
        {
          id: 'p-ack',
          from: 'laptop',
          to: 'server',
          via: ['router'],
          protocol: 'tcp',
          label: 'ACK',
          summary: `${CLIENT_PORT} → 80 [ACK] Seq=${ISN.client + 1} Ack=${ISN.server + 1}`,
          headers: [
            ethernet({ src: MAC.laptop, dst: MAC.routerLan, etherType: 'IPv4' }),
            ackIp.group,
            ack.group,
          ],
          sizeBytes: 66,
          at: 0,
          wireTimeMs: 14.3,
          meta: { ipv4: ackIp.meta, tcp: ack.meta },
        },
      ],
      actions: [
        {
          id: 'a-established',
          node: 'server',
          kind: 'process',
          label: 'Connection ESTABLISHED',
          at: 1600,
          durationMs: 800,
        },
      ],
      focus: ['laptop', 'server'],
    },
  ],
});
