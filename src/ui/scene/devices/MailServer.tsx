import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import { boundsOf, boxCorners, boxFrame, dots, polyPoints, segments, shadowCorners } from './iso';
import { INK, pale } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const CABINET = { w: 0.74, d: 0.6, h: 48 };

const frame = boxFrame(CABINET);

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([...boxCorners(CABINET), ...shadowCorners(52, 20)]);

/** Mail server: cabinet with a drive slot and an envelope on its front. 12 elements. */
export function MailServer({ tint = KIND_TINT['mail-server'], active = false }: SpriteProps) {
  const face = (su: number, dz: number) => frame.at(su, 1, dz);

  const body = [face(-0.66, 38), face(0.66, 38), face(0.66, 18), face(-0.66, 18)];
  const flap = [face(-0.66, 38), face(0.66, 38), face(0, 25)];
  const plate = polyPoints([
    frame.at(-0.55, -0.55, CABINET.h),
    frame.at(0.55, -0.55, CABINET.h),
    frame.at(0.55, 0.55, CABINET.h),
    frame.at(-0.55, 0.55, CABINET.h),
  ]);

  return (
    <g>
      <Shadow rx={52} ry={20} />
      <IsoBox {...CABINET} tint={tint} lit={active} />
      <polygon
        points={polyPoints(body)}
        style={{ fill: pale(tint), stroke: INK, strokeWidth: 1, strokeLinejoin: 'round' }}
      />
      <polygon
        points={polyPoints(flap)}
        style={{ fill: pale(tint, 55), stroke: INK, strokeWidth: 1, strokeLinejoin: 'round' }}
      />
      <path
        d={segments([
          [face(-0.66, 18), face(-0.1, 28)],
          [face(0.66, 18), face(0.1, 28)],
        ])}
        style={{ stroke: INK, strokeWidth: 0.9, strokeOpacity: 0.7 }}
      />
      <path
        d={segments([[face(-0.72, 9), face(0.3, 9)]])}
        style={{ stroke: INK, strokeWidth: 5.4, strokeLinecap: 'round' }}
      />
      <path
        d={dots([face(0.52, 9), face(0.72, 9)])}
        style={{ stroke: tint, strokeWidth: 3.6, strokeLinecap: 'round' }}
      />
      <path
        d={segments([
          [frame.at(1, -0.6, 10), frame.at(1, 0.6, 10)],
          [frame.at(1, -0.6, 15), frame.at(1, 0.6, 15)],
          [frame.at(1, -0.6, 20), frame.at(1, 0.6, 20)],
        ])}
        style={{ stroke: INK, strokeWidth: 1, strokeOpacity: 0.55 }}
      />
      <polygon
        points={plate}
        style={{
          fill: tint,
          fillOpacity: active ? 0.42 : 0.22,
          stroke: tint,
          strokeOpacity: 0.8,
          strokeLinejoin: 'round',
        }}
      />
    </g>
  );
}
