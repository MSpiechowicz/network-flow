import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import {
  boundsOf,
  boxCorners,
  boxFrame,
  dots,
  isoEllipse,
  polyPoints,
  project,
  segments,
  shadowCorners,
} from './iso';
import type { Point } from './iso';
import { EDGE, INK } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const LOWER = { w: 0.88, d: 0.74, h: 16 };
const SPACER = { w: 0.5, d: 0.44, h: 6, z: LOWER.h };
const UPPER = { w: 0.88, d: 0.74, h: 16, z: LOWER.h + SPACER.h };
const TOP = UPPER.z + UPPER.h;
const RING_RADIUS = 0.2;

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([
  ...boxCorners(LOWER),
  ...boxCorners(UPPER),
  ...shadowCorners(66, 24),
]);

/** One slab's front details: vent ticks and status LEDs. */
function slabDetails(spec: typeof LOWER | typeof UPPER, tint: string) {
  const f = boxFrame(spec);
  const mid = spec.h / 2;

  return (
    <>
      <path
        d={segments([[f.at(-0.78, 1, mid), f.at(0.3, 1, mid)]])}
        style={{ stroke: INK, strokeWidth: 5.4, strokeLinecap: 'round' }}
      />
      <path
        d={dots([f.at(0.52, 1, mid), f.at(0.72, 1, mid)])}
        style={{ stroke: tint, strokeWidth: 3.6, strokeLinecap: 'round' }}
      />
      <path
        d={segments([[f.at(-0.66, 1, mid), f.at(0.16, 1, mid)]])}
        style={{ stroke: EDGE, strokeWidth: 1, strokeOpacity: 0.35, strokeDasharray: '1.5 2.6' }}
      />
    </>
  );
}

/** CDN edge: two slabs on a spacer, topped with a ring of three linked cache nodes. 21 elements. */
export function CdnEdge({ tint = KIND_TINT['cdn-edge'], active = false }: SpriteProps) {
  const ring = isoEllipse(0, 0, RING_RADIUS, TOP);
  const nodes: Point[] = [90, 210, 330].map((deg) => {
    const rad = (deg * Math.PI) / 180;

    return project(Math.cos(rad) * RING_RADIUS, Math.sin(rad) * RING_RADIUS, TOP);
  });

  return (
    <g>
      <Shadow rx={66} ry={24} />
      <IsoBox {...LOWER} tint={tint} lit={active} />
      {slabDetails(LOWER, tint)}
      <IsoBox {...SPACER} tint={tint} lit={active} edge={false} />
      <IsoBox {...UPPER} tint={tint} lit={active} />
      {slabDetails(UPPER, tint)}
      <ellipse
        cx={ring.cx}
        cy={ring.cy}
        rx={ring.rx}
        ry={ring.ry}
        style={{
          fill: tint,
          fillOpacity: 0.14,
          stroke: tint,
          strokeOpacity: 0.7,
          strokeWidth: 1.2,
        }}
      />
      <polygon
        points={polyPoints(nodes)}
        style={{
          fill: 'none',
          stroke: tint,
          strokeOpacity: 0.8,
          strokeWidth: 1.2,
          strokeLinejoin: 'round',
        }}
      />
      <path d={dots(nodes)} style={{ stroke: tint, strokeWidth: 5, strokeLinecap: 'round' }} />
    </g>
  );
}
