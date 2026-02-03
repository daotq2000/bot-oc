// Relative Volume (RVOL) utilities.
// RVOL = currentVolume / SMA(volume, length)

export function sma(values, length) {
  const n = Math.max(1, Number(length) || 1);
  if (!Array.isArray(values) || values.length < n) return null;
  const slice = values.slice(-n);
  let sum = 0;
  let count = 0;
  for (const v of slice) {
    const x = Number(v);
    if (!Number.isFinite(x)) return null;
    sum += x;
    count++;
  }
  if (count === 0) return null;
  return sum / count;
}

export function rvolFromCandles(candles, length = 20, useLastClosed = true) {
  const n = Math.max(1, Number(length) || 1);
  if (!Array.isArray(candles) || candles.length < n) {
    return { rvol: null, currentVolume: null, avgVolume: null };
  }

  const arr = useLastClosed
    ? candles.filter(c => c && c.isClosed === true)
    : candles;

  if (arr.length < n) {
    return { rvol: null, currentVolume: null, avgVolume: null };
  }

  const slice = arr.slice(-n);
  const vols = slice.map(c => c?.volume);
  const avg = sma(vols, n);
  const currentVolume = Number(vols[vols.length - 1]);

  if (!Number.isFinite(avg) || avg <= 0 || !Number.isFinite(currentVolume)) {
    return { rvol: null, currentVolume: Number.isFinite(currentVolume) ? currentVolume : null, avgVolume: Number.isFinite(avg) ? avg : null };
  }

  return { rvol: currentVolume / avg, currentVolume, avgVolume: avg };
}

