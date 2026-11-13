import { describe, expect, it } from 'vitest';
import type { PacketDef, TcpMeta } from '../../model/types';
import { relativeTcp } from './tcpRelative';

function segment(id: string, tcp: TcpMeta): PacketDef {
  return {
    id,
    from: 'a',
    to: 'b',
    protocol: 'tcp',
    label: id,
    summary: id,
    headers: [],
    at: 0,
    wireTimeMs: 0,
    meta: { tcp },
  };
}

const CLIENT = 1_204_331_000;
const SERVER = 3_877_120_400;
const base = { conn: 'c', len: 0 } as const;

const packets = [
  segment('syn', { ...base, srcPort: 50000, dstPort: 443, seq: CLIENT, flags: ['SYN'] }),
  segment('synack', {
    ...base,
    srcPort: 443,
    dstPort: 50000,
    seq: SERVER,
    ack: CLIENT + 1,
    flags: ['SYN', 'ACK'],
  }),
  segment('ack', {
    ...base,
    srcPort: 50000,
    dstPort: 443,
    seq: CLIENT + 1,
    ack: SERVER + 1,
    flags: ['ACK'],
  }),
];

function metaOf(index: number): TcpMeta {
  const tcp = packets[index]?.meta?.tcp;
  if (tcp === undefined) throw new Error('missing tcp meta');

  return tcp;
}

describe('relativeTcp', () => {
  it('shows the SYN as relative 0', () => {
    expect(relativeTcp(packets, metaOf(0))).toEqual({ seq: 0 });
  });

  it('relates SYN-ACK ack to the client ISN', () => {
    expect(relativeTcp(packets, metaOf(1))).toEqual({ seq: 0, ack: 1 });
  });

  it('relates the final ACK to both ISNs', () => {
    expect(relativeTcp(packets, metaOf(2))).toEqual({ seq: 1, ack: 1 });
  });

  it('wraps around 2^32', () => {
    const wrap = [
      segment('syn', { ...base, srcPort: 1, dstPort: 2, seq: 4_294_967_295, flags: ['SYN'] }),
      segment('data', { ...base, srcPort: 1, dstPort: 2, seq: 4, flags: ['PSH'] }),
    ];
    const data = wrap[1]?.meta?.tcp;
    if (data === undefined) throw new Error('missing tcp meta');

    expect(relativeTcp(wrap, data)).toEqual({ seq: 5 });
  });
});
