import { Shadow } from './Shadow';
import { CLOUD_GRADIENT_ID, urlRef } from './ids';
import { boundsOf, shadowCorners } from './iso';
import type { Point } from './iso';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

/** Puffs as [x, y, radius] around the cloud centre. */
const PUFFS: readonly [number, number, number][] = [
  [-30, 6, 18],
  [-8, -8, 25],
  [20, -1, 21],
  [38, 9, 14],
  [2, 10, 17],
];
const RIM = 1.4;
/** The cloud hovers over a hub disc; links end at the disc, not under a floating cloud. */
const SCALE = 0.82;
const CENTRE_Y = -72;
const HUB = { rx: 50, ry: 25, h: 8 };
const POOL = { rx: 36, ry: 18 };

const puffCorners: Point[] = PUFFS.flatMap(([x, y, r]): Point[] => [
  [(x - r - RIM) * SCALE, CENTRE_Y + y * SCALE],
  [(x + r + RIM) * SCALE, CENTRE_Y + y * SCALE],
  [x * SCALE, CENTRE_Y + (y - r - RIM) * SCALE],
  [x * SCALE, CENTRE_Y + (y + r + RIM) * SCALE],
]);

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([...puffCorners, ...shadowCorners(58, 26)]);

/** Internet cloud on a hub: a disc with a glowing pool where the links meet, a faint beam and the cloud hovering above. 20 elements. */
export function Cloud({ tint = KIND_TINT.cloud, active = false }: SpriteProps) {
  const rim = active ? tint : '#8793b8';
  const globe = { cx: 1, cy: CENTRE_Y - 1 };
  const top = -HUB.h;

  return (
    <g>
      <Shadow rx={58} ry={24} />
      <path
        d={`M${-HUB.rx} 0v${top}a${HUB.rx} ${HUB.ry} 0 0 1 ${2 * HUB.rx} 0v${HUB.h}a${HUB.rx} ${HUB.ry} 0 0 1 ${-2 * HUB.rx} 0z`}
        style={{ fill: 'var(--face-left)', stroke: 'var(--face-stroke)' }}
      />
      <ellipse
        cy={top}
        rx={HUB.rx}
        ry={HUB.ry}
        style={{ fill: 'var(--face-top)', stroke: 'var(--face-stroke)' }}
      />
      <ellipse
        cy={top}
        rx={POOL.rx}
        ry={POOL.ry}
        style={{ fill: tint, fillOpacity: active ? 0.34 : 0.2, stroke: tint, strokeOpacity: 0.85 }}
      />
      <ellipse
        cy={top}
        rx={POOL.rx / 2}
        ry={POOL.ry / 2}
        style={{ fill: tint, fillOpacity: 0.3 }}
      />
      <path
        // The beam starts inside the cloud (drawn underneath it), so it always meets the cloud's underside.
        d={`M-22 ${top}L-12 ${CENTRE_Y + 4}H12L22 ${top}Z`}
        style={{ fill: tint, fillOpacity: active ? 0.2 : 0.11 }}
      />
      {PUFFS.map(([x, y, r]) => (
        <circle
          key={`rim-${x}`}
          cx={x * SCALE}
          cy={CENTRE_Y + y * SCALE}
          r={(r + RIM) * SCALE}
          style={{ fill: rim }}
        />
      ))}
      {PUFFS.map(([x, y, r]) => (
        <circle
          key={`fill-${x}`}
          cx={x * SCALE}
          cy={CENTRE_Y + y * SCALE}
          r={r * SCALE}
          style={{ fill: urlRef(CLOUD_GRADIENT_ID) }}
        />
      ))}
      {/* Globe: outline, a meridian, the equator and two parallels, centred on the cloud's body. */}
      <g
        transform={`translate(${globe.cx} ${globe.cy})`}
        style={{
          stroke: tint,
          strokeWidth: 1.5,
          strokeLinecap: 'round',
          fill: 'none',
          strokeOpacity: 0.95,
        }}
      >
        <circle r={10.5} style={{ fill: 'var(--panel)', fillOpacity: 0.35 }} />
        <ellipse rx={4.6} ry={10.5} />
        <path d="M-10.5 0h21M-9.1 -5.2h18.2M-9.1 5.2h18.2" />
      </g>
    </g>
  );
}
