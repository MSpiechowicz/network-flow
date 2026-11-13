import type { ScenarioDef } from '../../model/types';
import { NODE_KINDS } from '../../protocols/nodeKinds';
import { PROTOCOLS } from '../../protocols/registry';
import { errorIssue, type ValidationCode, type ValidationIssue } from './issue';
import { buildTopology } from './topology';

export const MAX_TITLE_LENGTH = 48;
export const MAX_SUMMARY_LENGTH = 200;

const KEBAB_CASE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export function isProtocolId(id: string): boolean {
  return Object.hasOwn(PROTOCOLS, id);
}

function isNodeKind(kind: string): boolean {
  return Object.hasOwn(NODE_KINDS, kind);
}

/** Reports every item whose id was already used by an earlier item. */
function checkUnique(
  issues: ValidationIssue[],
  items: readonly { id: string }[],
  pathOf: (index: number) => string,
  code: ValidationCode,
  what: string,
): void {
  const seen = new Set<string>();

  items.forEach((item, index) => {
    if (seen.has(item.id)) {
      issues.push(errorIssue(code, `${pathOf(index)}.id`, `duplicate ${what} id "${item.id}"`));
    }

    seen.add(item.id);
  });
}

function checkIdentity(def: ScenarioDef, issues: ValidationIssue[]): void {
  if (!KEBAB_CASE.test(def.id)) {
    issues.push(
      errorIssue(
        'scenario-id-not-kebab-case',
        'id',
        `scenario id "${def.id}" must be kebab-case (lower-case letters, digits and single dashes)`,
      ),
    );
  }

  checkUnique(issues, def.nodes, (i) => `nodes[${i}]`, 'node-id-duplicate', 'node');
  checkUnique(issues, def.links, (i) => `links[${i}]`, 'link-id-duplicate', 'link');
  checkUnique(issues, def.zones ?? [], (i) => `zones[${i}]`, 'zone-id-duplicate', 'zone');
  checkUnique(issues, def.phases ?? [], (i) => `phases[${i}]`, 'phase-id-duplicate', 'phase');
  checkUnique(issues, def.steps, (i) => `steps[${i}]`, 'step-id-duplicate', 'step');

  const packets = def.steps.flatMap((step, s) =>
    step.packets.map((packet, p) => ({ id: packet.id, path: `steps[${s}].packets[${p}]` })),
  );
  checkUnique(issues, packets, (i) => packets[i]?.path ?? '', 'packet-id-duplicate', 'packet');

  const actions = def.steps.flatMap((step, s) =>
    (step.actions ?? []).map((action, a) => ({ id: action.id, path: `steps[${s}].actions[${a}]` })),
  );
  checkUnique(issues, actions, (i) => actions[i]?.path ?? '', 'action-id-duplicate', 'action');
}

function checkRegistries(def: ScenarioDef, issues: ValidationIssue[]): void {
  def.protocols.forEach((protocol, index) => {
    if (!isProtocolId(protocol)) {
      issues.push(
        errorIssue(
          'protocol-unknown',
          `protocols[${index}]`,
          `protocol "${protocol}" is not in the protocol registry`,
        ),
      );
    }
  });

  def.nodes.forEach((node, index) => {
    if (!isNodeKind(node.kind)) {
      issues.push(
        errorIssue(
          'node-kind-unknown',
          `nodes[${index}].kind`,
          `node kind "${node.kind}" is not in the node-kind registry`,
        ),
      );
    }
  });
}

function checkNodesAndLinks(def: ScenarioDef, issues: ValidationIssue[]): void {
  const nodeIds = new Set(def.nodes.map((n) => n.id));
  const zoneIds = new Set((def.zones ?? []).map((z) => z.id));

  def.nodes.forEach((node, index) => {
    if (node.zone !== undefined && !zoneIds.has(node.zone)) {
      issues.push(
        errorIssue(
          'node-zone-unknown',
          `nodes[${index}].zone`,
          `node "${node.id}" references unknown zone "${node.zone}"`,
        ),
      );
    }
  });

  const cells = new Map<string, string>();
  def.nodes.forEach((node, index) => {
    const cell = `${node.position.col},${node.position.row}`;
    const occupant = cells.get(cell);

    if (occupant !== undefined) {
      issues.push(
        errorIssue(
          'node-shared-cell',
          `nodes[${index}].position`,
          `nodes "${occupant}" and "${node.id}" occupy the same grid cell (${cell})`,
        ),
      );
      return;
    }

    cells.set(cell, node.id);
  });

  const pairs = new Map<string, string>();
  def.links.forEach((link, index) => {
    const endpointsExist = [
      ['a', link.a],
      ['b', link.b],
    ] as const;

    let valid = true;
    for (const [side, endpoint] of endpointsExist) {
      if (!nodeIds.has(endpoint)) {
        valid = false;
        issues.push(
          errorIssue(
            'link-endpoint-missing',
            `links[${index}].${side}`,
            `link "${link.id}" references unknown node "${endpoint}"`,
          ),
        );
      }
    }

    if (link.a === link.b) {
      valid = false;
      issues.push(
        errorIssue(
          'link-self',
          `links[${index}]`,
          `link "${link.id}" connects node "${link.a}" to itself`,
        ),
      );
    }

    if (!valid) {
      return;
    }

    const key = [link.a, link.b].sort().join('\u0000');
    const first = pairs.get(key);

    if (first !== undefined) {
      issues.push(
        errorIssue(
          'link-duplicate-pair',
          `links[${index}]`,
          `more than one link between "${link.a}" and "${link.b}" ("${first}" and "${link.id}")`,
        ),
      );
      return;
    }

    pairs.set(key, link.id);
  });
}

