import { boxFrame, polyPoints, segments, type BoxSpec } from './iso';
import { EDGE, STROKE, faceFill } from './paint';

export interface IsoBoxProps extends BoxSpec {
  /** Accent colour mixed into the faces. Without it the faces use the plain device tokens. */
  tint?: string;
  /** Brighter top face and a tinted outline (the active state). */
  lit?: boolean;
  /** Draw a light edge along the two front top edges. Default true. */
  edge?: boolean;
}

/**
 * Cuboid on the iso grid: `w` and `d` in tiles, `h` in px, centred on (`col`, `row`).
 * Draws the left, right and top faces (back faces are never visible). 4 SVG elements.
 */
export function IsoBox({ tint, lit = false, edge = true, ...spec }: IsoBoxProps) {
  const f = boxFrame(spec);
  const h = spec.h;
  const outline = lit && tint ? tint : STROKE;

  const faceStyle = {
    stroke: outline,
    strokeWidth: 1,
    strokeLinejoin: 'round' as const,
  };

  return (
    <>
      <polygon
        points={polyPoints([f.at(-1, 1, h), f.at(1, 1, h), f.at(1, 1, 0), f.at(-1, 1, 0)])}
        style={{ ...faceStyle, fill: faceFill('left', tint, lit) }}
      />
      <polygon
        points={polyPoints([f.at(1, -1, h), f.at(1, 1, h), f.at(1, 1, 0), f.at(1, -1, 0)])}
        style={{ ...faceStyle, fill: faceFill('right', tint, lit) }}
      />
      <polygon
        points={polyPoints([f.at(-1, -1, h), f.at(1, -1, h), f.at(1, 1, h), f.at(-1, 1, h)])}
        style={{ ...faceStyle, fill: faceFill('top', tint, lit) }}
      />
      {edge ? (
        <path
          d={segments([
            [f.at(-1, 1, h), f.at(1, 1, h)],
            [f.at(1, 1, h), f.at(1, -1, h)],
          ])}
          style={{
            stroke: lit && tint ? tint : EDGE,
            fill: 'none',
            strokeWidth: 1,
            strokeOpacity: lit ? 0.9 : 0.55,
            strokeLinecap: 'round',
          }}
        />
      ) : null}
    </>
  );
}
