import { realtimeOCDetector } from '../services/RealtimeOCDetector.js';
import { strategyCache } from '../services/StrategyCache.js';
import { OrderService } from '../services/OrderService.js';
import { mexcPriceWs } from '../services/MexcWebSocketManager.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';
import { TrendIndicatorsState } from '../indicators/TrendIndicatorsState.js';
import { isTrendConfirmed } from '../indicators/trendFilter.js';
import { IndicatorWarmup } from '../indicators/IndicatorWarmup.js';
import { checkPullbackConfirmation, checkVolatilityFilter } from '../indicators/entryFilters.js';
import {
  calculateTakeProfit,
  calculateInitialStopLoss,
  calculateInitialStopLossByAmount,
  calculateLongEntryPrice,
  calculateShortEntryPrice
} from '../utils/calculator.js';
import { determineSide } from '../utils/sideSelector.js';
import { Position } from '../models/Position.js';
import { shouldLogSampled } from '../utils/logGate.js';

/**
 * WebSocketOCConsumer
 * 
 * Consumer WebSocket price ticks và detect OC realtime.
 * Trigger orders ngay lập tức khi match strategy.
 * 
 * Flow:
 * 1. Subscribe WebSocket cho tất cả symbols trong strategy cache
 * 2. Khi có price tick → detect OC
 * 3. Nếu match strategy → trigger order ngay lập tức
 * 4. Không sử dụng database candles
 */
export class WebSocketOCConsumer {
  constructor() {
    this.orderServices = new Map(); // botId -> OrderService
    this.isRunning = false;
    this.subscriptionInterval = null;
    this.cleanupInterval = null;
    this.processedCount = 0;
    this.matchCount = 0;
    this.skippedCount = 0; // Track skipped ticks due to throttling
    
    // ✅ MONITORING: Stats for OC scanning performance
    this._stats = {
      ticksReceived: 0,
      ticksProcessed: 0,
      ticksDropped: 0,
      matchesFound: 0,
      matchesProcessed: 0,
      lastTickAt: 0,
      lastProcessedAt: 0,
      lastMatchAt: 0,
      queueSize: 0,
      maxQueueSize: 0,
      avgProcessingTime: 0,
      processingTimeSamples: []
    };
    this._statsLogInterval = Number(configService.getNumber('OC_SCAN_STATS_LOG_INTERVAL_MS', 60000)); // 1 minute
    this._lastStatsLogAt = 0;
    this._startStatsLogger();
    
    // Cache for open positions to avoid excessive DB queries
    this.openPositionsCache = new Map(); // strategyId -> { hasOpenPosition: boolean, lastCheck: timestamp }
    this.openPositionsCacheTTL = 5000; // 5 seconds TTL
    
    // ✅ TRIỆT ĐỂ FIX: Debounce ticks per symbol to handle high-frequency streams (bookTicker)
    // This ensures only the latest tick in a burst is processed, reducing load significantly.
    this._debounceTimers = new Map(); // key -> timerId
    this._debounceInterval = Number(configService.getNumber('WS_OC_DEBOUNCE_MS', 200));
    
    // ✅ RATE LIMIT PROTECTION: Cooldown mechanism to prevent API rate limits
    this._processingQueue = []; // Queue of ticks waiting to be processed
    this._processing = false; // Flag to indicate if currently processing
    this._lastProcessedAt = 0; // Timestamp of last processed tick
    this._cooldownMs = Number(configService.getNumber('WS_OC_COOLDOWN_MS', 50)); // Minimum time between processing ticks
    this._maxConcurrent = Number(configService.getNumber('WS_OC_MAX_CONCURRENT', 3)); // Max concurrent detections
    this._activeDetections = 0; // Number of active detection operations

    // SHORT-TERM trend indicators cache (FOLLOWING_TREND filter only)
    this._trendIndicators = new Map(); // exchange|symbol -> { state, lastTs, warmedUp }
    this._trendIndicatorsTTL = Number(configService.getNumber('TREND_INDICATORS_TTL_MS', 30 * 60 * 1000));
    this._trendIndicatorsCleanupEveryMs = Number(configService.getNumber('TREND_INDICATORS_CLEANUP_MS', 5 * 60 * 1000));
    this._trendIndicatorsLastCleanupAt = 0;

    // ✅ ENHANCED: 15m trend indicators cache for multi-timeframe gate
    this._trendIndicators15m = new Map(); // exchange|symbol -> { state, lastTs, warmedUp, lastClosed15mStart }
    this._trendIndicators15mTTL = Number(configService.getNumber('TREND_INDICATORS_15M_TTL_MS', 30 * 60 * 1000));
    this._trendIndicators15mCleanupEveryMs = Number(configService.getNumber('TREND_INDICATORS_15M_CLEANUP_MS', 5 * 60 * 1000));
    this._trendIndicators15mLastCleanupAt = 0;
    this._warmedUpSymbols15m = new Set();

    // ✅ ENHANCED: 5m trend indicators cache for pullback confirmation
    this._trendIndicators5m = new Map(); // exchange|symbol -> { state, lastTs, warmedUp, lastClosed5mStart }
    this._trendIndicators5mTTL = Number(configService.getNumber('TREND_INDICATORS_5M_TTL_MS', 30 * 60 * 1000));
    this._trendIndicators5mCleanupEveryMs = Number(configService.getNumber('TREND_INDICATORS_5M_CLEANUP_MS', 5 * 60 * 1000));
    this._trendIndicators5mLastCleanupAt = 0;
    this._warmedUpSymbols5m = new Set();

    // Pre-warm service (Option C: REST snapshot to achieve "ready" status quickly)
    // ✅ OPTIMIZED: Giảm concurrency để tránh rate limit (chấp nhận warmup trong 5-10 phút)
    this._warmupService = new IndicatorWarmup();
    this._warmupEnabled = configService.getBoolean('INDICATORS_WARMUP_ENABLED', true);
    this._warmupConcurrency = Number(configService.getNumber('INDICATORS_WARMUP_CONCURRENCY', 2)); // Giảm từ 5 xuống 2
    
    // Track which symbols have been warmed up (to avoid re-warming)
    this._warmedUpSymbols = new Set(); // exchange|symbol keys
  }

  /**
   * ✅ MONITORING: Start periodic stats logger
   */
  _startStatsLogger() {
    setInterval(() => {
      const now = Date.now();
      if (now - this._lastStatsLogAt < this._statsLogInterval) return;
      this._lastStatsLogAt = now;

      const stats = this._stats;
      const timeSinceLastTick = stats.lastTickAt > 0 ? now - stats.lastTickAt : null;
      const timeSinceLastProcessed = stats.lastProcessedAt > 0 ? now - stats.lastProcessedAt : null;
      const timeSinceLastMatch = stats.lastMatchAt > 0 ? now - stats.lastMatchAt : null;
      
      // Calculate average processing time
      let avgProcessingTime = 0;
      if (stats.processingTimeSamples.length > 0) {
        const sum = stats.processingTimeSamples.reduce((a, b) => a + b, 0);
        avgProcessingTime = sum / stats.processingTimeSamples.length;
        // Keep only last 100 samples
        if (stats.processingTimeSamples.length > 100) {
          stats.processingTimeSamples = stats.processingTimeSamples.slice(-100);
        }
      }

      logger.info(
        `[WebSocketOCConsumer] 📊 OC Scan Stats | ` +
        `ticks: received=${stats.ticksReceived} processed=${stats.ticksProcessed} dropped=${stats.ticksDropped} ` +
        `matches: found=${stats.matchesFound} processed=${stats.matchesProcessed} ` +
        `queue: size=${this._processingQueue.length} max=${stats.maxQueueSize} ` +
        `active=${this._activeDetections}/${this._maxConcurrent} ` +
        `avgProcTime=${avgProcessingTime.toFixed(1)}ms ` +
        `lastTick=${timeSinceLastTick !== null ? Math.round(timeSinceLastTick / 1000) + 's ago' : 'never'} ` +
        `lastProcessed=${timeSinceLastProcessed !== null ? Math.round(timeSinceLastProcessed / 1000) + 's ago' : 'never'} ` +
        `lastMatch=${timeSinceLastMatch !== null ? Math.round(timeSinceLastMatch / 1000) + 's ago' : 'never'}`
      );

      // Reset max queue size for next interval
      stats.maxQueueSize = 0;
    }, 10000); // Check every 10 seconds
  }

