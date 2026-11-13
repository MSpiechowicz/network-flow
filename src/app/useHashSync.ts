import { useEffect } from 'react';
import type { PlaybackStore } from '../engine/store';
import { SCENARIOS } from '../scenarios';
import { parseHash, serializeRoute } from './routing';
import type { Route } from './routing';

function currentRoute(store: PlaybackStore): Route {
  const { scenarioId, stepIndex, view } = store.getState();

  return { scenarioId, stepIndex, view };
}

/**
 * Keeps `location.hash` and the playback state in sync.
 * - State to hash: when scenario, step or view change, the hash is rewritten with `replaceState`
 *   (no history entry per step). The first run normalises the hash, e.g. `#/url-journey/1`.
 * - Hash to state: `hashchange` (sidebar link clicks push an entry through their `href`, back/forward,
 *   or an edited URL) dispatches `load` unless the state already is that route.
 */
export function useHashSync(store: PlaybackStore): void {
  useEffect(() => {
    let last = currentRoute(store);

    const writeHash = (): void => {
      const hash = serializeRoute(last);
      if (window.location.hash !== hash) {
        window.history.replaceState(window.history.state, '', hash);
      }
    };

    const onStateChange = (): void => {
      const next = currentRoute(store);
      if (
        next.scenarioId === last.scenarioId &&
        next.stepIndex === last.stepIndex &&
        next.view === last.view
      ) {
        return;
      }

      last = next;
      writeHash();
    };

    const onHashChange = (): void => {
      const route = parseHash(window.location.hash, SCENARIOS);
      const now = currentRoute(store);

      if (
        route.scenarioId !== now.scenarioId ||
        route.stepIndex !== now.stepIndex ||
        route.view !== now.view
      ) {
        store.dispatch({
          type: 'load',
          scenarioId: route.scenarioId,
          stepIndex: route.stepIndex,
          view: route.view,
        });
      }

      // Normalise an invalid or clamped hash.
      last = currentRoute(store);
      writeHash();
    };

    writeHash();
    const unsubscribe = store.subscribe(onStateChange);
    window.addEventListener('hashchange', onHashChange);

    return () => {
      unsubscribe();
      window.removeEventListener('hashchange', onHashChange);
    };
  }, [store]);
}
