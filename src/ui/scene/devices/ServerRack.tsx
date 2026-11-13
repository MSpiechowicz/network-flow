import { IsoBox } from './IsoBox';
import { Shadow } from './Shadow';
import { boxFrame, dots, polyPoints, segments } from './iso';
import type { BoxSpec, Point } from './iso';
import { EDGE, INK } from './paint';
import { DEFAULT_RACK, rackBounds, rackBoxes } from './rackShape';
import type { RackShape } from './rackShape';
import { KIND_TINT } from './tints';
import type { SpriteProps } from './types';

// eslint-disable-next-line react-refresh/only-export-components -- static data read by sprites.ts
export const bounds = rackBounds(DEFAULT_RACK);

export interface ServerRackProps extends SpriteProps, Partial<RackShape> {}

interface CabinetProps {
  spec: BoxSpec;
  units: number;
  tint: string;
  active: boolean;
}

/** One cabinet: box, recessed units with vents and LEDs, side vents and a lit top plate. 10 elements. */
function Cabinet({ spec, units, tint, active }: CabinetProps) {
  const f = boxFrame(spec);
  const margin = 5;
  const pitch = (spec.h - margin * 2) / units;
  const barWidth = Math.max(2.6, Math.min(6.4, pitch * 0.55));

  const rows = Array.from({ length: units }, (_, i) => margin + pitch * (i + 0.5));
  const bars = rows.map((z) => [f.at(-0.74, 1, z), f.at(0.42, 1, z)] as const);
  const vents = rows.map((z) => [f.at(-0.62, 1, z), f.at(0.2, 1, z)] as const);
  const leds = rows.map((z) => f.at(0.74, 1, z));
  const status: Point[] = rows.map((z) => f.at(0.56, 1, z));

  const sideVents: (readonly [Point, Point])[] = [];

  for (let z = margin + 2; z < spec.h - margin; z += 5) {
    sideVents.push([f.at(1, -0.6, z), f.at(1, 0.6, z)]);
  }

  const plate = polyPoints([
    f.at(-0.55, -0.55, spec.h),
    f.at(0.55, -0.55, spec.h),
    f.at(0.55, 0.55, spec.h),
    f.at(-0.55, 0.55, spec.h),
  ]);

  return (
    <>
      <IsoBox {...spec} tint={tint} lit={active} />
      <path
        d={segments(bars)}
        style={{ stroke: INK, strokeWidth: barWidth, strokeLinecap: 'round' }}
      />
      <path
        d={segments(vents)}
        style={{
          stroke: EDGE,
          strokeWidth: 1,
          strokeOpacity: 0.32,
          strokeDasharray: '1.5 2.6',
        }}
      />
      <path d={dots(leds)} style={{ stroke: tint, strokeWidth: 4, strokeLinecap: 'round' }} />
      <path
        d={dots(status)}
        style={{ stroke: '#fff', strokeOpacity: 0.45, strokeWidth: 2.2, strokeLinecap: 'round' }}
      />
      <path d={segments(sideVents)} style={{ stroke: INK, strokeWidth: 1, strokeOpacity: 0.55 }} />
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
    </>
  );
}

/**
 * Server rack: one tall cabinet (`variant="single"`) or two side by side (`"double"`, the origin
 * server). Height, width and unit count can be overridden to tell server roles apart.
 * 11 elements single, 21 double.
 */
export function ServerRack({ tint = KIND_TINT.server, active = false, ...shape }: ServerRackProps) {
  const resolved: RackShape = {
    variant: shape.variant ?? DEFAULT_RACK.variant,
    w: shape.w ?? DEFAULT_RACK.w,
    d: shape.d ?? DEFAULT_RACK.d,
    h: shape.h ?? DEFAULT_RACK.h,
    units: shape.units ?? DEFAULT_RACK.units,
  };
  const span = resolved.variant === 'double' ? 56 : 34;

  return (
    <g>
      <Shadow rx={span + resolved.w * 40} ry={12 + resolved.w * 22} />
      {rackBoxes(resolved).map((spec) => (
        <Cabinet
          key={spec.col ?? 0}
          spec={spec}
          units={resolved.units}
          tint={tint}
          active={active}
        />
      ))}
    </g>
  );
}
