import { usePlayback, usePlaybackDispatch } from '../../engine/store';
import { Icon } from '../common/Icon';
import type { IconName } from '../common/Icon';
import styles from './controls.module.css';
import { Scrubber } from './Scrubber';
import { SpeedSelect } from './SpeedSelect';

interface PlaybackBarProps {
  onOpenShortcuts: () => void;
}

interface TogglePillProps {
  label: string;
  title: string;
  pressed: boolean;
  onToggle: () => void;
}

function TogglePill({ label, title, pressed, onToggle }: TogglePillProps) {
  return (
    <button
      type="button"
      className={styles.toggle}
      aria-pressed={pressed}
      title={title}
      onClick={onToggle}
    >
      <span className={styles.toggleDot} aria-hidden="true" />
      {label}
    </button>
  );
}

function PlayButton() {
  const dispatch = usePlaybackDispatch();
  const playing = usePlayback((s) => s.playing);
  const atEnd = usePlayback((s, c) => !s.playing && s.timeMs >= c.durationMs);

  let icon: IconName = 'play';
  let label = 'Play';
  if (playing) {
    icon = 'pause';
    label = 'Pause';
  } else if (atEnd) {
    icon = 'replay';
    label = 'Replay';
  }

  return (
    <button
      type="button"
      className={`${styles.button} ${styles.primary}`}
      title={`${label} (Space)`}
      onClick={() => {
        dispatch({ type: 'toggle' });
      }}
    >
      <Icon name={icon} />
      <span className={styles.primaryLabel}>{label}</span>
    </button>
  );
}

/** Previous / play / next, scrubber, speed, the two toggles and the shortcuts button. */
export function PlaybackBar({ onOpenShortcuts }: PlaybackBarProps) {
  const dispatch = usePlaybackDispatch();
  const autoPause = usePlayback((s) => s.autoPauseAtStepEnd);
  const reduced = usePlayback((s) => s.motion === 'reduced');

  return (
    <section className={styles.bar} aria-label="Playback controls">
      <div className={styles.transport}>
        <button
          type="button"
          className={styles.button}
          aria-label="Previous step"
          title="Previous step (←)"
          onClick={() => {
            dispatch({ type: 'prevStep' });
          }}
        >
          <Icon name="prev" />
        </button>
        <PlayButton />
        <button
          type="button"
          className={styles.button}
          aria-label="Next step"
          title="Next step (→)"
          onClick={() => {
            dispatch({ type: 'nextStep' });
          }}
        >
          <Icon name="next" />
        </button>
      </div>

      <Scrubber />

      <div className={styles.options}>
        <SpeedSelect />
        <TogglePill
          label="Pause each step"
          title="Pause at the end of every step"
          pressed={autoPause}
          onToggle={() => {
            dispatch({ type: 'setAutoPause', value: !autoPause });
          }}
        />
        <TogglePill
          label="Reduced motion"
          title="Packets jump between devices instead of gliding"
          pressed={reduced}
          onToggle={() => {
            dispatch({ type: 'setMotion', motion: reduced ? 'full' : 'reduced' });
          }}
        />
        <button
          type="button"
          className={`${styles.button} ${styles.help}`}
          aria-label="Keyboard shortcuts"
          title="Keyboard shortcuts (?)"
          onClick={onOpenShortcuts}
        >
          ?
        </button>
      </div>
    </section>
  );
}
