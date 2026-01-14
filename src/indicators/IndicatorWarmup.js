import logger from '../utils/logger.js';
import { TrendIndicatorsState } from './TrendIndicatorsState.js';

/**
 * Pre-warm indicators using historical kline data from REST API.
 * 
 * WHY: ADX(14) needs ~28 closed candles to be reliable. Without warmup,
 * bot will skip entries for ~30 minutes after restart (adx_not_ready).
 * 
 * This fetches ~100 closed 1m candles and ~100 closed 5m candles from public REST API (no auth needed)
 * and feeds them into indicator state to achieve "ready" status immediately.
 * 
 * - 1m candles: Used for ADX calculation (if state uses 1m interval) and EMA/RSI ticks
 * - 5m candles: Used for additional EMA/RSI ticks (better warmup) and future 5m ADX support
 */
export class IndicatorWarmup {
  constructor() {
    this.warmupCandleCount1m = 100; // Enough for ADX(14) + buffer (1m)
    this.warmupCandleCount5m = 100; // Enough for ADX(14) + buffer (5m)
    this.warmupTimeoutMs = 30 * 1000; // 30s timeout per symbol
  }

  /**
   * Fetch historical klines from Binance Futures public API.
   * @param {string} symbol - Symbol (e.g., 'BTCUSDT')
   * @param {string} interval - Interval ('1m', '5m', etc.)
   * @param {number} limit - Number of candles (default: 100)
   * @returns {Promise<Array>} Array of { startTime, open, high, low, close, isClosed: true }
   */
  async fetchBinanceKlines(symbol, interval = '1m', limit = 100) {
    try {
      const sym = String(symbol || '').toUpperCase();
      const intv = String(interval || '1m').toLowerCase();
      if (!sym) return [];

      // Binance Futures public klines endpoint (no auth required)
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${intv}&limit=${limit}`;
      
      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const data = await response.json();
      
      // Binance klines format: [openTime, open, high, low, close, volume, closeTime, ...]
      // We only need OHLC + timestamps
      return data.map(k => ({
        startTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        isClosed: true // Historical klines are always closed
      })).filter(c => 
        Number.isFinite(c.startTime) && 
        Number.isFinite(c.open) && 
        Number.isFinite(c.high) && 
        Number.isFinite(c.low) && 
        Number.isFinite(c.close) &&
        c.open > 0 && c.close > 0
      );
    } catch (error) {
      logger.warn(`[IndicatorWarmup] Failed to fetch ${interval} klines for ${symbol}: ${error?.message || error}`);
      return [];
    }
  }

  /**
   * Warmup a single symbol's indicators.
   * @param {string} exchange - Exchange name ('binance' or 'mexc')
   * @param {string} symbol - Symbol
   * @param {TrendIndicatorsState} state - Indicator state to warmup
   * @returns {Promise<boolean>} True if warmup succeeded
   */
  async warmupSymbol(exchange, symbol, state) {
    const ex = String(exchange || '').toLowerCase();
    const sym = String(symbol || '').toUpperCase();
    
    if (ex !== 'binance') {
      // MEXC warmup not implemented yet (needs MEXC public kline endpoint)
      logger.debug(`[IndicatorWarmup] Skipping warmup for ${ex} ${sym} (only Binance supported)`);
      return false;
    }

    try {
      // Fetch both 1m and 5m candles in parallel
      const [candles1m, candles5m] = await Promise.all([
        Promise.race([
          this.fetchBinanceKlines(sym, '1m', this.warmupCandleCount1m),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('1m warmup timeout')), this.warmupTimeoutMs)
          )
        ]),
        Promise.race([
          this.fetchBinanceKlines(sym, '5m', this.warmupCandleCount5m),
          new Promise((_, reject) => 
            setTimeout(() => reject(new Error('5m warmup timeout')), this.warmupTimeoutMs)
          )
        ])
      ]);

      if ((!candles1m || candles1m.length === 0) && (!candles5m || candles5m.length === 0)) {
        logger.warn(`[IndicatorWarmup] No candles fetched for ${ex} ${sym} (1m=${candles1m?.length || 0}, 5m=${candles5m?.length || 0})`);
        return false;
      }

      // Feed 1m candles in chronological order (oldest first)
      // This ensures indicators compute correctly (ADX needs previous candle for TR/DM)
      // 1m candles: Update EMA/RSI with close price (treating each candle close as a tick)
      //             Update ADX with closed candle (if state uses 1m interval)
      let fed1mCount = 0;
      if (candles1m && candles1m.length > 0) {
        for (const candle of candles1m) {
          // Update EMA/RSI with close price (treating each candle close as a tick)
          state.updateTick(candle.close, candle.startTime + 60000); // Use close time as tick timestamp
          
          // Update ADX with closed candle (if state uses 1m interval)
          state.updateClosedCandle(candle);
          fed1mCount++;
        }
      }

      // Feed 5m candles for additional context (if state supports 5m or for future use)
      // Note: Currently TrendIndicatorsState uses 1m interval for ADX, but we feed 5m for completeness
      // If you want to use 5m ADX, you'd need to create a separate state or modify TrendIndicatorsState
      let fed5mCount = 0;
      if (candles5m && candles5m.length > 0) {
        // For now, we only use 5m candles to update EMA/RSI with more granular ticks
        // (5m close prices as additional ticks for smoother EMA/RSI)
        for (const candle of candles5m) {
          // Update EMA/RSI with 5m close price (additional ticks for better warmup)
          state.updateTick(candle.close, candle.startTime + 300000); // Use close time as tick timestamp (5m = 300000ms)
          fed5mCount++;
        }
      }

      const fedCount = fed1mCount + fed5mCount;

      const snap = state.snapshot();
      const isReady = Number.isFinite(snap.ema20) && 
                      Number.isFinite(snap.ema50) && 
                      Number.isFinite(snap.rsi14) && 
                      Number.isFinite(snap.adx14);

      if (isReady) {
        logger.info(
          `[IndicatorWarmup] ✅ Warmup complete for ${ex} ${sym} | ` +
          `fed=1m:${fed1mCount} 5m:${fed5mCount} total:${fedCount} | ` +
          `EMA20=${snap.ema20?.toFixed(2) || 'N/A'} EMA50=${snap.ema50?.toFixed(2) || 'N/A'} ` +
          `RSI=${snap.rsi14?.toFixed(1) || 'N/A'} ADX=${snap.adx14?.toFixed(1) || 'N/A'}`
        );
      } else {
        logger.warn(
          `[IndicatorWarmup] ⚠️ Warmup incomplete for ${ex} ${sym} | ` +
          `fed=1m:${fed1mCount} 5m:${fed5mCount} total:${fedCount} | ` +
          `EMA20=${snap.ema20?.toFixed(2) || 'null'} EMA50=${snap.ema50?.toFixed(2) || 'null'} ` +
          `RSI=${snap.rsi14?.toFixed(1) || 'null'} ADX=${snap.adx14?.toFixed(1) || 'null'}`
        );
      }

      return isReady;
    } catch (error) {
      logger.warn(`[IndicatorWarmup] Warmup failed for ${ex} ${sym}: ${error?.message || error}`);
      return false;
    }
  }

  /**
   * Warmup indicators for multiple symbols in parallel (with concurrency limit).
   * @param {Map<string, TrendIndicatorsState>} indicators - Map of exchange|symbol -> state
   * @param {number} concurrency - Max parallel warmups (default: 5)
   * @returns {Promise<{ succeeded: number, failed: number }>}
   */
  async warmupBatch(indicators, concurrency = 5) {
    const entries = Array.from(indicators.entries());
    const results = { succeeded: 0, failed: 0 };

    for (let i = 0; i < entries.length; i += concurrency) {
      const batch = entries.slice(i, i + concurrency);
      const batchResults = await Promise.allSettled(
        batch.map(([key, state]) => {
          const [exchange, symbol] = key.split('|');
          return this.warmupSymbol(exchange, symbol, state);
        })
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled' && result.value === true) {
          results.succeeded++;
        } else {
          results.failed++;
        }
      }
    }

    return results;
  }
}

