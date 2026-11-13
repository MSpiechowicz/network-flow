export type { SpriteBounds } from './iso';

export interface SpriteProps {
  /** Accent colour (any CSS colour). Defaults to the sprite's own kind tint. */
  tint?: string;
  /** Highlights the device: brighter top face and a tinted outline. Static, no animation. */
  active?: boolean;
}
