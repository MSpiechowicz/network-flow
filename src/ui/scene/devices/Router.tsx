import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import { boundsOf, boxCorners, boxFrame, dots, segments, shadowCorners, shift } from './iso';
import type { Point } from './iso';
import { EDGE, INK } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const BASE = { w: 0.86, d: 0.58, h: 13 };
const ANTENNA = 30;
const ARC_LIFT = 13;
const ARC_RADII = [6, 11];

const frame = boxFrame(BASE);
const antennaFeet: Point[] = [frame.at(-0.7, -0.7, BASE.h), frame.at(0.7, -0.7, BASE.h)];
// The wifi mark sits between the two antennas, level with their upper half.
const arcCentre: Point = [
  (antennaFeet[0]![0] + antennaFeet[1]![0]) / 2,
  (antennaFeet[0]![1] + antennaFeet[1]![1]) / 2 - ARC_LIFT,
];

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([
  ...boxCorners(BASE),
  ...shadowCorners(56, 21),
  ...antennaFeet.map((p) => shift(p, 0, -ANTENNA - 4)),
  shift(arcCentre, -ARC_RADII[1]!, -ARC_RADII[1]!),
  shift(arcCentre, ARC_RADII[1]!, -ARC_RADII[1]!),
]);

function arc(c: Point, r: number): string {
  const s = Math.sin((50 * Math.PI) / 180) * r;
  const k = Math.cos((50 * Math.PI) / 180) * r;

  return `M${c[0] - s} ${c[1] - k}A${r} ${r} 0 0 1 ${c[0] + s} ${c[1] - k}`;
}

/** Router: low box with two antennas, wifi arcs, status LEDs and LAN ports. 14 elements. */
export function Router({ tint = KIND_TINT.router, active = false }: SpriteProps) {
  const ledGreen = [-0.62, -0.4, -0.18].map((su) => frame.at(su, 1, 6.5));
  const ledAmber = [frame.at(0.04, 1, 6.5)];
  const ports = [-0.6, -0.2, 0.2, 0.6].map(
    (sv) => [frame.at(1, sv - 0.12, 6.5), frame.at(1, sv + 0.12, 6.5)] as const,
  );

  return (
    <g>
      <Shadow rx={56} ry={21} />
      <path
        d={segments(antennaFeet.map((p) => [p, shift(p, 0, -ANTENNA)] as const))}
        style={{ stroke: EDGE, strokeWidth: 2.2, strokeLinecap: 'round' }}
      />
      <path
        d={dots(antennaFeet.map((p) => shift(p, 0, -ANTENNA - 1)))}
        style={{ stroke: tint, strokeWidth: 5.4, strokeLinecap: 'round' }}
      />
      <IsoBox {...BASE} tint={tint} lit={active} />
      <path
        d={segments([[frame.at(-0.8, 0.62, BASE.h), frame.at(0.8, 0.62, BASE.h)]])}
        style={{ stroke: tint, strokeWidth: 1.4, strokeOpacity: 0.7, strokeLinecap: 'round' }}
      />
      <path
        d={segments(
          [-0.2, 0, 0.2].map(
            (sv) => [frame.at(-0.6, sv, BASE.h), frame.at(0.2, sv, BASE.h)] as const,
          ),
        )}
        style={{ stroke: INK, strokeWidth: 1.4, strokeOpacity: 0.8, strokeLinecap: 'round' }}
      />
      <path
        d={dots(ledGreen)}
        style={{ stroke: 'var(--ok)', strokeWidth: 3.6, strokeLinecap: 'round' }}
      />
      <path
        d={dots(ledAmber)}
        style={{ stroke: 'var(--warn)', strokeWidth: 3.6, strokeLinecap: 'round' }}
      />
      <path d={segments(ports)} style={{ stroke: INK, strokeWidth: 5, strokeLinecap: 'butt' }} />
      <path
        d={ARC_RADII.map((r) => arc(arcCentre, r)).join('')}
        style={{
          stroke: tint,
          strokeWidth: 1.8,
          strokeLinecap: 'round',
          fill: 'none',
          strokeOpacity: 0.85,
        }}
      />
      <path
        d={dots([shift(arcCentre, 0, -1)])}
        style={{ stroke: tint, strokeWidth: 3.6, strokeLinecap: 'round' }}
      />
    </g>
  );
}
