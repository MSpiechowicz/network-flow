import { describe, expect, it } from 'vitest';
import type { ScenarioDef, StepDef } from '../../model/types';
import { groupStepsByPhase, monogram } from './phaseGroups';

function step(id: string, phase?: string): StepDef {
  return { id, title: id, phase, summary: id, body: [], packets: [] };
}

function scenario(steps: StepDef[]): ScenarioDef {
  return {
    id: 's',
    title: 'S',
    tagline: '',
    category: 'foundations',
    order: 1,
    protocols: [],
    nodes: [],
    links: [],
    phases: [
      { id: 'a', label: 'Phase A' },
      { id: 'b', label: 'Phase B' },
    ],
    steps,
  };
}

describe('groupStepsByPhase', () => {
  it('groups consecutive steps with the same phase and keeps their indices', () => {
    const groups = groupStepsByPhase(
      scenario([step('1', 'a'), step('2', 'a'), step('3', 'b'), step('4', 'a')]),
    );

    expect(groups.map((g) => [g.label, g.steps.map((s) => s.index)])).toEqual([
      ['Phase A', [0, 1]],
      ['Phase B', [2]],
      ['Phase A', [3]],
    ]);
  });

  it('returns one unlabelled group when no step has a phase', () => {
    const groups = groupStepsByPhase(scenario([step('1'), step('2')]));

    expect(groups).toHaveLength(1);
    expect(groups[0]?.label).toBeUndefined();
  });
});

describe('monogram', () => {
  it('uses the first word, upper-cased and shortened', () => {
    expect(monogram('URL journey')).toBe('URL');
    expect(monogram('Email: SMTP, POP3 and IMAP')).toBe('EMAIL');
  });
});
