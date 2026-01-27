import logger from '../utils/logger.js';

export class CandleAggregator {
  constructor(intervals = ['1m', '5m', '15m', '30m']) {
    this.intervals = Array.from(new Set(intervals.map(i => String(i).toLowerCase())));
    this._candles = new Map(); // key: symbol|interval|bucketStart -> candle
    this._latest = new Map(); // key: symbol|interval -> candle
    this._maxCandles = 50000; // soft cap

    // Queue of closed candles for async persistence (DB flush)
    // Each item: { symbol, interval, startTime, open, high, low, close, volume, closeTime, isClosed }
    this._closedQueue = [];
    this._maxClosedQueue = 200000; // soft cap to prevent memory blow-up on long outages
  }

  _enqueueClosedCandle(c) {
    try {
      if (!c || c.isClosed !== true) return;
      if (!c.symbol || !c.interval) return;
      if (!Number.isFinite(Number(c.startTime)) || Number(c.startTime) <= 0) return;
      if (!Number.isFinite(Number(c.open)) || Number(c.open) <= 0) return;
      if (!Number.isFinite(Number(c.close)) || Number(c.close) <= 0) return;

      // best-effort copy to avoid accidental mutation by other code
      const item = {
        symbol: String(c.symbol).toUpperCase(),
        interval: String(c.interval).toLowerCase(),
        startTime: Number(c.startTime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        volume: Number(c.volume ?? 0),
        closeTime: Number(c.closeTime || 0) || (Number(c.startTime) + this._intervalMs(c.interval) - 1),
        isClosed: true
      };

      this._closedQueue.push(item);
      if (this._closedQueue.length > this._maxClosedQueue) {
        // drop oldest 10% to recover
        this._closedQueue.splice(0, Math.floor(this._maxClosedQueue * 0.1));
      }
    } catch (_) {
      // ignore
    }
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
      const latestKey = this._latestKey(sym, interval);
      const prev = this._latest.get(latestKey);

      // If bucket changed, mark previous candle as closed
      if (prev && prev.startTime !== bucketStart && prev.isClosed !== true) {
        prev.isClosed = true;
        prev.closeTime = prev.startTime + this._intervalMs(interval);
        this._enqueueClosedCandle(prev);
      }

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
          isClosed: false,
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

      this._latest.set(latestKey, c);
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
    if (c.isClosed === true) {
      c.closeTime = Number(c.closeTime || 0) || (c.startTime + this._intervalMs(itv) - 1);
      this._enqueueClosedCandle(c);
    }

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

  /**
   * Get recent candles for a symbol/interval, sorted oldest -> newest
   * @param {string} symbol
   * @param {string} interval
   * @param {number} limit
   * @returns {Array<Object>}
   */
  getRecentCandles(symbol, interval, limit = 100) {
    const sym = String(symbol).toUpperCase();
    const itv = String(interval).toLowerCase();
    const prefix = `${sym}|${itv}|`;
    const out = [];

    for (const [key, candle] of this._candles.entries()) {
      if (key.startsWith(prefix)) {
        out.push(candle);
      }
    }

    if (out.length === 0) return [];

    out.sort((a, b) => (a.startTime || 0) - (b.startTime || 0));
    if (!limit || out.length <= limit) return out;
    return out.slice(-limit);
  }

  /**
   * Ingest historical candles (e.g. from REST/DB) into aggregator
   * @param {string} symbol
   * @param {string} interval
   * @param {Array<{startTime:number,open:number,high:number,low:number,close:number,volume?:number,isClosed?:boolean}>} candles
   */
  ingestHistoricalCandles(symbol, interval, candles = []) {
    const sym = String(symbol).toUpperCase();
    const itv = String(interval).toLowerCase();
    if (!Array.isArray(candles) || candles.length === 0) return;

    for (const c of candles) {
      const startTime = Number(c.startTime);
      const open = Number(c.open);
      const high = Number(c.high);
      const low = Number(c.low);
      const close = Number(c.close);
      const volume = Number(c.volume ?? 0);
      const isClosed = c.isClosed !== false;

      if (!Number.isFinite(startTime) || startTime <= 0) continue;
      if (!Number.isFinite(open) || open <= 0) continue;
      if (!Number.isFinite(close) || close <= 0) continue;

      this.ingestKline({
        symbol: sym,
        interval: itv,
        startTime,
        open,
        high: Number.isFinite(high) && high > 0 ? high : Math.max(open, close),
        low: Number.isFinite(low) && low > 0 ? low : Math.min(open, close),
        close,
        volume,
        isClosed,
        ts: startTime
      });
    }
  }

  /**
   * Drain closed candles for persistence. Returns up to maxItems.
   * Items are returned in FIFO order.
   */
  drainClosedCandles(maxItems = 1000) {
    const n = Math.max(1, Number(maxItems) || 1000);
    if (this._closedQueue.length === 0) return [];
    return this._closedQueue.splice(0, Math.min(n, this._closedQueue.length));
  }

  getClosedQueueSize() {
    return this._closedQueue.length;
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

