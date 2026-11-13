import type { ReactNode } from 'react';
import type { NodeActionKind } from '../../model/types';

/** Hue of an action's ring and chip. Local actions are not protocols, so they use state colours. */
export const ACTION_TINT: Record<NodeActionKind, string> = {
  process: 'var(--accent)',
  'cache-lookup': 'var(--info)',
  'cache-hit': 'var(--ok)',
  'cache-miss': 'var(--warn)',
  store: 'var(--info)',
  verify: 'var(--ok)',
  encrypt: 'var(--proto-tls)',
  decrypt: 'var(--proto-tls)',
  render: 'var(--accent)',
};

/** 12px glyphs centred on the origin. */
export const ACTION_ICON: Record<NodeActionKind, ReactNode> = {
  process: (
    <>
      <circle r={2.4} />
      <path d="M0-5.6V-3.6M0 3.6V5.6M-5.6 0H-3.6M3.6 0H5.6M-4-4L-2.6-2.6M2.6 2.6L4 4M4-4L2.6-2.6M-2.6 2.6L-4 4" />
    </>
  ),
  'cache-lookup': (
    <>
      <circle cx={-1} cy={-1} r={3.6} />
      <path d="M1.8 1.8L5 5" />
    </>
  ),
  'cache-hit': <path d="M-4.5 0.5L-1.5 3.5L4.5-3.5" />,
  'cache-miss': <path d="M-3.8-3.8L3.8 3.8M3.8-3.8L-3.8 3.8" />,
  store: (
    <>
      <ellipse cx={0} cy={-3.2} rx={4.6} ry={1.8} />
      <path d="M-4.6-3.2V3.2C-4.6 4.4-2.6 5-0 5S4.6 4.4 4.6 3.2V-3.2" />
    </>
  ),
  verify: (
    <>
      <path d="M0-5.6L4.8-3.8V0C4.8 3 2.8 4.6 0 5.8-2.8 4.6-4.8 3-4.8 0V-3.8Z" />
      <path d="M-2 0.2L-0.5 1.8L2.2-1.4" />
    </>
  ),
  encrypt: (
    <>
      <rect x={-4} y={-1} width={8} height={6} rx={1} />
      <path d="M-2.4-1V-2.6a2.4 2.4 0 0 1 4.8 0V-1" />
    </>
  ),
  decrypt: (
    <>
      <rect x={-4} y={-1} width={8} height={6} rx={1} />
      <path d="M-2.4-1V-2.6a2.4 2.4 0 0 1 4.8 0" />
    </>
  ),
  render: (
    <>
      <rect x={-5} y={-4.5} width={10} height={9} rx={1.4} />
      <path d="M-5-1.5H5" />
    </>
  ),
};
