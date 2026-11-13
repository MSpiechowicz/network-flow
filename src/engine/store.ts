import { createContext, createElement, useContext, useRef, useSyncExternalStore } from 'react';
import type { FC, ReactNode } from 'react';
import type { ScenarioDef, ScenarioId } from '../model/types';
import { compileScenario } from './compile';
import type { CompiledScenario } from './compile';
import { initialPlaybackState, reducePlayback } from './playback';
import type { MotionPref, PlaybackAction, PlaybackState, ViewMode } from './playback';

/**
 * Members are function-typed properties (not methods) so they can be passed around unbound, for example
 * `useSyncExternalStore(store.subscribe, ...)`; call sites are unchanged.
 */
export interface PlaybackStore {
  getState: () => PlaybackState;
  /** The compiled scenario of the current state. */
  getCompiled: () => CompiledScenario;
  dispatch: (a: PlaybackAction) => void;
  subscribe: (l: () => void) => () => void;
}

/**
 * Creates the store. Scenarios are compiled lazily on first use and cached. An unknown `scenarioId`
 * (initially or in a `load` action) falls back to the first scenario, so the state is always valid.
 * Listeners are notified only when the state object actually changes.
 */
export function createPlaybackStore(
  scenarios: readonly ScenarioDef[],
  initial: {
    scenarioId: ScenarioId;
    stepIndex?: number;
    view?: ViewMode;
    motion: MotionPref;
  },
): PlaybackStore {
  const first = scenarios[0];
  if (first === undefined) {
    throw new Error('createPlaybackStore needs at least one scenario');
  }

  const defs = new Map<ScenarioId, ScenarioDef>(scenarios.map((s) => [s.id, s]));
  const compiled = new Map<ScenarioId, CompiledScenario>();

  const resolveId = (id: ScenarioId): ScenarioId => (defs.has(id) ? id : first.id);

  const ctx = {
    getCompiled(id: ScenarioId): CompiledScenario {
      const known = compiled.get(id);
      if (known !== undefined) {
        return known;
      }

      const def = defs.get(id);
      if (def === undefined) {
        throw new Error(`Unknown scenario "${id}"`);
      }

      const fresh = compileScenario(def);
      compiled.set(id, fresh);

      return fresh;
    },
  };

  const listeners = new Set<() => void>();

  let state = initialPlaybackState(ctx, resolveId(initial.scenarioId), {
    stepIndex: initial.stepIndex,
    view: initial.view,
    motion: initial.motion,
  });

  return {
    getState: () => state,

    getCompiled: () => ctx.getCompiled(state.scenarioId),

    dispatch(action) {
      const resolved: PlaybackAction =
        action.type === 'load' ? { ...action, scenarioId: resolveId(action.scenarioId) } : action;
      const next = reducePlayback(state, resolved, ctx);

      if (next === state) {
        return;
      }

      state = next;
      for (const listener of [...listeners]) {
        listener();
      }
    },

    subscribe(listener) {
      listeners.add(listener);

      return () => {
        listeners.delete(listener);
      };
    },
  };
}

const PlaybackContext = createContext<PlaybackStore | null>(null);

export const PlaybackProvider: FC<{ store: PlaybackStore; children: ReactNode }> = ({
  store,
  children,
}) => createElement(PlaybackContext.Provider, { value: store }, children);

/** The store from the nearest `PlaybackProvider` (for code that needs `getState` imperatively). */
export function usePlaybackStore(): PlaybackStore {
  const store = useContext(PlaybackContext);
  if (store === null) {
    throw new Error('usePlayback must be used inside <PlaybackProvider>');
  }

  return store;
}

interface SnapshotCache<T> {
  state: PlaybackState;
  compiled: CompiledScenario;
  selector: unknown;
  value: T;
}

/**
 * Subscribes to a slice of the playback state. The component re-renders only when the selected value
 * changes by `isEqual` (default `Object.is`), so selectors that build arrays or objects must pass an
 * `isEqual`. The selector may be an inline function.
 */
export function usePlayback<T>(
  selector: (s: PlaybackState, c: CompiledScenario) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const store = usePlaybackStore();
  // Memo for `getSnapshot`; only touched there (React calls it, not render), and only ever replaced
  // by an equivalent value.
  const memoRef = useRef<SnapshotCache<T> | null>(null);

  const getSnapshot = (): T => {
    const state = store.getState();
    const compiled = store.getCompiled();
    const cached = memoRef.current;

    if (
      cached !== null &&
      cached.state === state &&
      cached.compiled === compiled &&
      cached.selector === selector
    ) {
      return cached.value;
    }

    const next = selector(state, compiled);
    const value = cached !== null && isEqual(cached.value, next) ? cached.value : next;
    memoRef.current = { state, compiled, selector, value };

    return value;
  };

  return useSyncExternalStore(store.subscribe, getSnapshot, getSnapshot);
}

/** Stable dispatch function; never causes a re-render. */
export function usePlaybackDispatch(): (a: PlaybackAction) => void {
  return usePlaybackStore().dispatch;
}
