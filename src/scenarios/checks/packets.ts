import type { ScenarioDef } from '../../model/types';
import { errorIssue, warningIssue, type ValidationIssue } from './issue';
import { listPacketRefs, routeOf, type PacketRef } from './refs';
import { isProtocolId } from './structure';
import { buildTopology, type Topology } from './topology';

export const MAX_LABEL_LENGTH = 18;

function checkRoute(ref: PacketRef, topology: Topology, issues: ValidationIssue[]): void {
  const { packet, path } = ref;

  if (!topology.nodeIds.has(packet.from)) {
    issues.push(
      errorIssue(
        'packet-from-unknown',
        `${path}.from`,
        `packet "${packet.id}" has unknown \`from\` node "${packet.from}"`,
      ),
    );
  }

  if (!topology.nodeIds.has(packet.to)) {
    issues.push(
      errorIssue(
        'packet-to-unknown',
        `${path}.to`,
        `packet "${packet.id}" has unknown \`to\` node "${packet.to}"`,
      ),
    );
  }

  (packet.via ?? []).forEach((nodeId, index) => {
    if (!topology.nodeIds.has(nodeId)) {
      issues.push(
        errorIssue(
          'packet-via-unknown',
          `${path}.via[${index}]`,
          `packet "${packet.id}" has unknown \`via\` node "${nodeId}"`,
        ),
      );
    }
  });

  const route = routeOf(packet);

  for (let i = 0; i + 1 < route.length; i++) {
    const a = route[i];
    const b = route[i + 1];

    // A missing node is already reported above; only complain about pairs that both exist.
    if (a === undefined || b === undefined) continue;
    if (!topology.nodeIds.has(a) || !topology.nodeIds.has(b)) continue;

    if (!topology.linkBetween(a, b)) {
      issues.push(
        errorIssue(
          'route-unlinked-hop',
          `${path}.via`,
          `packet "${packet.id}": consecutive route nodes "${a}" and "${b}" are not linked`,
        ),
      );
    }
  }
}

function checkFlood(ref: PacketRef, topology: Topology, issues: ValidationIssue[]): void {
  const { packet, path } = ref;
  const targets = packet.floodTo ?? [];

  if (targets.length > 0 && packet.delivery !== 'broadcast') {
    issues.push(
      errorIssue(
        'flood-without-broadcast',
        `${path}.delivery`,
        `packet "${packet.id}" has floodTo, so it must set delivery "broadcast"`,
      ),
    );
  }

  targets.forEach((target, index) => {
    if (!topology.nodeIds.has(target)) {
      issues.push(
        errorIssue(
          'flood-target-unknown',
          `${path}.floodTo[${index}]`,
          `packet "${packet.id}" floods to unknown node "${target}"`,
        ),
      );
      return;
    }

    if (topology.nodeIds.has(packet.to) && !topology.neighbours(packet.to).has(target)) {
      issues.push(
        errorIssue(
          'flood-target-not-neighbour',
          `${path}.floodTo[${index}]`,
          `packet "${packet.id}": floodTo node "${target}" is not a neighbour of \`to\` "${packet.to}"`,
        ),
      );
    }
  });
}

function checkOutcome(ref: PacketRef, issues: ValidationIssue[]): void {
  const { packet, path } = ref;
  const outcome = packet.outcome;
  const route = routeOf(packet);

  if (outcome?.kind === 'lost') {
    const index = route.indexOf(outcome.afterNode);

    if (index === -1) {
      issues.push(
        errorIssue(
          'outcome-node-off-route',
          `${path}.outcome.afterNode`,
          `packet "${packet.id}": lost outcome node "${outcome.afterNode}" is not on the route`,
        ),
      );
    } else if (index === route.length - 1) {
      issues.push(
        errorIssue(
          'outcome-lost-after-destination',
          `${path}.outcome.afterNode`,
          `packet "${packet.id}": lost outcome afterNode must not be the destination "${packet.to}"`,
        ),
      );
    }
  }

  if (outcome?.kind === 'dropped') {
    const index = route.indexOf(outcome.atNode);

    if (index === -1) {
      issues.push(
        errorIssue(
          'outcome-node-off-route',
          `${path}.outcome.atNode`,
          `packet "${packet.id}": dropped outcome node "${outcome.atNode}" is not on the route`,
        ),
      );
    } else if (index === 0) {
      issues.push(
        errorIssue(
          'outcome-dropped-at-source',
          `${path}.outcome.atNode`,
          `packet "${packet.id}": a packet cannot be dropped at its own source "${packet.from}"`,
        ),
      );
    }
  }
}