  /**
   * Initialize consumer
   * @param {Map<number, OrderService>} orderServices - Map of botId -> OrderService
   */
  async initialize(orderServices = new Map()) {
    try {
      this.orderServices = orderServices;
      
      logger.info(`[WebSocketOCConsumer] Initializing with ${orderServices.size} OrderServices: ${Array.from(orderServices.keys()).join(', ')}`);

      // Refresh strategy cache
      await strategyCache.refresh();

      // Subscribe WebSocket for all strategy symbols
      await this.subscribeWebSockets();

      // Setup periodic subscription refresh
      const subscriptionInterval = configService.getNumber('WS_OC_SUBSCRIBE_INTERVAL_MS', 60000);
      this.subscriptionInterval = setInterval(() => {
        this.subscribeWebSockets().catch(error => {
          logger.error('[WebSocketOCConsumer] Failed to refresh subscriptions:', error?.message || error);
        });
      }, subscriptionInterval);

      // Setup periodic cache cleanup
      this.cleanupInterval = setInterval(() => {
        if (realtimeOCDetector && typeof realtimeOCDetector.cleanup === 'function') {
          realtimeOCDetector.cleanup();
        }
      }, 300000); // Every 5 minutes

      // Register WebSocket price handlers (register before start to ensure handlers are set up)
      this.registerPriceHandlers();

      // ✅ Pre-warm indicators for all subscribed symbols (Option C: REST snapshot)
      // WHY: ADX(14) needs ~28 closed candles. Without warmup, bot skips entries for ~30min after restart.
      // This fetches ~100 closed 1m candles from public REST API and feeds into indicator state.
      if (this._warmupEnabled) {
        await this._warmupIndicatorsForSubscribedSymbols();
      }

      logger.info(`[WebSocketOCConsumer] ✅ Initialized successfully (isRunning=${this.isRunning}, orderServices=${this.orderServices.size})`);
    } catch (error) {
      logger.error('[WebSocketOCConsumer] ❌ Failed to initialize:', error?.message || error);
    }
  }

  /**
   * Register WebSocket price handlers
   */
  registerPriceHandlers() {
    // MEXC WebSocket handler
    try {
      const mexcHandler = ({ symbol, price, ts }) => {
        // Don't check isRunning here - let handlePriceTick check it
        // This allows handler to be registered even if consumer not started yet
        this.handlePriceTick('mexc', symbol, price, ts).catch(error => {
          logger.error(`[WebSocketOCConsumer] Error handling MEXC price tick:`, error?.message || error);
        });
      };
      mexcPriceWs.onPrice?.(mexcHandler);
      logger.info('[WebSocketOCConsumer] Registered MEXC WebSocket price handler');
    } catch (error) {
      logger.warn('[WebSocketOCConsumer] Failed to register MEXC handler:', error?.message || error);
    }

    // Binance WebSocket handler
    try {
      const webSocketOCConsumerBinanceHandler = ({ symbol, price, ts }) => {
        // Don't check isRunning here - let handlePriceTick check it
        // This allows handler to be registered even if consumer not started yet
        this.handlePriceTick('binance', symbol, price, ts).catch(error => {
          logger.error(`[WebSocketOCConsumer] Error handling Binance price tick:`, error?.message || error);
        });
      };
      webSocketManager.onPrice?.(webSocketOCConsumerBinanceHandler);
      logger.info('[WebSocketOCConsumer] Registered Binance WebSocket price handler');
    } catch (error) {
      logger.warn('[WebSocketOCConsumer] Failed to register Binance handler:', error?.message || error);
    }
  }

  /**
   * Handle price tick from WebSocket
   * ✅ OPTIMIZED: Batch processing + throttling
   * @param {string} exchange - Exchange name
   * @param {string} symbol - Symbol
   * @param {number} price - Current price
   * @param {number} timestamp - Event timestamp
   */
  _getTrendKey(exchange, symbol) {
    return `${String(exchange || '').toLowerCase()}|${String(symbol || '').toUpperCase()}`;
  }

  _getOrCreateTrendIndicators(exchange, symbol) {
    const key = this._getTrendKey(exchange, symbol);
    const now = Date.now();
    let cached = this._trendIndicators.get(key);
    if (!cached) {
      cached = { 
        state: new TrendIndicatorsState({ adxInterval: '1m' }), 
        lastTs: now, 
        lastClosed1mStart: null,
        warmedUp: false
      };
      this._trendIndicators.set(key, cached);
      return cached;
    }
    cached.lastTs = now;
    return cached;
  }

  /**
   * ✅ ENHANCED: Get or create 15m trend indicators for multi-timeframe gate
   */
  _getOrCreateTrendIndicators15m(exchange, symbol) {
    const key = this._getTrendKey(exchange, symbol);
    const now = Date.now();
    let cached = this._trendIndicators15m.get(key);
    if (!cached) {
      cached = { 
        state: new TrendIndicatorsState({ adxInterval: '15m' }), 
        lastTs: now, 
        lastClosed15mStart: null,
        warmedUp: false
      };
      this._trendIndicators15m.set(key, cached);
      return cached;
    }
    cached.lastTs = now;
    return cached;
  }

  /**
   * ✅ ENHANCED: Get or create 5m trend indicators for pullback confirmation
   */
  _getOrCreateTrendIndicators5m(exchange, symbol) {
    const key = this._getTrendKey(exchange, symbol);
    const now = Date.now();
    let cached = this._trendIndicators5m.get(key);
    if (!cached) {
      cached = {
        state: new TrendIndicatorsState({ adxInterval: '5m' }),
        lastTs: now,
        lastClosed5mStart: null,
        warmedUp: false
      };
      this._trendIndicators5m.set(key, cached);
      return cached;
    }
    cached.lastTs = now;
    return cached;
  }

  _cleanupTrendIndicatorsIfNeeded(now = Date.now()) {
    if (now - (this._trendIndicatorsLastCleanupAt || 0) < this._trendIndicatorsCleanupEveryMs) return;
    this._trendIndicatorsLastCleanupAt = now;
    for (const [k, v] of this._trendIndicators.entries()) {
      const last = Number(v?.lastTs || 0);
      if (!last || (now - last) > this._trendIndicatorsTTL) {
        this._trendIndicators.delete(k);
      }
    }
  }

