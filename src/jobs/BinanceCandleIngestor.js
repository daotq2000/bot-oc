import { PriceAlertConfig } from '../models/PriceAlertConfig.js';
import { Candle } from '../models/Candle.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { ExchangeService } from '../services/ExchangeService.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * BinanceCandleIngestor
 * - Listens to Binance WS price ticks
 * - Builds and upserts latest 1m candles into DB for tracked symbols
 * - Periodically fetches missing candles from API
 */
export class BinanceCandleIngestor {
  constructor() {
    this.tracked = new Set(); // normalized symbols (BTCUSDT)
    this.candles = new Map(); // key symbol -> current 1m candle object
    this.flushTimer = null;
    this.exchangeService = null;
  }

  normalizeSymbol(symbol) {
    if (!symbol) return symbol;
    return symbol.toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
  }

  getMinuteStart(ts) {
    return Math.floor(ts / 60000) * 60000;
  }

  async initialize() {
    try {
      // Create a dummy bot for exchange service
      const dummyBot = {
        id: 'binance_candle_ingestor',
        exchange: 'binance',
        access_key: process.env.BINANCE_API_KEY || '',
        secret_key: process.env.BINANCE_SECRET_KEY || ''
      };

      this.exchangeService = new ExchangeService(dummyBot);
      await this.exchangeService.initialize();

      // Load initial symbols from price alert configs (binance only)
      const configs = await PriceAlertConfig.findAll();
      for (const cfg of configs) {
        if ((cfg.exchange || 'mexc').toLowerCase() === 'binance' && cfg.is_active) {
          const symbols = typeof cfg.symbols === 'string' ? JSON.parse(cfg.symbols) : (cfg.symbols || []);
          if (Array.isArray(symbols)) {
            for (const sym of symbols) {
              this.tracked.add(this.normalizeSymbol(sym));
            }
          }
        }
      }

      if (this.tracked.size > 0) {
        logger.info(`[BinanceCandleIngestor] Tracking ${this.tracked.size} symbols`);
        webSocketManager.subscribe(Array.from(this.tracked));
      }

      // Register price tick handler
      webSocketManager.onPrice?.(this.onTick.bind(this));

      // Backfill minimal candles
      await this.backfillMissingCandles();

      // Start periodic flush
      const flushMs = Number(configService.getNumber('WS_CANDLE_FLUSH_INTERVAL_MS', 5000));
      this.flushTimer = setInterval(() => this.flush().catch(() => {}), Math.max(1000, flushMs));
      logger.info(`[BinanceCandleIngestor] Initialized. Tracking ${this.tracked.size} Binance symbols; flush=${flushMs}ms`);
    } catch (e) {
      logger.error('[BinanceCandleIngestor] Failed to initialize:', e);
    }
  }

  async backfillMissingCandles() {
    try {
      const enabled = configService.getBoolean?.('WS_CANDLE_BACKFILL_ENABLED', true) ?? true;
      if (!enabled) return;
      const lookback = Number(configService.getNumber('WS_CANDLE_BACKFILL_LOOKBACK_MIN', 3));
      if (this.tracked.size === 0 || !this.exchangeService) return;

      const symbols = Array.from(this.tracked);
      let inserted = 0;
      
      for (const sym of symbols) {
        try {
          const ohlcv = await this.exchangeService.fetchOHLCV(sym, '1m', lookback);
          if (!Array.isArray(ohlcv) || ohlcv.length === 0) continue;
          
          const rows = ohlcv.map(c => {
            // Handle both array format [timestamp, o, h, l, c, v] and object format
            if (Array.isArray(c)) {
              return {
                exchange: 'binance',
                symbol: sym,
                interval: '1m',
                open_time: c[0],
                open: c[1],
                high: c[2],
                low: c[3],
                close: c[4],
                volume: c[5],
                close_time: c[0] + 60000 - 1
              };
            } else {
              return {
                exchange: 'binance',
                symbol: sym,
                interval: '1m',
                open_time: c.open_time,
                open: c.open,
                high: c.high,
                low: c.low,
                close: c.close,
                volume: c.volume,
                close_time: c.close_time || (c.open_time + 60000 - 1)
              };
            }
          });
          
          await Candle.bulkInsert(rows);
          inserted += rows.length;
        } catch (e) {
          logger.debug(`[BinanceCandleIngestor] Backfill error for ${sym}:`, e?.message);
        }
      }
      
      logger.info(`[BinanceCandleIngestor] Backfill complete. Inserted ~${inserted} 1m candles for ${symbols.length} symbols`);
    } catch (e) {
      logger.warn('[BinanceCandleIngestor] backfill error:', e?.message || e);
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
          exchange: 'binance',
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
      logger.debug('[BinanceCandleIngestor] onTick error:', e?.message);
    }
  }

  async flush() {
    try {
      if (this.candles.size === 0) return;
      const arr = Array.from(this.candles.values());
      if (arr.length === 0) return;
      await Candle.bulkInsert(arr);
      logger.debug(`[BinanceCandleIngestor] Flushed ${arr.length} 1m candles`);
    } catch (e) {
      logger.warn('[BinanceCandleIngestor] flush error:', e?.message || e);
    }
  }

  stop() {
    if (this.flushTimer) clearInterval(this.flushTimer);
    this.flushTimer = null;
  }
}

