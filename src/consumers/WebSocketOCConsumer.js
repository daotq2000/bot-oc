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
    // Track failure cooldown per strategy to avoid retrying failed orders too soon
    this.failureCooldown = new Map(); // strategyId -> until timestamp (ms)
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

      // Log PIPPIN and first few price ticks
      const isPippin = symbol?.toUpperCase().includes('PIPPIN');
      if (isPippin || this.processedCount <= 10) {
        logger.info(`[WebSocketOCConsumer] 📥 Received price tick: ${exchange} ${symbol} = ${price} (count: ${this.processedCount}, isRunning: ${this.isRunning})`);
      }

      // Log every 1000th price tick for debugging
      if (this.processedCount % 1000 === 0) {
        logger.info(`[WebSocketOCConsumer] Processed ${this.processedCount} price ticks, ${this.matchCount} matches`);
      }

      // Detect OC and match with strategies
      if (isPippin) {
        logger.info(`[WebSocketOCConsumer] 🔍 Calling detectOC for ${exchange} ${symbol} @ ${price}`);
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

      // Process each match
      for (const match of matches) {
        logger.info(`[WebSocketOCConsumer] 🎯 Processing match: strategy ${match.strategy.id}, bot_id=${match.strategy.bot_id}, symbol=${match.strategy.symbol}, OC=${match.oc.toFixed(2)}%`);
        await this.processMatch(match).catch(error => {
          logger.error(`[WebSocketOCConsumer] ❌ Error processing match for strategy ${match.strategy.id}:`, error?.message || error, error?.stack);
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

      // Failure cool-down: avoid retrying failed orders too soon per strategy
      try {
        const until = this.failureCooldown.get(strategy.id);
        if (until && until > Date.now()) {
          logger.info(`[WebSocketOCConsumer] ⏳ Skip strategy ${strategy.id} due to failure cooldown until ${new Date(until).toISOString()}`);
          return;
        }
      } catch (_) {}

      logger.info(`[WebSocketOCConsumer] 🔍 Processing match: strategy ${strategy.id}, bot_id=${botId}, symbol=${strategy.symbol}, OC=${oc.toFixed(2)}%`);
      logger.info(`[WebSocketOCConsumer] Available OrderServices: ${Array.from(this.orderServices.keys()).join(', ')} (total: ${this.orderServices.size})`);

      // Get OrderService for this bot
      const orderService = this.orderServices.get(botId);
      if (!orderService) {
        logger.error(`[WebSocketOCConsumer] ❌ No OrderService found for bot ${botId}, skipping strategy ${strategy.id}. Available bots: ${Array.from(this.orderServices.keys()).join(', ')}`);
        return;
      }
      
      logger.info(`[WebSocketOCConsumer] ✅ Found OrderService for bot ${botId}`);

      // Check if strategy already has open position
      const { Position } = await import('../models/Position.js');
      const openPositions = await Position.findOpen(strategy.id);
      if (openPositions.length > 0) {
        logger.info(`[WebSocketOCConsumer] ⏭️ Strategy ${strategy.id} already has ${openPositions.length} open position(s), skipping`);
        return;
      }
      
      logger.info(`[WebSocketOCConsumer] ✅ No open positions for strategy ${strategy.id}, proceeding to create order`);

      // Import calculator functions for TP/SL calculation
      const { calculateTakeProfit, calculateInitialStopLoss, calculateLongEntryPrice, calculateShortEntryPrice } = await import('../utils/calculator.js');

      // Counter-trend side mapping: bullish → short, bearish → long
      const side = direction === 'bullish' ? 'short' : 'long';

      // Use interval open price for entry calculation (per-bucket open)
      const baseOpen = Number.isFinite(Number(match.openPrice)) && Number(match.openPrice) > 0
        ? Number(match.openPrice)
        : currentPrice;

      // Calculate entry price based on counter-trend side and OPEN price
      const entryPrice = side === 'long'
        ? calculateLongEntryPrice(baseOpen, Math.abs(oc), strategy.extend || 0)
        : calculateShortEntryPrice(baseOpen, Math.abs(oc), strategy.extend || 0);

      // Check extend condition: only trigger when price reaches the entry zone
      let extendOK = true;
      const extendVal = Number(strategy.extend || 0);
      if (extendVal > 0) {
        if (side === 'long') {
          extendOK = currentPrice <= entryPrice && entryPrice < baseOpen;
        } else {
          extendOK = currentPrice >= entryPrice && entryPrice > baseOpen;
        }
      }

      // Calculate TP and SL (based on side)
      const tpPrice = calculateTakeProfit(entryPrice, Math.abs(oc), strategy.take_profit || 55, side);
      const slPrice = calculateInitialStopLoss(tpPrice, Math.abs(oc), strategy.reduce || 10, side);

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

      // If extend condition not met, either place passive LIMIT (if enabled) or skip
      if (!extendOK) {
        const allowPassive = configService.getBoolean('ENABLE_LIMIT_ON_EXTEND_MISS', true);
        if (allowPassive) {
          signal.forcePassiveLimit = true; // OrderService will create a passive LIMIT at entryPrice
          logger.info(`[WebSocketOCConsumer] Extend not met; placing passive LIMIT (forcePassiveLimit) for strategy ${strategy.id} at ${entryPrice}`);
        } else {
          logger.info(`[WebSocketOCConsumer] Extend not met; skipping order for strategy ${strategy.id}. side=${side} baseOpen=${baseOpen} entry=${entryPrice} current=${currentPrice}`);
          return;
        }
      }

      logger.info(`[WebSocketOCConsumer] 🚀 Triggering order for strategy ${strategy.id} (${strategy.symbol}): ${signal.side} @ ${currentPrice}, OC=${oc.toFixed(2)}%`);

      // Trigger order immediately
      const cooldownMs = Number(configService.getNumber('ORDER_FAILURE_COOLDOWN_MS', 60000));
      try {
        const result = await orderService.executeSignal(signal);
        if (!result) {
          // Soft failure (e.g., validation/min notional) -> set cooldown
          const until = Date.now() + cooldownMs;
          this.failureCooldown.set(strategy.id, until);
          logger.warn(`[WebSocketOCConsumer] ⏳ Soft failure/no order for strategy ${strategy.id}, cooldown until ${new Date(until).toISOString()}`);
          return;
        }
      } catch (error) {
        // Hard failure -> set cooldown
        const until = Date.now() + cooldownMs;
        this.failureCooldown.set(strategy.id, until);
        logger.error(`[WebSocketOCConsumer] ❌ Error executing signal for strategy ${strategy.id}, cooldown until ${new Date(until).toISOString()}:`, error?.message || error);
        return;
      }

      logger.info(`[WebSocketOCConsumer] ✅ Order triggered successfully for strategy ${strategy.id}`);
    } catch (error) {
      logger.error(`[WebSocketOCConsumer] Error processing match:`, error?.message || error);
    }
  }

  /**
   * Subscribe WebSocket for all strategy symbols
   */
  async subscribeWebSockets() {
    try {
      // Refresh strategy cache
      await strategyCache.refresh();

      logger.info(`[WebSocketOCConsumer] Strategy cache size: ${strategyCache.size()}`);

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
        
        // Log PIPPIN strategies
        if (symbol?.includes('PIPPIN')) {
          logger.info(`[WebSocketOCConsumer] Found PIPPIN strategy: ${key} -> strategy_id=${strategy.id}, bot_id=${strategy.bot_id}, oc=${strategy.oc}, interval=${strategy.interval}`);
        }
      }

      // Log PIPPIN symbols
      const allSymbols = new Set([...mexcSymbols, ...binanceSymbols]);
      const pippinSymbols = Array.from(allSymbols).filter(s => s.includes('PIPPIN'));
      if (pippinSymbols.length > 0) {
        logger.info(`[WebSocketOCConsumer] PIPPIN symbols found: ${pippinSymbols.join(', ')}`);
      }

      // Subscribe MEXC
      if (mexcSymbols.size > 0) {
        logger.info(`[WebSocketOCConsumer] Subscribing MEXC WS to ${mexcSymbols.size} strategy symbols`);
        mexcPriceWs.subscribe(Array.from(mexcSymbols));
      }

      // Subscribe Binance
      if (binanceSymbols.size > 0) {
        logger.info(`[WebSocketOCConsumer] Subscribing Binance WS to ${binanceSymbols.size} strategy symbols`);
        webSocketManager.subscribe(Array.from(binanceSymbols));
        
        // Log if PIPPIN is in Binance symbols
        if (Array.from(binanceSymbols).some(s => s.includes('PIPPIN'))) {
          logger.info(`[WebSocketOCConsumer] ✅ PIPPIN is in Binance subscription list`);
        } else {
          logger.warn(`[WebSocketOCConsumer] ⚠️ PIPPIN is NOT in Binance subscription list! Binance symbols: ${Array.from(binanceSymbols).slice(0, 10).join(', ')}...`);
        }
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

