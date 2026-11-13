import type { NodeKind } from '../../../protocols/nodeKinds';
import { boundsOf, boxCorners, shadowCorners } from './iso';
import type { BoxSpec, SpriteBounds } from './iso';

/** Offset of each cabinet of a double rack from the centre, along +col, in tiles. */
export const DOUBLE_OFFSET = 0.25;

export interface RackShape {
  /** `single` is one cabinet; `double` is two side by side (the origin server). */
  variant: 'single' | 'double';
  /** Width of one cabinet along +col, in tiles. */
  w: number;
  /** Depth along +row, in tiles. */
  d: number;
  /** Cabinet height in px. */
  h: number;
  /** Rack units drawn on the front face. */
  units: number;
}

export const DEFAULT_RACK: RackShape = { variant: 'single', w: 0.6, d: 0.56, h: 52, units: 4 };

/** Cabinet boxes of a rack shape, back to front. */
export function rackBoxes({ variant, w, d, h }: RackShape): BoxSpec[] {
  if (variant === 'single') {
    return [{ w, d, h }];
  }

  return [
    { w, d, h, col: -DOUBLE_OFFSET },
    { w, d, h, col: DOUBLE_OFFSET },
  ];
}

export function rackBounds(shape: RackShape): SpriteBounds {
  const span = shape.variant === 'double' ? 56 : 34;

  return boundsOf([
    ...rackBoxes(shape).flatMap(boxCorners),
    ...shadowCorners(span + shape.w * 40, 12 + shape.w * 22),
  ]);
}

/**
 * Shape per node kind that draws the server rack. Rack height, width and unit count differ as
 * well as the tint, so servers of different roles read apart even without their badge.
 */
export const RACK_SHAPES: Partial<Record<NodeKind, RackShape>> = {
  'dns-resolver': { variant: 'single', w: 0.72, d: 0.56, h: 36, units: 3 },
  'dns-root': { variant: 'single', w: 0.5, d: 0.5, h: 80, units: 6 },
  'dns-tld': { variant: 'single', w: 0.56, d: 0.56, h: 62, units: 4 },
  'dns-authoritative': { variant: 'single', w: 0.62, d: 0.56, h: 48, units: 3 },
  'origin-server': { variant: 'double', w: 0.42, d: 0.6, h: 74, units: 5 },
  'api-server': { variant: 'single', w: 0.84, d: 0.5, h: 28, units: 2 },
  'dhcp-server': { variant: 'single', w: 0.66, d: 0.56, h: 42, units: 2 },
  server: DEFAULT_RACK,
};
