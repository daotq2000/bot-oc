import logger from '../utils/logger.js';
import { TrendIndicatorsState } from './TrendIndicatorsState.js';
import { configService } from '../services/ConfigService.js';
import { candleService } from '../services/CandleService.js';

/**
 * Pre-warm indicators using historical kline data from REST API.
 */
export class IndicatorWarmup {
  constructor() {
    this.warmupCandleCount1m = Number(configService.getNumber('INDICATORS_WARMUP_CANDLES_1M', 50));
    this.warmupCandleCount5m = Number(configService.getNumber('INDICATORS_WARMUP_CANDLES_5M', 0));
    this.warmupCandleCount15m = Number(configService.getNumber('INDICATORS_WARMUP_CANDLES_15M', 50));
    this.warmupTimeoutMs = Number(configService.getNumber('INDICATORS_WARMUP_TIMEOUT_MS', 30 * 1000));

    // Fast mode toggles
    this.fastModeEnabled = configService.getBoolean('INDICATORS_WARMUP_FAST_MODE', false);

    // Batch pacing
    const defaultDelay = this.fastModeEnabled ? 200 : 5000;
    this.batchDelayMs = Number(configService.getNumber('INDICATORS_WARMUP_BATCH_DELAY_MS', defaultDelay));
    this._lastBatchTime = 0;

    // Request throttling
    const defaultRpm = this.fastModeEnabled ? 900 : 400;
    this._maxRequestsPerMinute = Number(configService.getNumber('INDICATORS_WARMUP_MAX_REQUESTS_PER_MINUTE', defaultRpm));
    this._requestCount = 0;
    this._requestWindowStart = Date.now();
    this._requestWindowMs = 60 * 1000;

    // Exponential backoff
    this._rateLimitRetryDelay = Number(configService.getNumber('INDICATORS_WARMUP_429_RETRY_DELAY_MS', 10000));
    this._rateLimitBackoffMultiplier = Number(configService.getNumber('INDICATORS_WARMUP_429_BACKOFF_MULTIPLIER', 1.5));

    // Priority warmup
    this.prioritySymbols = this._parsePrioritySymbols(configService.getString('INDICATORS_WARMUP_PRIORITY_SYMBOLS', ''));
    this.priorityFirstOnlyCount = Number(configService.getNumber('INDICATORS_WARMUP_PRIORITY_ONLY_COUNT', 0));
  }

  _parsePrioritySymbols(s) {
    const raw = String(s || '')
      .split(',')
      .map(x => String(x).trim().toUpperCase())
      .filter(Boolean);
    return Array.from(new Set(raw));
  }

  async _checkAndThrottleRequests() {
    const now = Date.now();

    if (now - this._requestWindowStart >= this._requestWindowMs) {
      this._requestCount = 0;
      this._requestWindowStart = now;
    }

    if (this._requestCount >= this._maxRequestsPerMinute) {
      const waitTime = this._requestWindowMs - (now - this._requestWindowStart);
      if (waitTime > 0) {
        logger.warn(
          `[IndicatorWarmup] ⚠️ Rate limit approaching (${this._requestCount}/${this._maxRequestsPerMinute} requests). ` +
          `Waiting ${Math.ceil(waitTime / 1000)}s before next request...`
        );
        await new Promise(resolve => setTimeout(resolve, waitTime + 100));
        this._requestCount = 0;
        this._requestWindowStart = Date.now();
      }
    }

    this._requestCount++;
  }

  async fetchBinanceKlines(symbol, interval = '1m', limit = 100) {
    try {
      // Still keep local throttle counter to avoid overwhelming CandleService/REST
      await this._checkAndThrottleRequests();

      const sym = String(symbol || '').toUpperCase();
      const intv = String(interval || '1m').toLowerCase();
      if (!sym) return [];

      const candles = await candleService.getHistoricalCandles('binance', sym, intv, limit);
      return candles;
    } catch (error) {
      logger.warn(`[IndicatorWarmup] Failed to fetch ${interval} klines for ${symbol} via CandleService: ${error?.message || error}`);
      return [];
    }
  }

