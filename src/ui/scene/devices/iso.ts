/**
 * Isometric projection helpers shared by every sprite.
 *
 * A tile is 128 wide and 64 high: grid point (col, row) is drawn at
 * `x = (col - row) * 64`, `y = (col + row) * 32`. +col runs down and to the right on screen,
 * +row runs down and to the left. Heights are plain pixels (screen y, upwards).
 */

export const TILE_W = 128;
export const TILE_H = 64;

export type Point = readonly [x: number, y: number];

/**
 * Extent of a sprite around its local origin (the centre of its base on the ground), in px.
 * `left` is the x of the leftmost pixel (negative or zero), `right` the x of the rightmost,
 * `top` the height of the highest pixel above the ground (positive) and `bottom` how far the
 * lowest pixel, usually the ground shadow, extends below the origin (positive).
 */
export interface SpriteBounds {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export interface BoxSpec {
  /** Extent along +col, in tiles. */
  w: number;
  /** Extent along +row, in tiles. */
  d: number;
  /** Height, in px. */
  h: number;
  /** Offset of the box centre along +col, in tiles. */
  col?: number;
  /** Offset of the box centre along +row, in tiles. */
  row?: number;
  /** Elevation of the box base above the ground, in px. */
  z?: number;
}

export interface BoxFrame {
  /**
   * Screen point on or around the box. `su` runs along +col and `sv` along +row, both in
   * [-1, 1] across the box. `dz` is the height above the box base in px.
   */
  at: (su: number, sv: number, dz?: number) => Point;
}

export function project(col: number, row: number, z = 0): Point {
  return [((col - row) * TILE_W) / 2, ((col + row) * TILE_H) / 2 - z];
}

export function boxFrame({ w, d, col = 0, row = 0, z = 0 }: BoxSpec): BoxFrame {
  return {
    at: (su, sv, dz = 0) => project(col + (su * w) / 2, row + (sv * d) / 2, z + dz),
  };
}

export function lerp(a: Point, b: Point, t: number): Point {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t];
}

export function shift(p: Point, dx: number, dy: number): Point {
  return [p[0] + dx, p[1] + dy];
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

/** SVG `points` attribute for a polygon. */
export function polyPoints(list: readonly Point[]): string {
  return list.map(([x, y]) => `${fmt(x)},${fmt(y)}`).join(' ');
}

/** SVG path data made of independent straight segments (one `M`/`L` pair each). */
export function segments(list: readonly (readonly [Point, Point])[]): string {
  return list.map(([a, b]) => `M${fmt(a[0])} ${fmt(a[1])}L${fmt(b[0])} ${fmt(b[1])}`).join('');
}

/** SVG path data for zero-length segments; with a round cap and a stroke width they draw dots. */
export function dots(list: readonly Point[]): string {
  return list.map(([x, y]) => `M${fmt(x)} ${fmt(y)}h0`).join('');
}

/** Ellipse that a circle of the given radius (in tiles) lying on a ground-parallel plane projects to. */
export function isoEllipse(col: number, row: number, radius: number, z = 0) {
  const [cx, cy] = project(col, row, z);
  return { cx, cy, rx: radius * TILE_W * Math.SQRT1_2, ry: radius * TILE_H * Math.SQRT1_2 };
}

/** Tight bounds of a point set, rounded outwards. */
export function boundsOf(points: readonly Point[]): SpriteBounds {
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);

  return {
    left: Math.floor(Math.min(...xs)),
    right: Math.ceil(Math.max(...xs)),
    top: Math.ceil(-Math.min(...ys)),
    bottom: Math.ceil(Math.max(...ys)),
  };
}

/** Corners of a box's silhouette, for `boundsOf`. */
export function boxCorners(spec: BoxSpec): Point[] {
  const f = boxFrame(spec);
  const out: Point[] = [];

  for (const su of [-1, 1]) {
    for (const sv of [-1, 1]) {
      out.push(f.at(su, sv, 0), f.at(su, sv, spec.h));
    }
  }

  return out;
}

/** Bounds of a ground shadow ellipse centred slightly below the origin. */
export function shadowCorners(rx: number, ry: number, cy = 2): Point[] {
  return [
    [-rx, cy],
    [rx, cy],
    [0, cy + ry],
    [0, cy - ry],
  ];
}
