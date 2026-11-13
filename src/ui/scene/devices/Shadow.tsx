import { SHADOW_GRADIENT_ID, urlRef } from './ids';

/** Soft ground shadow under a device. Needs `<SceneDefs>` for its gradient; invisible without. */
export function Shadow({ rx, ry, cy = 2 }: { rx: number; ry: number; cy?: number }) {
  return <ellipse cx={0} cy={cy} rx={rx} ry={ry} style={{ fill: urlRef(SHADOW_GRADIENT_ID) }} />;
}