  /**
   * Pre-warm indicators for all symbols that will be subscribed.
   * Fetches ~100 closed 1m candles from Binance public REST API and feeds into indicator state.
   * This achieves "ready" status immediately instead of waiting ~30 minutes for ADX warmup.
   */
  async _warmupIndicatorsForSubscribedSymbols() {
    try {
      // ✅ SOLUTION 3: Chỉ warmup symbols đang active (có strategies trong cache)
      // Get all symbols from strategy cache (these are the ones we'll subscribe to)
      await strategyCache.refresh();
      
      const symbolsToWarmup = new Map(); // exchange|symbol -> state
      const skippedReasons = { notBinance: 0, counterTrend: 0, alreadyWarmed: 0 };
      
      for (const [key, strategy] of strategyCache.cache.entries()) {
        const [exchange, symbol] = key.split('|');
        if (!exchange || !symbol) continue;
        
        // Only warmup Binance for now (MEXC needs separate endpoint)
        if (String(exchange).toLowerCase() !== 'binance') {
          skippedReasons.notBinance++;
          continue;
        }
        
        // Only warmup if strategy is FOLLOWING_TREND (is_reverse_strategy=false)
        // Counter-trend strategies don't use trend filters, so no need to warmup
        if (Boolean(strategy.is_reverse_strategy) === true) {
          skippedReasons.counterTrend++;
          continue;
        }
        
        // Check if already warmed up
        const warmupKey = this._getTrendKey(exchange, symbol);
        if (this._warmedUpSymbols.has(warmupKey)) {
          skippedReasons.alreadyWarmed++;
          continue;
        }
        
        const state = this._getOrCreateTrendIndicators(exchange, symbol);
        symbolsToWarmup.set(warmupKey, state.state);
        
        // ✅ ENHANCED: Also warmup 15m state for multi-timeframe gate
        const state15m = this._getOrCreateTrendIndicators15m(exchange, symbol);
        const warmupKey15m = `${warmupKey}_15m`;
        symbolsToWarmup.set(warmupKey15m, state15m.state);

        // ✅ ENHANCED: Also warmup 5m state for pullback confirmation
        const state5m = this._getOrCreateTrendIndicators5m(exchange, symbol);
        const warmupKey5m = `${warmupKey}_5m`;
        symbolsToWarmup.set(warmupKey5m, state5m.state);
      }

      if (symbolsToWarmup.size === 0) {
        logger.info(
          `[WebSocketOCConsumer] No symbols to warmup | ` +
          `skipped: notBinance=${skippedReasons.notBinance} counterTrend=${skippedReasons.counterTrend} alreadyWarmed=${skippedReasons.alreadyWarmed}`
        );
        return;
      }

      logger.info(
        `[WebSocketOCConsumer] 🔥 Starting indicator warmup for ${symbolsToWarmup.size} states (1m + 15m) | ` +
        `skipped: notBinance=${skippedReasons.notBinance} counterTrend=${skippedReasons.counterTrend} alreadyWarmed=${skippedReasons.alreadyWarmed}`
      );
      const warmupStart = Date.now();

      const results = await this._warmupService.warmupBatch(symbolsToWarmup, this._warmupConcurrency);

      // Mark symbols as warmed up
      for (const [key, state] of symbolsToWarmup.entries()) {
        if (state.isWarmedUp && state.isWarmedUp()) {
          if (key.endsWith('_15m')) {
            // 15m state
            const baseKey = key.replace('_15m', '');
            this._warmedUpSymbols15m.add(baseKey);
            const cached = this._trendIndicators15m.get(baseKey);
            if (cached) cached.warmedUp = true;
          } else if (key.endsWith('_5m')) {
            // 5m state
            const baseKey = key.replace('_5m', '');
            this._warmedUpSymbols5m.add(baseKey);
            const cached = this._trendIndicators5m.get(baseKey);
            if (cached) cached.warmedUp = true;
          } else {
            // 1m state
            this._warmedUpSymbols.add(key);
            const cached = this._trendIndicators.get(key);
            if (cached) cached.warmedUp = true;
          }
        }
      }

      const warmupDuration = Date.now() - warmupStart;
      logger.info(
        `[WebSocketOCConsumer] ✅ Indicator warmup complete | ` +
        `succeeded=${results.succeeded} failed=${results.failed} ` +
        `duration=${warmupDuration}ms`
      );
    } catch (error) {
      // Non-blocking: if warmup fails, indicators will warmup progressively from live ticks
      logger.warn(`[WebSocketOCConsumer] Indicator warmup failed (non-blocking): ${error?.message || error}`);
    }
  }

  /**
   * Warmup indicators for newly added FOLLOWING_TREND strategies.
   * Called automatically when subscribeWebSockets() detects new symbols.
   * Only warms up symbols that haven't been warmed up yet.
   */
  async _warmupNewSymbols() {
    if (!this._warmupEnabled) return;

    try {
      // ✅ SOLUTION 3: Chỉ warmup symbols mới đang active
      const symbolsToWarmup = new Map(); // exchange|symbol -> state
      const skippedReasons = { notBinance: 0, counterTrend: 0, alreadyWarmed: 0 };
      
      for (const [key, strategy] of strategyCache.cache.entries()) {
        const [exchange, symbol] = key.split('|');
        if (!exchange || !symbol) continue;
        
        // Only warmup Binance for now (MEXC needs separate endpoint)
        if (String(exchange).toLowerCase() !== 'binance') {
          skippedReasons.notBinance++;
          continue;
        }
        
        // Only warmup if strategy is FOLLOWING_TREND (is_reverse_strategy=false)
        if (Boolean(strategy.is_reverse_strategy) === true) {
          skippedReasons.counterTrend++;
          continue;
        }
        
        const warmupKey = this._getTrendKey(exchange, symbol);
        
        // Skip if already warmed up
        if (this._warmedUpSymbols.has(warmupKey)) {
          skippedReasons.alreadyWarmed++;
          continue;
        }
        
        // Check if indicator state exists and is already warmed up
        const cached = this._trendIndicators.get(warmupKey);
        if (cached && cached.warmedUp) {
          this._warmedUpSymbols.add(warmupKey);
          skippedReasons.alreadyWarmed++;
          continue;
        }
        
        // Get or create indicator state
        const state = this._getOrCreateTrendIndicators(exchange, symbol);
        symbolsToWarmup.set(warmupKey, state.state);
        
        // ✅ ENHANCED: Also warmup 15m state for multi-timeframe gate
        const state15m = this._getOrCreateTrendIndicators15m(exchange, symbol);
        const warmupKey15m = `${warmupKey}_15m`;
        symbolsToWarmup.set(warmupKey15m, state15m.state);
      }

      if (symbolsToWarmup.size === 0) {
        logger.debug(
          `[WebSocketOCConsumer] No new symbols to warmup | ` +
          `skipped: notBinance=${skippedReasons.notBinance} counterTrend=${skippedReasons.counterTrend} alreadyWarmed=${skippedReasons.alreadyWarmed}`
        );
        return; // No new symbols to warmup
      }

      logger.info(
        `[WebSocketOCConsumer] 🔥 Warming up ${symbolsToWarmup.size} new states (1m + 15m) | ` +
        `skipped: notBinance=${skippedReasons.notBinance} counterTrend=${skippedReasons.counterTrend} alreadyWarmed=${skippedReasons.alreadyWarmed}`
      );
      const warmupStart = Date.now();

      const results = await this._warmupService.warmupBatch(symbolsToWarmup, this._warmupConcurrency);

      // Mark symbols as warmed up
      for (const [key, state] of symbolsToWarmup.entries()) {
        if (state.isWarmedUp && state.isWarmedUp()) {
          if (key.endsWith('_15m')) {
            // 15m state
            const baseKey = key.replace('_15m', '');
            this._warmedUpSymbols15m.add(baseKey);
            const cached = this._trendIndicators15m.get(baseKey);
            if (cached) cached.warmedUp = true;
          } else {
            // 1m state
            this._warmedUpSymbols.add(key);
            const cached = this._trendIndicators.get(key);
            if (cached) cached.warmedUp = true;
          }
        }
      }

      const warmupDuration = Date.now() - warmupStart;
      logger.info(
        `[WebSocketOCConsumer] ✅ New symbols warmup complete | ` +
        `succeeded=${results.succeeded} failed=${results.failed} ` +
        `duration=${warmupDuration}ms`
      );
    } catch (error) {
      // Non-blocking: if warmup fails, indicators will warmup progressively from live ticks
      logger.warn(`[WebSocketOCConsumer] New symbols warmup failed (non-blocking): ${error?.message || error}`);
    }
  }

