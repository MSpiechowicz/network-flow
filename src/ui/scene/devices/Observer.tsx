import { Shadow } from './Shadow';
import { boundsOf, shadowCorners } from './iso';
import { INK } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const HEAD_Y = -60;

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([[-30, 0], [36, -90], [-20, -78], ...shadowCorners(36, 14)]);

function wave(r: number): string {
  const rad = (a: number) => (a * Math.PI) / 180;

  return `M${r * Math.cos(rad(-55))} ${HEAD_Y + 2 + r * Math.sin(rad(-55))}A${r} ${r} 0 0 1 ${r * Math.cos(rad(30))} ${HEAD_Y + 2 + r * Math.sin(rad(30))}`;
}

/** Eavesdropper: a hooded figure on a spot plate, glowing eyes, listening waves. 9 elements. */
export function Observer({ tint = KIND_TINT.observer, active = false }: SpriteProps) {
  return (
    <g>
      <Shadow rx={36} ry={14} />
      <ellipse
        cx={0}
        cy={0}
        rx={30}
        ry={14}
        style={{
          fill: 'var(--face-right)',
          stroke: active ? tint : 'var(--face-stroke)',
          strokeWidth: 1,
        }}
      />
      <ellipse
        cx={0}
        cy={0}
        rx={20}
        ry={9}
        style={{ fill: 'none', stroke: tint, strokeOpacity: 0.55, strokeWidth: 1 }}
      />
      <path
        d="M0 -50C-7 -50 -14 -42 -17 -30C-21 -17 -23 -8 -26 -2C-16 4 -8 5 0 5Z"
        style={{ fill: 'var(--face-left)', stroke: 'var(--face-stroke)', strokeLinejoin: 'round' }}
      />
      <path
        d="M0 -50C7 -50 14 -42 17 -30C21 -17 23 -8 26 -2C16 4 8 5 0 5Z"
        style={{ fill: 'var(--face-right)', stroke: 'var(--face-stroke)', strokeLinejoin: 'round' }}
      />
      <path
        d="M0 -76C-11 -76 -17 -68 -17 -59C-17 -51 -12 -44 -6 -41L0 -38L6 -41C12 -44 17 -51 17 -59C17 -68 11 -76 0 -76Z"
        style={{ fill: 'var(--face-top)', stroke: 'var(--face-stroke)', strokeLinejoin: 'round' }}
      />
      <path
        d="M0 -67C-8 -67 -12 -62 -12 -57C-12 -52 -8 -49 0 -49C8 -49 12 -52 12 -57C12 -62 8 -67 0 -67Z"
        style={{ fill: INK }}
      />
      <path
        d={`M-5.5 ${HEAD_Y + 3}h0M5.5 ${HEAD_Y + 3}h0`}
        style={{ stroke: tint, strokeWidth: 4, strokeLinecap: 'round' }}
      />
      <path
        d={[wave(27), wave(35)].join('')}
        style={{
          stroke: tint,
          strokeWidth: 1.6,
          strokeLinecap: 'round',
          fill: 'none',
          strokeOpacity: 0.8,
        }}
      />
    </g>
  );
}
