import logger from '../utils/logger.js';
import { Candle } from '../models/Candle.js';
import { configService } from './ConfigService.js';
import { webSocketManager } from './WebSocketManager.js';

/**
 * CandleService
 *
 * Single source of truth for historical candles with the following strategy:
 * 1) Aggregator-first (in-memory, from WebSocket ticks/klines)
 * 2) DB cache (candles table)
 * 3) REST fallback (BinanceDirectClient) - only when really needed
 */
class CandleService {
  constructor() {
    // REST rate limit / backoff is delegated to BinanceDirectClient
    this._rateLimitRetryDelay = Number(configService.getNumber('CANDLES_429_RETRY_DELAY_MS', 10000));
    this._rateLimitBackoffMultiplier = Number(configService.getNumber('CANDLES_429_BACKOFF_MULTIPLIER', 1.5));
  }

  /**
   * Normalize exchange name
   */
  _normalizeExchange(exchange) {
    const ex = String(exchange || '').toLowerCase();
    if (ex === 'binance' || !ex) return 'binance';
    return ex;
  }

  /**
   * Get recent candles from in-memory CandleAggregator
   * @param {string} exchange
   * @param {string} symbol
   * @param {string} interval
   * @param {number} limit
   * @returns {Array<{startTime:number,open:number,high:number,low:number,close:number,isClosed:boolean}>}
   */
  getFromAggregator(exchange, symbol, interval, limit = 100) {
    try {
      const ex = this._normalizeExchange(exchange);
      if (ex !== 'binance') return [];

      const aggregator = webSocketManager?.candleAggregator;
      if (!aggregator || typeof aggregator.getRecentCandles !== 'function') {
        return [];
      }

      const candles = aggregator.getRecentCandles(symbol, interval, limit) || [];

      return candles.map(c => ({
        startTime: Number(c.startTime),
        open: Number(c.open),
        high: Number(c.high),
        low: Number(c.low),
        close: Number(c.close),
        isClosed: c.isClosed === true
      })).filter(c =>
        Number.isFinite(c.startTime) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.open > 0 &&
        c.close > 0
      );
    } catch (e) {
      logger.debug(`[CandleService] getFromAggregator failed for ${exchange} ${symbol} ${interval}: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * Get candles from DB cache (candles table)
   */
  async getFromDb(exchange, symbol, interval, limit = 100) {
    try {
      const ex = this._normalizeExchange(exchange);
      const rows = await Candle.getCandles(ex, symbol, interval, limit);
      return rows.map(row => ({
        startTime: Number(row.open_time),
        open: Number(row.open),
        high: Number(row.high),
        low: Number(row.low),
        close: Number(row.close),
        isClosed: true
      })).filter(c =>
        Number.isFinite(c.startTime) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.open > 0 &&
        c.close > 0
      );
    } catch (e) {
      logger.warn(`[CandleService] getFromDb failed for ${exchange} ${symbol} ${interval}: ${e?.message || e}`);
      return [];
    }
  }

  /**
   * Fetch candles from REST (Binance futures API) as a last resort
   */
  async getFromRest(exchange, symbol, interval = '1m', limit = 100, options = {}) {
    const ex = this._normalizeExchange(exchange);
    if (ex !== 'binance') return [];

    const sym = String(symbol || '').toUpperCase();
    const intv = String(interval || '1m').toLowerCase();
    if (!sym) return [];

    const useLegacyFetch = configService.getBoolean('CANDLES_USE_LEGACY_FETCH', false);

    try {
      if (!useLegacyFetch) {
        const { BinanceDirectClient } = await import('./BinanceDirectClient.js');
        const client = new BinanceDirectClient(null, null, false, null);

        try {
          const params = { symbol: sym, interval: intv, limit };
          const data = await client.makeMarketDataRequest('/fapi/v1/klines', 'GET', params, options);

          // success: reset backoff
          this._rateLimitRetryDelay = Number(configService.getNumber('CANDLES_429_RETRY_DELAY_MS', 10000));

          return data.map(k => ({
            startTime: Number(k[0]),
            open: parseFloat(k[1]),
            high: parseFloat(k[2]),
            low: parseFloat(k[3]),
            close: parseFloat(k[4]),
            isClosed: true
          })).filter(c =>
            Number.isFinite(c.startTime) &&
            Number.isFinite(c.open) &&
            Number.isFinite(c.high) &&
            Number.isFinite(c.low) &&
            Number.isFinite(c.close) &&
            c.open > 0 &&
            c.close > 0
          );
        } catch (error) {
          if (error?.status === 429 || error?.code === 'RATE_LIMIT_BLOCKED' || /rate limit/i.test(error?.message || '')) {
            logger.error(
              `[CandleService] ⚠️ REST rate limit hit for ${symbol} ${interval}. ` +
              `Waiting ${this._rateLimitRetryDelay / 1000}s before retry...`
            );
            await new Promise(resolve => setTimeout(resolve, this._rateLimitRetryDelay));
            this._rateLimitRetryDelay = Math.min(
              this._rateLimitRetryDelay * this._rateLimitBackoffMultiplier,
              60000
            );
            return this.getFromRest(exchange, symbol, interval, limit);
          }
          throw error;
        }
      }

      // Legacy direct fetch as fallback
      const url = `https://fapi.binance.com/fapi/v1/klines?symbol=${sym}&interval=${intv}&limit=${limit}`;
      const controller = new AbortController();
      const timeoutMs = Number(configService.getNumber('BINANCE_MARKET_DATA_TIMEOUT_MS', 20000));
      const timeoutId = setTimeout(() => controller.abort(new Error(`Request timeout after ${timeoutMs}ms`)), timeoutMs);

      // Respect upstream abort if provided
      const externalSignal = options?.signal;
      let detachExternalAbort = null;
      if (externalSignal) {
        if (externalSignal.aborted) {
          controller.abort(externalSignal.reason);
        } else {
          const onAbort = () => controller.abort(externalSignal.reason);
          externalSignal.addEventListener('abort', onAbort, { once: true });
          detachExternalAbort = () => {
            try { externalSignal.removeEventListener('abort', onAbort); } catch (_) {}
          };
        }
      }

      const response = await fetch(url, {
        method: 'GET',
        headers: { 'Content-Type': 'application/json' },
        signal: controller.signal
      });

      clearTimeout(timeoutId);
      if (detachExternalAbort) detachExternalAbort();

      if (!response.ok) {
        if (response.status === 429) {
          logger.error(
            `[CandleService] ⚠️ REST rate limit hit for ${symbol} ${interval}. ` +
            `Waiting ${this._rateLimitRetryDelay / 1000}s before retry...`
          );
          await new Promise(resolve => setTimeout(resolve, this._rateLimitRetryDelay));
          this._rateLimitRetryDelay = Math.min(
            this._rateLimitRetryDelay * this._rateLimitBackoffMultiplier,
            60000
          );
          return this.getFromRest(exchange, symbol, interval, limit);
        }
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      this._rateLimitRetryDelay = Number(configService.getNumber('CANDLES_429_RETRY_DELAY_MS', 10000));

      const responseText = await response.text();
      let data;
      try {
        data = JSON.parse(responseText);
      } catch (e) {
        logger.error(`[CandleService] Failed to parse JSON from Binance API for ${symbol}. Response: ${responseText}`);
        throw new Error(`Failed to parse JSON from Binance API: ${e.message}`);
      }

      return data.map(k => ({
        startTime: Number(k[0]),
        open: parseFloat(k[1]),
        high: parseFloat(k[2]),
        low: parseFloat(k[3]),
        close: parseFloat(k[4]),
        isClosed: true
      })).filter(c =>
        Number.isFinite(c.startTime) &&
        Number.isFinite(c.open) &&
        Number.isFinite(c.high) &&
        Number.isFinite(c.low) &&
        Number.isFinite(c.close) &&
        c.open > 0 &&
        c.close > 0
      );
    } catch (error) {
      logger.warn(`[CandleService] REST fetch failed for ${exchange} ${symbol} ${interval}: ${error?.message || error}`);
      return [];
    }
  }

  /**
   * Persist candles to DB and feed into CandleAggregator
   */
  async _ingestAndPersist(exchange, symbol, interval, candles) {
    if (!candles || candles.length === 0) return;
    const ex = this._normalizeExchange(exchange);
    const sym = String(symbol || '').toUpperCase();
    const intv = String(interval || '1m').toLowerCase();

    try {
      // 1) Persist to DB
      const dbCandles = candles.map(c => ({
        exchange: ex,
        symbol: sym,
        interval: intv,
        open_time: c.startTime,
        open: c.open,
        high: c.high,
        low: c.low,
        close: c.close,
        volume: c.volume ?? 0
      }));
      await Candle.bulkInsert(dbCandles);
    } catch (e) {
      logger.warn(`[CandleService] bulkInsert failed for ${ex} ${sym} ${interval}: ${e?.message || e}`);
    }

    try {
      const aggregator = webSocketManager?.candleAggregator;
      if (!aggregator || typeof aggregator.ingestHistoricalCandles !== 'function') return;
      aggregator.ingestHistoricalCandles(sym, intv, candles);
    } catch (e) {
      logger.debug(`[CandleService] ingestHistoricalCandles failed for ${ex} ${sym} ${interval}: ${e?.message || e}`);
    }
  }

  /**
   * PUBLIC: Get historical candles with Aggregator-first / DB-fallback / REST-last
   * Always returns candles sorted oldest -> newest.
   */
  async getHistoricalCandles(exchange, symbol, interval, limit = 100, options = {}) {
    const ex = this._normalizeExchange(exchange);
    const sym = String(symbol || '').toUpperCase();
    const intv = String(interval || '1m').toLowerCase();
    const safeLimit = Math.max(1, Number(limit) || 100);

    // 1) Aggregator
    let aggCandles = this.getFromAggregator(ex, sym, intv, safeLimit);
    if (aggCandles.length >= safeLimit) {
      return aggCandles.slice(-safeLimit);
    }

    // 2) DB
    let dbCandles = await this.getFromDb(ex, sym, intv, safeLimit);
    let combined = [...dbCandles, ...aggCandles];

    // De-duplicate by startTime
    combined = combined
      .reduce((map, c) => {
        if (!map.has(c.startTime)) map.set(c.startTime, c);
        return map;
      }, new Map());
    let merged = Array.from(combined.values()).sort((a, b) => a.startTime - b.startTime);

    if (merged.length >= safeLimit) {
      return merged.slice(-safeLimit);
    }

    // 3) REST fallback: fetch missing candles
    const missing = safeLimit - merged.length;
    const restCandles = await this.getFromRest(ex, sym, intv, Math.max(missing, safeLimit), options);

    if (restCandles.length > 0) {
      await this._ingestAndPersist(ex, sym, intv, restCandles);

      // Merge again
      const mergedMap = new Map();
      for (const c of [...merged, ...restCandles]) {
        if (!mergedMap.has(c.startTime)) mergedMap.set(c.startTime, c);
      }
      merged = Array.from(mergedMap.values()).sort((a, b) => a.startTime - b.startTime);
    }

    if (merged.length === 0) {
      logger.warn(`[CandleService] No candles available for ${ex} ${sym} ${intv}`);
    }

    return merged.slice(-safeLimit);
  }
}

export const candleService = new CandleService();


