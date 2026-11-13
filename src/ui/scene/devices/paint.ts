import type { CSSProperties } from 'react';

/** Paint values shared by the sprites. They all resolve through `tokens.css` custom properties. */
export const INK = 'var(--face-ink)';
export const EDGE = 'var(--face-edge)';
export const BEZEL = 'var(--face-bezel)';
export const STROKE = 'var(--face-stroke)';

export type Face = 'top' | 'left' | 'right';

/** Face colour: the token, with the tint mixed in when one is given. */
export function faceFill(face: Face, tint?: string, lit = false): string {
  const base = face === 'top' && lit ? 'var(--face-top-lit)' : `var(--face-${face})`;

  if (!tint) {
    return base;
  }

  const mix = lit ? 'var(--face-tint-mix-lit)' : 'var(--face-tint-mix)';

  return `color-mix(in srgb, ${tint} ${mix}, ${base})`;
}

/** A tint blended towards white, for envelopes and highlights. */
export function pale(tint: string, amount = 30): string {
  return `color-mix(in srgb, ${tint} ${amount}%, #f4f6fb)`;
}

export function fill(value: string): CSSProperties {
  return { fill: value };
}

export function stroke(value: string): CSSProperties {
  return { stroke: value };
}
