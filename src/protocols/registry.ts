import type { Layer, Reference } from '../model/types';

/**
 * Protocol registry: the closed set of protocols a `PacketDef.protocol`,
 * `HeaderGroup.protocol` or `ScenarioDef.protocols` entry may use.
 *
 * Adding a protocol is a data-only change: add one entry below and mirror its colour as
 * `--proto-<id>` in `src/styles/tokens.css`.
 */
export interface ProtocolInfo {
  /** Short label used in the packet table's Protocol column, for example `"DNS"`. */
  label: string;
  fullName: string;
  /** TCP/IP layer the protocol's header is grouped under in the header inspector. */
  layer: Layer;
  /** Hex colour on the dark canvas. Mirrored as `--proto-<id>` in `tokens.css`. */
  color: string;
  /** Well-known port(s), as display text, for example `"UDP 53, TCP 53"`. */
  ports?: string;
  references?: readonly Reference[];
}

export const PROTOCOLS = {
  ethernet: {
    label: 'Ethernet',
    fullName: 'Ethernet II frame',
    layer: 'link',
    color: '#9aa5b8',
    references: [
      {
        label: 'RFC 894: IP datagrams over Ethernet',
        url: 'https://www.rfc-editor.org/rfc/rfc894',
      },
    ],
  },
  ipv4: {
    label: 'IPv4',
    fullName: 'Internet Protocol version 4',
    layer: 'internet',
    color: '#6f9cff',
    references: [
      { label: 'RFC 791: Internet Protocol', url: 'https://www.rfc-editor.org/rfc/rfc791' },
    ],
  },
  icmp: {
    label: 'ICMP',
    fullName: 'Internet Control Message Protocol',
    layer: 'internet',
    color: '#ff6b6b',
    references: [
      {
        label: 'RFC 792: Internet Control Message Protocol',
        url: 'https://www.rfc-editor.org/rfc/rfc792',
      },
      { label: 'RFC 1191: Path MTU Discovery', url: 'https://www.rfc-editor.org/rfc/rfc1191' },
    ],
  },
  tcp: {
    label: 'TCP',
    fullName: 'Transmission Control Protocol',
    layer: 'transport',
    color: '#5fd4e8',
    references: [
      {
        label: 'RFC 9293: Transmission Control Protocol',
        url: 'https://www.rfc-editor.org/rfc/rfc9293',
      },
    ],
  },
  udp: {
    label: 'UDP',
    fullName: 'User Datagram Protocol',
    layer: 'transport',
    color: '#f27fd2',
    references: [
      { label: 'RFC 768: User Datagram Protocol', url: 'https://www.rfc-editor.org/rfc/rfc768' },
    ],
  },
  dns: {
    label: 'DNS',
    fullName: 'Domain Name System',
    layer: 'application',
    color: '#b79cff',
    ports: 'UDP 53, TCP 53',
    references: [
      {
        label: 'RFC 1034: Domain names, concepts and facilities',
        url: 'https://www.rfc-editor.org/rfc/rfc1034',
      },
      {
        label: 'RFC 1035: Domain names, implementation and specification',
        url: 'https://www.rfc-editor.org/rfc/rfc1035',
      },
    ],
  },
  dhcp: {
    label: 'DHCP',
    fullName: 'Dynamic Host Configuration Protocol',
    layer: 'application',
    color: '#d8e15c',
    ports: 'UDP 67 (server), UDP 68 (client)',
    references: [
      { label: 'RFC 2131: DHCP', url: 'https://www.rfc-editor.org/rfc/rfc2131' },
      { label: 'RFC 2132: DHCP options', url: 'https://www.rfc-editor.org/rfc/rfc2132' },
    ],
  },
  ntp: {
    label: 'NTP',
    fullName: 'Network Time Protocol',
    layer: 'application',
    color: '#3fd9a0',
    ports: 'UDP 123',
    references: [
      { label: 'RFC 5905: NTP version 4', url: 'https://www.rfc-editor.org/rfc/rfc5905' },
    ],
  },
  http: {
    label: 'HTTP',
    fullName: 'Hypertext Transfer Protocol',
    layer: 'application',
    color: '#8fe388',
    ports: 'TCP 80, TCP 443',
    references: [
      { label: 'RFC 9110: HTTP semantics', url: 'https://www.rfc-editor.org/rfc/rfc9110' },
      { label: 'RFC 9112: HTTP/1.1', url: 'https://www.rfc-editor.org/rfc/rfc9112' },
      { label: 'RFC 9113: HTTP/2', url: 'https://www.rfc-editor.org/rfc/rfc9113' },
    ],
  },
  tls: {
    label: 'TLS',
    fullName: 'Transport Layer Security',
    // The inspector has four layers; TLS records sit above TCP, so they group with the application.
    layer: 'application',
    color: '#f6b94c',
    ports: 'TCP 443 (HTTPS)',
    references: [
      {
        label: 'RFC 8446: TLS version 1.3',
        url: 'https://www.rfc-editor.org/rfc/rfc8446',
      },
    ],
  },
  smtp: {
    label: 'SMTP',
    fullName: 'Simple Mail Transfer Protocol',
    layer: 'application',
    color: '#ff9a62',
    ports: 'TCP 25 (relay), TCP 587 (submission), TCP 465 (implicit TLS)',
    references: [
      { label: 'RFC 5321: SMTP', url: 'https://www.rfc-editor.org/rfc/rfc5321' },
      { label: 'RFC 6409: Message submission', url: 'https://www.rfc-editor.org/rfc/rfc6409' },
      {
        label: 'RFC 8314: Cleartext considered obsolete',
        url: 'https://www.rfc-editor.org/rfc/rfc8314',
      },
    ],
  },
  pop3: {
    label: 'POP3',
    fullName: 'Post Office Protocol version 3',
    layer: 'application',
    color: '#e3c28f',
    ports: 'TCP 110, TCP 995 (implicit TLS)',
    references: [{ label: 'RFC 1939: POP3', url: 'https://www.rfc-editor.org/rfc/rfc1939' }],
  },
  imap: {
    label: 'IMAP',
    fullName: 'Internet Message Access Protocol',
    layer: 'application',
    color: '#ff8fb1',
    ports: 'TCP 143, TCP 993 (implicit TLS)',
    references: [{ label: 'RFC 9051: IMAP4rev2', url: 'https://www.rfc-editor.org/rfc/rfc9051' }],
  },
} as const satisfies Record<string, ProtocolInfo>;

/** Every valid protocol id. An id that is not a key of `PROTOCOLS` is a compile error. */
export type ProtocolId = keyof typeof PROTOCOLS;

/** Typed lookup; use this instead of indexing `PROTOCOLS` so optional fields (`ports`) are readable. */
export function protocolInfo(id: ProtocolId): ProtocolInfo {
  return PROTOCOLS[id];
}
