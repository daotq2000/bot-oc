import ccxt from 'ccxt';
import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { Strategy } from '../models/Strategy.js';
import { Candle } from '../models/Candle.js';
import { mexcPriceWs } from '../services/MexcWebSocketManager.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * WsCandleIngestor
 * - Listens to MEXC WS price ticks
 * - Builds and upserts latest 1m candles into DB for tracked symbols
 */
export class WsCandleIngestor {
  constructor() {
    this.tracked = new Set(); // normalized symbols (BTCUSDT)
    this.candles = new Map(); // key symbol -> current 1m candle object
    this.flushTimer = null;
  }

  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    return symbol.toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
  }

  getMinuteStart(ts) {
    return Math.floor(ts / 60000) * 60000;
  }

  toCcxtSwapSymbol(normalized) {
    // 'BTCUSDT' -> 'BTC/USDT:USDT'
    const base = normalized.replace(/USDT$/, '');
    return `${base}/USDT:USDT`;
  }

  async backfillMissingCandles() {
    try {
      const enabled = configService.getBoolean?.('WS_CANDLE_BACKFILL_ENABLED', true) ?? true;
      if (!enabled) return;
      const lookback = Number(configService.getNumber('WS_CANDLE_BACKFILL_LOOKBACK_MIN', 3));
      if (this.tracked.size === 0) return;

      const ex = new ccxt.mexc({ enableRateLimit: true, options: { defaultType: 'swap' } });
      // Force .co domain for MEXC REST
      try {
        if ('hostname' in ex) ex.hostname = 'mexc.co';
        const u = ex.urls || {};
        const repl = (v) => (typeof v === 'string' ? v.replaceAll('mexc.com', 'mexc.co') : v);
        if (u.api && typeof u.api === 'object') {
          for (const k of Object.keys(u.api)) u.api[k] = repl(u.api[k]);
        }
        if (u.www) u.www = repl(u.www);
        if (u.test) u.test = repl(u.test);
        if (u.doc) u.doc = Array.isArray(u.doc) ? u.doc.map(repl) : repl(u.doc);
        ex.urls = u;
      } catch (_) {}
      await ex.loadMarkets();

      const symbols = Array.from(this.tracked);
      let inserted = 0;
      for (const sym of symbols) {
        try {
          const marketSym = this.toCcxtSwapSymbol(sym);
          const ohlcv = await ex.fetchOHLCV(marketSym, '1m', undefined, lookback);
          if (!Array.isArray(ohlcv) || ohlcv.length === 0) continue;
          const rows = ohlcv.map(c => ({
            exchange: 'mexc',
            symbol: sym,
            interval: '1m',
            open_time: c[0],
            open: c[1],
            high: c[2],
            low: c[3],
            close: c[4],
            volume: c[5],
            close_time: c[0] + 60000 - 1
          }));
          await Candle.bulkInsert(rows);
          inserted += rows.length;
        } catch (e) {
          // ignore per-symbol error
        }
      }
      logger.info(`[WsCandleIngestor] Backfill complete. Inserted ~${inserted} 1m candles for ${symbols.length} symbols`);
    } catch (e) {
      logger.warn('[WsCandleIngestor] backfill error:', e?.message || e);
    }
  }

  async initialize() {
    // Load initial symbols from strategies and price alert configs
    try {
      const [strategies, configs] = await Promise.all([
        Strategy.findAll(null, true),
        PriceAlertConfig.findAll('mexc')
      ]);

      for (const s of strategies) {
        if ((s.exchange || '').toLowerCase() === 'mexc') {
          this.tracked.add(this.normalizeSymbol(s.symbol));
        }
      }
      for (const c of configs) {
        const arr = typeof c.symbols === 'string' ? JSON.parse(c.symbols) : c.symbols;
        if (Array.isArray(arr)) {
          for (const sym of arr) this.tracked.add(this.normalizeSymbol(sym));
        }
      }

      if (this.tracked.size > 0) {
        mexcPriceWs.subscribe(Array.from(this.tracked));
      }

      // Register price tick handler once
      mexcPriceWs.onPrice?.(this.onTick.bind(this));

      // Backfill minimal candles so OC scanner has data immediately
      await this.backfillMissingCandles();

      // Start periodic flush
      const flushMs = Number(configService.getNumber('WS_CANDLE_FLUSH_INTERVAL_MS', 5000));
      this.flushTimer = setInterval(() => this.flush().catch(() => {}), Math.max(1000, flushMs));
      logger.info(`[WsCandleIngestor] Initialized. Tracking ${this.tracked.size} MEXC symbols; flush=${flushMs}ms`);
    } catch (e) {
      logger.error('[WsCandleIngestor] Failed to initialize:', e);
    }
  }

  onTick({ symbol, price, ts }) {
    try {
      const sym = this.normalizeSymbol(symbol);
      if (!this.tracked.has(sym)) return;
      const t = ts || Date.now();
      const openTime = this.getMinuteStart(t);
      const key = sym;
      let c = this.candles.get(key);
      if (!c || c.open_time !== openTime) {
        // roll minute
        c = {
          exchange: 'mexc',
          symbol: sym,
          interval: '1m',
          open_time: openTime,
          open: price,
          high: price,
          low: price,
          close: price,
          volume: 0,
          close_time: openTime + 60000 - 1
        };
        this.candles.set(key, c);
      } else {
        // update OHLC
        c.close = price;
        if (price > c.high) c.high = price;
        if (price < c.low) c.low = price;
      }
    } catch (e) {
      // ignore
    }
  }

  async flush() {
    try {
      if (this.candles.size === 0) return;
      const arr = Array.from(this.candles.values());
      if (arr.length === 0) return;
      await Candle.bulkInsert(arr);
      logger.info(`[WsCandleIngestor] Flushed ${arr.length} 1m candles`);
    } catch (e) {
      logger.warn('[WsCandleIngestor] flush error:', e?.message || e);
    }
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }
}