  _updateTrendIndicatorsFromTick(exchange, symbol, price, timestamp) {
    try {
      const ex = String(exchange || '').toLowerCase();
      
      // ✅ ENHANCED: Update 1m, 5m, and 15m states
      const cached1m = this._getOrCreateTrendIndicators(ex, symbol);
      cached1m.state.updateTick(price, timestamp);

      const cached5m = this._getOrCreateTrendIndicators5m(ex, symbol);
      cached5m.state.updateTick(price, timestamp);

      const cached15m = this._getOrCreateTrendIndicators15m(ex, symbol);
      cached15m.state.updateTick(price, timestamp);

      // Update ADX/ATR from CLOSED candles (1m, 5m, 15m)
      if (ex === 'binance') {
        // Update 1m state
        const candle1m = webSocketManager.getLatestCandle(symbol, '1m');
        if (candle1m && candle1m.isClosed === true) {
          const start1m = Number(candle1m.startTime);
          if (Number.isFinite(start1m) && start1m > 0 && cached1m.lastClosed1mStart !== start1m) {
            cached1m.lastClosed1mStart = start1m;
            cached1m.state.updateClosedCandle(candle1m);
          }
        }

        // Update 5m state
        const candle5m = webSocketManager.getLatestCandle(symbol, '5m');
        if (candle5m && candle5m.isClosed === true) {
          const start5m = Number(candle5m.startTime);
          if (Number.isFinite(start5m) && start5m > 0 && cached5m.lastClosed5mStart !== start5m) {
            cached5m.lastClosed5mStart = start5m;
            // For 5m state: feed close as tick and update closed candle for ATR
            cached5m.state.updateTick(candle5m.close, start5m + 300000);
            cached5m.state.updateClosedCandle(candle5m);
          }
        }
        
        // Update 15m state
        const candle15m = webSocketManager.getLatestCandle(symbol, '15m');
        if (candle15m && candle15m.isClosed === true) {
          const start15m = Number(candle15m.startTime);
          if (Number.isFinite(start15m) && start15m > 0 && cached15m.lastClosed15mStart !== start15m) {
            cached15m.lastClosed15mStart = start15m;
            // For 15m state: feed close as tick and update closed candle for ADX/ATR
            cached15m.state.updateTick(candle15m.close, start15m + 900000);
            cached15m.state.updateClosedCandle(candle15m);
          }
        }
      } else if (ex === 'mexc') {
        // MEXC: Only update 1m state (no 5m/15m candle support yet)
        // MexcWebSocketManager currently exposes kline open/close caches but not a candle object.
        // For safety and no extra REST/DB calls, we only update closed-candle indicators on Binance.
      }

      this._cleanupTrendIndicatorsIfNeeded(timestamp);
    } catch (_) {
      // Must be non-blocking.
    }
  }

  async handlePriceTick(exchange, symbol, price, timestamp = Date.now()) {
    try {
      // ✅ MONITORING: Track tick received
      this._stats.ticksReceived++;
      this._stats.lastTickAt = Date.now();

      if (!this.isRunning || !price || !Number.isFinite(price) || price <= 0) {
        this._stats.ticksDropped++;
        return;
      }

      // ✅ Update lightweight trend indicators immediately (non-blocking)
      this._updateTrendIndicatorsFromTick(exchange, symbol, price, timestamp);

      // ✅ TRIỆT ĐỂ FIX: Debounce heavy processing to handle high-frequency ticks
      const key = `${exchange}|${symbol}`;
      
      // Clear previous timer for this symbol
      if (this._debounceTimers.has(key)) {
        clearTimeout(this._debounceTimers.get(key));
      }

      // ✅ FIX: Create a safe copy with explicit values to avoid closure issues
      const tickData = {
        exchange: String(exchange),
        symbol: String(symbol),
        price: Number(price),
        timestamp: Number(timestamp),
        key: key
      };

      // Set a new timer to enqueue the latest tick after the interval
      const timerId = setTimeout(() => {
        // Enqueue tick for rate-limited processing
        this._enqueueForProcessing(tickData);
        this._debounceTimers.delete(key);
      }, this._debounceInterval);

      this._debounceTimers.set(key, timerId);

    } catch (error) {
      logger.error(`[WebSocketOCConsumer] Error in handlePriceTick for ${exchange}|${symbol}:`, error?.message || error);
    }
  }

  /**
   * ✅ RATE LIMIT PROTECTION: Enqueue tick for rate-limited processing
   */
  _enqueueForProcessing(tickData) {
    // ✅ FIX: Validate and create a safe copy to prevent closure issues
    const { exchange, symbol, price, timestamp, key } = tickData;
    
    // Validate required fields
    if (!exchange || !symbol || !price || !timestamp) {
      logger.warn(`[WebSocketOCConsumer] Invalid tick data received: ${JSON.stringify(tickData)}`);
      this._stats.ticksDropped++;
      return;
    }
    
    // Create a safe copy with all required fields
    const safeTickData = {
      exchange: String(exchange),
      symbol: String(symbol),
      price: Number(price),
      timestamp: Number(timestamp),
      key: key || `${exchange}|${symbol}`
    };
    
    // Deduplicate: Remove any existing entry for this symbol in queue
    this._processingQueue = this._processingQueue.filter(item => item.key !== safeTickData.key);
    
    // Add to queue
    this._processingQueue.push(safeTickData);
    
    // ✅ MONITORING: Track queue size
    this._stats.queueSize = this._processingQueue.length;
    if (this._processingQueue.length > this._stats.maxQueueSize) {
      this._stats.maxQueueSize = this._processingQueue.length;
    }
    
    // Start processing if not already running
    if (!this._processing) {
      this._processQueue();
    }
  }

  /**
   * ✅ RATE LIMIT PROTECTION: Process queue with cooldown and concurrency limits
   */
  async _processQueue() {
    if (this._processing || this._processingQueue.length === 0) {
      return;
    }

    this._processing = true;

    try {
      while (this._processingQueue.length > 0) {
        // Check cooldown: wait if needed
        const now = Date.now();
        const timeSinceLastProcess = now - this._lastProcessedAt;
        if (timeSinceLastProcess < this._cooldownMs) {
          await new Promise(resolve => setTimeout(resolve, this._cooldownMs - timeSinceLastProcess));
        }

        // Check concurrency limit: wait if too many active
        while (this._activeDetections >= this._maxConcurrent) {
          await new Promise(resolve => setTimeout(resolve, 10)); // Check every 10ms
        }

        // Get next tick from queue
        const tickData = this._processingQueue.shift();
        if (!tickData) {
          continue;
        }

        // ✅ FIX: Validate and create a safe copy of tick data
        const { exchange, symbol, price, timestamp, key } = tickData;
        
        // Validate required fields
        if (!exchange || !symbol || !price || !timestamp) {
          logger.warn(`[WebSocketOCConsumer] Invalid tick data in queue: ${JSON.stringify(tickData)}`);
          continue;
        }

        // Create a safe copy for processing
        const tick = { exchange, symbol, price, timestamp };

        // Process tick asynchronously (don't await to allow concurrent processing)
        this._lastProcessedAt = Date.now();
        this.processedCount++;
        this._activeDetections++;
        
        // ✅ MONITORING: Track processing start
        const processingStartTime = Date.now();

        // Process without awaiting to allow concurrent processing
        this._detectAndProcess(tick)
          .catch(error => {
            const errorMsg = error?.message || String(error);
            const errorStack = error?.stack || '';
            logger.error(
              `[WebSocketOCConsumer] Error in rate-limited _detectAndProcess for ${key || `${exchange}|${symbol}`}: ${errorMsg}`,
              errorStack ? { stack: errorStack } : undefined
            );
          })
          .finally(() => {
            this._activeDetections--;
            // ✅ MONITORING: Track processing time
            const processingTime = Date.now() - processingStartTime;
            this._stats.processingTimeSamples.push(processingTime);
            if (this._stats.processingTimeSamples.length > 1000) {
              this._stats.processingTimeSamples = this._stats.processingTimeSamples.slice(-100);
            }
          });
      }
    } finally {
      this._processing = false;
      
      // If queue has more items, process them (recursive call)
      if (this._processingQueue.length > 0) {
        setImmediate(() => this._processQueue());
      }
    }
  }

