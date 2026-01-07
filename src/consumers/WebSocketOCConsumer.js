import { realtimeOCDetector } from '../services/RealtimeOCDetector.js';
import { strategyCache } from '../services/StrategyCache.js';
import { OrderService } from '../services/OrderService.js';
import { mexcPriceWs } from '../services/MexcWebSocketManager.js';
import { webSocketManager } from '../services/WebSocketManager.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

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
    
    // Cache for open positions to avoid excessive DB queries
    this.openPositionsCache = new Map(); // strategyId -> { hasOpenPosition: boolean, lastCheck: timestamp }
    this.openPositionsCacheTTL = 5000; // 5 seconds TTL
    
    // ✅ OPTIMIZED: Batch processing for price ticks
    this._tickQueue = [];
    this._batchSize = Number(configService.getNumber('WS_TICK_BATCH_SIZE', 20));
    this._batchTimeout = Number(configService.getNumber('WS_TICK_BATCH_TIMEOUT_MS', 50));
    this._processing = false;
    this._batchTimer = null;
    
    // ✅ OPTIMIZED: Throttling per symbol
    this._lastProcessed = new Map(); // exchange|symbol -> timestamp
    this._minTickInterval = Number(configService.getNumber('WS_TICK_MIN_INTERVAL_MS', 100));
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
      const binanceHandler = ({ symbol, price, ts }) => {
        // Don't check isRunning here - let handlePriceTick check it
        // This allows handler to be registered even if consumer not started yet
        this.handlePriceTick('binance', symbol, price, ts).catch(error => {
          logger.error(`[WebSocketOCConsumer] Error handling Binance price tick:`, error?.message || error);
        });
      };
      webSocketManager.onPrice?.(binanceHandler);
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
  async handlePriceTick(exchange, symbol, price, timestamp = Date.now()) {
    try {
      if (!this.isRunning) {
        if (symbol?.toUpperCase().includes('PIPPIN')) {
          logger.warn(`[WebSocketOCConsumer] ⚠️ Skipping price tick for ${exchange} ${symbol} - NOT RUNNING! isRunning=${this.isRunning}`);
        }
        return; // Skip if not running
      }

      if (!price || !Number.isFinite(price) || price <= 0) {
        if (symbol?.toUpperCase().includes('PIPPIN')) {
          logger.warn(`[WebSocketOCConsumer] ⚠️ Invalid price for ${exchange} ${symbol}: ${price}`);
        }
        return; // Invalid price
      }

      // ✅ OPTIMIZED: Throttle - chỉ process mỗi symbol mỗi N ms
      const key = `${exchange}|${symbol}`;
      const lastProcessed = this._lastProcessed.get(key);
      if (lastProcessed && (timestamp - lastProcessed) < this._minTickInterval) {
        this.skippedCount++;
        return; // Skip - too soon
      }

      // ✅ OPTIMIZED: Add to batch queue
      this._tickQueue.push({ exchange, symbol, price, timestamp });

      // Process batch nếu đủ size
      if (this._tickQueue.length >= this._batchSize) {
        await this._processBatch();
      } else if (!this._batchTimer) {
        // Schedule batch processing after timeout
        this._batchTimer = setTimeout(() => {
          this._batchTimer = null;
          this._processBatch();
        }, this._batchTimeout);
      }
    } catch (error) {
      logger.error(`[WebSocketOCConsumer] Error in handlePriceTick:`, error?.message || error);
    }
  }

  /**
   * ✅ OPTIMIZED: Process batch of price ticks
   * Deduplicates ticks (only latest per symbol) and processes in parallel
   */
  async _processBatch() {
    if (this._processing || this._tickQueue.length === 0) return;
    
    this._processing = true;
    const startTime = Date.now();

    try {
      const batch = this._tickQueue.splice(0, this._batchSize);
      
      // ✅ Deduplicate: Chỉ lấy tick mới nhất cho mỗi symbol
      const latest = new Map();
      for (const tick of batch) {
        const key = `${tick.exchange}|${tick.symbol}`;
        const existing = latest.get(key);
        if (!existing || existing.timestamp < tick.timestamp) {
          latest.set(key, tick);
        }
      }

      // Process unique symbols in parallel (limited concurrency)
      const concurrency = Number(configService.getNumber('WS_TICK_CONCURRENCY', 10));
      const ticks = Array.from(latest.values());
      
      for (let i = 0; i < ticks.length; i += concurrency) {
        const batch = ticks.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(tick => this._detectAndProcess(tick))
        );
        
        // Update last processed timestamps
        batch.forEach(tick => {
          this._lastProcessed.set(`${tick.exchange}|${tick.symbol}`, tick.timestamp);
        });
      }

      this.processedCount += latest.size;
      
      const duration = Date.now() - startTime;
      if (duration > 100) {
        logger.debug(`[WebSocketOCConsumer] Processed batch of ${latest.size} ticks in ${duration}ms`);
      }
    } catch (error) {
      logger.error('[WebSocketOCConsumer] Batch processing error:', error?.message || error);
    } finally {
      this._processing = false;
      
      // Process remaining nếu có
      if (this._tickQueue.length > 0) {
        setTimeout(() => this._processBatch(), this._batchTimeout);
      }
    }
  }

  /**
   * ✅ OPTIMIZED: Detect OC and process matches for a single tick
   */
  async _detectAndProcess(tick) {
    try {
      const { exchange, symbol, price, timestamp } = tick;

      // Detect OC and match with strategies
      const matches = await realtimeOCDetector.detectOC(exchange, symbol, price, timestamp, 'WebSocketOCConsumer');

      if (matches.length === 0) {
        return; // No matches
      }

      this.matchCount += matches.length;

      logger.info(`[WebSocketOCConsumer] 🎯 Found ${matches.length} match(es) for ${exchange} ${symbol}: ${matches.map(m => `strategy ${m.strategy.id} (OC=${m.oc.toFixed(2)}%)`).join(', ')}`);

      // Process matches in parallel (batch processing for better performance)
      // Use Promise.allSettled to avoid one failure blocking others
      const results = await Promise.allSettled(
        matches.map(match => 
          this.processMatch(match).catch(error => {
            logger.error(`[WebSocketOCConsumer] ❌ Error processing match for strategy ${match.strategy.id}:`, error?.message || error);
            throw error; // Re-throw to be caught by Promise.allSettled
          })
        )
      );
      
      // Log results for debugging
      const succeeded = results.filter(r => r.status === 'fulfilled').length;
      const failed = results.filter(r => r.status === 'rejected').length;
      if (failed > 0) {
        logger.warn(`[WebSocketOCConsumer] Processed ${matches.length} matches: ${succeeded} succeeded, ${failed} failed`);
        results.filter(r => r.status === 'rejected').forEach((r, i) => {
          logger.error(`[WebSocketOCConsumer] Match ${i} failed:`, r.reason?.message || r.reason);
        });
      }
    } catch (error) {
      logger.error(`[WebSocketOCConsumer] ❌ Error handling price tick for ${exchange} ${symbol}:`, error?.message || error, error?.stack);
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

      logger.info(`[WebSocketOCConsumer] 🔍 Processing match: strategy ${strategy.id}, bot_id=${botId}, symbol=${strategy.symbol}, OC=${oc.toFixed(2)}%`);

      // Get OrderService for this bot
      const orderService = this.orderServices.get(botId);
      if (!orderService) {
        logger.error(`[WebSocketOCConsumer] ❌ No OrderService found for bot ${botId}, skipping strategy ${strategy.id}. Available bots: ${Array.from(this.orderServices.keys()).join(', ')}`);
        return;
      }

      // Check if strategy already has open position (with cache to reduce DB queries)
      const hasOpenPosition = await this.checkOpenPosition(strategy.id);
      if (hasOpenPosition) {
        logger.info(`[WebSocketOCConsumer] ⏭️ Strategy ${strategy.id} already has open position(s), skipping`);
        return;
      }
      
      logger.info(`[WebSocketOCConsumer] ✅ Strategy ${strategy.id} has no open position, proceeding...`);

      // Import calculator functions for TP/SL calculation
      const { calculateTakeProfit, calculateInitialStopLoss, calculateLongEntryPrice, calculateShortEntryPrice } = await import('../utils/calculator.js');
      const { determineSide } = await import('../utils/sideSelector.js');

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
        logger.info(
          `[WebSocketOCConsumer] Trend-following strategy ${strategy.id}: ` +
          `entry=${entryPrice} (using current price), forceMarket=true`
        );
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
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const slPrice = isStoplossValid ? calculateInitialStopLoss(entryPrice, rawStoploss, side) : null;

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
        amount: strategy.amount || 1000, // Default amount if not set
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

      logger.info(`[WebSocketOCConsumer] 🚀 Triggering order for strategy ${strategy.id} (${strategy.symbol}): ${signal.side} @ ${currentPrice}, OC=${oc.toFixed(2)}%`);

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
    const { Position } = await import('../models/Position.js');
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
    return {
      isRunning: this.isRunning,
      processedCount: this.processedCount,
      matchCount: this.matchCount,
      ocDetectorStats: realtimeOCDetector.getStats(),
      strategyCacheSize: strategyCache.size()
    };
  }
}

// Export singleton instance
export const webSocketOCConsumer = new WebSocketOCConsumer();

