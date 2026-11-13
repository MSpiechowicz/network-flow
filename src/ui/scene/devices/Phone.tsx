import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import { SCREEN_GRADIENT_ID, urlRef } from './ids';
import { boundsOf, boxCorners, boxFrame, polyPoints, segments, shadowCorners } from './iso';
import { BEZEL, EDGE, INK } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const DOCK = { w: 0.62, d: 0.32, h: 4 };
const BODY = { w: 0.52, d: 0.16, h: 60, z: DOCK.h };

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([
  ...boxCorners(DOCK),
  ...boxCorners(BODY),
  ...shadowCorners(40, 15),
]);

/** Phone: slim slab standing in a dock, home screen of tinted app icons. 22 elements. */
export function Phone({ tint = KIND_TINT.phone, active = false }: SpriteProps) {
  const body = boxFrame(BODY);
  const face = (su: number, dz: number) => body.at(su, 1, dz);

  const icons: [number, number][] = [];

  for (const dz of [14, 24, 34]) {
    for (const su of [-0.64, -0.17, 0.3]) {
      icons.push([su, dz]);
    }
  }

  return (
    <g>
      <Shadow rx={40} ry={15} />
      <IsoBox {...DOCK} tint={tint} lit={active} />
      <IsoBox {...BODY} tint={tint} lit={active} />
      <polygon
        points={polyPoints([face(-0.8, 58), face(0.8, 58), face(0.8, 4), face(-0.8, 4)])}
        style={{ fill: urlRef(SCREEN_GRADIENT_ID), stroke: BEZEL, strokeLinejoin: 'round' }}
      />
      <polygon
        points={polyPoints([face(-0.68, 53), face(0.68, 53), face(0.68, 46), face(-0.68, 46)])}
        style={{ fill: tint, fillOpacity: 0.3, stroke: tint, strokeOpacity: 0.7 }}
      />
      {icons.map(([su, dz]) => (
        <polygon
          key={`${su}:${dz}`}
          points={polyPoints([
            face(su, dz + 5.4),
            face(su + 0.34, dz + 5.4),
            face(su + 0.34, dz),
            face(su, dz),
          ])}
          style={{ fill: tint, fillOpacity: 0.42 }}
        />
      ))}
      <path
        d={segments([[face(-0.25, 60.5), face(0.25, 60.5)]])}
        style={{ stroke: INK, strokeWidth: 2.4, strokeLinecap: 'round' }}
      />
      <path
        d={segments([[face(-0.3, 7), face(0.3, 7)]])}
        style={{ stroke: EDGE, strokeWidth: 1.4, strokeLinecap: 'round', strokeOpacity: 0.7 }}
      />
    </g>
  );
}