  /**
   * ✅ OPTIMIZED: Detect OC and process matches for a single tick
   */
  async _detectAndProcess(tick) {
    // ✅ FIX: Declare variables outside try block so they're available in catch block
    let exchange = '';
    let symbol = '';
    let price = 0;
    let timestamp = Date.now();

    try {
      // ✅ FIX: Validate and extract tick data safely
      if (!tick || typeof tick !== 'object') {
        logger.error(`[WebSocketOCConsumer] Invalid tick data: ${JSON.stringify(tick)}`);
        return;
      }

      exchange = String(tick.exchange || '').trim();
      symbol = String(tick.symbol || '').trim();
      price = Number(tick.price);
      timestamp = Number(tick.timestamp) || Date.now();

      // Validate required fields
      if (!exchange || !symbol || !Number.isFinite(price) || price <= 0) {
        logger.error(`[WebSocketOCConsumer] Invalid tick data fields: exchange=${exchange}, symbol=${symbol}, price=${price}, timestamp=${timestamp}`);
        return;
      }

      // Detect OC and match with strategies
      const matches = await realtimeOCDetector.detectOC(exchange, symbol, price, timestamp, 'WebSocketOCConsumer');

      // ✅ MONITORING: Track processed tick
      this._stats.ticksProcessed++;
      this._stats.lastProcessedAt = Date.now();

      if (matches.length === 0) {
        return; // No matches
      }

      this.matchCount += matches.length;
      // ✅ MONITORING: Track matches found
      this._stats.matchesFound += matches.length;
      this._stats.lastMatchAt = Date.now();

      if (shouldLogSampled('WS_MATCHES', 50)) {
        logger.info(`[WebSocketOCConsumer] 🎯 Found ${matches.length} match(es) for ${exchange} ${symbol}: ${matches.map(m => `strategy ${m.strategy.id} (OC=${m.oc.toFixed(2)}%)`).join(', ')}`);
      }

      // PRIORITY QUEUE: Sort matches by mainnet/testnet priority
      // Mainnet (binance_testnet=false/null) = priority 1 (highest), Testnet = priority 0 (lower)
      matches.sort((matchA, matchB) => {
        const botIdA = matchA.strategy.bot_id;
        const botIdB = matchB.strategy.bot_id;
        const orderServiceA = this.orderServices.get(botIdA);
        const orderServiceB = this.orderServices.get(botIdB);
        const isMainnetA = orderServiceA?.exchangeService?.bot?.exchange === 'binance' && 
                          (orderServiceA.exchangeService.bot.binance_testnet === null || 
                           orderServiceA.exchangeService.bot.binance_testnet === false || 
                           orderServiceA.exchangeService.bot.binance_testnet === 0);
        const isMainnetB = orderServiceB?.exchangeService?.bot?.exchange === 'binance' && 
                          (orderServiceB.exchangeService.bot.binance_testnet === null || 
                           orderServiceB.exchangeService.bot.binance_testnet === false || 
                           orderServiceB.exchangeService.bot.binance_testnet === 0);
        const priorityA = isMainnetA ? 1 : 0;
        const priorityB = isMainnetB ? 1 : 0;
        return priorityB - priorityA; // Higher priority first (mainnet first)
      });

      // Process matches in parallel (batch processing for better performance)
      // Use Promise.allSettled to avoid one failure blocking others
      // Mainnet matches are processed first due to sorting above
      const results = await Promise.allSettled(
        matches.map(match => 
          this.processMatch(match).catch(error => {
            logger.error(`[WebSocketOCConsumer] ❌ Error processing match for strategy ${match.strategy.id}:`, error?.message || error);
            throw error; // Re-throw to be caught by Promise.allSettled
          })
        )
      );
      
      // ✅ MONITORING: Track matches processed
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      this._stats.matchesProcessed += succeeded;
      if (failed > 0) {
        logger.warn(`[WebSocketOCConsumer] Processed ${matches.length} matches: ${succeeded} succeeded, ${failed} failed`);
        results.filter(r => r.status === 'rejected').forEach((r, i) => {
          logger.error(`[WebSocketOCConsumer] Match ${i} failed:`, r.reason?.message || r.reason);
        });
      }
    } catch (error) {
      // ✅ FIX: Use safe fallback if variables not set
      const exchangeStr = exchange || (tick?.exchange ? String(tick.exchange) : 'unknown');
      const symbolStr = symbol || (tick?.symbol ? String(tick.symbol) : 'unknown');
      logger.error(
        `[WebSocketOCConsumer] ❌ Error handling price tick for ${exchangeStr} ${symbolStr}:`,
        error?.message || error,
        error?.stack
      );
    }
  }

