/** Animation time as `m:ss.s`, for example `1:05.3`. */
export function formatClock(ms: number): string {
  const tenths = Math.floor(Math.max(ms, 0) / 100);
  const minutes = Math.floor(tenths / 600);
  const seconds = Math.floor((tenths % 600) / 10);

  return `${minutes}:${String(seconds).padStart(2, '0')}.${tenths % 10}`;
}

/** `0.25×`, `1×`, `1.5×`. */
export function formatSpeed(speed: number): string {
  return `${String(speed)}×`;
}
