/**
 * Scenario validator: structural rules, packet rules and the technical-accuracy checks
 * (addresses, TCP sequence numbers, IPv4 fragments) described in the authoring guardrails.
 *
 * - `validateScenario(def)` checks one scenario in isolation.
 * - `validateScenarioSet(entries)` checks what only the whole set can know: ids against file
 *   names and ids that repeat across files.
 * - `describeIssues(issues)` formats issues for a terminal or a test failure message.
 */
import type { ScenarioDef } from '../model/types';
import { checkAddresses } from './checks/addresses';
import { checkConcurrency } from './checks/concurrency';
import { checkFragments } from './checks/fragments';
import { errorIssue, type ValidationIssue } from './checks/issue';
import { checkPackets } from './checks/packets';
import { listPacketRefs } from './checks/refs';
import { checkStructure } from './checks/structure';
import { checkTcp } from './checks/tcp';
import type { ScenarioEntry } from './index';

export type { IssueSeverity, ValidationCode, ValidationIssue } from './checks/issue';
export { MAX_CONCURRENT_PACKETS } from './checks/concurrency';

/** Every problem in one scenario, errors and warnings, in a stable order. */
export function validateScenario(def: ScenarioDef): ValidationIssue[] {
  const refs = listPacketRefs(def);

  const tcpSegments = refs.flatMap(({ packet, path }) =>
    packet.meta?.tcp ? [{ path, meta: packet.meta.tcp }] : [],
  );
  const ipv4Segments = refs.flatMap(({ packet, path }) =>
    packet.meta?.ipv4 ? [{ path, meta: packet.meta.ipv4 }] : [],
  );

  return [
    ...checkStructure(def),
    ...checkPackets(def),
    ...checkConcurrency(def),
    ...checkAddresses(def),
    ...checkTcp(tcpSegments),
    ...checkFragments(ipv4Segments),
  ];
}

/** The file name without directory or extension: `./data/tcp.ts` gives `tcp`. */
function fileStem(path: string): string {
  const name = path.split('/').pop() ?? path;

  return name.replace(/\.[^.]+$/, '');
}

/**
 * Set-level rules over the registered scenarios: a scenario's `id` must equal its file name,
 * and no two scenarios may share an id. Issue paths are the file paths.
 */
export function validateScenarioSet(entries: readonly ScenarioEntry[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const firstFileById = new Map<string, string>();

  for (const { path, scenario } of entries) {
    const stem = fileStem(path);

    if (scenario.id !== stem) {
      issues.push(
        errorIssue(
          'scenario-id-file-mismatch',
          path,
          `scenario id "${scenario.id}" must equal its file name "${stem}"`,
        ),
      );
    }

    const firstFile = firstFileById.get(scenario.id);
    if (firstFile !== undefined) {
      issues.push(
        errorIssue(
          'scenario-id-duplicate',
          path,
          `scenario id "${scenario.id}" is already used by ${firstFile}`,
        ),
      );
      continue;
    }

    firstFileById.set(scenario.id, path);
  }

  return issues;
}

/**
 * One line per issue: `severity  code  path  message`. Pass `scenarioId` to prefix every line,
 * which keeps output readable when several scenarios are validated in one run.
 */
export function describeIssues(issues: readonly ValidationIssue[], scenarioId?: string): string {
  if (issues.length === 0) {
    return 'no issues';
  }

  const prefix = scenarioId === undefined ? '' : `[${scenarioId}] `;

  return issues
    .map((i) => `${prefix}${i.severity.padEnd(7)} ${i.code}  ${i.path}  ${i.message}`)
    .join('\n');
}
