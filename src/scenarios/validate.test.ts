import { describe, expect, it } from 'vitest';
import type { ScenarioDef } from '../model/types';
import broadcast from './__fixtures__/broadcast';
import { BROKEN_SCENARIOS } from './__fixtures__/broken';
import minimal from './__fixtures__/minimal';
import { isSafeReferenceUrl } from './checks/structure';
import { SCENARIOS, SCENARIO_ENTRIES, type ScenarioEntry } from './index';
import {
  describeIssues,
  validateScenario,
  validateScenarioSet,
  type ValidationCode,
  type ValidationIssue,
} from './validate';

function errorsOf(issues: readonly ValidationIssue[]): ValidationIssue[] {
  return issues.filter((i) => i.severity === 'error');
}

/** The error code each deliberately broken scenario must produce. */
const EXPECTED_CODE: Record<string, ValidationCode> = {
  'scenario-id-not-kebab-case': 'scenario-id-not-kebab-case',
  'duplicate-node-id': 'node-id-duplicate',
  'duplicate-link-id': 'link-id-duplicate',
  'duplicate-step-id': 'step-id-duplicate',
  'duplicate-packet-id': 'packet-id-duplicate',
  'duplicate-action-id': 'action-id-duplicate',
  'link-endpoint-missing': 'link-endpoint-missing',
  'self-link': 'link-self',
  'duplicate-link-pair': 'link-duplicate-pair',
  'shared-grid-cell': 'node-shared-cell',
  'unknown-zone': 'node-zone-unknown',
  'unknown-phase': 'step-phase-unknown',
  'sequence-lane-missing': 'sequence-lane-unknown',
  'packet-from-missing': 'packet-from-unknown',
  'packet-to-missing': 'packet-to-unknown',
  'packet-via-missing': 'packet-via-unknown',
  'route-hop-not-linked': 'route-unlinked-hop',
  'flood-target-not-neighbour': 'flood-target-not-neighbour',
  'flood-without-broadcast-delivery': 'flood-without-broadcast',
  'lost-after-node-not-on-route': 'outcome-node-off-route',
  'lost-after-destination': 'outcome-lost-after-destination',
  'dropped-node-not-on-route': 'outcome-node-off-route',
  'unknown-protocol': 'protocol-unknown',
  'negative-at': 'packet-at-negative',
  'packets-not-sorted-by-at': 'packets-not-sorted-by-at',
  'wire-time-decreases': 'wire-time-decreasing',
  'step-summary-empty': 'step-summary-empty',
  'step-title-too-long': 'step-title-too-long',
  'step-summary-too-long': 'step-summary-too-long',
  'packet-label-too-long': 'packet-label-too-long',
  'action-node-missing': 'action-node-unknown',
  'too-many-concurrent-packets': 'concurrent-packets-exceeded',
  'public-ipv4-in-node': 'address-ipv4-outside-documentation',
  'public-ipv4-in-meta': 'address-ipv4-outside-documentation',
  'ipv6-outside-documentation-range': 'address-ipv6-outside-documentation',
  'hostname-not-reserved': 'address-hostname-not-reserved',
  'tcp-first-segment-not-syn': 'tcp-first-not-syn',
  'tcp-second-segment-not-syn-ack': 'tcp-second-not-syn-ack',
  'tcp-synack-wrong-ack': 'tcp-syn-ack-wrong-ack',
  'tcp-seq-mismatch': 'tcp-seq-mismatch',
  'tcp-ack-beyond-peer-seq': 'tcp-ack-beyond-peer',
  'fragment-offset-gap': 'ip-fragment-gap',
  'fragment-length-not-multiple-of-8': 'ip-fragment-length-not-multiple-of-8',
};

describe('registered scenarios', () => {
  it('has at least one scenario to validate', () => {
    expect(SCENARIOS.length).toBeGreaterThan(0);
  });

  // The lasting guard for data-only extension: a new file in data/ is checked automatically.
  it.each(SCENARIOS.map((s) => [s.id, s] as const))(
    '%s has no validation errors',
    (id, scenario) => {
      const errors = errorsOf(validateScenario(scenario));

      expect(errors, describeIssues(errors, id)).toEqual([]);
    },
  );

  it('are consistent as a set (ids match file names and are unique)', () => {
    const issues = validateScenarioSet(SCENARIO_ENTRIES);

    expect(issues, describeIssues(issues)).toEqual([]);
  });
});

