import { strategyCache } from './StrategyCache.js';
import logger from '../utils/logger.js';
import ccxt from 'ccxt';
import { configService } from './ConfigService.js';
import { LRUCache } from '../utils/LRUCache.js';

export class RealtimeOCDetector {
  constructor() {
    this.openPriceCache = new LRUCache(1000);
    this.openFetchCache = new LRUCache(200);
    this.openPrimeToleranceMs = Number(configService.getNumber('OC_OPEN_PRIME_TOLERANCE_MS', 3000));
    this.lastPriceCache = new LRUCache(600);
    this.priceChangeThreshold = 0.0001;
    this._publicClients = new Map();
    this.maxPublicClients = 10;
    this._restFetchQueue = [];
    this._restFetchInProgress = false;
    this._restFetchDelay = Number(configService.getNumber('OC_REST_FETCH_DELAY_MS', 30));
    this._maxRestFetchQueue = Number(configService.getNumber('OC_REST_FETCH_MAX_QUEUE', 300));
    this._restFetchConcurrent = Number(configService.getNumber('OC_REST_FETCH_CONCURRENT', 2));
    this._restOpenFailCache = new LRUCache(2000);
    this._restOpenFailTtlMs = Number(configService.getNumber('OC_REST_OPEN_FAIL_TTL_MS', 4000));
    this._restQueueEvictStaleMs = Number(configService.getNumber('OC_REST_QUEUE_EVICT_STALE_MS', 120000));
    this._restQueueDropOverbucket = configService.getBoolean('OC_REST_QUEUE_DROP_OVERBUCKET', true);
    this._ocMatchStateCache = new LRUCache(5000);
    this.ocReverseRetraceRatio = Number(configService.getNumber('OC_REVERSE_RETRACE_RATIO', 0.2));
    this.ocReverseStallMs = Number(configService.getNumber('OC_REVERSE_STALL_MS', 4000));
    this.telegramService = null;
    this.alertEnabled = false;
    this.alertScanRunning = false;
    this.alertScanTimer = null;
    this.alertWatchlistRefreshTimer = null;
    this.alertState = new Map();
    this.alertWatchers = [];
    this.maxAlertStateCacheSize = 1000;
    this.startCacheCleanup();
  }

  startCacheCleanup() {
    setInterval(() => this.cleanupOldCacheEntries(), 5 * 60 * 1000);
  }

