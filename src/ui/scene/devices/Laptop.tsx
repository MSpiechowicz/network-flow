import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import { SCREEN_GRADIENT_ID, urlRef } from './ids';
import {
  boundsOf,
  boxCorners,
  boxFrame,
  lerp,
  polyPoints,
  segments,
  shadowCorners,
  shift,
} from './iso';
import type { Point } from './iso';
import { BEZEL, EDGE, INK } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const BASE = { w: 0.84, d: 0.6, h: 5 };
const LID_HEIGHT = 52;
const LID_LEAN = 6;
const LID_THICKNESS: Point = [2.6, -1.3];

const frame = boxFrame(BASE);
const hingeLeft = frame.at(-1, -1, BASE.h);
const hingeRight = frame.at(1, -1, BASE.h);
const lidRise: Point = [LID_LEAN, -LID_HEIGHT];

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([
  ...boxCorners(BASE),
  ...shadowCorners(60, 22),
  shift(hingeLeft, lidRise[0], lidRise[1]),
  shift(hingeRight, lidRise[0] + LID_THICKNESS[0], lidRise[1]),
]);

/** Laptop: base with keyboard, tilted lid with a screen of tinted "code". 15 elements. */
export function Laptop({ tint = KIND_TINT.laptop, active = false }: SpriteProps) {
  const a = hingeLeft;
  const b = hingeRight;
  const c = shift(b, lidRise[0], lidRise[1]);
  const d = shift(a, lidRise[0], lidRise[1]);

  /** Point on the lid, `fu` along its width and `fv` down from the top edge, both 0..1. */
  const onLid = (fu: number, fv: number): Point => {
    const top = lerp(d, c, fu);
    const bottom = lerp(a, b, fu);

    return lerp(top, bottom, fv);
  };

  const codeLines: [number, number, number][] = [
    [0.2, 0.12, 0.5],
    [0.34, 0.2, 0.62],
    [0.48, 0.12, 0.4],
    [0.62, 0.2, 0.55],
  ];

  return (
    <g>
      <Shadow rx={60} ry={22} />
      <polygon
        points={polyPoints([a, b, c, d].map((p) => shift(p, LID_THICKNESS[0], LID_THICKNESS[1])))}
        style={{ fill: INK }}
      />
      <IsoBox {...BASE} tint={tint} lit={active} />
      <polygon
        points={polyPoints([
          frame.at(-0.82, -0.55, BASE.h),
          frame.at(0.82, -0.55, BASE.h),
          frame.at(0.82, 0.2, BASE.h),
          frame.at(-0.82, 0.2, BASE.h),
        ])}
        style={{ fill: INK }}
      />
      <path
        d={segments(
          [-0.38, -0.12, 0.14].map(
            (sv) => [frame.at(-0.76, sv, BASE.h), frame.at(0.76, sv, BASE.h)] as const,
          ),
        )}
        style={{
          stroke: EDGE,
          strokeOpacity: 0.4,
          strokeWidth: 3.2,
          strokeDasharray: '2.6 1.6',
        }}
      />
      <polygon
        points={polyPoints([
          frame.at(-0.32, 0.46, BASE.h),
          frame.at(0.32, 0.46, BASE.h),
          frame.at(0.32, 0.82, BASE.h),
          frame.at(-0.32, 0.82, BASE.h),
        ])}
        style={{ fill: 'var(--face-top)', stroke: EDGE, strokeOpacity: 0.35 }}
      />
      <polygon
        points={polyPoints([a, b, c, d])}
        style={{
          fill: BEZEL,
          stroke: active ? tint : 'var(--face-edge)',
          strokeWidth: 1,
          strokeLinejoin: 'round',
        }}
      />
      <polygon
        points={polyPoints([
          onLid(0.05, 0.1),
          onLid(0.95, 0.1),
          onLid(0.95, 0.94),
          onLid(0.05, 0.94),
        ])}
        style={{ fill: urlRef(SCREEN_GRADIENT_ID) }}
      />
      <path
        d={segments(
          codeLines.map(([fv, from, to]) => [onLid(from, fv + 0.1), onLid(to, fv + 0.1)] as const),
        )}
        style={{ stroke: tint, strokeWidth: 2, strokeLinecap: 'round', strokeOpacity: 0.8 }}
      />
      <polygon
        points={polyPoints([
          onLid(0.62, 0.62),
          onLid(0.88, 0.62),
          onLid(0.88, 0.86),
          onLid(0.62, 0.86),
        ])}
        style={{ fill: tint, fillOpacity: 0.22, stroke: tint, strokeOpacity: 0.6 }}
      />
      <polygon
        points={polyPoints([
          onLid(0.5, 0.1),
          onLid(0.72, 0.1),
          onLid(0.4, 0.94),
          onLid(0.18, 0.94),
        ])}
        style={{ fill: '#fff', fillOpacity: 0.05 }}
      />
      <circle
        cx={onLid(0.5, 0.045)[0]}
        cy={onLid(0.5, 0.045)[1]}
        r={1.1}
        style={{ fill: EDGE, fillOpacity: 0.8 }}
      />
    </g>
  );
}
