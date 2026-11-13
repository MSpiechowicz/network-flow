import { describe, expect, it } from 'vitest';
import { formatClock, formatSpeed } from './format';

describe('formatClock', () => {
  it('formats minutes, seconds and tenths', () => {
    expect(formatClock(0)).toBe('0:00.0');
    expect(formatClock(12_450)).toBe('0:12.4');
    expect(formatClock(65_300)).toBe('1:05.3');
  });

  it('clamps negative times to zero', () => {
    expect(formatClock(-50)).toBe('0:00.0');
  });
});

describe('formatSpeed', () => {
  it('appends the multiplication sign', () => {
    expect(formatSpeed(0.25)).toBe('0.25×');
    expect(formatSpeed(2)).toBe('2×');
  });
});
