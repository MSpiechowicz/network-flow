import type { PacketDef, TcpMeta } from '../../model/types';

const MOD = 2 ** 32;

export interface RelativeTcp {
  seq: number;
  /** Absent when the segment has no ACK flag or the peer's ISN is unknown. */
  ack?: number;
}

/** Initial sequence number per direction (keyed by source port) of one connection. */
function initialSequenceNumbers(packets: readonly PacketDef[], conn: string): Map<number, number> {
  const isns = new Map<number, number>();

  // A SYN defines the ISN of its direction; otherwise the first segment seen stands in for it.
  for (const packet of packets) {
    const tcp = packet.meta?.tcp;
    if (tcp?.conn === conn && tcp.flags.includes('SYN') && !isns.has(tcp.srcPort)) {
      isns.set(tcp.srcPort, tcp.seq);
    }
  }

  for (const packet of packets) {
    const tcp = packet.meta?.tcp;
    if (tcp?.conn === conn && !isns.has(tcp.srcPort)) {
      isns.set(tcp.srcPort, tcp.seq);
    }
  }

  return isns;
}

/**
 * Relative sequence/acknowledgment numbers like a capture tool shows them: seq minus this direction's
 * ISN, ack minus the peer's ISN (both modulo 2^32). Returns `undefined` when the connection's own
 * direction has no known ISN.
 */
export function relativeTcp(packets: readonly PacketDef[], meta: TcpMeta): RelativeTcp | undefined {
  const isns = initialSequenceNumbers(packets, meta.conn);
  const own = isns.get(meta.srcPort);
  if (own === undefined) {
    return undefined;
  }

  const result: RelativeTcp = { seq: (((meta.seq - own) % MOD) + MOD) % MOD };

  const peer = isns.get(meta.dstPort);
  if (meta.ack !== undefined && meta.flags.includes('ACK') && peer !== undefined) {
    result.ack = (((meta.ack - peer) % MOD) + MOD) % MOD;
  }

  return result;
}
