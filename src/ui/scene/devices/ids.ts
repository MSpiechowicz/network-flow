import type { ProtocolId } from '../../../protocols/registry';

/** Ids of the shared `<defs>` in `SceneDefs.tsx`. Sprites and the scene reference them by `url(#id)`. */
export const GLOW_FILTER_ID = 'nf-glow';
export const SCREEN_GRADIENT_ID = 'nf-screen';
export const CLOUD_GRADIENT_ID = 'nf-cloud';
export const SHADOW_GRADIENT_ID = 'nf-shadow';
export const GRID_MASK_ID = 'nf-grid-fade';
export const GRID_FADE_GRADIENT_ID = 'nf-grid-fade-gradient';

/** Id of the radial glow gradient a packet of this protocol fills its halo with. */
export function pktGradientId(protocol: ProtocolId): string {
  return `pkt-${protocol}`;
}

/** `url(#id)` reference for fill, stroke, filter and mask attributes. */
export function urlRef(id: string): string {
  return `url(#${id})`;
}
