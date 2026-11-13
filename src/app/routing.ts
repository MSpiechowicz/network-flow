import type { ScenarioDef, ScenarioId } from '../model/types';
import type { ViewMode } from '../engine/playback';

export interface Route {
  scenarioId: ScenarioId;
  /** 0-based (the hash is 1-based). */
  stepIndex: number;
  view: ViewMode;
}

/**
 * Parses `#/<scenarioId>/<step 1-based>?view=network|sequence`. Never throws and always returns a
 * route that exists in `scenarios`:
 * - an unknown scenario id (or an empty hash) gives the first scenario, step 0, network view;
 * - a missing, non-numeric or < 1 step gives step 0, a step beyond the end is clamped to the last;
 * - an unknown `view` gives `network`.
 * With no scenarios at all the route has an empty `scenarioId`.
 */
export function parseHash(hash: string, scenarios: readonly ScenarioDef[]): Route {
  const first = scenarios[0];
  const fallback: Route = { scenarioId: first?.id ?? '', stepIndex: 0, view: 'network' };

  const body = hash.replace(/^#/, '');
  const queryAt = body.indexOf('?');
  const path = queryAt < 0 ? body : body.slice(0, queryAt);
  const query = queryAt < 0 ? '' : body.slice(queryAt + 1);

  const [idPart = '', stepPart = ''] = path.split('/').filter((segment) => segment !== '');
  const scenario = scenarios.find((s) => s.id === safeDecode(idPart));
  if (scenario === undefined) {
    return fallback;
  }

  const view = new URLSearchParams(query).get('view') === 'sequence' ? 'sequence' : 'network';

  return {
    scenarioId: scenario.id,
    stepIndex: parseStep(stepPart, scenario.steps.length),
    view,
  };
}

/** `#/tcp/3?view=sequence`; the view is omitted for `network`. */
export function serializeRoute(r: Route): string {
  const path = `#/${encodeURIComponent(r.scenarioId)}/${r.stepIndex + 1}`;

  return r.view === 'sequence' ? `${path}?view=sequence` : path;
}

function parseStep(text: string, stepCount: number): number {
  if (!/^\d+$/.test(text)) {
    return 0;
  }

  const oneBased = Number(text);

  return Math.min(Math.max(oneBased - 1, 0), Math.max(stepCount - 1, 0));
}

function safeDecode(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}
