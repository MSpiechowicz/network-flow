import type { ScenarioDef, StepDef } from '../../model/types';

export interface StepGroup {
  /** Phase label, or `undefined` for steps without a phase. */
  label: string | undefined;
  steps: { step: StepDef; index: number }[];
}

/** Consecutive steps with the same phase, in scenario order. */
export function groupStepsByPhase(scenario: ScenarioDef): StepGroup[] {
  const groups: StepGroup[] = [];
  let currentPhase: string | undefined;

  scenario.steps.forEach((step, index) => {
    const last = groups[groups.length - 1];

    if (last !== undefined && index > 0 && step.phase === currentPhase) {
      last.steps.push({ step, index });

      return;
    }

    currentPhase = step.phase;
    groups.push({
      label: scenario.phases?.find((phase) => phase.id === step.phase)?.label,
      steps: [{ step, index }],
    });
  });

  return groups;
}

/** Short rail label: the first word of the title in capitals, at most four characters. */
export function monogram(title: string): string {
  return (title.split(/\s+/)[0] ?? title)
    .replace(/[^\p{L}\p{N}]/gu, '')
    .slice(0, 5)
    .toUpperCase();
}
