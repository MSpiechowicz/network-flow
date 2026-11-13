import { describe, expect, it } from 'vitest';
import broadcast from '../scenarios/__fixtures__/broadcast';
import minimal from '../scenarios/__fixtures__/minimal';
import { parseHash, serializeRoute } from './routing';
import type { Route } from './routing';

// minimal has 3 steps, broadcast has 3 steps; minimal sorts first.
const scenarios = [minimal, broadcast];
const FALLBACK: Route = { scenarioId: 'minimal', stepIndex: 0, view: 'network' };

describe('parseHash', () => {
  it('reads scenario, 1-based step and view', () => {
    expect(parseHash('#/broadcast/2?view=sequence', scenarios)).toEqual({
      scenarioId: 'broadcast',
      stepIndex: 1,
      view: 'sequence',
    });
  });

  it('defaults to the network view and accepts a hash without the leading #', () => {
    expect(parseHash('/minimal/3', scenarios)).toEqual({
      scenarioId: 'minimal',
      stepIndex: 2,
      view: 'network',
    });
  });

  it('falls back to the first scenario for an empty or unknown id', () => {
    expect(parseHash('', scenarios)).toEqual(FALLBACK);
    expect(parseHash('#', scenarios)).toEqual(FALLBACK);
    expect(parseHash('#/nope/2?view=sequence', scenarios)).toEqual(FALLBACK);
    expect(parseHash('#/%E0%A4%A/2', scenarios)).toEqual(FALLBACK);
  });

  it('uses step 0 when the step is missing, zero, negative or not a number', () => {
    for (const hash of [
      '#/broadcast',
      '#/broadcast/0',
      '#/broadcast/-3',
      '#/broadcast/abc',
      '#/broadcast/1.5',
    ]) {
      expect(parseHash(hash, scenarios)).toEqual({ ...FALLBACK, scenarioId: 'broadcast' });
    }
  });

  it('clamps a step beyond the end to the last step', () => {
    expect(parseHash('#/minimal/999', scenarios).stepIndex).toBe(2);
  });

  it('treats an unknown view as network', () => {
    expect(parseHash('#/minimal/2?view=3d', scenarios).view).toBe('network');
    expect(parseHash('#/minimal/2?view=', scenarios).view).toBe('network');
  });

  it('ignores extra query parameters and a trailing slash', () => {
    expect(parseHash('#/minimal/2/?x=1&view=sequence', scenarios)).toEqual({
      scenarioId: 'minimal',
      stepIndex: 1,
      view: 'sequence',
    });
  });

  it('does not throw without scenarios', () => {
    expect(parseHash('#/minimal/2', [])).toEqual({ scenarioId: '', stepIndex: 0, view: 'network' });
  });
});

describe('serializeRoute', () => {
  it('writes a 1-based step and omits the view when it is network', () => {
    expect(serializeRoute({ scenarioId: 'tcp', stepIndex: 2, view: 'network' })).toBe('#/tcp/3');
  });

  it('adds ?view=sequence for the sequence view', () => {
    expect(serializeRoute({ scenarioId: 'tcp', stepIndex: 2, view: 'sequence' })).toBe(
      '#/tcp/3?view=sequence',
    );
  });

  it('round-trips every valid route', () => {
    for (const scenario of scenarios) {
      for (let stepIndex = 0; stepIndex < scenario.steps.length; stepIndex++) {
        for (const view of ['network', 'sequence'] as const) {
          const route: Route = { scenarioId: scenario.id, stepIndex, view };

          expect(parseHash(serializeRoute(route), scenarios)).toEqual(route);
        }
      }
    }
  });
});