function checkSteps(def: ScenarioDef, issues: ValidationIssue[]): void {
  const nodeIds = buildTopology(def).nodeIds;
  const phaseIds = new Set((def.phases ?? []).map((p) => p.id));

  def.steps.forEach((step, s) => {
    const path = `steps[${s}]`;

    if (step.title.trim() === '') {
      issues.push(
        errorIssue('step-title-empty', `${path}.title`, `step "${step.id}" has no title`),
      );
    } else if (step.title.length > MAX_TITLE_LENGTH) {
      issues.push(
        errorIssue(
          'step-title-too-long',
          `${path}.title`,
          `step title is longer than ${MAX_TITLE_LENGTH} characters (${step.title.length})`,
        ),
      );
    }

    if (step.summary.trim() === '') {
      issues.push(
        errorIssue('step-summary-empty', `${path}.summary`, `step "${step.id}" has no summary`),
      );
    } else if (step.summary.length > MAX_SUMMARY_LENGTH) {
      issues.push(
        errorIssue(
          'step-summary-too-long',
          `${path}.summary`,
          `step summary is longer than ${MAX_SUMMARY_LENGTH} characters (${step.summary.length})`,
        ),
      );
    }

    (step.references ?? []).forEach((reference, r) => {
      if (!isSafeReferenceUrl(reference.url)) {
        issues.push(
          errorIssue(
            'reference-url-invalid',
            `${path}.references[${String(r)}].url`,
            `reference URL must be an absolute https:// link (${reference.url})`,
          ),
        );
      }
    });

    if (step.phase !== undefined && !phaseIds.has(step.phase)) {
      issues.push(
        errorIssue(
          'step-phase-unknown',
          `${path}.phase`,
          `step "${step.id}" references unknown phase "${step.phase}"`,
        ),
      );
    }

    (step.focus ?? []).forEach((nodeId, f) => {
      if (!nodeIds.has(nodeId)) {
        issues.push(
          errorIssue(
            'step-focus-unknown',
            `${path}.focus[${f}]`,
            `step "${step.id}" focuses unknown node "${nodeId}"`,
          ),
        );
      }
    });

    (step.actions ?? []).forEach((action, a) => {
      const actionPath = `${path}.actions[${a}]`;

      if (!nodeIds.has(action.node)) {
        issues.push(
          errorIssue(
            'action-node-unknown',
            `${actionPath}.node`,
            `action "${action.id}" references unknown node "${action.node}"`,
          ),
        );
      }

      if (!(action.at >= 0) || !(action.durationMs > 0)) {
        issues.push(
          errorIssue(
            'timing-invalid',
            actionPath,
            `action "${action.id}" needs at >= 0 and durationMs > 0 (got at=${action.at}, durationMs=${action.durationMs})`,
          ),
        );
      }
    });
  });

  (def.sequenceLanes ?? []).forEach((nodeId, index) => {
    if (!nodeIds.has(nodeId)) {
      issues.push(
        errorIssue(
          'sequence-lane-unknown',
          `sequenceLanes[${index}]`,
          `sequenceLanes references unknown node "${nodeId}"`,
        ),
      );
    }
  });
}

/** Identity, registry, topology and step-level rules that do not involve packets. */
export function checkStructure(def: ScenarioDef): ValidationIssue[] {
  const issues: ValidationIssue[] = [];

  checkIdentity(def, issues);
  checkRegistries(def, issues);
  checkNodesAndLinks(def, issues);
  checkSteps(def, issues);

  return issues;
}

/** References are rendered as links, so only plain `https:` URLs without credentials are allowed. */
export function isSafeReferenceUrl(url: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '';
}
