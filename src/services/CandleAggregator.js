import logger from '../utils/logger.js';

export class CandleAggregator {
  constructor(intervals = ['1m', '5m', '15m', '30m']) {
    this.intervals = Array.from(new Set(intervals.map(i => String(i).toLowerCase())));
    this._candles = new Map(); // key: symbol|interval|bucketStart -> candle
    this._latest = new Map(); // key: symbol|interval -> candle
    this._maxCandles = 50000; // soft cap
  }

  _intervalMs(interval) {
    const m = String(interval).match(/^(\d+)([mhd])$/i);
    if (!m) return 60000;
    const v = Number(m[1]);
    const u = m[2].toLowerCase();
    if (u === 'm') return v * 60_000;
    if (u === 'h') return v * 3_600_000;
    if (u === 'd') return v * 86_400_000;
    return 60_000;
  }

  _bucketStart(interval, ts) {
    const ms = this._intervalMs(interval);
    return Math.floor(ts / ms) * ms;
  }

  _key(symbol, interval, bucketStart) {
    return `${symbol}|${interval}|${bucketStart}`;
  }

  _latestKey(symbol, interval) {
    return `${symbol}|${interval}`;
  }

  ingestTick({ symbol, price, volume = 0, ts = Date.now() }) {
    const sym = String(symbol).toUpperCase();
    const p = Number(price);
    const v = Number(volume) || 0;
    const t = Number(ts) || Date.now();
    if (!sym || !Number.isFinite(p) || p <= 0) return;

    for (const interval of this.intervals) {
      const bucketStart = this._bucketStart(interval, t);
      const k = this._key(sym, interval, bucketStart);
      let c = this._candles.get(k);
      if (!c) {
        c = {
          symbol: sym,
          interval,
          startTime: bucketStart,
          open: p,
          high: p,
          low: p,
          close: p,
          volume: 0,
          ticks: 0,
          lastUpdate: t
        };
        this._candles.set(k, c);
      }
      c.high = Math.max(c.high, p);
      c.low = Math.min(c.low, p);
      c.close = p;
      c.volume += v;
      c.ticks += 1;
      c.lastUpdate = t;

      this._latest.set(this._latestKey(sym, interval), c);
    }

    // Soft cleanup
    if (this._candles.size > this._maxCandles) {
      this._evictOldest(Math.floor(this._maxCandles * 0.1));
    }
  }

  ingestKline({ symbol, interval, startTime, open, high, low, close, volume, isClosed, ts = Date.now() }) {
    const sym = String(symbol).toUpperCase();
    const itv = String(interval).toLowerCase();
    if (!this.intervals.includes(itv)) return;

    const bucketStart = Number(startTime);
    if (!Number.isFinite(bucketStart) || bucketStart <= 0) return;

    const k = this._key(sym, itv, bucketStart);
    const c = {
      symbol: sym,
      interval: itv,
      startTime: bucketStart,
      open: Number(open),
      high: Number(high),
      low: Number(low),
      close: Number(close),
      volume: Number(volume) || 0,
      isClosed: Boolean(isClosed),
      lastUpdate: Number(ts) || Date.now()
    };

    if (!Number.isFinite(c.open) || c.open <= 0) return;
    if (!Number.isFinite(c.close) || c.close <= 0) return;

    this._candles.set(k, c);
    this._latest.set(this._latestKey(sym, itv), c);

    if (this._candles.size > this._maxCandles) {
      this._evictOldest(Math.floor(this._maxCandles * 0.1));
    }
  }

  getLatestCandle(symbol, interval) {
    const sym = String(symbol).toUpperCase();
    const itv = String(interval).toLowerCase();
    return this._latest.get(this._latestKey(sym, itv)) || null;
  }

  getOpen(symbol, interval, bucketStart) {
    const sym = String(symbol).toUpperCase();
    const itv = String(interval).toLowerCase();
    const bs = Number(bucketStart);
    const c = this._candles.get(this._key(sym, itv, bs));
    const o = c?.open;
    return Number.isFinite(o) && o > 0 ? o : null;
  }

  getClose(symbol, interval, bucketStart) {
    const sym = String(symbol).toUpperCase();
    const itv = String(interval).toLowerCase();
    const bs = Number(bucketStart);
    const c = this._candles.get(this._key(sym, itv, bs));
    const cl = c?.close;
    return Number.isFinite(cl) && cl > 0 ? cl : null;
  }

  _evictOldest(n) {
    try {
      const entries = Array.from(this._candles.entries());
      entries.sort((a, b) => (a[1]?.startTime || 0) - (b[1]?.startTime || 0));
      for (let i = 0; i < Math.min(n, entries.length); i++) {
        this._candles.delete(entries[i][0]);
      }
    } catch (e) {
      logger.debug(`[CandleAggregator] Evict failed: ${e?.message || e}`);
    }
  }
}