  /**
   * Process matched strategy and trigger order
   * @param {Object} match - Match object from detectOC
   */
  async processMatch(match) {
    try {
      const { strategy, oc, direction, currentPrice, interval } = match;
      const botId = strategy.bot_id;

      if (shouldLogSampled('PROCESS_MATCH', 100)) {
        logger.info(`[WebSocketOCConsumer] 🔍 Processing match: strategy ${strategy.id}, bot_id=${botId}, symbol=${strategy.symbol}, OC=${oc.toFixed(2)}%`);
      }

      // Get OrderService for this bot
      let orderService = this.orderServices.get(botId);
      if (!orderService) {
        // ✅ AUTO-FIX: Try to create OrderService for this bot if missing
        logger.warn(`[WebSocketOCConsumer] ⚠️ No OrderService found for bot ${botId}, attempting to create one...`);
        try {
          const { Bot } = await import('../models/Bot.js');
          const { ExchangeService } = await import('../services/ExchangeService.js');
          const bot = await Bot.findById(botId);
          if (!bot) {
            logger.error(`[WebSocketOCConsumer] ❌ Bot ${botId} not found in database, skipping strategy ${strategy.id}`);
            return;
          }
          if (!bot.is_active && bot.is_active !== 1) {
            logger.warn(`[WebSocketOCConsumer] ⚠️ Bot ${botId} is not active, skipping strategy ${strategy.id}`);
            return;
          }
          const exchangeService = new ExchangeService(bot);
          await exchangeService.initialize();
          // Try to get telegramService from various sources
          let telegramService = null;
          try {
            const { telegramService: tgService } = await import('../services/TelegramService.js');
            telegramService = tgService;
          } catch (e) {
            // If singleton doesn't exist, try to get from StrategiesWorker or create a minimal one
            logger.warn(`[WebSocketOCConsumer] Could not get TelegramService singleton, OrderService will work without Telegram notifications`);
          }
          orderService = new OrderService(exchangeService, telegramService);
          this.orderServices.set(botId, orderService);
          logger.info(`[WebSocketOCConsumer] ✅ Auto-created OrderService for bot ${botId}`);
        } catch (error) {
          logger.error(`[WebSocketOCConsumer] ❌ Failed to auto-create OrderService for bot ${botId}:`, error?.message || error);
          return;
        }
      }

      // Check if strategy already has open position (with cache to reduce DB queries)
      const hasOpenPosition = await this.checkOpenPosition(strategy.id);
      if (hasOpenPosition) {
        logger.info(`[WebSocketOCConsumer] ⏭️ Strategy ${strategy.id} already has open position(s), skipping`);
        return;
      }
      
      logger.info(`[WebSocketOCConsumer] ✅ Strategy ${strategy.id} has no open position, proceeding...`);

      // Determine side based on direction, trade_type and is_reverse_strategy from bot
      const side = determineSide(direction, strategy.trade_type, strategy.is_reverse_strategy);
      logger.debug(
        `[WebSocketOCConsumer] Side mapping: strategy_id=${strategy.id}, bot_id=${strategy.bot_id}, ` +
        `direction=${direction}, trade_type=${strategy.trade_type}, is_reverse_strategy=${strategy.is_reverse_strategy}, side=${side}`
      );

      // If side is null, skip this match (strategy không phù hợp với direction hiện tại)
      if (!side) {
        logger.info(
          `[WebSocketOCConsumer] ⏭️ Strategy ${strategy.id} skipped by side mapping ` +
          `(direction=${direction}, trade_type=${strategy.trade_type}, is_reverse_strategy=${strategy.is_reverse_strategy})`
        );
        return;
      }

      // Use interval open price for entry calculation (per-bucket open)
      const baseOpen = Number.isFinite(Number(match.openPrice)) && Number(match.openPrice) > 0
        ? Number(match.openPrice)
        : currentPrice;

      // Determine entry price and order type based on strategy type:
      // - Counter-trend (is_reverse_strategy = true): Use extend logic with LIMIT order
      // - Trend-following (is_reverse_strategy = false): Use current price with MARKET order
      const isReverseStrategy = Boolean(strategy.is_reverse_strategy);

      // ✅ CRITICAL: ALL orders MUST pass through trend filter gate
      // WHY: OC spikes during sideways markets are often fakeouts; we only trade when
      // EMA alignment + ADX strength + RSI regime confirm the existing `direction`.
      // Indicators NEVER flip direction; they only validate/reject.
      const matchExchange = match.exchange || strategy.exchange || 'binance';
      const exchangeLower = String(matchExchange).toLowerCase();
      
      // Store indicator state for logging when order is triggered
      let filterIndicatorState = null;
      
      // ✅ ENHANCED: Apply multi-timeframe filter to ALL strategies
      // For Binance: Full filter (EMA + ADX + RSI) on 15m + pullback + volatility
      // For MEXC: Partial filter (EMA + RSI) on 1m + pullback + volatility
      if (exchangeLower === 'binance') {
        // ✅ ENHANCED: Use 15m state for trend/regime gate
        const ind15m = this._getOrCreateTrendIndicators15m(matchExchange, strategy.symbol);
        const ind1m = this._getOrCreateTrendIndicators(matchExchange, strategy.symbol);
        
        // Update 15m indicators with currentPrice
        ind15m.state.updateTick(currentPrice, match.timestamp || Date.now());
        
        // Get latest closed 15m candle for ADX/ATR update
        const candle15m = webSocketManager.getLatestCandle(strategy.symbol, '15m');
        if (candle15m && candle15m.isClosed === true) {
          const start15m = Number(candle15m.startTime);
          if (Number.isFinite(start15m) && start15m > 0 && ind15m.lastClosed15mStart !== start15m) {
            ind15m.lastClosed15mStart = start15m;
            ind15m.state.updateClosedCandle(candle15m);
          }
        }
        
        // ✅ ENHANCED: Check trend confirmation with 15m state (trend/regime gate)
        const verdict = isTrendConfirmed(direction, currentPrice, ind1m.state, ind15m.state);
        
        if (!verdict.ok) {
          const snap15m = ind15m.state.snapshot();
          if (shouldLogSampled('FILTER_REJECT', 100)) {
            logger.info(
              `[WebSocketOCConsumer] ⏭️ Trend filters rejected entry (15m gate) | strategy=${strategy.id} symbol=${strategy.symbol} ` +
              `type=${isReverseStrategy ? 'COUNTER_TREND' : 'FOLLOWING_TREND'} direction=${direction} reason=${verdict.reason} | ` +
              `15m: EMA20=${snap15m.ema20?.toFixed(4) || 'N/A'} EMA50=${snap15m.ema50?.toFixed(4) || 'N/A'} ` +
              `ADX=${snap15m.adx14?.toFixed(2) || 'N/A'} RSI=${snap15m.rsi14?.toFixed(2) || 'N/A'} ` +
              `price=${currentPrice.toFixed(4)}`
            );
          }
          return;
        }
        
        // ✅ ENHANCED: Check volatility filter (ATR% on 15m)
        const snap15m = ind15m.state.snapshot();
        const volCheck = checkVolatilityFilter(snap15m.atr14, currentPrice);
        if (!volCheck.ok) {
          if (shouldLogSampled('FILTER_REJECT', 100)) {
            logger.info(
              `[WebSocketOCConsumer] ⏭️ Volatility filter rejected entry | strategy=${strategy.id} symbol=${strategy.symbol} ` +
              `reason=${volCheck.reason} ATR%=${volCheck.atrPercent?.toFixed(2) || 'N/A'}%`
            );
          }
          return;
        }
        
        // ✅ ENHANCED: Check pullback confirmation (5m EMA20)
        const ind5m = this._getOrCreateTrendIndicators5m(matchExchange, strategy.symbol);
        ind5m.state.updateTick(currentPrice, match.timestamp || Date.now());
        const candle5m = webSocketManager.getLatestCandle(strategy.symbol, '5m');
        if (candle5m) {
          const snap5m = ind5m.state.snapshot();
          const pullbackCheck = checkPullbackConfirmation(direction, currentPrice, candle5m, snap5m.ema20);
          if (!pullbackCheck.ok) {
            if (shouldLogSampled('FILTER_REJECT', 100)) {
              logger.info(
                `[WebSocketOCConsumer] ⏭️ Pullback filter rejected entry | strategy=${strategy.id} symbol=${strategy.symbol} ` +
                `reason=${pullbackCheck.reason} EMA20_5m=${snap5m.ema20?.toFixed(4) || 'N/A'}`
              );
            }
            return;
          }
        }
        
        // ✅ Log when all filters pass
        filterIndicatorState = snap15m; // Store 15m state for logging
        const emaCondition = direction === 'bullish'
          ? `price(${currentPrice.toFixed(4)}) > EMA20_15m(${snap15m.ema20?.toFixed(4)}) > EMA50_15m(${snap15m.ema50?.toFixed(4)}) AND EMA20Slope > 0`
          : `price(${currentPrice.toFixed(4)}) < EMA20_15m(${snap15m.ema20?.toFixed(4)}) < EMA50_15m(${snap15m.ema50?.toFixed(4)}) AND EMA20Slope < 0`;
        const adxCondition = `ADX_15m(${snap15m.adx14?.toFixed(2)}) >= 25`;
        const rsiCondition = direction === 'bullish'
          ? `RSI_15m(${snap15m.rsi14?.toFixed(2)}) >= 55`
          : `RSI_15m(${snap15m.rsi14?.toFixed(2)}) <= 45`;
        if (shouldLogSampled('FILTER_PASS', 50)) {
          logger.info(
            `[WebSocketOCConsumer] ✅ All filters PASSED (15m gate) | strategy=${strategy.id} symbol=${strategy.symbol} ` +
            `type=${isReverseStrategy ? 'COUNTER_TREND' : 'FOLLOWING_TREND'} direction=${direction} | ` +
            `CONDITIONS: ${emaCondition} ✓ ${adxCondition} ✓ ${rsiCondition} ✓ ` +
            `ATR%=${volCheck.atrPercent?.toFixed(2)}% ✓ Pullback ✓`
          );
        }
      } else if (exchangeLower === 'mexc') {
        // ✅ MEXC: Apply partial filter (EMA + RSI only, no ADX)
        // WHY: MEXC doesn't have closed candle aggregation for ADX calculation
        const ind = this._getOrCreateTrendIndicators(matchExchange, strategy.symbol);
        ind.state.updateTick(currentPrice, match.timestamp || Date.now());
        
        const snap = ind.state.snapshot();
        const ema20 = Number(snap.ema20);
        const ema50 = Number(snap.ema50);
        const ema20Slope = Number(snap.ema20Slope);
        const rsi14 = Number(snap.rsi14);
        
        // Check if indicators are ready
        if (!Number.isFinite(ema20) || !Number.isFinite(ema50) || !Number.isFinite(ema20Slope)) {
          logger.info(
            `[WebSocketOCConsumer] ⏭️ Trend filters rejected entry | strategy=${strategy.id} symbol=${strategy.symbol} ` +
            `type=${isReverseStrategy ? 'COUNTER_TREND' : 'FOLLOWING_TREND'} direction=${direction} reason=ema_not_ready`
          );
          return;
        }
        if (!Number.isFinite(rsi14)) {
          logger.info(
            `[WebSocketOCConsumer] ⏭️ Trend filters rejected entry | strategy=${strategy.id} symbol=${strategy.symbol} ` +
            `type=${isReverseStrategy ? 'COUNTER_TREND' : 'FOLLOWING_TREND'} direction=${direction} reason=rsi_not_ready`
          );
          return;
        }
        
        // EMA filter
        const emaOk = direction === 'bullish'
          ? (currentPrice > ema20 && ema20 > ema50 && ema20Slope > 0)
          : (currentPrice < ema20 && ema20 < ema50 && ema20Slope < 0);
        
        if (!emaOk) {
          logger.info(
            `[WebSocketOCConsumer] ⏭️ Trend filters rejected entry | strategy=${strategy.id} symbol=${strategy.symbol} ` +
            `type=${isReverseStrategy ? 'COUNTER_TREND' : 'FOLLOWING_TREND'} direction=${direction} reason=ema_filter | ` +
            `EMA20=${ema20.toFixed(4)} EMA50=${ema50.toFixed(4)} EMA20Slope=${ema20Slope.toFixed(4)} price=${currentPrice.toFixed(4)}`
          );
          return;
        }
        
        // RSI filter
        const rsiOk = direction === 'bullish' ? (rsi14 >= 55) : (rsi14 <= 45);
        if (!rsiOk) {
          logger.info(
            `[WebSocketOCConsumer] ⏭️ Trend filters rejected entry | strategy=${strategy.id} symbol=${strategy.symbol} ` +
            `type=${isReverseStrategy ? 'COUNTER_TREND' : 'FOLLOWING_TREND'} direction=${direction} reason=rsi_regime | ` +
            `RSI=${rsi14.toFixed(2)}`
          );
          return;
        }
        
        // ✅ Log when filter passes with ALL conditions
        filterIndicatorState = { ema20, ema50, ema20Slope, rsi14 }; // Store for later logging
        const emaCondition = direction === 'bullish'
          ? `price(${currentPrice.toFixed(4)}) > EMA20(${ema20.toFixed(4)}) > EMA50(${ema50.toFixed(4)}) AND EMA20Slope(${ema20Slope.toFixed(4)}) > 0`
          : `price(${currentPrice.toFixed(4)}) < EMA20(${ema20.toFixed(4)}) < EMA50(${ema50.toFixed(4)}) AND EMA20Slope(${ema20Slope.toFixed(4)}) < 0`;
        const rsiCondition = direction === 'bullish'
          ? `RSI(${rsi14.toFixed(2)}) >= 55`
          : `RSI(${rsi14.toFixed(2)}) <= 45`;
        logger.info(
          `[WebSocketOCConsumer] ✅ Trend filter PASSED (MEXC) | strategy=${strategy.id} symbol=${strategy.symbol} ` +
          `type=${isReverseStrategy ? 'COUNTER_TREND' : 'FOLLOWING_TREND'} direction=${direction} | ` +
          `CONDITIONS: ${emaCondition} ✓ ${rsiCondition} ✓`
        );
      } else {
        // ✅ Unknown exchange - reject for safety
        logger.warn(
          `[WebSocketOCConsumer] ⏭️ Trend filters rejected entry | strategy=${strategy.id} symbol=${strategy.symbol} ` +
          `exchange=${matchExchange} unknown exchange (no filter available)`
        );
        return;
      }

      let entryPrice;
      let forceMarket = false;

      if (isReverseStrategy) {
        // Counter-trend: Calculate entry price with extend logic
        // LONG: entry = current - extendRatio * delta (entry < current)
        // SHORT: entry = current + extendRatio * delta (entry > current)
        // where delta = abs(current - open), extendRatio = extend / 100
        entryPrice = side === 'long'
          ? calculateLongEntryPrice(currentPrice, baseOpen, strategy.extend || 0)
          : calculateShortEntryPrice(currentPrice, baseOpen, strategy.extend || 0);
      } else {
        // Trend-following: Use current price directly, force MARKET order
        entryPrice = currentPrice;
        forceMarket = true;
        if (shouldLogSampled('ENTRY_INFO', 100)) {
          logger.info(
            `[WebSocketOCConsumer] Trend-following strategy ${strategy.id}: ` +
            `entry=${entryPrice} (using current price), forceMarket=true`
          );
        }
      }

      // Pre-calculate extend distance (only for counter-trend)
      const totalExtendDistance = isReverseStrategy ? Math.abs(baseOpen - entryPrice) : 0;

      // Extend check only applies to counter-trend strategies
      const extendOK = isReverseStrategy ? true : true; // Always OK for trend-following (no extend needed)
      const extendVal = strategy.extend || 0;
      
      logger.info(
        `[WebSocketOCConsumer] Entry calculation for strategy ${strategy.id}: ` +
        `is_reverse_strategy=${isReverseStrategy}, extendOK=${extendOK}, extendVal=${extendVal}, ` +
        `side=${side}, currentPrice=${currentPrice}, entryPrice=${entryPrice}, baseOpen=${baseOpen}, ` +
        `totalExtendDistance=${totalExtendDistance}, forceMarket=${forceMarket}`
      );

      // Calculate TP and SL (based on side)
      const tpPrice = calculateTakeProfit(entryPrice, strategy.take_profit || 55, side);
      // Only compute SL when strategy.stoploss > 0. No fallback to reduce/up_reduce
      // NEW: stoploss is now in USDT (not percentage), need quantity to calculate SL price
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      
      // Calculate quantity from amount and entry price for SL calculation
      const amount = strategy.amount || 1000; // Default amount if not set
      let slPrice = null;
      if (isStoplossValid) {
        const estimatedQuantity = entryPrice > 0 ? amount / entryPrice : 0;
        if (estimatedQuantity > 0) {
          slPrice = calculateInitialStopLossByAmount(entryPrice, estimatedQuantity, rawStoploss, side);
        } else {
          logger.warn(`[WebSocketOCConsumer] Cannot calculate SL: invalid quantity (amount=${amount}, entry=${entryPrice})`);
        }
      }

      // Create signal object - OrderService.executeSignal expects strategy object
      const signal = {
        strategy: strategy, // Pass full strategy object
        side,
        entryPrice: entryPrice,
        currentPrice: currentPrice,
        oc: Math.abs(oc),
        interval,
        timestamp: match.timestamp,
        tpPrice: tpPrice,
        slPrice: slPrice,
        amount: amount,
        forceMarket: forceMarket // Force MARKET order for trend-following strategies
      };

      // Extend check only applies to counter-trend strategies
      // For trend-following (is_reverse_strategy = false), skip extend check and use MARKET order
      if (!isReverseStrategy) {
        // Trend-following: Skip extend check, MARKET order will be used
        logger.info(
          `[WebSocketOCConsumer] Trend-following strategy ${strategy.id}: Skipping extend check, using MARKET order`
        );
      } else if (!extendOK) {
        // Counter-trend: If extend condition not met, either place passive LIMIT (if enabled) or skip.
      // New behaviour:
      // - Không yêu cầu giá phải chạm 100% mức extend.
      // - Cho phép đặt LIMIT nếu chênh lệch giữa currentPrice và entryPrice <= EXTEND_LIMIT_MAX_DIFF_RATIO * quãng đường extend.
        const allowPassive = configService.getBoolean('ENABLE_LIMIT_ON_EXTEND_MISS', true);
        if (allowPassive) {
          // Allow overriding max diff ratio via config (default 0.5 = 50%)
          const maxDiffRatio = Number(configService.getNumber('EXTEND_LIMIT_MAX_DIFF_RATIO', 0.5)) || 0.5;
          let priceDiffRatio = 0;
          if (totalExtendDistance > 0) {
            priceDiffRatio = Math.abs(currentPrice - entryPrice) / totalExtendDistance; // 0.0 → 1.0+
          }

          logger.info(
            `[WebSocketOCConsumer] Extend miss for strategy ${strategy.id}: ` +
            `allowPassive=${allowPassive}, priceDiffRatio=${priceDiffRatio.toFixed(4)}, maxDiffRatio=${maxDiffRatio}, ` +
            `totalExtendDistance=${totalExtendDistance}, currentPrice=${currentPrice}, entryPrice=${entryPrice}`
          );

          // Chỉ đặt LIMIT nếu chênh lệch giá <= maxDiffRatio * quãng đường extend
          if (totalExtendDistance === 0 || priceDiffRatio <= maxDiffRatio) {
            signal.forcePassiveLimit = true; // OrderService sẽ tạo LIMIT thụ động tại entryPrice
            logger.info(
              `[WebSocketOCConsumer] ⚠️ Extend not fully met; placing passive LIMIT for strategy ${strategy.id} at ${entryPrice} (priceDiffRatio=${priceDiffRatio.toFixed(4)}, maxDiffRatio=${maxDiffRatio})`
            );
          } else {
            logger.warn(
              `[WebSocketOCConsumer] ❌ Extend not met and price difference too large; ` +
              `SKIPPING order for strategy ${strategy.id}. ` +
              `priceDiffRatio=${priceDiffRatio.toFixed(4)} > maxDiffRatio=${maxDiffRatio}, side=${side}, baseOpen=${baseOpen}, entry=${entryPrice}, current=${currentPrice}`
            );
            return;
          }
        } else {
          logger.warn(
            `[WebSocketOCConsumer] ❌ Extend not met; SKIPPING order for strategy ${strategy.id} because passive LIMIT is disabled. ` +
            `side=${side} baseOpen=${baseOpen} entry=${entryPrice} current=${currentPrice}`
          );
          return;
        }
      }

      // ✅ Log order execution with all filter conditions that passed
      let filterSummary = '';
      if (filterIndicatorState) {
        if (exchangeLower === 'binance') {
          filterSummary = `EMA20=${filterIndicatorState.ema20?.toFixed(4)} EMA50=${filterIndicatorState.ema50?.toFixed(4)} EMA20Slope=${filterIndicatorState.ema20Slope?.toFixed(4)} ADX=${filterIndicatorState.adx14?.toFixed(2)} RSI=${filterIndicatorState.rsi14?.toFixed(2)}`;
        } else if (exchangeLower === 'mexc') {
          filterSummary = `EMA20=${filterIndicatorState.ema20?.toFixed(4)} EMA50=${filterIndicatorState.ema50?.toFixed(4)} EMA20Slope=${filterIndicatorState.ema20Slope?.toFixed(4)} RSI=${filterIndicatorState.rsi14?.toFixed(2)}`;
        }
      }
      logger.info(
        `[WebSocketOCConsumer] 🚀 Triggering order for strategy ${strategy.id} (${strategy.symbol}): ` +
        `${signal.side.toUpperCase()} @ ${currentPrice.toFixed(4)}, OC=${oc.toFixed(2)}% | ` +
        `FILTER PASSED: ${filterSummary || 'N/A'}`
      );

      // Trigger order immediately
      const result = await orderService.executeSignal(signal).catch(error => {
        logger.error(`[WebSocketOCConsumer] ❌ Error executing signal for strategy ${strategy.id}:`, error?.message || error);
        throw error; // Re-throw to be caught by outer try-catch
      });

      // Clear cache after order is placed (position is now open)
      if (result && result.id) {
        this.clearPositionCache(strategy.id);
        logger.debug(`[WebSocketOCConsumer] ✅ Order triggered successfully for strategy ${strategy.id}, position ${result.id} opened`);
      } else {
        logger.debug(`[WebSocketOCConsumer] ✅ Order triggered for strategy ${strategy.id}`);
      }
    } catch (error) {
      logger.error(`[WebSocketOCConsumer] Error processing match:`, error?.message || error, error?.stack);
      // Re-throw to allow caller to handle
      throw error;
    }
  }

