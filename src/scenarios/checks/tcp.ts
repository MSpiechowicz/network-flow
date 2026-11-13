import type { TcpMeta } from '../../model/types';
import { errorIssue, type ValidationIssue } from './issue';

/** One TCP segment in scenario order, with the path of the packet it came from. */
export interface TcpSegment {
  path: string;
  meta: TcpMeta;
}

const SEQ_SPACE = 2 ** 32;

function add32(a: number, b: number): number {
  return (a + b) % SEQ_SPACE;
}

/** True when `a` is after `b` in 32-bit sequence space (serial number arithmetic). */
function seqAfter(a: number, b: number): boolean {
  const diff = (((a - b) % SEQ_SPACE) + SEQ_SPACE) % SEQ_SPACE;

  return diff > 0 && diff < SEQ_SPACE / 2;
}

/** Sequence numbers a segment consumes: its data plus one each for SYN and FIN. */
function seqLength(m: TcpMeta): number {
  return m.len + (m.flags.includes('SYN') ? 1 : 0) + (m.flags.includes('FIN') ? 1 : 0);
}

/** One direction of a connection. */
interface Direction {
  /** `srcPort>dstPort` of the segments that travel this way. */
  key: string;
  /** Sequence number the next new segment in this direction must carry. */
  nextSeq: number;
}

interface Connection {
  client: Direction;
  server?: Direction;
  /** The client's SYN sequence number, or `undefined` when the handshake was not shown. */
  clientIsn?: number;
}

function describe(m: TcpMeta): string {
  return `${m.srcPort} -> ${m.dstPort} [${m.flags.join(',')}] seq=${m.seq}`;
}

/**
 * Checks TCP segments per connection (`meta.conn`) and direction, in the order given:
 * the connection opens with a SYN, a SYN-ACK acknowledging ISN+1 answers it, every later
 * segment starts at the next expected sequence number (unless it is a `retransmission` or a
 * documented `resync`), and an ACK never acknowledges bytes the peer has not sent.
 */
export function checkTcp(segments: readonly TcpSegment[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const connections = new Map<string, Connection>();

  for (const { path, meta: m } of segments) {
    const key = `${m.srcPort}>${m.dstPort}`;
    const where = `${path}.meta.tcp`;
    const connection = connections.get(m.conn);

    // First segment of the connection.
    if (!connection) {
      const isSyn = m.flags.includes('SYN') && !m.flags.includes('ACK');

      if (!isSyn && !m.resync) {
        issues.push(
          errorIssue(
            'tcp-first-not-syn',
            where,
            `first TCP segment of connection "${m.conn}" must be SYN, got ${describe(m)}`,
          ),
        );
      }

      connections.set(m.conn, {
        client: { key, nextSeq: add32(m.seq, seqLength(m)) },
        clientIsn: isSyn ? m.seq : undefined,
      });
      continue;
    }

    let direction: Direction;
    let peer: Direction | undefined;
    let isHandshakeReply = false;

    if (key === connection.client.key) {
      direction = connection.client;
      peer = connection.server;
    } else if (connection.server === undefined) {
      isHandshakeReply = true;
      direction = { key, nextSeq: add32(m.seq, seqLength(m)) };
      connection.server = direction;
      peer = connection.client;
    } else if (key === connection.server.key) {
      direction = connection.server;
      peer = connection.client;
    } else {
      issues.push(
        errorIssue(
          'tcp-endpoint-mismatch',
          where,
          `segment ${describe(m)} does not match the ports of connection "${m.conn}" (${connection.client.key} and ${connection.server.key})`,
        ),
      );
      continue;
    }

    if (isHandshakeReply) {
      checkHandshakeReply(issues, where, m, connection);
      continue;
    }

    if (!m.retransmission && !m.resync && m.seq !== direction.nextSeq) {
      issues.push(
        errorIssue(
          'tcp-seq-mismatch',
          `${where}.seq`,
          `segment seq does not match the expected next sequence number: ${describe(m)}, expected ${direction.nextSeq}`,
        ),
      );
    }

    if (m.flags.includes('ACK')) {
      if (m.ack === undefined) {
        issues.push(
          errorIssue('tcp-ack-missing', `${where}.ack`, `segment with ACK flag has no ack number`),
        );
      } else if (m.resync && peer) {
        // Omitted segments: trust the ack and move our idea of the peer forward.
        if (seqAfter(m.ack, peer.nextSeq)) peer.nextSeq = m.ack;
      } else if (peer && seqAfter(m.ack, peer.nextSeq)) {
        issues.push(
          errorIssue(
            'tcp-ack-beyond-peer',
            `${where}.ack`,
            `ack ${m.ack} acknowledges bytes the peer has not sent (peer has sent up to ${peer.nextSeq})`,
          ),
        );
      }
    }

    const end = add32(m.seq, seqLength(m));
    if (m.resync || seqAfter(end, direction.nextSeq)) {
      direction.nextSeq = end;
    }
  }

  return issues;
}

function checkHandshakeReply(
  issues: ValidationIssue[],
  where: string,
  m: TcpMeta,
  connection: Connection,
): void {
  if (m.resync) return;

  if (!m.flags.includes('SYN') || !m.flags.includes('ACK')) {
    issues.push(
      errorIssue(
        'tcp-second-not-syn-ack',
        where,
        `second segment of the handshake must be SYN+ACK, got ${describe(m)}`,
      ),
    );
    return;
  }

  const { clientIsn } = connection;
  if (clientIsn === undefined) return;

  const expected = add32(clientIsn, 1);
  if (m.ack !== expected) {
    issues.push(
      errorIssue(
        'tcp-syn-ack-wrong-ack',
        `${where}.ack`,
        `SYN-ACK ack must equal client ISN + 1 (${expected}), got ${String(m.ack)}`,
      ),
    );
  }
}