function checkProtocols(
  ref: PacketRef,
  declared: ReadonlySet<string>,
  issues: ValidationIssue[],
): void {
  const { packet, path } = ref;

  if (!isProtocolId(packet.protocol)) {
    issues.push(
      errorIssue(
        'protocol-unknown',
        `${path}.protocol`,
        `protocol "${packet.protocol}" is not in the protocol registry`,
      ),
    );
  } else if (!declared.has(packet.protocol)) {
    issues.push(
      warningIssue(
        'protocol-not-declared',
        `${path}.protocol`,
        `packet "${packet.id}" uses protocol "${packet.protocol}", which the scenario's \`protocols\` list omits`,
      ),
    );
  }

  packet.headers.forEach((group, index) => {
    if (!isProtocolId(group.protocol)) {
      issues.push(
        errorIssue(
          'protocol-unknown',
          `${path}.headers[${index}].protocol`,
          `header protocol "${group.protocol}" is not in the protocol registry`,
        ),
      );
    }
  });
}

function checkTimingAndText(ref: PacketRef, issues: ValidationIssue[]): void {
  const { packet, path } = ref;

  if (!(packet.at >= 0)) {
    issues.push(
      errorIssue(
        'packet-at-negative',
        `${path}.at`,
        `packet "${packet.id}": \`at\` must be >= 0 (got ${packet.at})`,
      ),
    );
  }

  if (packet.hopMs !== undefined && !(packet.hopMs > 0)) {
    issues.push(
      errorIssue(
        'timing-invalid',
        `${path}.hopMs`,
        `packet "${packet.id}": hopMs must be > 0 (got ${packet.hopMs})`,
      ),
    );
  }

  if (packet.dwellMs !== undefined && !(packet.dwellMs >= 0)) {
    issues.push(
      errorIssue(
        'timing-invalid',
        `${path}.dwellMs`,
        `packet "${packet.id}": dwellMs must be >= 0 (got ${packet.dwellMs})`,
      ),
    );
  }

  if (packet.label.length > MAX_LABEL_LENGTH) {
    issues.push(
      errorIssue(
        'packet-label-too-long',
        `${path}.label`,
        `packet label "${packet.label}" is longer than ${MAX_LABEL_LENGTH} characters (${packet.label.length})`,
      ),
    );
  }
}

/** `at` order inside each step, and `wireTimeMs` order across the whole scenario. */
function checkOrdering(refs: readonly PacketRef[], issues: ValidationIssue[]): void {
  let previous: PacketRef | undefined;

  for (const ref of refs) {
    if (previous) {
      const sameStep = previous.stepIndex === ref.stepIndex;

      if (sameStep && ref.packet.at < previous.packet.at) {
        issues.push(
          errorIssue(
            'packets-not-sorted-by-at',
            `${ref.path}.at`,
            `packets in a step must be sorted by \`at\`: "${ref.packet.id}" (${ref.packet.at}) comes after "${previous.packet.id}" (${previous.packet.at})`,
          ),
        );
      }

      if (ref.packet.wireTimeMs < previous.packet.wireTimeMs) {
        issues.push(
          errorIssue(
            'wire-time-decreasing',
            `${ref.path}.wireTimeMs`,
            `wireTimeMs must not decrease across the scenario: "${ref.packet.id}" (${ref.packet.wireTimeMs}) comes after "${previous.packet.id}" (${previous.packet.wireTimeMs})`,
          ),
        );
      }
    }

    previous = ref;
  }
}

/** Per-packet rules (route, flood, outcome, registry, text limits) and ordering rules. */
export function checkPackets(def: ScenarioDef): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const topology = buildTopology(def);
  const declared = new Set<string>(def.protocols);
  const refs = listPacketRefs(def);

  for (const ref of refs) {
    checkRoute(ref, topology, issues);
    checkFlood(ref, topology, issues);
    checkOutcome(ref, issues);
    checkProtocols(ref, declared, issues);
    checkTimingAndText(ref, issues);
  }

  checkOrdering(refs, issues);

  return issues;
}
