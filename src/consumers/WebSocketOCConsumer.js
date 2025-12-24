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
    
    // Cache for open positions to avoid excessive DB queries
    this.openPositionsCache = new Map(); // strategyId -> { hasOpenPosition: boolean, lastCheck: timestamp }
    this.openPositionsCacheTTL = 5000; // 5 seconds TTL
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
        realtimeOCDetector.cleanup();
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

      this.processedCount++;

      // Log PIPPIN and first few price ticks (debug only)
      const isPippin = symbol?.toUpperCase().includes('PIPPIN');
      if (isPippin || this.processedCount <= 10) {
        // Reduce logging frequency to save memory (log every 10000 ticks instead of every tick)
        if (this.processedCount % 10000 === 0) {
          logger.debug(`[WebSocketOCConsumer] 📥 Received price tick: ${exchange} ${symbol} = ${price} (count: ${this.processedCount}, isRunning: ${this.isRunning})`);
        }
      }

      // Log every 10000th price tick for debugging (reduced frequency)
      if (this.processedCount % 10000 === 0) {
        logger.debug(`[WebSocketOCConsumer] Processed ${this.processedCount} price ticks, ${this.matchCount} matches`);
      }

      // Detect OC and match with strategies
      if (isPippin) {
        logger.debug(`[WebSocketOCConsumer] 🔍 Calling detectOC for ${exchange} ${symbol} @ ${price}`);
      }
      const matches = await realtimeOCDetector.detectOC(exchange, symbol, price, timestamp, 'WebSocketOCConsumer');

      if (matches.length === 0) {
        if (isPippin) {
          logger.warn(`[WebSocketOCConsumer] ⚠️ No matches found for ${exchange} ${symbol} @ ${price}`);
        }
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

      // Counter-trend side mapping: bullish → short, bearish → long
      const side = direction === 'bullish' ? 'short' : 'long';

      // Use interval open price for entry calculation (per-bucket open)
      const baseOpen = Number.isFinite(Number(match.openPrice)) && Number(match.openPrice) > 0
        ? Number(match.openPrice)
        : currentPrice;

      // Calculate entry price based on trend-following side and OPEN price
      const entryPrice = side === 'long'
        ? calculateLongEntryPrice(currentPrice, Math.abs(oc), strategy.extend || 0)
        : calculateShortEntryPrice(currentPrice, Math.abs(oc), strategy.extend || 0);

      // Pre-calculate extend distance (full 100% extend move from baseOpen to entryPrice)
      const totalExtendDistance = Math.abs(baseOpen - entryPrice);

      // The 'extend' logic is disabled for the counter-trend strategy as it's based on the previous trend-following model.
      const extendOK = true;
      
      logger.info(`[WebSocketOCConsumer] Extend check for strategy ${strategy.id}: extendOK=${extendOK}, extendVal=${extendVal}, side=${side}, currentPrice=${currentPrice}, entryPrice=${entryPrice}, baseOpen=${baseOpen}, totalExtendDistance=${totalExtendDistance}`);

      // Calculate TP and SL (based on side)
      const tpPrice = calculateTakeProfit(entryPrice, Math.abs(oc), strategy.take_profit || 55, side);
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
        amount: strategy.amount || 1000 // Default amount if not set
      };

      // If extend condition not met, either place passive LIMIT (if enabled) or skip.
      // New behaviour:
      // - Không yêu cầu giá phải chạm 100% mức extend.
      // - Cho phép đặt LIMIT nếu chênh lệch giữa currentPrice và entryPrice <= EXTEND_LIMIT_MAX_DIFF_RATIO * quãng đường extend.
      if (!extendOK) {
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
      logger.error(`[WebSocketOCConsumer] Error processing match:`, error?.message || error);
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