  async warmupSymbol(exchange, symbol, state) {
    const ex = String(exchange || '').toLowerCase();
    const sym = String(symbol || '').toUpperCase();

    if (ex !== 'binance') {
      logger.debug(`[IndicatorWarmup] Skipping warmup for ${ex} ${sym} (only Binance supported)`);
      return false;
    }

    try {
      const adxInterval = state?.adxInterval || '1m';
      const is15mState = adxInterval === '15m';
      const targetInterval = is15mState ? '15m' : '1m';
      const targetCount = is15mState ? this.warmupCandleCount15m : this.warmupCandleCount1m;

      const candles = await Promise.race([
        this.fetchBinanceKlines(sym, targetInterval, targetCount),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error(`${targetInterval} warmup timeout`)), this.warmupTimeoutMs)
        )
      ]).catch(err => {
        logger.warn(`[IndicatorWarmup] Failed to fetch ${targetInterval} candles for ${ex} ${sym}: ${err?.message || err}`);
        return [];
      });

      let candles5m = [];
      if (this.warmupCandleCount5m > 0 && !is15mState) {
        candles5m = await Promise.race([
          this.fetchBinanceKlines(sym, '5m', this.warmupCandleCount5m),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error('5m warmup timeout')), this.warmupTimeoutMs)
          )
        ]).catch(err => {
          logger.debug(`[IndicatorWarmup] Failed to fetch 5m candles for ${ex} ${sym}: ${err?.message || err}`);
          return [];
        });
      }

      if ((!candles || candles.length === 0) && (!candles5m || candles5m.length === 0)) {
        logger.warn(`[IndicatorWarmup] No candles fetched for ${ex} ${sym} (${targetInterval}=${candles?.length || 0}, 5m=${candles5m?.length || 0})`);
        return false;
      }

      // ✅ ENHANCED: Cache open prices from warmup candles to RealtimeOCDetector
      // This helps getAccurateOpen() work even when WebSocket data is unavailable
      await this._cacheOpenPricesFromCandles(ex, sym, candles, targetInterval);
      if (candles5m && candles5m.length > 0 && !is15mState) {
        await this._cacheOpenPricesFromCandles(ex, sym, candles5m, '5m');
      }

      let fedCount = 0;
      if (candles && candles.length > 0) {
        const intervalMs = is15mState ? 900000 : 60000;
        for (const candle of candles) {
          state.updateTick(candle.close, candle.startTime + intervalMs);
          state.updateClosedCandle(candle);
          fedCount++;
        }
      }

      if (candles5m && candles5m.length > 0 && !is15mState) {
        for (const candle of candles5m) {
          state.updateTick(candle.close, candle.startTime + 300000);
          fedCount++;
        }
      }

      return state.isWarmedUp && state.isWarmedUp();
    } catch (error) {
      logger.warn(`[IndicatorWarmup] Warmup failed for ${ex} ${sym}: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * ✅ NEW: Cache open prices from warmup candles to RealtimeOCDetector
   * This helps getAccurateOpen() work even when WebSocket data is unavailable
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {Array} candles - Array of candle objects
   * @param {string} interval - Interval (e.g., '1m', '5m', '15m')
   */
  async _cacheOpenPricesFromCandles(exchange, symbol, candles, interval) {
    try {
      if (!candles || candles.length === 0) return;

      const { realtimeOCDetector } = await import('../services/RealtimeOCDetector.js');
      const intervalMs = realtimeOCDetector.getIntervalMs(interval);
      if (!intervalMs) return;

      let cachedCount = 0;
      for (const candle of candles) {
        const bucketStart = Number(candle.startTime);
        if (!Number.isFinite(bucketStart) || bucketStart <= 0) continue;

        const open = Number(candle.open);
        if (!Number.isFinite(open) || open <= 0) continue;

        const key = `${exchange}|${symbol}|${interval}|${bucketStart}`;
        const now = Date.now();
        
        // Cache with source 'indicator_warmup' for tracking
        realtimeOCDetector.openPriceCache.set(key, {
          open,
          bucketStart,
          lastUpdate: now,
          source: 'indicator_warmup'
        });
        cachedCount++;
      }

      if (cachedCount > 0) {
        logger.debug(
          `[IndicatorWarmup] ✅ Cached ${cachedCount} open prices for ${exchange} ${symbol} ${interval} ` +
          `(from warmup candles)`
        );
      }
    } catch (error) {
      logger.debug(`[IndicatorWarmup] Failed to cache open prices: ${error?.message || error}`);
    }
  }

  _extractSymbolFromKey(key) {
    const parts = String(key || '').split('|');
    const rawSymbol = parts[1] || '';
    return String(rawSymbol).toUpperCase().replace(/_(15m|5m)$/i, '');
  }

  _extractExchangeFromKey(key) {
    const parts = String(key || '').split('|');
    return String(parts[0] || '').toLowerCase();
  }

  _isPriorityKey(key) {
    if (!this.prioritySymbols || this.prioritySymbols.length === 0) return false;
    const sym = this._extractSymbolFromKey(key);
    return this.prioritySymbols.includes(sym);
  }

  /**
   * ✅ NEW: Fetch and cache open prices for symbols (without warmup indicators)
   * Useful for periodic refresh of open price cache
   * @param {Array<{exchange: string, symbol: string, intervals: Array<string>}>} symbols - Array of symbol configs
   * @param {number} concurrency - Max concurrent requests
   * @returns {Promise<{succeeded: number, failed: number}>}
   */
  async fetchAndCacheOpenPrices(symbols, concurrency = 2) {
    const results = { succeeded: 0, failed: 0 };
    const startTime = Date.now();

    logger.info(
      `[IndicatorWarmup] 🚀 Starting open price cache refresh for ${symbols.length} symbols ` +
      `(concurrency=${concurrency})`
    );

    for (let i = 0; i < symbols.length; i += concurrency) {
      const batch = symbols.slice(i, i + concurrency);
      const batchIndex = Math.floor(i / concurrency) + 1;

      if (i > 0) {
        await this._checkAndThrottleRequests();
      }

      const batchResults = await Promise.allSettled(
        batch.map(async ({ exchange, symbol, intervals }) => {
          const ex = String(exchange || '').toLowerCase();
          const sym = String(symbol || '').toUpperCase();

          if (ex !== 'binance') {
            return false; // Only Binance supported
          }

          try {
            // Fetch latest candles for each interval
            for (const interval of intervals || ['1m']) {
              const candles = await this.fetchBinanceKlines(sym, interval, 2); // Fetch 2 latest candles
              if (candles && candles.length > 0) {
                await this._cacheOpenPricesFromCandles(ex, sym, candles, interval);
              }
            }
            return true;
          } catch (error) {
            logger.debug(`[IndicatorWarmup] Failed to cache open prices for ${ex} ${sym}: ${error?.message || error}`);
            return false;
          }
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value === true) {
          results.succeeded++;
        } else {
          results.failed++;
        }
      }

      if (batchIndex % 10 === 0 || batchIndex === Math.ceil(symbols.length / concurrency)) {
        logger.info(
          `[IndicatorWarmup] Open price cache refresh progress: ` +
          `batch ${batchIndex} | Succeeded: ${results.succeeded} Failed: ${results.failed}`
        );
      }
    }

    const duration = Math.round((Date.now() - startTime) / 1000);
    logger.info(
      `[IndicatorWarmup] ✅ Open price cache refresh complete | ` +
      `Succeeded: ${results.succeeded} Failed: ${results.failed} | Duration: ${duration}s`
    );

    return results;
  }

  /**
   * Warmup indicators for multiple symbols in parallel (with concurrency limit).
   *
   * ✅ ENHANCED:
   * - Priority warmup: warm INDICATORS_WARMUP_PRIORITY_SYMBOLS first
   * - Optional: warm only top N priority symbols (INDICATORS_WARMUP_PRIORITY_ONLY_COUNT)
   * - Fast mode: defaults to higher RPM and lower batch delay
   * - ✅ NEW: Automatically caches open prices from warmup candles
   */
  async warmupBatch(indicators, concurrency = 2) {
    const entriesAll = Array.from(indicators.entries());

    // Priority ordering
    const priority = [];
    const rest = [];
    for (const e of entriesAll) {
      const [key] = e;
      if (this._isPriorityKey(key)) priority.push(e);
      else rest.push(e);
    }

    let entries = priority.concat(rest);

    // If only warmup priority N states (useful during news)
    if (this.priorityFirstOnlyCount > 0) {
      const keep = entries.slice(0, this.priorityFirstOnlyCount);
      entries = keep;
      logger.info(`[IndicatorWarmup] Priority-only warmup enabled: keeping first ${entries.length} states`);
    } else if (priority.length > 0) {
      logger.info(`[IndicatorWarmup] Priority warmup: priorityStates=${priority.length} totalStates=${entriesAll.length}`);
    }

    const results = { succeeded: 0, failed: 0 };
    const totalBatches = Math.ceil(entries.length / concurrency);
    const startTime = Date.now();

    logger.info(
      `[IndicatorWarmup] 🚀 Starting warmup for ${entries.length} states in ${totalBatches} batches ` +
      `(concurrency=${concurrency}, delay=${this.batchDelayMs}ms between batches, rpmCap=${this._maxRequestsPerMinute}, fastMode=${this.fastModeEnabled})`
    );

    for (let i = 0; i < entries.length; i += concurrency) {
      const batchIndex = Math.floor(i / concurrency) + 1;
      const batch = entries.slice(i, i + concurrency);
      const elapsed = Math.round((Date.now() - startTime) / 1000);

      if (i > 0) {
        const now = Date.now();
        const timeSinceLastBatch = now - this._lastBatchTime;
        if (timeSinceLastBatch < this.batchDelayMs) {
          const delay = this.batchDelayMs - timeSinceLastBatch;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }

      if (batchIndex === 1 || batchIndex % 10 === 0) {
        logger.info(
          `[IndicatorWarmup] Processing batch ${batchIndex}/${totalBatches} (${batch.length} states) | ` +
          `Elapsed: ${elapsed}s | Requests in window: ${this._requestCount}/${this._maxRequestsPerMinute}`
        );
      }

      const batchResults = await Promise.allSettled(
        batch.map(([key, state]) => {
          const exchange = this._extractExchangeFromKey(key);
          const symbol = this._extractSymbolFromKey(key);
          return this.warmupSymbol(exchange, symbol, state);
        })
      );

      this._lastBatchTime = Date.now();

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value === true) {
          results.succeeded++;
        } else {
          results.failed++;
          if (result.status === 'rejected') {
            logger.warn(`[IndicatorWarmup] Batch warmup failed: ${result.reason?.message || result.reason}`);
          }
        }
      }

      if (batchIndex % 10 === 0 || batchIndex === totalBatches) {
        const progress = ((batchIndex / totalBatches) * 100).toFixed(1);
        logger.info(
          `[IndicatorWarmup] Progress: ${progress}% (${batchIndex}/${totalBatches} batches) | ` +
          `Succeeded: ${results.succeeded} Failed: ${results.failed}`
        );
      }
    }

    const totalDuration = Math.round((Date.now() - startTime) / 1000);
    logger.info(
      `[IndicatorWarmup] ✅ Warmup complete | ` +
      `Total: ${entries.length} states | Succeeded: ${results.succeeded} Failed: ${results.failed} | ` +
      `Duration: ${totalDuration}s (${Math.round(totalDuration / 60)}m ${totalDuration % 60}s)`
    );

    return results;
  }
}
