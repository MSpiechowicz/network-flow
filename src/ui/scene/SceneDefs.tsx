import { PROTOCOLS } from '../../protocols/registry';
import type { ProtocolId } from '../../protocols/registry';
import {
  CLOUD_GRADIENT_ID,
  GLOW_FILTER_ID,
  GRID_FADE_GRADIENT_ID,
  GRID_MASK_ID,
  SCREEN_GRADIENT_ID,
  SHADOW_GRADIENT_ID,
  pktGradientId,
} from './devices/ids';

/* eslint-disable react-refresh/only-export-components -- id helpers live beside the defs they name */
export {
  CLOUD_GRADIENT_ID,
  GLOW_FILTER_ID,
  GRID_MASK_ID,
  SCREEN_GRADIENT_ID,
  SHADOW_GRADIENT_ID,
  pktGradientId,
  urlRef,
} from './devices/ids';
/* eslint-enable react-refresh/only-export-components */

export interface SceneDefsProps {
  /** Scene area in scene units; the grid fade mask covers it. */
  area: { x: number; y: number; width: number; height: number };
}

const PROTOCOL_IDS = Object.keys(PROTOCOLS) as ProtocolId[];

/**
 * Shared `<defs>` for the scene SVG. Render once, inside the root `<svg>`.
 *
 * - `nf-glow`: the one glow filter, for static halos only (at most four at a time).
 * - `pkt-<protocolId>`: radial glow a packet fills its halo with, so packets need no filter.
 * - `nf-screen`, `nf-cloud`, `nf-shadow`: gradients the device sprites use.
 * - `nf-grid-fade`: mask that fades the floor grid out towards the edges of `area`.
 */
export function SceneDefs({ area }: SceneDefsProps) {
  return (
    <defs>
      <filter id={GLOW_FILTER_ID} x="-60%" y="-60%" width="220%" height="220%">
        <feGaussianBlur in="SourceGraphic" stdDeviation="7" result="blur" />
        <feMerge>
          <feMergeNode in="blur" />
          <feMergeNode in="SourceGraphic" />
        </feMerge>
      </filter>

      {PROTOCOL_IDS.map((id) => (
        <radialGradient key={id} id={pktGradientId(id)}>
          <stop offset="0" stopColor={PROTOCOLS[id].color} stopOpacity={0.95} />
          <stop offset="0.35" stopColor={PROTOCOLS[id].color} stopOpacity={0.45} />
          <stop offset="1" stopColor={PROTOCOLS[id].color} stopOpacity={0} />
        </radialGradient>
      ))}

      <linearGradient id={SCREEN_GRADIENT_ID} x1="0" y1="0" x2="1" y2="1">
        <stop offset="0" stopColor="#2c3a2a" />
        <stop offset="1" stopColor="#151b22" />
      </linearGradient>

      <linearGradient
        id={CLOUD_GRADIENT_ID}
        gradientUnits="userSpaceOnUse"
        x1="0"
        y1="-76"
        x2="0"
        y2="-14"
      >
        <stop offset="0" stopColor="#5d6b92" />
        <stop offset="1" stopColor="#2c3349" />
      </linearGradient>

      <radialGradient id={SHADOW_GRADIENT_ID}>
        <stop offset="0" stopColor="#000" stopOpacity={0.55} />
        <stop offset="0.6" stopColor="#000" stopOpacity={0.28} />
        <stop offset="1" stopColor="#000" stopOpacity={0} />
      </radialGradient>

      <radialGradient id={GRID_FADE_GRADIENT_ID}>
        <stop offset="0.35" stopColor="#fff" />
        <stop offset="1" stopColor="#000" />
      </radialGradient>

      <mask
        id={GRID_MASK_ID}
        maskUnits="userSpaceOnUse"
        x={area.x}
        y={area.y}
        width={area.width}
        height={area.height}
      >
        <rect
          x={area.x}
          y={area.y}
          width={area.width}
          height={area.height}
          fill={`url(#${GRID_FADE_GRADIENT_ID})`}
        />
      </mask>
    </defs>
  );
}