  cleanupOldCacheEntries() {
    const now = Date.now();
    const maxAge = 15 * 60 * 1000;
    let cleaned = 0;
    for (const [key, value] of this.openPriceCache.entries()) {
      if (now - value.lastUpdate > maxAge) {
        this.openPriceCache.delete(key);
        cleaned++;
      }
    }
    for (const [key, value] of this.openFetchCache.entries()) {
      if (now - value.timestamp > maxAge) {
        this.openFetchCache.delete(key);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[RealtimeOCDetector] Cleaned ${cleaned} old cache entries.`);
    }
  }

  // Alias for compatibility with WebSocketOCConsumer
  cleanup() {
    this.cleanupOldCacheEntries();
  }

  getBucketStart(interval, timestamp = Date.now()) {
    const intervalMs = this.getIntervalMs(interval);
    return Math.floor(timestamp / intervalMs) * intervalMs;
  }

  getIntervalMs(interval) {
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 60000;
    const value = parseInt(match[1]);
    const unit = match[2];
    switch (unit) {
      case 'm': return value * 60000;
      case 'h': return value * 3600000;
      case 'd': return value * 86400000;
      default: return 60000;
    }
  }

  async getAccurateOpen(exchange, symbol, interval, currentPrice, timestamp = Date.now()) {
    const ex = (exchange || '').toLowerCase();
    const sym = String(symbol || '').toUpperCase().replace(/[/:_]/g, '');
    const bucketStart = this.getBucketStart(interval, timestamp);
    const key = `${ex}|${sym}|${interval}|${bucketStart}`;
    let openSource = 'unknown';

    const cached = this.openPriceCache.get(key);
    if (cached && cached.bucketStart === bucketStart && Number.isFinite(cached.open) && cached.open > 0) {
      openSource = cached.source || 'cache';
      return { open: cached.open, error: null, source: openSource };
    }

    try {
      if (ex === 'binance') {
        const { webSocketManager } = await import('./WebSocketManager.js');

        // 1) Best: exact bucket open from WS (kline cache / aggregator)
        const wsOpen = webSocketManager.getKlineOpen(sym, interval, bucketStart);
        if (Number.isFinite(wsOpen) && wsOpen > 0) {
          this.openPriceCache.set(key, { open: wsOpen, bucketStart, lastUpdate: timestamp, source: 'binance_ws_bucket_open' });
          return { open: wsOpen, error: null, source: 'binance_ws_bucket_open' };
        }

        // 2) If we have latest candle for this interval and it matches the bucketStart, use its open
        const latest = webSocketManager.getLatestCandle(sym, interval);
        if (latest && Number(latest.startTime) === Number(bucketStart)) {
          const lo = Number(latest.open);
          if (Number.isFinite(lo) && lo > 0) {
            this.openPriceCache.set(key, { open: lo, bucketStart, lastUpdate: timestamp, source: 'binance_ws_latest_candle_open' });
            return { open: lo, error: null, source: 'binance_ws_latest_candle_open' };
          }
        }

        // 3) Fallback: previous bucket close as current bucket open
        const intervalMs = this.getIntervalMs(interval);
        const prevBucketStart = bucketStart - intervalMs;
        const prevClose = webSocketManager.getKlineClose(sym, interval, prevBucketStart);
        if (Number.isFinite(prevClose) && prevClose > 0) {
          this.openPriceCache.set(key, { open: prevClose, bucketStart, lastUpdate: timestamp, source: 'binance_ws_prev_close' });
          return { open: prevClose, error: null, source: 'binance_ws_prev_close' };
        }
      } else if (ex === 'mexc') {
        const { mexcPriceWs } = await import('./MexcWebSocketManager.js');
        const wsOpen = mexcPriceWs.getKlineOpen(sym, interval, bucketStart);
        if (Number.isFinite(wsOpen) && wsOpen > 0) {
          this.openPriceCache.set(key, { open: wsOpen, bucketStart, lastUpdate: timestamp, source: 'mexc_ws_kline' });
          return { open: wsOpen, error: null, source: 'mexc_ws_kline' };
        }
        const intervalMs = this.getIntervalMs(interval);
        const prevBucketStart = bucketStart - intervalMs;
        const prevClose = mexcPriceWs.getKlineClose(sym, interval, prevBucketStart);
        if (Number.isFinite(prevClose) && prevClose > 0) {
          this.openPriceCache.set(key, { open: prevClose, bucketStart, lastUpdate: timestamp, source: 'mexc_ws_prev_close' });
          return { open: prevClose, error: null, source: 'mexc_ws_prev_close' };
        }
      }
    } catch (wsErr) {
      logger.debug(`[RealtimeOCDetector] WS open fallback failed for ${ex} ${sym} ${interval}: ${wsErr?.message || wsErr}`);
    }

    return { open: null, error: new Error('No WebSocket open price available') };
  }

  normalizeSymbolForAlert(symbol) {
    if (!symbol) return symbol;
    return symbol.toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
  }

  async initializeAlerts(telegramService) {
    this.telegramService = telegramService;
    this.alertEnabled = true;

    await this.refreshAlertWatchlist();

    try {
      const { mexcPriceWs } = await import('./MexcWebSocketManager.js');
      mexcPriceWs.onPrice(({ symbol, price, ts }) => {
        this.onAlertTick('mexc', symbol, price, ts).catch(error => {
          logger.error(`[RealtimeOCDetector] Error in MEXC alert tick:`, error?.message || error);
        });
      });
      logger.info(`[RealtimeOCDetector] ✅ Registered MEXC alert price handler`);
    } catch (error) {
      logger.error(`[RealtimeOCDetector] ❌ Failed to register MEXC alert handler:`, error?.message || error);
    }
    
    try {
      const { webSocketManager } = await import('./WebSocketManager.js');
      webSocketManager.onPrice(({ symbol, price, ts }) => {
        this.onAlertTick('binance', symbol, price, ts).catch(error => {
          logger.error(`[RealtimeOCDetector] Error in Binance alert tick:`, error?.message || error);
        });
      });
      logger.info(`[RealtimeOCDetector] ✅ Registered Binance alert price handler`);
    } catch (error) {
      logger.error(`[RealtimeOCDetector] ❌ Failed to register Binance alert handler:`, error?.message || error);
    }

    const ttl = Number(configService.getNumber('OC_ALERT_WATCHLIST_REFRESH_MS', 30000));
    this.alertWatchlistRefreshTimer = setInterval(() => {
      this.refreshAlertWatchlist().catch(() => {});
    }, Math.max(5000, ttl));
  }

  async refreshAlertWatchlist() {
    try {
      const { priceAlertSymbolTracker } = await import('./PriceAlertSymbolTracker.js');
      await priceAlertSymbolTracker.refresh();
      const { PriceAlertConfig } = await import('../models/PriceAlertConfig.js');
      const configs = await PriceAlertConfig.findAll();
      const watchers = [];
      const mexcSet = new Set();
      const binanceSet = new Set();

      for (const cfg of configs) {
        if (!cfg.is_active) continue;
        const exchange = (cfg.exchange || 'mexc').toLowerCase();
        const symbols = Array.from(priceAlertSymbolTracker.getSymbolsForExchange(exchange));
        const intervals = Array.isArray(cfg.intervals) ? cfg.intervals : JSON.parse(cfg.intervals || '["1m"]');
        if (symbols.length === 0) continue;

        const normalized = symbols.map(s => this.normalizeSymbolForAlert(s)).filter(Boolean);
        watchers.push({
          cfgId: cfg.id, exchange, symbols: new Set(normalized),
          intervals: new Set(intervals.length > 0 ? intervals : ['1m']),
          threshold: Number(cfg.threshold || 0), chatId: cfg.telegram_chat_id
        });

        for (const s of normalized) {
          if (exchange === 'mexc') mexcSet.add(s); else if (exchange === 'binance') binanceSet.add(s);
        }
      }

      if (mexcSet.size > 0) {
        const { mexcPriceWs } = await import('./MexcWebSocketManager.js');
        mexcPriceWs.subscribe(Array.from(mexcSet));
      }
      if (binanceSet.size > 0) {
        const { webSocketManager } = await import('./WebSocketManager.js');
        webSocketManager.subscribe(Array.from(binanceSet));
      }

      this.alertWatchers = watchers;
      logger.info(`[RealtimeOCDetector] Alert watchlist refreshed: ${watchers.length} configs; MEXC=${mexcSet.size}, BINANCE=${binanceSet.size}`);
    } catch (e) {
      logger.warn('[RealtimeOCDetector] refreshAlertWatchlist failed:', e?.message || e);
    }
  }

  async onAlertTick(exchange, symbol, price, ts = Date.now()) {
    if (!this.alertEnabled) return;
    if (!this.alertWatchers || this.alertWatchers.length === 0) return;

    const sym = this.normalizeSymbolForAlert(symbol);
    const p = Number(price);
    if (!Number.isFinite(p) || p <= 0) return;

    for (const w of this.alertWatchers) {
      if (w.exchange !== exchange.toLowerCase() || !w.symbols.has(sym)) continue;

      for (const interval of w.intervals) {
        const bucketStart = this.getBucketStart(interval, ts);
        const { open, source } = await this.getAccurateOpen(w.exchange, sym, interval, p, ts);
        if (!Number.isFinite(open) || open <= 0) continue;

        const oc = ((p - open) / open) * 100;
        const absOc = Math.abs(oc);
        const absThreshold = Math.abs(Number(w.threshold || 0));
        if (absThreshold <= 0) continue;

        // Debug bucket info to verify OC vs nến thực tế
        logger.info(
          `[RealtimeOCDetector] 🔍 OC bucket debug | ${exchange.toUpperCase()} ${sym} ${interval} ` +
          `bucketStart=${bucketStart} oc=${oc.toFixed(2)}% open=${open.toFixed(8)} current=${p.toFixed(8)} source=${source || 'unknown'}`
        );

        const stateKey = `${w.cfgId}|${exchange}|${sym}|${interval}`;
        let state = this.alertState.get(stateKey);
        if (!state) {
          state = { lastAlertTime: 0, armed: true, lastAlertOcAbs: 0 };
          this.alertState.set(stateKey, state);
        }

        const stepPercent = Math.abs(Number(configService.getNumber('OC_ALERT_STEP_PERCENT', w.threshold)));
        const ocDeltaFromLastAlert = absOc - state.lastAlertOcAbs;

        if (absOc >= absThreshold && ocDeltaFromLastAlert >= stepPercent && state.armed) {
          const minIntervalMs = Number(configService.getNumber('PRICE_ALERT_MIN_INTERVAL_MS', 60000));
          if (Date.now() - state.lastAlertTime >= minIntervalMs) {
            logger.info(
              `[RealtimeOCDetector] 🚨 Sending alert for ${exchange.toUpperCase()} ${sym} ${interval} ` +
              `oc=${oc.toFixed(2)}% (open=${open.toFixed(8)}, current=${p.toFixed(8)}, ` +
              `source=${source || 'unknown'}, thr=${absThreshold}%, step=${stepPercent}%)`
            );
            if (this.telegramService) {
              this.telegramService.sendVolatilityAlert(w.chatId, {
                symbol: sym, interval, oc, open, currentPrice: p,
                direction: oc >= 0 ? 'bullish' : 'bearish'
              }).catch(e => logger.error(`[Telegram] Failed to send alert to ${w.chatId}:`, e));
            }
            state.lastAlertTime = Date.now();
            state.lastAlertOcAbs = absOc;
            state.armed = false;
          }
        } else if (absOc < absThreshold * 0.6) {
          state.armed = true;
          state.lastAlertOcAbs = 0;
        }
      }
    }
  }
}

export const realtimeOCDetector = new RealtimeOCDetector();
