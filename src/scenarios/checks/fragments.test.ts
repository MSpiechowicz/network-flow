import { describe, expect, it } from 'vitest';
import type { Ipv4Meta } from '../../model/types';
import { checkFragments, type Ipv4Segment } from './fragments';

const common = { src: '192.168.1.23', dst: '203.0.113.10', ttl: 64, id: 0x4242 };

function seg(path: string, over: Partial<Ipv4Meta>): Ipv4Segment {
  return { path, meta: { ...common, ...over } };
}

/** The worked example: 1500 bytes over MTU 1400 is 1376 + 104 data bytes. */
const original = (): Ipv4Segment => seg('orig', { totalLength: 1500, df: false });
const first = (): Ipv4Segment => seg('f1', { mf: true, fragOffset: 0, totalLength: 1396 });
const second = (): Ipv4Segment => seg('f2', { mf: false, fragOffset: 172, totalLength: 124 });

function codes(segments: Ipv4Segment[]): string[] {
  return checkFragments(segments).map((i) => i.code);
}

describe('checkFragments', () => {
  it('accepts the worked example, with or without the original', () => {
    expect(codes([first(), second()])).toEqual([]);
    expect(codes([original(), first(), second()])).toEqual([]);
  });

  it('accepts three fragments and fragments listed out of order', () => {
    const third = [
      seg('a', { mf: true, fragOffset: 0, totalLength: 1020 }),
      seg('b', { mf: true, fragOffset: 125, totalLength: 1020 }),
      seg('c', { mf: false, fragOffset: 250, totalLength: 520 }),
    ];

    expect(codes(third)).toEqual([]);
    expect(codes([third[2]!, third[0]!, third[1]!])).toEqual([]);
  });

  it('ignores packets that are not fragments, even with a shared id', () => {
    expect(codes([original(), seg('other', { totalLength: 60, id: 7 })])).toEqual([]);
  });

  it('does not mix datagrams with different ids', () => {
    const other = [
      seg('x1', { id: 1, mf: true, fragOffset: 0, totalLength: 1396 }),
      seg('x2', { id: 1, mf: false, fragOffset: 172, totalLength: 124 }),
    ];

    expect(codes([...other, first(), second()])).toEqual([]);
  });

  it('flags a gap between fragment offsets', () => {
    const bad = seg('f2', { mf: false, fragOffset: 173, totalLength: 124 });

    expect(checkFragments([first(), bad]).map((i) => [i.code, i.path])).toEqual([
      ['ip-fragment-gap', 'f2.meta.ipv4.fragOffset'],
    ]);
  });

  it('flags overlapping fragments', () => {
    const bad = seg('f2', { mf: false, fragOffset: 100, totalLength: 124 });

    expect(codes([first(), bad])).toEqual(['ip-fragment-gap']);
  });

  it('flags a first fragment that does not start at offset 0', () => {
    const late = seg('f1', { mf: true, fragOffset: 10, totalLength: 1396 });

    expect(codes([late, second()])).toContain('ip-fragment-gap');
  });

  it('flags a non-last fragment whose data is not a multiple of 8', () => {
    const odd = seg('f1', { mf: true, fragOffset: 0, totalLength: 1395 });

    expect(codes([odd, second()])).toContain('ip-fragment-length-not-multiple-of-8');
  });

  it('flags a missing tail (last fragment still has MF) and a stray MF=0 in the middle', () => {
    expect(codes([first()])).toEqual(['ip-fragment-mf-flag']);

    const middle = [
      seg('a', { mf: true, fragOffset: 0, totalLength: 1020 }),
      seg('b', { mf: false, fragOffset: 125, totalLength: 1020 }),
      seg('c', { mf: false, fragOffset: 250, totalLength: 520 }),
    ];
    expect(codes(middle)).toEqual(['ip-fragment-mf-flag']);
  });

  it('flags fragments whose data does not add up to the original', () => {
    const short = seg('f2', { mf: false, fragOffset: 172, totalLength: 100 });

    expect(codes([original(), first(), short])).toEqual(['ip-fragment-total-mismatch']);
  });

  it('requires totalLength on fragments', () => {
    const noLength = seg('f2', { mf: false, fragOffset: 172 });

    expect(codes([first(), noLength])).toEqual(['ip-fragment-length-missing']);
  });
});
