import { useEffect } from 'react';
import type { PlaybackStore } from './store';

/** Longest frame delta fed to the engine, so a stalled frame or tab switch cannot jump ahead. */
export const MAX_TICK_MS = 100;

/**
 * Drives the engine clock: a requestAnimationFrame loop that dispatches `tick(dt)` with `dt` capped
 * at 100 ms. The loop runs only while the store is playing and the document is visible; it is stopped
 * when paused, when the tab is hidden, and on unmount.
 */
export function useClock(store: PlaybackStore): void {
  useEffect(() => {
    let frame = 0;
    let lastFrameAt = 0;

    const shouldRun = (): boolean => store.getState().playing && !document.hidden;

    const loop = (now: number): void => {
      const dt = Math.min(Math.max(now - lastFrameAt, 0), MAX_TICK_MS);
      lastFrameAt = now;

      // Subscribers may react to this tick (for example by pausing); `frame` stays non-zero while we
      // are inside the callback so they do not schedule a second loop.
      store.dispatch({ type: 'tick', deltaMs: dt });

      frame = shouldRun() ? requestAnimationFrame(loop) : 0;
    };

    const sync = (): void => {
      if (shouldRun()) {
        if (frame === 0) {
          lastFrameAt = performance.now();
          frame = requestAnimationFrame(loop);
        }
      } else if (frame !== 0) {
        cancelAnimationFrame(frame);
        frame = 0;
      }
    };

    const unsubscribe = store.subscribe(sync);
    document.addEventListener('visibilitychange', sync);
    sync();

    return () => {
      unsubscribe();
      document.removeEventListener('visibilitychange', sync);
      cancelAnimationFrame(frame);
      frame = 0;
    };
  }, [store]);
}
