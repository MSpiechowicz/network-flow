import type { ReactNode } from 'react';
import styles from './common.module.css';

export type IconName =
  | 'play'
  | 'pause'
  | 'prev'
  | 'next'
  | 'replay'
  | 'chevron'
  | 'menu'
  | 'close'
  | 'lock'
  | 'external'
  | 'shield';

const STROKE = {
  fill: 'none',
  stroke: 'currentColor',
  strokeWidth: 1.6,
  strokeLinecap: 'round',
  strokeLinejoin: 'round',
} as const;

const GLYPHS: Record<IconName, ReactNode> = {
  play: <path d="M5 3l8 5-8 5z" fill="currentColor" />,
  pause: <path d="M4 3h3v10H4zM9 3h3v10H9z" fill="currentColor" />,
  prev: <path d="M3 2.5h2v11H3zM13.5 2.5v11L6 8z" fill="currentColor" />,
  next: <path d="M11 2.5h2v11h-2zM2.5 2.5v11L10 8z" fill="currentColor" />,
  replay: <path d="M13 8a5 5 0 1 1-1.6-3.7M13 2.5v3h-3" {...STROKE} />,
  chevron: <path d="M5.5 3l5 5-5 5" {...STROKE} />,
  menu: <path d="M2.5 4h11M2.5 8h11M2.5 12h11" {...STROKE} />,
  close: <path d="M3.5 3.5l9 9M12.5 3.5l-9 9" {...STROKE} />,
  lock: <path d="M4 7.2h8v6.3H4zM5.6 7.2V5.2a2.4 2.4 0 0 1 4.8 0v2" {...STROKE} />,
  external: <path d="M9 2.5h4.5V7M13.5 2.5L7 9M11.5 9.5V13H3V4.5h3.5" {...STROKE} />,
  shield: <path d="M8 2l5 1.8v4.2c0 3-2.2 4.8-5 6-2.8-1.2-5-3-5-6V3.8z" {...STROKE} />,
};

/** Decorative 16px glyph; always hidden from assistive technology (the caller labels the control). */
export function Icon({ name, size = 16 }: { name: IconName; size?: number }) {
  return (
    <svg
      className={styles.icon}
      width={size}
      height={size}
      viewBox="0 0 16 16"
      aria-hidden="true"
      focusable="false"
    >
      {GLYPHS[name]}
    </svg>
  );
}
