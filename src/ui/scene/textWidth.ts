/**
 * Width of a text run in px. Uses a canvas with the page's real fonts when one is available, so
 * chips hug their text; falls back to a per-character estimate (tests, SSR, no canvas).
 */
type FontFamily = 'sans' | 'mono';

const cache = new Map<string, number>();
let context: CanvasRenderingContext2D | null | undefined;
const families: Partial<Record<FontFamily, string>> = {};

function familyOf(family: FontFamily): string {
  const known = families[family];
  if (known !== undefined) {
    return known;
  }

  const fallback = family === 'mono' ? 'monospace' : 'sans-serif';
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(`--font-${family}`)
    .trim();
  const resolved = value === '' ? fallback : value;
  families[family] = resolved;

  return resolved;
}

export function textWidth(
  text: string,
  weight: number,
  sizePx: number,
  family: FontFamily,
  estimatePerChar: number,
): number {
  if (typeof document === 'undefined') {
    return text.length * estimatePerChar;
  }

  const key = `${family}|${String(weight)}|${String(sizePx)}|${text}`;
  const cached = cache.get(key);
  if (cached !== undefined) {
    return cached;
  }

  if (context === undefined) {
    context = document.createElement('canvas').getContext('2d');
  }
  if (context === null) {
    return text.length * estimatePerChar;
  }

  context.font = `${String(weight)} ${String(sizePx)}px ${familyOf(family)}`;
  const width = context.measureText(text).width;
  cache.set(key, width);

  return width;
}
