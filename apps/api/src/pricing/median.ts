/** Median of values; null when empty. */
export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** Keeps the [P10, P90] band. No-op for n < 5 (nothing sane to trim). */
export function trimOutliers(values: number[]): number[] {
  if (values.length < 5) return values;
  const sorted = [...values].sort((a, b) => a - b);
  const lo = Math.floor(0.1 * sorted.length);
  const hi = Math.ceil(0.9 * sorted.length);
  return sorted.slice(lo, hi);
}
