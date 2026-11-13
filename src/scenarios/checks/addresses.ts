import type { ScenarioDef } from '../../model/types';
import { errorIssue, type ValidationIssue } from './issue';
import { listPacketRefs } from './refs';

/** IPv4 ranges a scenario may use without allowlisting: documentation, private, special. */
const ALLOWED_IPV4_RANGES: readonly { base: string; bits: number; name: string }[] = [
  { base: '192.0.2.0', bits: 24, name: 'TEST-NET-1' },
  { base: '198.51.100.0', bits: 24, name: 'TEST-NET-2' },
  { base: '203.0.113.0', bits: 24, name: 'TEST-NET-3' },
  { base: '10.0.0.0', bits: 8, name: 'RFC 1918' },
  { base: '172.16.0.0', bits: 12, name: 'RFC 1918' },
  { base: '192.168.0.0', bits: 16, name: 'RFC 1918' },
  { base: '0.0.0.0', bits: 32, name: 'unspecified' },
  { base: '255.255.255.255', bits: 32, name: 'limited broadcast' },
  { base: '127.0.0.0', bits: 8, name: 'loopback' },
];

/** Hostnames must equal or sit under one of these (RFC 2606 / 6761). */
const RESERVED_DOMAINS = ['example.com', 'example.net', 'example.org', 'example', 'test'];

/** Real infrastructure names scenarios may show without an explicit allowlist entry. */
const INFRASTRUCTURE_DOMAINS = ['root-servers.net', 'gtld-servers.net'];

/** Parses dotted-quad IPv4 into an unsigned 32-bit number, or `undefined` when malformed. */
export function parseIpv4(address: string): number | undefined {
  const match = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(address);
  if (!match) return undefined;

  let value = 0;
  for (const part of match.slice(1)) {
    const octet = Number(part);
    if (octet > 255) return undefined;

    value = value * 256 + octet;
  }

  return value;
}

function inRange(value: number, base: number, bits: number): boolean {
  const size = 2 ** (32 - bits);

  return value >= base && value < base + size;
}

/** True when the address is in an allowed range or in `allowlist`. `false` also for malformed input. */
export function isAllowedIpv4(address: string, allowlist: readonly string[] = []): boolean {
  if (allowlist.includes(address)) return true;

  const value = parseIpv4(address);
  if (value === undefined) return false;

  return ALLOWED_IPV4_RANGES.some((range) => {
    const base = parseIpv4(range.base);

    return base !== undefined && inRange(value, base, range.bits);
  });
}

/**
 * Parses the first two 16-bit groups of an IPv6 address (enough to test `2001:db8::/32`).
 * Returns `undefined` when the text is not a well-formed IPv6 address.
 */
function ipv6Prefix(address: string): [number, number] | undefined {
  const text = address.split('/')[0] ?? '';
  const halves = text.split('::');
  if (halves.length > 2) return undefined;

  const groupsOf = (part: string): string[] => (part === '' ? [] : part.split(':'));
  const head = groupsOf(halves[0] ?? '');
  const tail = groupsOf(halves[1] ?? '');
  const compressed = halves.length === 2;
  const all = [...head, ...tail];

  if (!all.every((g) => /^[0-9a-f]{1,4}$/i.test(g))) return undefined;
  if (compressed ? all.length > 7 : all.length !== 8) return undefined;

  const first = head[0] ?? '0';
  const second = head[1] ?? '0';

  return [parseInt(first, 16), parseInt(second, 16)];
}

export type Ipv6Verdict = 'ok' | 'malformed' | 'outside';

/** Checks an IPv6 address against `2001:db8::/32`. */
export function checkIpv6Address(address: string): Ipv6Verdict {
  const prefix = ipv6Prefix(address);
  if (!prefix) return 'malformed';

  return prefix[0] === 0x2001 && prefix[1] === 0x0db8 ? 'ok' : 'outside';
}

function isUnder(host: string, domain: string): boolean {
  return host === domain || host.endsWith(`.${domain}`);
}

/** True for reserved example domains, allowlisted infrastructure names and `allowlist` entries. */
export function isAllowedHostname(hostname: string, allowlist: readonly string[] = []): boolean {
  const host = hostname.toLowerCase().replace(/\.$/, '');

  if (allowlist.some((entry) => entry.toLowerCase() === host)) return true;

  return [...RESERVED_DOMAINS, ...INFRASTRUCTURE_DOMAINS].some((domain) => isUnder(host, domain));
}

function checkIpv4(
  issues: ValidationIssue[],
  address: string,
  path: string,
  where: string,
  allowlist: readonly string[],
): void {
  if (parseIpv4(address) === undefined) {
    issues.push(
      errorIssue(
        'address-ipv4-malformed',
        path,
        `${where} "${address}" is not a valid IPv4 address`,
      ),
    );
    return;
  }

  if (!isAllowedIpv4(address, allowlist)) {
    issues.push(
      errorIssue(
        'address-ipv4-outside-documentation',
        path,
        `${where} ${address} is outside the documentation ranges (192.0.2.0/24, 198.51.100.0/24, 203.0.113.0/24), RFC 1918 and special addresses; add it to addressAllowlist only if it is a real, deliberate address`,
      ),
    );
  }
}

/** Node addresses and `meta.ipv4` addresses must come from reserved or documentation ranges. */
export function checkAddresses(def: ScenarioDef): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const allowlist = def.addressAllowlist ?? [];

  def.nodes.forEach((node, index) => {
    const addresses = node.addresses;
    if (!addresses) return;

    const base = `nodes[${index}].addresses`;

    if (addresses.ipv4 !== undefined) {
      checkIpv4(issues, addresses.ipv4, `${base}.ipv4`, `node "${node.id}" address`, allowlist);
    }

    if (addresses.ipv6 !== undefined) {
      const verdict = checkIpv6Address(addresses.ipv6);

      if (verdict === 'malformed') {
        issues.push(
          errorIssue(
            'address-ipv6-malformed',
            `${base}.ipv6`,
            `node "${node.id}" address "${addresses.ipv6}" is not a valid IPv6 address`,
          ),
        );
      } else if (verdict === 'outside') {
        issues.push(
          errorIssue(
            'address-ipv6-outside-documentation',
            `${base}.ipv6`,
            `node "${node.id}" address ${addresses.ipv6} must be in 2001:db8::/32`,
          ),
        );
      }
    }

    if (addresses.hostname !== undefined && !isAllowedHostname(addresses.hostname, allowlist)) {
      issues.push(
        errorIssue(
          'address-hostname-not-reserved',
          `${base}.hostname`,
          `node "${node.id}" hostname "${addresses.hostname}" must end in example.com, example.net, example.org, .example or .test (or be allowlisted infrastructure)`,
        ),
      );
    }
  });

  for (const { packet, path } of listPacketRefs(def)) {
    const ipv4 = packet.meta?.ipv4;
    if (!ipv4) continue;

    checkIpv4(issues, ipv4.src, `${path}.meta.ipv4.src`, 'meta.ipv4 source address', allowlist);
    checkIpv4(issues, ipv4.dst, `${path}.meta.ipv4.dst`, 'meta.ipv4 address', allowlist);
  }

  return issues;
}
