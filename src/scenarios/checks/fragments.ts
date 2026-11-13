import type { Ipv4Meta } from '../../model/types';
import { errorIssue, type ValidationIssue } from './issue';

/** One IPv4 header's checked values, with the path of the packet it came from. */
export interface Ipv4Segment {
  path: string;
  meta: Ipv4Meta;
}

const IPV4_HEADER_BYTES = 20;

function isFragment(m: Ipv4Meta): boolean {
  return m.mf === true || (m.fragOffset ?? 0) > 0;
}

/**
 * Checks IPv4 fragments that share an identification value (same source, destination and `id`).
 * Fragments must tile the datagram: offsets (in 8-byte units) are contiguous, every fragment but
 * the last carries a multiple of 8 data bytes and has MF set, the last has MF clear, and, when the
 * unfragmented original is also shown, the data lengths add up to its data length.
 */
export function checkFragments(segments: readonly Ipv4Segment[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const groups = new Map<string, Ipv4Segment[]>();

  for (const segment of segments) {
    const { src, dst, id } = segment.meta;
    if (id === undefined) continue;

    const key = `${src}>${dst}#${id}`;
    groups.set(key, [...(groups.get(key) ?? []), segment]);
  }

  for (const [key, members] of groups) {
    const fragments = members
      .filter((s) => isFragment(s.meta))
      .sort((x, y) => (x.meta.fragOffset ?? 0) - (y.meta.fragOffset ?? 0));
    if (fragments.length === 0) continue;

    checkGroup(issues, key, fragments, members);
  }

  return issues;
}

function checkGroup(
  issues: ValidationIssue[],
  key: string,
  fragments: readonly Ipv4Segment[],
  members: readonly Ipv4Segment[],
): void {
  const missingLength = fragments.filter((f) => f.meta.totalLength === undefined);
  for (const fragment of missingLength) {
    issues.push(
      errorIssue(
        'ip-fragment-length-missing',
        `${fragment.path}.meta.ipv4.totalLength`,
        `fragment of datagram ${key} must set totalLength`,
      ),
    );
  }
  if (missingLength.length > 0) return;

  const dataLength = (f: Ipv4Segment): number => (f.meta.totalLength ?? 0) - IPV4_HEADER_BYTES;
  const last = fragments[fragments.length - 1];
  if (!last) return;

  fragments.forEach((fragment, index) => {
    const isLast = fragment === last;
    const where = `${fragment.path}.meta.ipv4`;

    if (isLast && fragment.meta.mf === true) {
      issues.push(
        errorIssue(
          'ip-fragment-mf-flag',
          `${where}.mf`,
          `the last fragment of datagram ${key} (offset ${fragment.meta.fragOffset ?? 0}) still has MF set, so a fragment is missing`,
        ),
      );
    } else if (!isLast && fragment.meta.mf !== true) {
      issues.push(
        errorIssue(
          'ip-fragment-mf-flag',
          `${where}.mf`,
          `fragment of datagram ${key} at offset ${fragment.meta.fragOffset ?? 0} is followed by more data, so MF must be set`,
        ),
      );
    }

    if (!isLast && dataLength(fragment) % 8 !== 0) {
      issues.push(
        errorIssue(
          'ip-fragment-length-not-multiple-of-8',
          `${where}.totalLength`,
          `data length of a non-last fragment must be a multiple of 8, got ${dataLength(fragment)} (totalLength ${fragment.meta.totalLength ?? 0} - ${IPV4_HEADER_BYTES})`,
        ),
      );
    }

    const expectedOffset = index === 0 ? 0 : expectedNextOffset(fragments[index - 1]);
    const actualOffset = (fragment.meta.fragOffset ?? 0) * 8;
    if (expectedOffset !== undefined && actualOffset !== expectedOffset) {
      issues.push(
        errorIssue(
          'ip-fragment-gap',
          `${where}.fragOffset`,
          `fragment offsets are not contiguous: offset ${fragment.meta.fragOffset ?? 0} (byte ${actualOffset}) should start at byte ${expectedOffset}`,
        ),
      );
    }
  });

  checkAgainstOriginal(issues, key, fragments, members, last, dataLength);
}

function expectedNextOffset(previous: Ipv4Segment | undefined): number | undefined {
  if (!previous) return undefined;

  const data = (previous.meta.totalLength ?? 0) - IPV4_HEADER_BYTES;

  return (previous.meta.fragOffset ?? 0) * 8 + data;
}

function checkAgainstOriginal(
  issues: ValidationIssue[],
  key: string,
  fragments: readonly Ipv4Segment[],
  members: readonly Ipv4Segment[],
  last: Ipv4Segment,
  dataLength: (f: Ipv4Segment) => number,
): void {
  const original = members.find((s) => !isFragment(s.meta) && s.meta.totalLength !== undefined);
  if (!original || original.meta.totalLength === undefined) return;

  const total = (last.meta.fragOffset ?? 0) * 8 + dataLength(last);
  const expected = original.meta.totalLength - IPV4_HEADER_BYTES;

  if (total !== expected) {
    issues.push(
      errorIssue(
        'ip-fragment-total-mismatch',
        `${last.path}.meta.ipv4.totalLength`,
        `fragments of datagram ${key} carry ${total} data bytes in total (${fragments.length} fragments), but the original has ${expected}`,
      ),
    );
  }
}
