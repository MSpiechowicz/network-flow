import { describe, expect, it } from 'vitest';
import type { TcpFlag, TcpMeta } from '../../model/types';
import { checkTcp, type TcpSegment } from './tcp';

const C = 1000; // client ISN
const S = 5000; // server ISN

/** Segment from the client (port 50000) or the server (port 80) of connection `c1`. */
function seg(
  from: 'client' | 'server',
  flags: TcpFlag[],
  seq: number,
  extra: Partial<TcpMeta> = {},
): TcpSegment {
  return {
    path: 'steps[0].packets[0]',
    meta: {
      conn: 'c1',
      srcPort: from === 'client' ? 50000 : 80,
      dstPort: from === 'client' ? 80 : 50000,
      seq,
      flags,
      len: 0,
      ...extra,
    },
  };
}

const handshake = (): TcpSegment[] => [
  seg('client', ['SYN'], C),
  seg('server', ['SYN', 'ACK'], S, { ack: C + 1 }),
  seg('client', ['ACK'], C + 1, { ack: S + 1 }),
];

function codes(segments: TcpSegment[]): string[] {
  return checkTcp(segments).map((i) => i.code);
}

describe('checkTcp', () => {
  it('accepts a handshake, data, acknowledgments and a four-segment close', () => {
    const segments = [
      ...handshake(),
      seg('client', ['PSH', 'ACK'], C + 1, { ack: S + 1, len: 100 }),
      seg('server', ['ACK'], S + 1, { ack: C + 101 }),
      seg('server', ['PSH', 'ACK'], S + 1, { ack: C + 101, len: 500 }),
      seg('client', ['FIN', 'ACK'], C + 101, { ack: S + 501 }),
      seg('server', ['ACK'], S + 501, { ack: C + 102 }),
      seg('server', ['FIN', 'ACK'], S + 501, { ack: C + 102 }),
      seg('client', ['ACK'], C + 102, { ack: S + 502 }),
    ];

    expect(codes(segments)).toEqual([]);
  });

  it('accepts a retransmission that reuses the original sequence number', () => {
    const segments = [
      ...handshake(),
      seg('client', ['ACK'], C + 1, { ack: S + 1, len: 100 }),
      seg('client', ['ACK'], C + 1, { ack: S + 1, len: 100, retransmission: true }),
      seg('client', ['ACK'], C + 101, { ack: S + 1, len: 50 }),
    ];

    expect(codes(segments)).toEqual([]);
  });

  it('accepts an old (lower) ACK', () => {
    const segments = [
      ...handshake(),
      seg('server', ['ACK'], S + 1, { ack: C + 1, len: 10 }),
      seg('server', ['ACK'], S + 11, { ack: C + 1, len: 10 }),
      seg('client', ['ACK'], C + 1, { ack: S + 11 }),
      seg('client', ['ACK'], C + 1, { ack: S + 21 }),
    ];

    expect(codes(segments)).toEqual([]);
  });

  it('handles sequence numbers that wrap around 2^32', () => {
    const isn = 2 ** 32 - 1;
    const segments = [
      seg('client', ['SYN'], isn),
      seg('server', ['SYN', 'ACK'], S, { ack: 0 }),
      seg('client', ['ACK'], 0, { ack: S + 1 }),
    ];

    expect(codes(segments)).toEqual([]);
  });

  it('keeps connections apart by id', () => {
    const other = handshake().map((s) => ({ ...s, meta: { ...s.meta, conn: 'c2' } }));

    expect(codes([...handshake(), ...other])).toEqual([]);
  });

  it('requires the first segment to be a SYN', () => {
    expect(codes([seg('client', ['ACK'], C, { ack: 1 })])).toContain('tcp-first-not-syn');
    expect(codes([seg('client', ['SYN', 'ACK'], C, { ack: 1 })])).toContain('tcp-first-not-syn');
  });

  it('lets a documented resync start a connection without a SYN', () => {
    expect(codes([seg('client', ['ACK'], C, { ack: 1, resync: true })])).toEqual([]);
  });

  it('requires SYN+ACK as the second segment', () => {
    const segments = [seg('client', ['SYN'], C), seg('server', ['ACK'], S, { ack: C + 1 })];

    expect(codes(segments)).toContain('tcp-second-not-syn-ack');
  });

  it('requires the SYN-ACK to acknowledge client ISN + 1', () => {
    const segments = [seg('client', ['SYN'], C), seg('server', ['SYN', 'ACK'], S, { ack: C })];

    expect(codes(segments)).toContain('tcp-syn-ack-wrong-ack');
  });

  it('rejects a segment that skips ahead of the expected sequence number', () => {
    const segments = [...handshake(), seg('client', ['ACK'], C + 2, { ack: S + 1 })];

    expect(codes(segments)).toEqual(['tcp-seq-mismatch']);
  });

  it('counts SYN and FIN as one sequence number each', () => {
    const afterFin = [
      ...handshake(),
      seg('client', ['FIN', 'ACK'], C + 1, { ack: S + 1 }),
      seg('client', ['ACK'], C + 1, { ack: S + 1 }),
    ];

    expect(codes(afterFin)).toEqual(['tcp-seq-mismatch']);
  });

  it('rejects an ACK for bytes the peer has not sent', () => {
    const segments = [...handshake(), seg('client', ['ACK'], C + 1, { ack: S + 2 })];

    expect(codes(segments)).toEqual(['tcp-ack-beyond-peer']);
  });

  it('rejects the ACK flag without an ack number', () => {
    const segments = [...handshake(), seg('client', ['ACK'], C + 1)];

    expect(codes(segments)).toEqual(['tcp-ack-missing']);
  });

  it('rejects a third pair of ports on one connection', () => {
    const stray: TcpSegment = {
      path: 'steps[1].packets[0]',
      meta: {
        conn: 'c1',
        srcPort: 50001,
        dstPort: 80,
        seq: C + 1,
        flags: ['ACK'],
        len: 0,
        ack: S + 1,
      },
    };

    expect(codes([...handshake(), stray])).toEqual(['tcp-endpoint-mismatch']);
  });

  it('lets resync reset expectations after omitted segments', () => {
    const segments = [
      ...handshake(),
      // 1400 bytes from the server were left out of the scenario.
      seg('server', ['ACK'], S + 1401, { ack: C + 1, len: 10, resync: true }),
      seg('client', ['ACK'], C + 1, { ack: S + 1411 }),
    ];

    expect(codes(segments)).toEqual([]);
  });

  it('points at the offending packet', () => {
    const bad = seg('client', ['ACK'], C + 9, { ack: S + 1 });
    const [issue] = checkTcp([...handshake(), { ...bad, path: 'steps[4].packets[2]' }]);

    expect(issue?.path).toBe('steps[4].packets[2].meta.tcp.seq');
    expect(issue?.severity).toBe('error');
  });
});
