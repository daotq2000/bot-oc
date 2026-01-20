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
    
    // ✅ NEW: Periodic refresh of open price cache using IndicatorWarmup
    // This helps maintain accurate open prices even when WebSocket data is unavailable
    const refreshInterval = Number(configService.getNumber('OC_OPEN_PRICE_REFRESH_INTERVAL_MS', 5 * 60 * 1000)); // Default 5 minutes
    if (refreshInterval > 0) {
      setInterval(() => {
        this.refreshOpenPriceCache().catch(error => {
          logger.debug(`[RealtimeOCDetector] Failed to refresh open price cache: ${error?.message || error}`);
        });
      }, refreshInterval);
      logger.info(`[RealtimeOCDetector] ✅ Open price cache refresh enabled (interval: ${refreshInterval}ms)`);
    }
  }

  /**
   * ✅ NEW: Refresh open price cache for active symbols using IndicatorWarmup
   * This fetches latest candles and caches open prices without warmup indicators
   */
  async refreshOpenPriceCache() {
    try {
      const { IndicatorWarmup } = await import('../indicators/IndicatorWarmup.js');
      const { strategyCache } = await import('./StrategyCache.js');
      const warmupService = new IndicatorWarmup();

      // Get all active symbols from strategy cache
      await strategyCache.refresh();
      const symbols = new Set();
      const symbolIntervals = new Map(); // symbol -> Set<intervals>

      for (const [key, strategy] of strategyCache.cache.entries()) {
        const [exchange, symbol] = key.split('|');
        if (!exchange || !symbol) continue;
        if (String(exchange).toLowerCase() !== 'binance') continue; // Only Binance for now

        const symbolKey = `${exchange}|${symbol}`;
        if (!symbolIntervals.has(symbolKey)) {
          symbolIntervals.set(symbolKey, new Set());
        }
        const intervals = symbolIntervals.get(symbolKey);
        intervals.add(strategy.interval || '1m');
      }

      if (symbolIntervals.size === 0) {
        logger.debug(`[RealtimeOCDetector] No active symbols to refresh open price cache`);
        return;
      }

      // Convert to array format for fetchAndCacheOpenPrices
      const symbolsToRefresh = Array.from(symbolIntervals.entries()).map(([key, intervals]) => {
        const [exchange, symbol] = key.split('|');
        return {
          exchange: exchange || 'binance',
          symbol: symbol || '',
          intervals: Array.from(intervals)
        };
      });

      const concurrency = Number(configService.getNumber('OC_OPEN_PRICE_REFRESH_CONCURRENCY', 5));
      const results = await warmupService.fetchAndCacheOpenPrices(symbolsToRefresh, concurrency);

      logger.debug(
        `[RealtimeOCDetector] ✅ Open price cache refresh complete | ` +
        `Succeeded: ${results.succeeded} Failed: ${results.failed} | ` +
        `Symbols: ${symbolsToRefresh.length}`
      );
    } catch (error) {
      logger.debug(`[RealtimeOCDetector] Error refreshing open price cache: ${error?.message || error}`);
    }
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

        // 3) DISABLED: REST API fallback removed to prevent rate limiting
        // ⚠️ CRITICAL FIX: REST API was causing massive rate limit issues
        // - With 541 symbols and WebSocket failures, this created hundreds of requests/second
        // - Binance IP banned us for "Way too many requests"
        // - Solution: Rely only on WebSocket data + prev_close fallback
        // - WebSocket should be fixed to provide reliable data instead
        
        // If REST API fallback is absolutely needed, it must:
        // 1. Check if client is rate limited first
        // 2. Use aggressive caching (minutes, not seconds)
        // 3. Use centralized request scheduler
        // 4. Have circuit breaker that disables it when 429 detected
        
        // Keeping code commented for reference:
        /*
        const restFallbackEnabled = configService.getBoolean('OC_REST_FALLBACK_ENABLED', false);
        if (restFallbackEnabled) {
          try {
            const { BinanceDirectClient } = await import('./BinanceDirectClient.js');
            const binanceClient = new BinanceDirectClient(null, null, false, null);
            
            // Check if rate limited before making request
            if (binanceClient._rateLimitBlocked) {
              logger.debug(`[RealtimeOCDetector] Skipping REST fallback - rate limited`);
            } else {
              const intervalMs = this.getIntervalMs(interval);
              const endTime = bucketStart + intervalMs;
              const params = { symbol: sym, interval: interval, limit: 2, endTime: endTime };
              
              const klinesData = await binanceClient.makeMarketDataRequest('/fapi/v1/klines', 'GET', params);
              // ... rest of logic
            }
          } catch (restErr) {
            logger.debug(`[RealtimeOCDetector] REST API fallback failed: ${restErr?.message || restErr}`);
          }
        }
        */

        // 4) Fallback: previous bucket close as current bucket open (LAST RESORT)
        // ⚠️ WARNING: This is less accurate and may cause OC calculation errors
        const intervalMs = this.getIntervalMs(interval);
        const prevBucketStart = bucketStart - intervalMs;
        const prevClose = webSocketManager.getKlineClose(sym, interval, prevBucketStart);
        if (Number.isFinite(prevClose) && prevClose > 0) {
          logger.warn(
            `[RealtimeOCDetector] ⚠️ Using prev_close as open (less accurate) | ${sym} ${interval} ` +
            `bucketStart=${bucketStart} prevClose=${prevClose.toFixed(8)}`
          );
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
      const realtimeOCDetectorBinanceHandler = ({ symbol, price, ts }) => {
        this.onAlertTick('binance', symbol, price, ts).catch(error => {
          logger.error(`[RealtimeOCDetector] Error in Binance alert tick:`, error?.message || error);
        });
      };
      webSocketManager.onPrice(realtimeOCDetectorBinanceHandler);
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
        let { open, source } = await this.getAccurateOpen(w.exchange, sym, interval, p, ts);
        
        // ✅ CRITICAL FIX: Fallback to current price if getAccurateOpen fails
        // This ensures alerts still work even when WebSocket data is unavailable
        // OC will be 0% initially, but will update as price moves within the bucket
        if (!Number.isFinite(open) || open <= 0) {
          logger.debug(
            `[RealtimeOCDetector] ⚠️ getAccurateOpen failed for ${exchange.toUpperCase()} ${sym} ${interval}, ` +
            `using current price as fallback (OC will be 0% initially)`
          );
          open = p; // Use current price as fallback
          source = 'fallback_current_price';
        }

        const oc = ((p - open) / open) * 100;
        const absOc = Math.abs(oc);
        const absThreshold = Math.abs(Number(w.threshold || 0));
        if (absThreshold <= 0) continue;

        // Debug bucket info to verify OC vs nến thực tế
        // ✅ Changed to debug level to reduce log spam
        logger.debug(
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
                direction: oc >= 0 ? 'bullish' : 'bearish',
                exchange: w.exchange // ✅ FIX: Use w.exchange instead of undefined 'ex'
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

  /**
   * Detect OC and match with strategies for WebSocketOCConsumer
   * @param {string} exchange - Exchange name (e.g., 'binance', 'mexc')
   * @param {string} symbol - Symbol (e.g., 'BTCUSDT')
   * @param {number} price - Current price
   * @param {number} timestamp - Timestamp (default: Date.now())
   * @param {string} source - Source identifier (e.g., 'WebSocketOCConsumer')
   * @returns {Promise<Array>} Array of match objects: { strategy, oc, direction, currentPrice, interval, exchange, openPrice, timestamp }
   */
  async detectOC(exchange, symbol, price, timestamp = Date.now(), source = 'unknown') {
    try {
      const ex = (exchange || '').toLowerCase();
      const sym = String(symbol || '').toUpperCase().replace(/[/:_]/g, '');
      const p = Number(price);
      const ts = Number(timestamp) || Date.now();

      if (!ex || !sym || !Number.isFinite(p) || p <= 0) {
        return [];
      }

      // Get strategies for this exchange and symbol
      const strategies = strategyCache.getStrategies(ex, sym);
      if (!strategies || strategies.length === 0) {
        return [];
      }

      const matches = [];

      // Process each strategy
      for (const strategy of strategies) {
        // Skip inactive strategies
        if (!strategy.is_active || strategy.bot?.is_active === false) {
          continue;
        }

        // Get strategy interval
        const strategyInterval = String(strategy.interval || '1m').toLowerCase();
        if (!strategyInterval) {
          continue;
        }

        // Get accurate open price for this interval
        const { open, source: openSource } = await this.getAccurateOpen(ex, sym, strategyInterval, p, ts);
        if (!Number.isFinite(open) || open <= 0) {
          // Skip if we can't get open price
          continue;
        }

        // Calculate OC
        const oc = ((p - open) / open) * 100;
        const ocAbs = Math.abs(oc);
        const direction = oc >= 0 ? 'bullish' : 'bearish';

        // Check if OC meets strategy threshold
        const strategyOcThreshold = Number(strategy.oc || 0);
        if (ocAbs < strategyOcThreshold) {
          continue;
        }

        // Create match object
        matches.push({
          strategy,
          oc,
          direction,
          currentPrice: p,
          interval: strategyInterval,
          exchange: ex,
          openPrice: open,
          timestamp: ts
        });
      }

      return matches;
    } catch (error) {
      logger.error(`[RealtimeOCDetector] Error in detectOC for ${exchange} ${symbol}:`, error?.message || error);
      return [];
    }
  }

  /**
   * Get stats for monitoring
   */
  getStats() {
    return {
      openPriceCacheSize: this.openPriceCache.size,
      openFetchCacheSize: this.openFetchCache.size,
      alertStateSize: this.alertState.size,
      alertWatchersCount: this.alertWatchers?.length || 0
    };
  }
}

export const realtimeOCDetector = new RealtimeOCDetector();
