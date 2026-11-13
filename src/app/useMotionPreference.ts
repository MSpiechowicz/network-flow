import { useEffect } from 'react';
import type { MotionPref } from '../engine/playback';
import type { PlaybackStore } from '../engine/store';

const STORAGE_KEY = 'nf.motion';
const REDUCE_QUERY = '(prefers-reduced-motion: reduce)';

/** The user's saved choice, or `null` (also when storage is unavailable). */
export function readStoredMotion(): MotionPref | null {
  try {
    const value = window.localStorage.getItem(STORAGE_KEY);

    return value === 'full' || value === 'reduced' ? value : null;
  } catch {
    return null;
  }
}

function storeMotion(pref: MotionPref): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, pref);
  } catch {
    // Storage can be blocked (private mode, policy); the choice then lasts for this visit only.
  }
}

/** The OS-level preference. */
export function systemMotion(): MotionPref {
  return window.matchMedia(REDUCE_QUERY).matches ? 'reduced' : 'full';
}

/** Saved choice if there is one, otherwise `prefers-reduced-motion`. */
export function initialMotion(): MotionPref {
  return readStoredMotion() ?? systemMotion();
}

/**
 * Keeps the motion preference in sync outside the store:
 * - mirrors it on `<html data-motion>` for the reduced-motion CSS in `global.css`;
 * - saves the user's choice in `localStorage["nf.motion"]`;
 * - follows OS changes while the user has no saved choice (those are not saved as a choice).
 */
export function useMotionPreference(store: PlaybackStore): void {
  useEffect(() => {
    let applied = store.getState().motion;
    let systemValue: MotionPref | null = null;

    document.documentElement.dataset.motion = applied;

    const unsubscribe = store.subscribe(() => {
      const next = store.getState().motion;
      if (next === applied) {
        return;
      }

      applied = next;
      document.documentElement.dataset.motion = next;

      // Only user changes are saved; a change we applied from the OS preference is not.
      if (next === systemValue) {
        systemValue = null;
      } else {
        storeMotion(next);
      }
    });

    const query = window.matchMedia(REDUCE_QUERY);
    const onSystemChange = (): void => {
      if (readStoredMotion() !== null) {
        return;
      }

      const next = systemMotion();
      systemValue = next;
      store.dispatch({ type: 'setMotion', motion: next });
    };
    query.addEventListener('change', onSystemChange);

    return () => {
      unsubscribe();
      query.removeEventListener('change', onSystemChange);
    };
  }, [store]);
}
