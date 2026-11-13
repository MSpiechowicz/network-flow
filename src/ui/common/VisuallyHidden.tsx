import type { ReactNode } from 'react';
import styles from './common.module.css';

/** Text for assistive technology only. */
export function VisuallyHidden({ children }: { children: ReactNode }) {
  return <span className={styles.visuallyHidden}>{children}</span>;
}
