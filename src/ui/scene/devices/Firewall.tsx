import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import { boundsOf, boxCorners, boxFrame, polyPoints, segments, shadowCorners, shift } from './iso';
import type { Point } from './iso';
import { INK } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const PLINTH = { w: 1.12, d: 0.42, h: 4 };
const WALL = { w: 1.0, d: 0.3, h: 36, z: PLINTH.h };
const COURSES = 4;
const FLAME_SCALE = 0.85;
const FLAME_LIFT = 4;
const FLAME_TOP = 36;

const FLAME =
  'M0 -34C4 -24 14 -18 14 -6C14 3 8 8 0 8C-8 8 -14 3 -14 -6C-14 -14 -8 -18 -6 -26C-3 -22 -2 -19 -1 -14C2 -20 1 -28 0 -34Z';
const FLAME_CORE = 'M0 -14C3 -9 7 -6 7 -1C7 3 4 5 0 5C-4 5 -7 3 -7 -1C-7 -5 -3 -8 0 -14Z';

const wall = boxFrame(WALL);
const flameBase: Point = wall.at(0, 0, WALL.h + FLAME_LIFT);

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([
  ...boxCorners(PLINTH),
  ...boxCorners(WALL),
  ...shadowCorners(72, 24),
  shift(flameBase, -14 * FLAME_SCALE, -FLAME_TOP),
  shift(flameBase, 14 * FLAME_SCALE, -FLAME_TOP),
]);

/** Firewall: brick wall on a plinth with a flame above it. 12 elements. */
export function Firewall({ tint = KIND_TINT.firewall, active = false }: SpriteProps) {
  const rowHeight = WALL.h / COURSES;
  const joints: (readonly [Point, Point])[] = [];

  for (let row = 0; row < COURSES; row++) {
    const lo = row * rowHeight;
    const offset = row % 2 === 0 ? 0 : 0.25;

    for (let su = -0.75 + offset; su < 1; su += 0.5) {
      joints.push([wall.at(su, 1, lo), wall.at(su, 1, lo + rowHeight)]);
    }
  }

  const courses: (readonly [Point, Point])[] = [];

  for (let row = 1; row < COURSES; row++) {
    courses.push([wall.at(-1, 1, row * rowHeight), wall.at(1, 1, row * rowHeight)]);
    courses.push([wall.at(1, 1, row * rowHeight), wall.at(1, -1, row * rowHeight)]);
  }

  const stripe = polyPoints([
    wall.at(-1, 1, WALL.h),
    wall.at(1, 1, WALL.h),
    wall.at(1, 1, WALL.h - 5),
    wall.at(-1, 1, WALL.h - 5),
  ]);

  return (
    <g>
      <Shadow rx={72} ry={24} />
      <IsoBox {...PLINTH} edge={false} />
      <IsoBox {...WALL} tint={tint} lit={active} />
      <path
        d={segments([...courses, ...joints])}
        style={{ stroke: INK, strokeWidth: 1.1, strokeOpacity: 0.75, strokeLinecap: 'round' }}
      />
      <polygon points={stripe} style={{ fill: tint, fillOpacity: 0.5 }} />
      <g transform={`translate(${flameBase[0]} ${flameBase[1]}) scale(${FLAME_SCALE})`}>
        <path
          d={FLAME}
          style={{ fill: tint, stroke: 'var(--face-ink)', strokeWidth: 1, strokeLinejoin: 'round' }}
        />
        <path d={FLAME_CORE} style={{ fill: '#ffd98a' }} />
      </g>
    </g>
  );
}