  /**
   * Check if strategy has open position (with cache)
   * @param {number} strategyId - Strategy ID
   * @returns {Promise<boolean>} True if has open position
   */
  async checkOpenPosition(strategyId) {
    const now = Date.now();
    const cached = this.openPositionsCache.get(strategyId);
    
    // Return cached result if still valid
    if (cached && (now - cached.lastCheck) < this.openPositionsCacheTTL) {
      return cached.hasOpenPosition;
    }
    
    // Query database
    const openPositions = await Position.findOpen(strategyId);
    const hasOpenPosition = openPositions.length > 0;
    
    // Update cache
    this.openPositionsCache.set(strategyId, {
      hasOpenPosition,
      lastCheck: now
    });
    
    return hasOpenPosition;
  }

  /**
   * Clear open position cache for a strategy (call when position is opened/closed)
   * @param {number} strategyId - Strategy ID
   */
  clearPositionCache(strategyId) {
    this.openPositionsCache.delete(strategyId);
  }

  /**
   * Subscribe WebSocket for all strategy symbols
   */
  async subscribeWebSockets() {
    try {
      // Refresh strategy cache
      await strategyCache.refresh();

      logger.debug(`[WebSocketOCConsumer] Strategy cache size: ${strategyCache.size()}`);

      // Collect symbols by exchange
      const mexcSymbols = new Set();
      const binanceSymbols = new Set();

      for (const [key, strategy] of strategyCache.cache.entries()) {
        const [exchange, symbol] = key.split('|');
        if (exchange === 'mexc') {
          mexcSymbols.add(symbol);
        } else if (exchange === 'binance') {
          binanceSymbols.add(symbol);
        }
        
        // Log PIPPIN strategies (debug only)
        if (symbol?.includes('PIPPIN')) {
          logger.debug(`[WebSocketOCConsumer] Found PIPPIN strategy: ${key} -> strategy_id=${strategy.id}, bot_id=${strategy.bot_id}, oc=${strategy.oc}, interval=${strategy.interval}`);
        }
      }

      // Subscribe MEXC
      if (mexcSymbols.size > 0) {
        logger.debug(`[WebSocketOCConsumer] Subscribing MEXC WS to ${mexcSymbols.size} strategy symbols`);
        mexcPriceWs.subscribe(Array.from(mexcSymbols));
      }

      // Subscribe Binance
      if (binanceSymbols.size > 0) {
        logger.debug(`[WebSocketOCConsumer] Subscribing Binance WS to ${binanceSymbols.size} strategy symbols`);
        webSocketManager.subscribe(Array.from(binanceSymbols));
      }

      logger.info(`[WebSocketOCConsumer] WebSocket subscriptions updated: MEXC=${mexcSymbols.size}, Binance=${binanceSymbols.size}`);

      // ✅ Warmup indicators for newly added FOLLOWING_TREND strategies
      // This ensures indicators are ready immediately when new strategies are added
      await this._warmupNewSymbols();
    } catch (error) {
      logger.error('[WebSocketOCConsumer] Error subscribing WebSockets:', error?.message || error, error?.stack);
    }
  }

