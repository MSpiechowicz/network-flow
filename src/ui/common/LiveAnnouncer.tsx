import { usePlayback } from '../../engine/store';
import styles from './common.module.css';

/**
 * Polite live region that announces step changes ("Step 3 of 9: SYN-ACK"), never per tick: the
 * selector returns a string, so the component re-renders only when the text changes. The region
 * exists from the first render, so the initial text is not announced.
 */
export function LiveAnnouncer() {
  const message = usePlayback((s, c) => {
    const step = c.steps[s.stepIndex];

    return `${c.def.title}. Step ${s.stepIndex + 1} of ${c.steps.length}: ${step?.def.title ?? ''}`;
  });

  return (
    <div className={styles.visuallyHidden} role="status" aria-live="polite" aria-atomic="true">
      {message}
    </div>
  );
}
