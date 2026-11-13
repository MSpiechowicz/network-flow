import type { ScenarioCategory, ScenarioDef, ScenarioId } from '../model/types';
import broadcastFixture from './__fixtures__/broadcast';
import minimalFixture from './__fixtures__/minimal';

/** Sidebar order of the categories. */
export const CATEGORY_ORDER: readonly ScenarioCategory[] = [
  'journey',
  'foundations',
  'network-services',
  'web',
  'email',
];

/** Sidebar heading for each category. */
export const CATEGORY_LABELS: Record<ScenarioCategory, string> = {
  journey: 'Journey',
  foundations: 'Foundations',
  'network-services': 'Network services',
  web: 'Web',
  email: 'Email',
};

/** A scenario together with the module path it was loaded from. */
export interface ScenarioEntry {
  /** Glob key, for example `./data/tcp.ts` (or `./__fixtures__/minimal.ts` for the dev fallback). */
  path: string;
  scenario: ScenarioDef;
}

/**
 * Every `src/scenarios/data/*.ts` default export. Adding a scenario means adding one file there.
 * `import: 'default'` makes the values the scenarios themselves.
 */
const dataModules = import.meta.glob<ScenarioDef>('./data/*.ts', {
  eager: true,
  import: 'default',
});

function collectEntries(): ScenarioEntry[] {
  const entries: ScenarioEntry[] = [];

  for (const [path, scenario] of Object.entries(dataModules)) {
    // A data file without a default export would otherwise show up as a confusing `undefined`.
    if (typeof scenario !== 'object') {
      throw new Error(`${path} must default-export defineScenario({ ... })`);
    }

    entries.push({ path, scenario });
  }

  if (entries.length === 0 && import.meta.env.DEV) {
    // Dev-only fallback so the shell works before any content exists.
    entries.push(
      { path: './__fixtures__/minimal.ts', scenario: minimalFixture },
      { path: './__fixtures__/broadcast.ts', scenario: broadcastFixture },
    );
  }

  return entries.sort((x, y) => {
    const byCategory =
      CATEGORY_ORDER.indexOf(x.scenario.category) - CATEGORY_ORDER.indexOf(y.scenario.category);
    if (byCategory !== 0) {
      return byCategory;
    }

    return x.scenario.order - y.scenario.order || x.scenario.id.localeCompare(y.scenario.id);
  });
}

/** Scenarios with their source paths, in sidebar order. Used by the validator to check file names. */
export const SCENARIO_ENTRIES: readonly ScenarioEntry[] = collectEntries();

/** All registered scenarios, sorted by category (journey, foundations, network-services, web, email), then `order`. */
export const SCENARIOS: readonly ScenarioDef[] = SCENARIO_ENTRIES.map((e) => e.scenario);

/** Returns the scenario with this id, or `undefined`. */
export function getScenario(id: ScenarioId): ScenarioDef | undefined {
  return SCENARIOS.find((s) => s.id === id);
}
