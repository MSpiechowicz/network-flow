import { describe, expect, it } from 'vitest';
import { formatWireTime, protocolLabel } from './format';

describe('formatWireTime', () => {
  it('prints milliseconds with one decimal below one second', () => {
    expect(formatWireTime(12.4)).toBe('+12.4 ms');
    expect(formatWireTime(0)).toBe('+0.0 ms');
    expect(formatWireTime(999.4)).toBe('+999.4 ms');
  });

  it('prints seconds with three decimals from one second to one minute', () => {
    expect(formatWireTime(1000)).toBe('+1.000 s');
    expect(formatWireTime(1203)).toBe('+1.203 s');
    expect(formatWireTime(59999.2)).toBe('+59.999 s');
  });

  it('switches form at the boundaries after rounding', () => {
    expect(formatWireTime(999.96)).toBe('+1.000 s');
    expect(formatWireTime(59999.7)).toBe('+1:00');
  });

  it('prints minutes and seconds from one minute to one hour', () => {
    expect(formatWireTime(60_000)).toBe('+1:00');
    expect(formatWireTime(125_400)).toBe('+2:05');
    expect(formatWireTime(3_599_000)).toBe('+59:59');
  });

  it('prints hours, minutes and seconds from one hour', () => {
    expect(formatWireTime(3_600_000)).toBe('+1:00:00');
    expect(formatWireTime(43_200_007.4)).toBe('+12:00:00');
    expect(formatWireTime(21_600_000 + 61_000)).toBe('+6:01:01');
  });
});

describe('protocolLabel', () => {
  it('uses the registry label', () => {
    expect(protocolLabel('dns', undefined)).toBe('DNS');
  });

  it('marks encrypted application protocols as carried in TLS', () => {
    expect(protocolLabel('http', true)).toBe('HTTP (in TLS)');
  });

  it('does not wrap TLS in itself', () => {
    expect(protocolLabel('tls', true)).toBe('TLS');
  });
});
