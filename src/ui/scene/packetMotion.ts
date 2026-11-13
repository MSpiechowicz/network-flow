import { pointAlong } from '../../engine/geometry';
import { DEFAULT_LINGER_MS } from '../../engine/selectors';
import type { ActivePacket } from '../../engine/selectors';
import type { SceneModel } from './sceneModel';

/** How far along its link a lost packet gets before it is gone, as a fraction of the link. */
const LOST_STOP = 0.58;
/** Progress along the lost hop after which the dot has vanished and only the mark is left. */
const LOST_MARK_AT = 0.6;
const GROW_MS = 160;

/** Slow in, slow out: packets ease towards the devices and pause there. */
export function ease(progress: number): number {
  return progress < 0.5 ? 2 * progress * progress : 1 - (-2 * progress + 2) ** 2 / 2;
}

export interface PacketPlacement {
  x: number;
  y: number;
  opacity: number;
  /** Pop-in factor: a new packet grows from 0.6 to full size, so a paused packet is never invisible. */
  grow: number;
}

/**
 * Where a glyph sits at `timeMs`: exactly on the link's own polyline (the same points the link is drawn
 * through), so the glow dot is on the cable and only the label chip floats above it.
 */
export function placePacket(
  item: ActivePacket,
  model: SceneModel,
  timeMs: number,
  reduced: boolean,
): PacketPlacement {
  const { hop, hopProgress, phase, packet, copy } = item;
  const points = model.hopPolyline(hop);

  const travelled = reduced ? hopProgress : ease(hopProgress);
  const fraction = phase === 'lost' ? LOST_STOP * travelled : travelled;
  const at = pointAlong(points, fraction);

  let opacity = 1;
  let grow = 1;

  if (!reduced) {
    const first = copy === 0 ? packet.hops[0] : hop;
    if (first !== undefined && hop === first && timeMs - first.startMs < GROW_MS) {
      grow = 0.6 + (0.4 * Math.max(0, timeMs - first.startMs)) / GROW_MS;
    }

    if (phase === 'arrived') {
      opacity = Math.min(opacity, Math.max(0, 1 - (timeMs - hop.endMs) / DEFAULT_LINGER_MS));
    }

    if (phase === 'lost') {
      opacity = Math.min(opacity, 1 - 0.45 * Math.min(1, hopProgress / LOST_MARK_AT));
    }
  }

  return { x: at.x, y: at.y, opacity, grow };
}

export type GlyphMode = 'flying' | 'lost' | 'dropped' | 'blocked';

export function glyphMode(item: ActivePacket): GlyphMode {
  switch (item.phase) {
    case 'lost':
      return item.hopProgress >= LOST_MARK_AT ? 'lost' : 'flying';
    case 'dropped':
      return 'dropped';
    case 'blocked':
      return 'blocked';
    default:
      return 'flying';
  }
}
