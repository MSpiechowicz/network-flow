import type { ChangeEvent } from 'react';
import { SPEEDS } from '../../engine/playback';
import { usePlayback, usePlaybackDispatch } from '../../engine/store';
import styles from './controls.module.css';
import { formatSpeed } from './format';

export function SpeedSelect() {
  const speed = usePlayback((s) => s.speed);
  const dispatch = usePlaybackDispatch();

  const onChange = (event: ChangeEvent<HTMLSelectElement>): void => {
    const next = SPEEDS.find((candidate) => String(candidate) === event.currentTarget.value);

    if (next !== undefined) {
      dispatch({ type: 'setSpeed', speed: next });
    }
  };

  return (
    <label className={styles.speed}>
      <span className={styles.speedLabel}>Speed</span>
      <select value={String(speed)} onChange={onChange} className={styles.select}>
        {SPEEDS.map((candidate) => (
          <option key={candidate} value={String(candidate)}>
            {formatSpeed(candidate)}
          </option>
        ))}
      </select>
    </label>
  );
}
