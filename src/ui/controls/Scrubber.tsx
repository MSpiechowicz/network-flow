import { memo } from 'react';
import type { ChangeEvent, CSSProperties, KeyboardEvent } from 'react';
import type { CompiledScenario } from '../../engine/compile';
import { usePlayback, usePlaybackDispatch, usePlaybackStore } from '../../engine/store';
import styles from './controls.module.css';
import { formatClock } from './format';

const KEY_STEP_MS = 250;
const KEY_PAGE_MS = 2000;

/** Step boundaries as decorative tick marks. Re-renders only when the scenario changes. */
const StepTicks = memo(function StepTicks({ compiled }: { compiled: CompiledScenario }) {
  const duration = compiled.durationMs;

  return (
    <div className={styles.ticks} aria-hidden="true">
      {compiled.steps.slice(1).map((step) => (
        <i
          key={step.index}
          className={styles.tick}
          style={{ '--at': duration > 0 ? step.startMs / duration : 0 } as CSSProperties}
        />
      ))}
    </div>
  );
});

/**
 * Timeline slider with a tick per step boundary. The only control (with the elapsed readout) that
 * re-renders on every tick. Arrow keys seek ±250 ms, PageUp/PageDown ±2 s, Home/End the ends.
 */
export function Scrubber() {
  const store = usePlaybackStore();
  const dispatch = usePlaybackDispatch();
  const compiled = usePlayback((_s, c) => c);
  const timeMs = usePlayback((s) => s.timeMs);
  const stepIndex = usePlayback((s) => s.stepIndex);

  const duration = compiled.durationMs;
  const step = compiled.steps[stepIndex];
  const valueText = `Step ${String(stepIndex + 1)} of ${String(compiled.steps.length)}, ${step?.def.title ?? ''}`;
  const progress = duration > 0 ? timeMs / duration : 0;

  const seekBy = (deltaMs: number): void => {
    dispatch({ type: 'seek', timeMs: store.getState().timeMs + deltaMs });
  };

  const onChange = (event: ChangeEvent<HTMLInputElement>): void => {
    dispatch({ type: 'seek', timeMs: event.currentTarget.valueAsNumber });
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    const deltas: Record<string, number> = {
      ArrowRight: KEY_STEP_MS,
      ArrowUp: KEY_STEP_MS,
      ArrowLeft: -KEY_STEP_MS,
      ArrowDown: -KEY_STEP_MS,
      PageUp: KEY_PAGE_MS,
      PageDown: -KEY_PAGE_MS,
    };
    const delta = deltas[event.key];

    if (delta !== undefined) {
      event.preventDefault();
      seekBy(delta);
    } else if (event.key === 'Home') {
      event.preventDefault();
      dispatch({ type: 'seek', timeMs: 0 });
    } else if (event.key === 'End') {
      event.preventDefault();
      dispatch({ type: 'seek', timeMs: duration });
    }
  };

  return (
    <div className={styles.scrubber}>
      <div className={styles.track}>
        <input
          type="range"
          className={styles.range}
          aria-label="Timeline"
          aria-valuetext={valueText}
          min={0}
          max={duration}
          step="any"
          value={timeMs}
          style={{ '--progress': progress } as CSSProperties}
          onChange={onChange}
          onKeyDown={onKeyDown}
        />
        <StepTicks compiled={compiled} />
        {/* The visible handle: drawn above the step notches; the native thumb underneath is invisible. */}
        <span
          className={styles.knob}
          style={{ '--progress': progress } as CSSProperties}
          aria-hidden="true"
        />
      </div>
      <span className={styles.clock} aria-hidden="true">
        {formatClock(timeMs)} / {formatClock(duration)}
      </span>
    </div>
  );
}
