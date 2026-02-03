// Donchian Channel (highest high / lowest low over lookback)
// Pure function utilities; no external deps.

export function donchian(candles, length = 20) {
  const n = Math.max(1, Number(length) || 1);
  if (!Array.isArray(candles) || candles.length === 0) {
    return { high: null, low: null };
  }

  const slice = candles.slice(-n);
  let high = -Infinity;
  let low = Infinity;

  for (const c of slice) {
    if (!c) continue;
    const h = Number(c.high);
    const l = Number(c.low);
    if (Number.isFinite(h)) high = Math.max(high, h);
    if (Number.isFinite(l)) low = Math.min(low, l);
  }

  if (!Number.isFinite(high) || !Number.isFinite(low)) {
    return { high: null, low: null };
  }

  return { high, low };
}

