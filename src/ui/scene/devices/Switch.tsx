import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import { boundsOf, boxCorners, boxFrame, polyPoints, segments, shadowCorners } from './iso';
import type { Point } from './iso';
import { INK } from './paint';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

const BASE = { w: 1.04, d: 0.56, h: 12 };
const PORT_PITCH = 8.6;

const frame = boxFrame(BASE);

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = boundsOf([...boxCorners(BASE), ...shadowCorners(66, 22)]);

/** Flat arrow on the top face, from `su0` to `su1` along +col at row position `sv`. */
function arrow(su0: number, su1: number, sv: number): Point[] {
  const dir = Math.sign(su1 - su0);
  const head = su1 - dir * 0.3;
  const z = BASE.h;

  return [
    frame.at(su0, sv - 0.08, z),
    frame.at(head, sv - 0.08, z),
    frame.at(head, sv - 0.26, z),
    frame.at(su1, sv, z),
    frame.at(head, sv + 0.26, z),
    frame.at(head, sv + 0.08, z),
    frame.at(su0, sv + 0.08, z),
  ];
}

/** Switch: wide flat unit, a row of ports with link LEDs, and two-way arrows on top. 10 elements. */
export function Switch({ tint = KIND_TINT.switch, active = false }: SpriteProps) {
  const portsFrom = frame.at(-0.9, 1, 5.2);
  const portsTo = frame.at(0.9, 1, 5.2);
  const ledFrom = frame.at(-0.9, 1, 9.6);
  const ledTo = frame.at(0.9, 1, 9.6);
  const uplink = [frame.at(1, -0.5, 6), frame.at(1, 0.5, 6)] as const;

  return (
    <g>
      <Shadow rx={66} ry={22} />
      <IsoBox {...BASE} tint={tint} lit={active} />
      <polygon
        points={polyPoints(arrow(-0.55, 0.55, -0.3))}
        style={{ fill: tint, fillOpacity: 0.85 }}
      />
      <polygon
        points={polyPoints(arrow(0.55, -0.55, 0.32))}
        style={{ fill: tint, fillOpacity: 0.55 }}
      />
      <path
        d={segments([[portsFrom, portsTo]])}
        style={{ stroke: INK, strokeWidth: 5, strokeDasharray: `6.2 ${PORT_PITCH - 6.2}` }}
      />
      <path
        d={segments([[ledFrom, ledTo]])}
        style={{
          stroke: tint,
          strokeWidth: 2,
          strokeLinecap: 'round',
          strokeDasharray: `0.01 ${PORT_PITCH - 0.01}`,
          strokeDashoffset: -3.1,
        }}
      />
      <path d={segments([uplink])} style={{ stroke: INK, strokeWidth: 5, strokeLinecap: 'butt' }} />
    </g>
  );
}
