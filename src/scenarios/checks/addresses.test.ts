import { describe, expect, it } from 'vitest';
import type { ScenarioDef } from '../../model/types';
import minimal from '../__fixtures__/minimal';
import {
  checkAddresses,
  checkIpv6Address,
  isAllowedHostname,
  isAllowedIpv4,
  parseIpv4,
} from './addresses';

describe('isAllowedIpv4', () => {
  it.each([
    '192.0.2.80',
    '198.51.100.7',
    '203.0.113.255',
    '10.1.2.3',
    '172.16.0.1',
    '172.31.255.254',
    '192.168.1.23',
    '0.0.0.0',
    '255.255.255.255',
    '127.0.0.1',
  ])('allows %s', (address) => {
    expect(isAllowedIpv4(address)).toBe(true);
  });

  it.each([
    '8.8.8.8',
    '1.1.1.1',
    '172.32.0.1',
    '192.0.3.1',
    '198.51.101.1',
    '203.0.114.1',
    '11.0.0.1',
  ])('rejects %s', (address) => {
    expect(isAllowedIpv4(address)).toBe(false);
  });

  it('allows an address from the scenario allowlist', () => {
    expect(isAllowedIpv4('198.41.0.4')).toBe(false);
    expect(isAllowedIpv4('198.41.0.4', ['198.41.0.4'])).toBe(true);
  });

  it('rejects malformed addresses', () => {
    expect(parseIpv4('192.168.1')).toBeUndefined();
    expect(parseIpv4('192.168.1.256')).toBeUndefined();
    expect(isAllowedIpv4('192.168.1.1.1')).toBe(false);
  });
});

describe('checkIpv6Address', () => {
  it.each([
    '2001:db8::1',
    '2001:db8:1::23',
    '2001:0db8:0000:0000:0000:0000:0000:0001',
    '2001:DB8::',
  ])('accepts %s', (address) => {
    expect(checkIpv6Address(address)).toBe('ok');
  });

  it.each(['2a00:1450::1', '::1', 'fe80::1', '2001:db9::1', '2001:4860:4860::8888'])(
    'places %s outside the documentation range',
    (address) => {
      expect(checkIpv6Address(address)).toBe('outside');
    },
  );

  it.each(['not-an-address', '2001:db8:::1', '2001:db8::1::2', '12345::1', '1:2:3:4:5:6:7'])(
    'calls %s malformed',
    (address) => {
      expect(checkIpv6Address(address)).toBe('malformed');
    },
  );
});

describe('isAllowedHostname', () => {
  it.each([
    'example.com',
    'www.example.com',
    'API.Example.NET',
    'mx1.example.org',
    'host.example',
    'laptop.test',
    'a.root-servers.net',
    'a.gtld-servers.net',
    'www.example.com.',
  ])('allows %s', (host) => {
    expect(isAllowedHostname(host)).toBe(true);
  });

  it.each([
    'www.realsite.com',
    'notexample.com',
    'example.com.evil.io',
    'google.com',
    'servers.net',
  ])('rejects %s', (host) => {
    expect(isAllowedHostname(host)).toBe(false);
  });

  it('allows a hostname from the scenario allowlist', () => {
    expect(isAllowedHostname('ns.real-registry.net', ['ns.real-registry.net'])).toBe(true);
  });
});

describe('checkAddresses', () => {
  function withNodeAddresses(addresses: NonNullable<ScenarioDef['nodes'][number]['addresses']>) {
    const scenario = structuredClone(minimal) as ScenarioDef;
    const node = scenario.nodes[0];
    if (node) node.addresses = addresses;

    return scenario;
  }

  it('accepts the shared fixture', () => {
    expect(checkAddresses(minimal)).toEqual([]);
  });

  it('flags each bad node address with its own code and path', () => {
    const issues = checkAddresses(
      withNodeAddresses({
        ipv4: '8.8.8.8',
        ipv6: '2a00:1450::1',
        hostname: 'www.realsite.com',
      }),
    );

    expect(issues.map((i) => [i.code, i.path])).toEqual([
      ['address-ipv4-outside-documentation', 'nodes[0].addresses.ipv4'],
      ['address-ipv6-outside-documentation', 'nodes[0].addresses.ipv6'],
      ['address-hostname-not-reserved', 'nodes[0].addresses.hostname'],
    ]);
  });

  it('reports malformed addresses separately from out-of-range ones', () => {
    const codes = checkAddresses(withNodeAddresses({ ipv4: '300.1.1.1', ipv6: 'zz::1' })).map(
      (i) => i.code,
    );

    expect(codes).toEqual(['address-ipv4-malformed', 'address-ipv6-malformed']);
  });

  it('honours the scenario allowlist for real servers', () => {
    const scenario = withNodeAddresses({ ipv4: '198.41.0.4', hostname: 'a.root-servers.net' });

    expect(checkAddresses(scenario).map((i) => i.code)).toEqual([
      'address-ipv4-outside-documentation',
    ]);
    expect(checkAddresses({ ...scenario, addressAllowlist: ['198.41.0.4'] })).toEqual([]);
  });

  it('checks both ends of meta.ipv4', () => {
    const scenario = structuredClone(minimal) as ScenarioDef;
    const ipv4 = scenario.steps[0]?.packets[0]?.meta?.ipv4;
    if (!ipv4) throw new Error('fixture has no ipv4 meta');
    ipv4.src = '9.9.9.9';
    ipv4.dst = '1.1.1.1';

    expect(checkAddresses(scenario).map((i) => i.path)).toEqual([
      'steps[0].packets[0].meta.ipv4.src',
      'steps[0].packets[0].meta.ipv4.dst',
    ]);
  });
});