  /**
   * Start consumer
   */
  start() {
    if (this.isRunning) {
      logger.warn('[WebSocketOCConsumer] Already running');
      return;
    }

    this.isRunning = true;
    
    // Log status
    logger.info(`[WebSocketOCConsumer] ✅ Started with ${this.orderServices.size} OrderServices`);
    if (this.orderServices.size === 0) {
      logger.warn('[WebSocketOCConsumer] ⚠️ No OrderServices available - orders will not be triggered!');
    } else {
      logger.info(`[WebSocketOCConsumer] Available bot IDs: ${Array.from(this.orderServices.keys()).join(', ')}`);
    }
  }

  /**
   * Stop consumer
   */
  stop() {
    if (!this.isRunning) return;

    this.isRunning = false;

    // Clear intervals
    if (this.subscriptionInterval) {
      clearInterval(this.subscriptionInterval);
      this.subscriptionInterval = null;
    }
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    logger.info('[WebSocketOCConsumer] ✅ Stopped');
  }

  /**
   * Get consumer stats
   * @returns {Object} Consumer statistics
   */
  getStats() {
    const now = Date.now();
    const avgProcessingTime = this._stats.processingTimeSamples.length > 0
      ? this._stats.processingTimeSamples.reduce((a, b) => a + b, 0) / this._stats.processingTimeSamples.length
      : 0;

    return {
      isRunning: this.isRunning,
      processedCount: this.processedCount,
      matchCount: this.matchCount,
      skippedCount: this.skippedCount,
      queueSize: this._processingQueue.length,
      activeDetections: this._activeDetections,
      maxConcurrent: this._maxConcurrent,
      cooldownMs: this._cooldownMs,
      ocDetectorStats: realtimeOCDetector.getStats(),
      strategyCacheSize: strategyCache.size(),
      // ✅ MONITORING: Enhanced stats
      stats: {
        ticksReceived: this._stats.ticksReceived,
        ticksProcessed: this._stats.ticksProcessed,
        ticksDropped: this._stats.ticksDropped,
        matchesFound: this._stats.matchesFound,
        matchesProcessed: this._stats.matchesProcessed,
        maxQueueSize: this._stats.maxQueueSize,
        avgProcessingTime: avgProcessingTime,
        timeSinceLastTick: this._stats.lastTickAt > 0 ? now - this._stats.lastTickAt : null,
        timeSinceLastProcessed: this._stats.lastProcessedAt > 0 ? now - this._stats.lastProcessedAt : null,
        timeSinceLastMatch: this._stats.lastMatchAt > 0 ? now - this._stats.lastMatchAt : null
      }
    };
  }
}

// Export singleton instance
export const webSocketOCConsumer = new WebSocketOCConsumer();

