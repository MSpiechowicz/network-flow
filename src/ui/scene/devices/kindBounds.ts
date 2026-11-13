import { nodeKindInfo } from '../../../protocols/nodeKinds';
import type { NodeKind } from '../../../protocols/nodeKinds';
import type { SpriteBounds } from './iso';
import { DEFAULT_RACK, RACK_SHAPES, rackBounds } from './rackShape';
import { SPRITES } from './sprites';

/** Bounds of the device a node kind draws, including its own rack shape, excluding the badge chip. */
export function kindBounds(kind: NodeKind): SpriteBounds {
  const { sprite } = nodeKindInfo(kind);

  if (sprite === 'server') {
    return rackBounds(RACK_SHAPES[kind] ?? DEFAULT_RACK);
  }

  return SPRITES[sprite].bounds;
}