describe('fixtures', () => {
  it.each([minimal, broadcast].map((s) => [s.id, s as ScenarioDef] as const))(
    '%s is valid and has no warnings',
    (id, scenario) => {
      const issues = validateScenario(scenario);

      expect(issues, describeIssues(issues, id)).toEqual([]);
    },
  );
});

describe('broken scenarios', () => {
  it('every broken case has an expected error code, and vice versa', () => {
    expect(BROKEN_SCENARIOS.map((c) => c.name).sort()).toEqual(Object.keys(EXPECTED_CODE).sort());
  });

  it.each(BROKEN_SCENARIOS.map((c) => [c.name, c] as const))('%s is detected', (name, broken) => {
    const code = EXPECTED_CODE[name];
    const issues = errorsOf(validateScenario(broken.scenario));

    expect(
      issues.map((i) => i.code),
      `expected ${String(code)} (${broken.expect}); got:\n${describeIssues(issues)}`,
    ).toContain(code);
  });

  it('reports the location and a message for each issue', () => {
    const broken = BROKEN_SCENARIOS.find((c) => c.name === 'route-hop-not-linked');
    const issue = validateScenario(broken?.scenario ?? minimal).find(
      (i) => i.code === 'route-unlinked-hop',
    );

    expect(issue?.severity).toBe('error');
    expect(issue?.path).toBe('steps[0].packets[0].via');
    expect(issue?.message).toContain('"laptop"');
    expect(issue?.message).toContain('"server"');
  });
});

describe('validateScenarioSet', () => {
  function entry(path: string, id: string): ScenarioEntry {
    return { path, scenario: { ...structuredClone(minimal), id } };
  }

  it('accepts ids that equal their file names', () => {
    expect(
      validateScenarioSet([entry('./data/tcp.ts', 'tcp'), entry('./data/udp.ts', 'udp')]),
    ).toEqual([]);
  });

  it('rejects an id that differs from the file name', () => {
    const issues = validateScenarioSet([entry('./data/tcp.ts', 'tcp-basics')]);

    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({
      severity: 'error',
      code: 'scenario-id-file-mismatch',
      path: './data/tcp.ts',
    });
  });

  it('rejects an id used by two files, naming the first file', () => {
    const issues = validateScenarioSet([
      entry('./data/dns.ts', 'dns'),
      entry('./data/dns2.ts', 'dns'),
    ]);

    const duplicate = issues.find((i) => i.code === 'scenario-id-duplicate');
    expect(duplicate?.path).toBe('./data/dns2.ts');
    expect(duplicate?.message).toContain('./data/dns.ts');
  });
});

describe('describeIssues', () => {
  const issue: ValidationIssue = {
    severity: 'error',
    code: 'route-unlinked-hop',
    path: 'steps[1].packets[0].via',
    message: 'not linked',
  };

  it('prints severity, code, path and message on one line per issue', () => {
    const text = describeIssues([
      issue,
      { ...issue, severity: 'warning', code: 'protocol-not-declared' },
    ]);
    const lines = text.split('\n');

    expect(lines).toHaveLength(2);
    expect(lines[0]).toMatch(
      /^error\s+route-unlinked-hop\s+steps\[1\]\.packets\[0\]\.via\s+not linked$/,
    );
    expect(lines[1]).toMatch(/^warning\s+protocol-not-declared/);
  });

  it('prefixes lines with the scenario id when given', () => {
    expect(describeIssues([issue], 'tcp')).toMatch(/^\[tcp\] error/);
  });

  it('says so when there is nothing to report', () => {
    expect(describeIssues([])).toBe('no issues');
  });
});

describe('reference URLs', () => {
  it.each([
    ['https://www.rfc-editor.org/rfc/rfc9293#section-3.5', true],
    ['http://www.rfc-editor.org/rfc/rfc9293', false],
    ['javascript:alert(1)', false],
    ['vscode://file/etc/passwd', false],
    ['https://user:pw@example.com/', false],
    ['not a url', false],
  ])('%s -> %s', (url, ok) => {
    expect(isSafeReferenceUrl(url)).toBe(ok);
  });

  it('reports an unsafe reference in a scenario', () => {
    const base = structuredClone(minimal) as ScenarioDef;
    const first = base.steps[0];
    if (first === undefined) throw new Error('fixture has no steps');
    first.references = [{ label: 'bad', url: 'http://example.com/' }];

    expect(validateScenario(base).map((i) => i.code)).toContain('reference-url-invalid');
  });
});
