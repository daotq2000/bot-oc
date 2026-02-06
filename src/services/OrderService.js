import { Position } from '../models/Position.js';
// EntryOrder tracking is deprecated after introducing positions.status='entry_pending'
// import { EntryOrder } from '../models/EntryOrder.js';
import { TelegramService } from './TelegramService.js';
import { positionLimitService } from './PositionLimitService.js';

import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * Order Service - Order execution and management
 */
export class OrderService {
  constructor(exchangeService, telegramService) {
    this.exchangeService = exchangeService;
    this.telegramService = telegramService;
    
    // Cache for position counts to avoid excessive DB queries
    this.positionCountCache = new Map(); // botId -> { count, timestamp }
    this.positionCountCacheTTL = 5000; // 5 seconds
    this.maxCacheSize = 100; // Maximum number of bot entries to cache
    
    // Start periodic cleanup to prevent memory leaks
    this.startCacheCleanup();
  }

  /**
   * Start periodic cache cleanup
   */
  startCacheCleanup() {
    // Clean up old cache entries every 30 seconds
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => {
      this.cleanupCache();
    }, 30000); // 30 seconds
  }

  /**
   * Clean up old cache entries to prevent memory leaks
   */
  cleanupCache() {
    const now = Date.now();
    let cleaned = 0;
    
    // Remove expired entries
    for (const [botId, value] of this.positionCountCache.entries()) {
      if (now - value.timestamp > this.positionCountCacheTTL * 2) {
        this.positionCountCache.delete(botId);
        cleaned++;
      }
    }
    
    // Enforce max size (LRU eviction)
    if (this.positionCountCache.size > this.maxCacheSize) {
      const entries = Array.from(this.positionCountCache.entries())
        .sort((a, b) => a[1].timestamp - b[1].timestamp);
      const toRemove = entries.slice(0, this.positionCountCache.size - this.maxCacheSize);
      for (const [botId] of toRemove) {
        this.positionCountCache.delete(botId);
        cleaned++;
      }
    }
    
    if (cleaned > 0) {
      logger.debug(`[OrderService] Cleaned ${cleaned} cache entries. Current size: ${this.positionCountCache.size}`);
    }
  }

  /**
   * Stop cache cleanup timer
   */
  stopCacheCleanup() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
  }

  // Send central log to file (orders.log / orders-error.log) instead of Telegram
  // level: 'info' | 'warn' | 'error'
  async sendCentralLog(message, level = 'info') {
    try {
      const { orderLogger } = await import('../utils/logger.js');
      const logMessage = String(message || '');
      
      if (level === 'error') {
        orderLogger.error(logMessage);
      } else if (level === 'warn') {
        orderLogger.warn(logMessage);
      } else {
        orderLogger.info(logMessage);
      }
    } catch (e) {
      logger.warn(`[OrderService] Failed to write order log: ${e?.message || e}`);
      // Fallback to main logger if orderLogger fails
      if (level === 'error') {
        logger.error(`[OrderService] ${message}`);
      } else if (level === 'warn') {
        logger.warn(`[OrderService] ${message}`);
      } else {
        logger.info(`[OrderService] ${message}`);
      }
    }
  }

  /**
   * Execute signal and create order
   * @param {Object} signal - Signal object from RealtimeOCDetector/WebSocketOCConsumer
   * @returns {Promise<Object|null>} Position object or null
   */
  async executeSignal(signal) {
    try {
      const { strategy, side, entryPrice, amount, tpPrice, slPrice } = signal;

      // Central log: attempt
      await this.sendCentralLog(`Order Attempt | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} entry=${entryPrice} amt=${amount} tp=${tpPrice ?? 'n/a'} sl=${slPrice ?? 'n/a'} oc=${signal?.oc ?? 'n/a'}`);

      // Enforce minimum notional for new positions (protect from tiny orders)
      const minNotional = 6; // USDT
      if (Number(amount) < minNotional) {
        logger.warn(`[OrderService] Skip order: amount ${Number(amount).toFixed(2)} < ${minNotional} USDT (bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol})`);
        await this.sendCentralLog(
          `Order SkipMinNotional | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} side=${String(side).toUpperCase()} amt=${Number(amount).toFixed(2)} < ${minNotional}`,
          'warn'
        );
        return null;
      }

      // Simple position limit check (with cache)
      // max_concurrent_trades MUST come from bots table (JOINed into strategy as a top-level field)
      // Do not rely on strategy.bot here because strategy objects are often plain rows.
      // Position limit: prefer the bot config (strategy.bot.max_concurrent_trades)
      // NOTE: The previous code used `strategy?.bot` which is an object; Number(object) => NaN,
      // causing fallback/default behavior and wrong limits.
      const maxPositions = Number(strategy?.bot?.max_concurrent_trades ?? strategy?.max_concurrent_trades ?? 100);
      
      // Only check if limit is set and reasonable
      if (maxPositions > 0 && maxPositions < 10000) {
        const now = Date.now();
        const cached = this.positionCountCache.get(strategy.bot_id);
        
        let currentCount;
        if (cached && (now - cached.timestamp) < this.positionCountCacheTTL) {
          currentCount = cached.count;
        } else {
          // Query database
          const pool = (await import('../config/database.js')).default;
          const [result] = await pool.execute(
            'SELECT COUNT(*) as count FROM positions WHERE bot_id = ? AND status = ?',
            [strategy.bot_id, 'open']
          );
          currentCount = result[0].count;
          
          // Update cache
          this.positionCountCache.set(strategy.bot_id, {
            count: currentCount,
            timestamp: now
          });
        }
        
        if (currentCount >= maxPositions) {
          logger.warn(`[OrderService] Max positions reached for bot ${strategy.bot_id}: ${currentCount}/${maxPositions}, skipping strategy ${strategy.id}`);
          return null;
        }
      }
      
      // Per-coin exposure limit (max_amount_per_coin, in USDT) - HARD LIMIT
      // Check using PositionLimitService before creating any new order
      const canOpen = await positionLimitService.canOpenNewPosition({
        botId: strategy.bot_id,
        symbol: strategy.symbol,
        newOrderAmount: amount
      });

      if (!canOpen) {
        // Get current total for logging
        const currentTotal = await positionLimitService.getCurrentTotalAmount(strategy.bot_id, strategy.symbol);
      const maxAmountPerCoin = Number(strategy.bot?.max_amount_per_coin || 0);
        
            logger.warn(
          `[OrderService] [POSITION_LIMIT_REACHED] bot=${strategy.bot_id} symbol=${strategy.symbol} ` +
          `current=${currentTotal.toFixed(2)} new=${Number(amount || 0).toFixed(2)} max=${maxAmountPerCoin.toFixed(2)}. ` +
          `Skipping strategy ${strategy.id}`
            );
            await this.sendCentralLog(
              `Order SkipMaxPerCoin | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ` +
          `${String(side).toUpperCase()} current=${currentTotal.toFixed(2)} new=${Number(amount || 0).toFixed(2)} max=${maxAmountPerCoin.toFixed(2)}`
            );
            return null;
      }
      
      // Check if entry price is still valid
      const currentPrice = await this.exchangeService.getTickerPrice(strategy.symbol);
      
      // Determine order type:
      // 1. Force MARKET if signal.forceMarket is true (trend-following strategies)
      // 2. Force LIMIT if signal.forcePassiveLimit is true (extend not met for counter-trend)
      // 3. Otherwise, use shouldUseMarketOrder() logic
      let orderType;
      if (signal.forceMarket) {
        // Trend-following: Always use MARKET order to avoid "order would immediately trigger" error
        orderType = 'market';
        logger.info(
          `[OrderService] Force MARKET order for trend-following strategy ${strategy.id} ` +
          `(entry=${entryPrice}, current=${currentPrice})`
        );
      } else if (signal.forcePassiveLimit) {
        // Counter-trend with extend not met: Use LIMIT order
        orderType = 'limit';
      } else {
        // Default: Check if price already passed entry or too far from entry
        orderType = this.shouldUseMarketOrder(side, currentPrice, entryPrice)
          ? 'market'
          : 'limit';
      }

      // Create order
      // For SHORT with limit and NOT forced passive limit, use entry trigger STOP_MARKET instead of passive limit
      let order;
      let attemptedMarketFallback = false;
      try {
          // Note: amount here is in USDT, ExchangeService will calculate quantity
          order = await this.exchangeService.createOrder({
            symbol: strategy.symbol,
            side: side === 'long' ? 'buy' : 'sell',
            positionSide: side === 'long' ? 'LONG' : 'SHORT',
            amount: amount, // USDT amount from strategy config
            type: orderType,
            price: orderType === 'limit' ? entryPrice : undefined
          });
      } catch (e) {
        const em = e?.message || '';
        // Binance Quant Rule (-4400): allow only reduceOnly for now → skip opening order
        if (em.includes('-4400') || em.toLowerCase().includes('quantitative rules') || em.toLowerCase().includes('reduceonly order is allowed')) {
          logger.warn(
            `[OrderService] Skip order due to Binance quant rule (-4400) | bot=${strategy?.bot_id} ` +
            `strat=${strategy?.id} symbol=${strategy.symbol} side=${side} amount=${amount} reason=${em}`
          );
          await this.sendCentralLog(
            `Order SkipQuantRule | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ` +
            `${String(side).toUpperCase()} amount=${amount} reason=${em}`,
            'warn'
          );
          return null;
        }
        
        // Handle margin insufficient error (-2019) - skip order gracefully
        if (em.includes('-2019') || em.includes('Margin is insufficient') || em.includes('Insufficient margin')) {
          logger.error(
            `[OrderService] ❌ Margin insufficient, skipping order | bot=${strategy?.bot_id} ` +
            `strat=${strategy?.id} symbol=${strategy.symbol} side=${side} amount=${amount} USDT`
          );
          await this.sendCentralLog(
            `Order SkippedInsufficientMargin | bot=${strategy?.bot_id} strat=${strategy?.id} ` +
            `${strategy?.symbol} ${String(side).toUpperCase()} amount=${amount} USDT`
          );
          return null; // Skip order instead of throwing error
        }
        
        // MEXC and Binance error handling for immediate trigger
        const shouldFallbackToMarket = 
          em.includes('-2021') || 
          em.toLowerCase().includes('would immediately trigger') ||
          em.includes('Order price is too high') ||
          em.includes('Order price is too low') ||
          em.includes('Invalid order price');
        
        // Check config to enable/disable fallback to market
        const enableFallbackToMarket = configService.getBoolean('ENABLE_FALLBACK_TO_MARKET', false);

        if (shouldFallbackToMarket && enableFallbackToMarket) {
          logger.warn(`[OrderService] Fallback to MARKET due to price trigger for ${strategy.symbol} (side=${side}). Error: ${em}`);
          attemptedMarketFallback = true;
          order = await this.exchangeService.createOrder({
            symbol: strategy.symbol,
            side: side === 'long' ? 'buy' : 'sell',
            positionSide: side === 'long' ? 'LONG' : 'SHORT',
            amount: amount,
            type: 'market'
          });
          orderType = 'market';
          await this.sendCentralLog(`Order FallbackToMarket | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} reason=${em}`);
        } else {
          // Log and skip order if fallback is disabled
          if (shouldFallbackToMarket && !enableFallbackToMarket) {
            logger.warn(`[OrderService] Order would trigger immediately but fallback to market is disabled. Skipping order for ${strategy.symbol} (side=${side}). Error: ${em}`);
            await this.sendCentralLog(`Order SkippedNoFallback | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} reason=${em}`);
            return null; // Skip order instead of throwing error
          }
          throw e;
        }
      }

      // Ensure we have a valid order object before proceeding
      if (!order || !order.id) {
        logger.error(`[OrderService] Order creation failed or returned invalid object for ${strategy.symbol}. Aborting position creation.`);
        await this.sendCentralLog(`Order Failed | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} reason=InvalidOrderObject`);
        // Do not throw here, just return null to prevent crashing the scanner
        return null;
      }

      // Determine effective entry price and whether we have confirmed exposure:
      // - MARKET (or fallback): use avgFillPrice / price / currentPrice
      // - LIMIT: immediately query order status; if already filled, use real fill price
      let effectiveEntryPrice = entryPrice;
      let hasImmediateExposure = false; // true if MARKET or LIMIT already filled
      try {
        if (orderType === 'market') {
          const filled = Number(order?.avgFillPrice || order?.price || currentPrice);
          if (Number.isFinite(filled) && filled > 0) {
            effectiveEntryPrice = filled;
            hasImmediateExposure = true;
          }
        } else if (orderType === 'limit') {
          // Sync confirmation: check if the limit order was filled immediately
          const st = await this.exchangeService.getOrderStatus(strategy.symbol, order.id);
          const status = (st?.status || '').toLowerCase();
          const filledQty = Number(st?.filled || 0);

          if (status === 'closed' || status === 'filled' || filledQty > 0) {
            // Try to get the precise average fill price
            const avg = await this.exchangeService.getOrderAverageFillPrice(strategy.symbol, order.id);
            if (Number.isFinite(avg) && avg > 0) {
              effectiveEntryPrice = avg;
              hasImmediateExposure = true;
              logger.debug(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} filled immediately, using avgFillPrice=${avg} as entry.`);
            } else {
              // Fallback to entryPrice if avgFillPrice not available
              effectiveEntryPrice = entryPrice;
              hasImmediateExposure = true;
              logger.debug(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} filled immediately, fallback to entryPrice=${entryPrice}.`);
            }
          } else {
            // CRITICAL FIX: If LIMIT order price was crossed, treat as exposure even if status is 'open'
            // Exchange lag can cause status to be 'open' even when order is already filled
            const priceCrossed = 
              (side === 'long' && currentPrice > entryPrice) ||
              (side === 'short' && currentPrice < entryPrice);
            
            if (priceCrossed) {
              // Price crossed entry - order likely filled but status not updated yet
              // Treat as exposure to avoid duplicate position creation
              effectiveEntryPrice = currentPrice; // Use current price as best estimate
              hasImmediateExposure = true;
              logger.warn(
                `[OrderService] LIMIT order ${order.id} for ${strategy.symbol} price crossed (status=${st?.status || 'n/a'}, ` +
                `currentPrice=${currentPrice}, entryPrice=${entryPrice}). Treating as filled to avoid duplicate position.`
              );
            } else {
              logger.debug(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} not filled yet (status=${st?.status || 'n/a'}, filled=${filledQty}). Position will track exposure via guards.`);
            }
          }
        }
      } catch (e) {
        logger.warn(`[OrderService] Failed to refine entry price from exchange for order ${order?.id} ${strategy.symbol}: ${e?.message || e}`);
      }

      // Calculate temporary TP/SL prices based on the effective entry price
      const { calculateTakeProfit, calculateInitialStopLoss, calculateInitialStopLossByAmount } = await import('../utils/calculator.js');
      const tempTpPrice = calculateTakeProfit(effectiveEntryPrice, strategy.take_profit, side);
      // Only compute SL when strategy.stoploss > 0. No fallback to reduce/up_reduce
      // NEW: stoploss is now in USDT (not percentage), need quantity to calculate SL price
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const hasValidStoploss = Number.isFinite(rawStoploss) && rawStoploss > 0;
      
      // Calculate quantity from amount and entry price for SL calculation
      let tempSlPrice = null;
      if (hasValidStoploss) {
        const estimatedQuantity = effectiveEntryPrice > 0 ? amount / effectiveEntryPrice : 0;
        if (estimatedQuantity > 0) {
          tempSlPrice = calculateInitialStopLossByAmount(effectiveEntryPrice, estimatedQuantity, rawStoploss, side);
        } else {
          logger.warn(`[OrderService] Cannot calculate SL: invalid quantity (amount=${amount}, entry=${effectiveEntryPrice})`);
        }
      }

      // --- UNIFIED POSITION CREATION ---
      // Always create a Position record immediately after order placement on exchange.
      // This ensures every intended position is tracked in the DB from the start.
      let position = null;
      try {
        position = await Position.create({
          strategy_id: strategy.id,
          bot_id: strategy.bot_id,
          order_id: order.id,
          symbol: strategy.symbol,
          side: side,
          entry_price: effectiveEntryPrice, // This is the intended/estimated entry price
          amount: amount,
          take_profit_price: tempTpPrice,
          stop_loss_price: tempSlPrice,
          current_reduce: strategy.reduce,
          status: 'entry_pending', // NEW: Start with a pending status
          tp_sl_pending: true, // TP/SL orders will be placed after fill confirmation
          not_on_exchange_count: 0
        });
        logger.info(`[OrderService] Position ${position.id} created with status 'entry_pending' for order ${order.id}.`);

        // If fill is already confirmed (MARKET or immediate LIMIT), promote to 'open' right away.
        if (hasImmediateExposure) {
          position = await Position.update(position.id, {
            status: 'open',
            entry_price: effectiveEntryPrice // Update with the actual fill price
          });
          logger.info(`[OrderService] Position ${position.id} promoted to 'open' immediately (fill confirmed).`);
        }
      } catch (posError) {
        logger.error(`[OrderService] CRITICAL: Failed to create Position in DB after order was placed on exchange. OrderId: ${order.id}. Error: ${posError?.message || posError}`);
        // We don't re-throw, but PositionSync will need to heal this.
        return null;
      }

      if (position) {
        // Only treat as opened when status is open (entry filled confirmed)
        if (position.status === 'open') {
          logger.info(`Position opened:`, {
            positionId: position.id,
            symbol: strategy.symbol,
            side,
            entryPrice: position.entry_price,
            tpPrice,
            slPrice
          });

          // Ensure bot info present before sending notifications
          if (!strategy.bot && strategy.bot_id) {
            const { Bot } = await import('../models/Bot.js');
            strategy.bot = await Bot.findById(strategy.bot_id);
          }

          // Telegram notification disabled to avoid spam and rate limits
          // Order logs are now written to logs/orders.log and logs/orders-error.log files
          // try {
          //   await this.telegramService.sendOrderNotification(position, strategy);
          //   logger.debug(`[OrderService] ✅ Order notification sent successfully for position ${position.id}`);
          // } catch (e) {
          //   logger.error(`[OrderService] Failed to send order notification for position ${position.id}:`, e);
          // }

          // Send entry trade alert to central channel
          try {
            // Ensure bot info is loaded before sending alert
            if (!strategy.bot && strategy.bot_id) {
              const { Bot } = await import('../models/Bot.js');
              strategy.bot = await Bot.findById(strategy.bot_id);
              logger.debug(`[OrderService] Loaded bot info for strategy ${strategy.id}: bot_id=${strategy.bot?.id}, exchange=${strategy.bot?.exchange}`);
            }
            
            logger.info(`[OrderService] Sending entry trade alert for position ${position.id} (symbol=${position.symbol}, bot_id=${strategy.bot_id})`);
            await this.telegramService.sendEntryTradeAlert(position, strategy, signal.oc);
            logger.info(`[OrderService] ✅ Entry trade alert sent successfully for position ${position.id}`);
          } catch (e) {
            logger.error(`[OrderService] Failed to send entry trade channel alert for position ${position.id}:`, e);
            logger.error(`[OrderService] Error stack:`, e?.stack);
          }
        }

        // TP/SL creation is handled by PositionMonitor.
        logger.debug(`Entry order placed for position ${position.id}. TP/SL will be placed by PositionMonitor.`);

        // ✅ NEW: Immediate TP/SL placement for filled positions
        // This ensures protection is in place within milliseconds of entry
        if (position.status === 'open') {
          const immediateTPSLEnabled = configService.getBoolean('IMMEDIATE_TPSL_ENABLED', true);
          if (immediateTPSLEnabled) {
            // Place TP/SL immediately in background (non-blocking)
            this.placeImmediateTpSl(position, strategy, effectiveEntryPrice, tempTpPrice, tempSlPrice)
              .catch(err => {
                logger.warn(`[OrderService] Immediate TP/SL failed for position ${position.id}, PositionMonitor will retry: ${err?.message || err}`);
              });
          }
        }

        if (position.status === 'open') {
          // Central log: success (filled)
          await this.sendCentralLog(`Order Success | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} orderId=${order?.id} posId=${position?.id} type=${orderType} entry=${position.entry_price} tp=${tempTpPrice} sl=${tempSlPrice}`);
        } else {
          // Central log: pending entry
          await this.sendCentralLog(`Order EntryPending | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} orderId=${order?.id} posId=${position?.id} type=${orderType} entry=${effectiveEntryPrice} tp=${tempTpPrice} sl=${tempSlPrice}`);
        }
      }

      // Always return the Position record (status can be entry_pending or open)
      return position;
    } catch (error) {
      const msg = error?.message || '';
      const softErrors = [
        'not available for trading on Binance Futures',
        'below minimum notional',
        'Invalid price after rounding',
        'Precision is over the maximum',
      ];
      if (
        softErrors.some(s => msg.includes(s)) ||
        msg.includes('-1121') || msg.includes('-1111') || msg.includes('-4061') || msg.includes('-2027')
      ) {
        logger.warn(`Skip executing signal due to validation: ${msg}`);
        await this.sendCentralLog(`Order SoftSkip | bot=${signal?.strategy?.bot_id} strat=${signal?.strategy?.id} ${signal?.strategy?.symbol} ${String(signal?.side).toUpperCase()} reason=${msg}`);
        return null; // do not escalate
      }

            logger.error(`Failed to execute signal:`, error);

      // Detailed error logging for order placement failures
      const errorContext = {
        message: 'Order placement failed',
        bot_id: signal?.strategy?.bot_id,
        strategy_id: signal?.strategy?.id,
        symbol: signal?.strategy?.symbol,
        side: signal?.side,
        oc: signal?.oc,
        errorMessage: error?.message,
        errorCode: error?.code,
        errorStack: error?.stack
      };
      logger.error('Order Execution Error', errorContext);
      if (error.code) {
        logger.error(`Error code: ${error.code}`);
      }
      if (error.message) {
        logger.error(`Error message: ${error.message}`);
      }
      // Central log: failure
      try {
        const strat = signal?.strategy || {};
        await this.sendCentralLog(`Order Error | bot=${strat?.bot_id} strat=${strat?.id} ${strat?.symbol} ${String(signal?.side).toUpperCase()} msg=${error?.message || error} code=${error?.code || ''}`, 'error');
      } catch (_) {}
      throw error;
    } finally {
      // If order was not created, cancel reservation (if any)
      // Cleanup logic removed (concurrency management disabled)
    }
  }

  /**
   * Check if should use market order instead of limit
   * @param {string} side - 'long' or 'short'
   * @param {number} currentPrice - Current market price
   * @param {number} entryPrice - Desired entry price
   * @returns {boolean}
   */
  shouldUseMarketOrder(side, currentPrice, entryPrice) {
    if (!Number.isFinite(currentPrice) || !Number.isFinite(entryPrice) || currentPrice <= 0 || entryPrice <= 0) {
      return false; // Invalid prices, use limit as safe default
    }
    
    const priceDiff = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
    
    // CRITICAL FIX: Use MARKET order when:
    // 1. Price already crossed entry (missed limit opportunity)
    // 2. Price is too far from entry (>0.5%) - limit unlikely to fill
    // 
    // Use LIMIT order when:
    // - Price is close to entry (<0.5%) and hasn't crossed yet
    const hasCrossedEntry = 
      (side === 'long' && currentPrice > entryPrice) ||
      (side === 'short' && currentPrice < entryPrice);
    
    return hasCrossedEntry || priceDiff > 0.5;
  }

  /**
   * Calculate order amount in contracts
   * @param {string} symbol - Trading symbol
   * @param {number} amountUSDT - Amount in USDT
   * @param {number} price - Entry price
   * @returns {Promise<number>} Order amount in contracts
   */
  async calculateOrderAmount(symbol, amountUSDT, price) {
    // For most futures contracts, 1 contract = 1 USDT
    // But we should calculate based on contract size
    // For simplicity, assuming 1:1 ratio
    // In production, fetch contract size from exchange
    return amountUSDT / price;
  }

  /**
   * Cancel order and update position
   * @param {Object} position - Position object
   * @param {string} reason - Cancel reason
   * @returns {Promise<Object>} Updated position
   */
  async cancelOrder(position, reason) {
    try {
      // Cancel order on exchange
      await this.exchangeService.cancelOrder(position.order_id, position.symbol);

      // Update position status
      const updated = await Position.cancel(position.id, reason);

      logger.info(`Order cancelled:`, {
        positionId: position.id,
        symbol: position.symbol,
        reason
      });

      return updated;
    } catch (error) {
      logger.error(`Failed to cancel order for position ${position.id}:`, error);
      throw error;
    }
  }

  /**
   * Close position manually
   * @param {Object} position - Position object
   * @returns {Promise<Object>} Updated position
   */
  async closePosition(position) {
    try {
      // Get current price
      const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);

      // Close position on exchange
      await this.exchangeService.closePosition(
        position.symbol,
        position.side,
        position.amount
      );

      // Calculate PnL
      const { calculatePnL } = await import('../utils/calculator.js');
      const pnl = calculatePnL(
        position.entry_price,
        currentPrice,
        position.amount,
        position.side
      );

      // Update position
      const updated = await Position.close(position.id, currentPrice, pnl, 'manual');

      logger.info(`Position closed manually:`, {
        positionId: position.id,
        symbol: position.symbol,
        pnl
      });

      // Send Telegram notification
      await this.telegramService.sendCloseNotification(updated, position);

      return updated;
    } catch (error) {
      logger.error(`Failed to close position ${position.id}:`, error);
      throw error;
    }
  }

  /**
   * ✅ NEW: Place TP/SL orders immediately after entry fill
   * This ensures position protection is in place within milliseconds
   * UPGRADED: Places TP and SL in PARALLEL for faster protection
   * 
   * @param {Object} position - Position object
   * @param {Object} strategy - Strategy object
   * @param {number} entryPrice - Actual entry fill price
   * @param {number} tpPrice - Calculated take profit price
   * @param {number} slPrice - Calculated stop loss price
   * @returns {Promise<{tpOrderId: string|null, slOrderId: string|null}>}
   */
  async placeImmediateTpSl(position, strategy, entryPrice, tpPrice, slPrice) {
    const startTime = Date.now();
    let tpOrderId = null;
    let slOrderId = null;

    try {
      logger.info(
        `[OrderService] 🚀 Placing immediate TP/SL for position ${position.id} | ` +
        `symbol=${position.symbol} side=${position.side} entry=${entryPrice} tp=${tpPrice} sl=${slPrice}`
      );

      // Get closable quantity from exchange for validation and preferred quantity
      const quantity = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
      if (!quantity || quantity <= 0) {
        logger.warn(`[OrderService] No closable quantity for position ${position.id}, skipping immediate TP/SL`);
        return { tpOrderId: null, slOrderId: null };
      }

      // ========== PARALLEL TP+SL PLACEMENT ==========
      // Use dedicated TP/SL creation methods which handle closePosition properly
      const orderPromises = [];
      
      // TP order promise - use createCloseTakeProfitMarket which handles closePosition correctly
      if (tpPrice && Number.isFinite(tpPrice) && tpPrice > 0) {
        orderPromises.push(
          this.exchangeService.createCloseTakeProfitMarket(
            position.symbol,
            position.side,    // 'long' or 'short'
            tpPrice,
            position,         // pass position for clientOrderId mapping
            quantity          // preferred quantity
          ).then(order => ({ type: 'tp', order, price: tpPrice }))
            .catch(err => ({ type: 'tp', error: err, price: tpPrice }))
        );
      }
      
      // SL order promise - use createCloseStopMarket which handles closePosition correctly
      if (slPrice && Number.isFinite(slPrice) && slPrice > 0) {
        orderPromises.push(
          this.exchangeService.createCloseStopMarket(
            position.symbol,
            position.side,    // 'long' or 'short'
            slPrice,
            position,         // pass position for clientOrderId mapping
            quantity          // preferred quantity (will be passed to createCloseStopMarket)
          ).then(order => ({ type: 'sl', order, price: slPrice }))
            .catch(err => ({ type: 'sl', error: err, price: slPrice }))
        );
      }

      // Wait for all orders to complete
      const results = await Promise.all(orderPromises);
      
      // Process results
      for (const result of results) {
        if (result.type === 'tp') {
          // Binance returns orderId, not id - handle both cases
          const orderId = result.order?.orderId || result.order?.id;
          if (orderId) {
            tpOrderId = orderId;
            logger.info(
              `[OrderService] ✅ Immediate TP placed for position ${position.id} | ` +
              `orderId=${tpOrderId} price=${result.price} qty=${quantity}`
            );
          } else if (result.order === null) {
            // createCloseTakeProfitMarket returns null when no position exists on exchange
            logger.warn(`[OrderService] TP skipped for position ${position.id}: no position found on exchange`);
          } else if (result.error) {
            const errMsg = result.error?.message || '';
            if (errMsg.includes('-2021') || errMsg.includes('would immediately trigger')) {
              logger.warn(`[OrderService] TP would trigger immediately for position ${position.id}, skipping TP order`);
            } else if (errMsg.includes('-2022') || errMsg.includes('ReduceOnly')) {
              logger.warn(`[OrderService] ReduceOnly rejected for TP on position ${position.id}: ${errMsg}`);
            } else {
              logger.error(`[OrderService] Failed to place immediate TP for position ${position.id}: ${errMsg}`);
            }
          }
        } else if (result.type === 'sl') {
          // Binance returns orderId, not id - handle both cases
          const orderId = result.order?.orderId || result.order?.id;
          if (orderId) {
            slOrderId = orderId;
            logger.info(
              `[OrderService] ✅ Immediate SL placed for position ${position.id} | ` +
              `orderId=${slOrderId} price=${result.price} qty=${quantity}`
            );
          } else if (result.order === null) {
            // createCloseStopMarket returns null when no position exists on exchange
            logger.warn(`[OrderService] SL skipped for position ${position.id}: no position found on exchange`);
          } else if (result.error) {
            const errMsg = result.error?.message || '';
            if (errMsg.includes('-2021') || errMsg.includes('would immediately trigger')) {
              logger.warn(`[OrderService] SL would trigger immediately for position ${position.id}, skipping SL order`);
            } else if (errMsg.includes('-2022') || errMsg.includes('ReduceOnly')) {
              logger.warn(`[OrderService] ReduceOnly rejected for SL on position ${position.id}: ${errMsg}`);
            } else {
              logger.error(`[OrderService] Failed to place immediate SL for position ${position.id}: ${errMsg}`);
            }
          }
        }
      }

      // ========== UPDATE POSITION IN DB ==========
      const updateData = {};
      if (tpOrderId) {
        updateData.exit_order_id = tpOrderId;
        updateData.take_profit_price = tpPrice;
      }
      if (slOrderId) {
        updateData.sl_order_id = slOrderId;
        updateData.stop_loss_price = slPrice;
      }
      
      // Clear tp_sl_pending if at least TP was placed successfully
      if (tpOrderId) {
        updateData.tp_sl_pending = false;
      }

      if (Object.keys(updateData).length > 0) {
        await Position.update(position.id, updateData);
      }

      const duration = Date.now() - startTime;
      logger.info(
        `[OrderService] ⚡ Immediate TP/SL completed for position ${position.id} in ${duration}ms | ` +
        `tpOrderId=${tpOrderId || 'N/A'} slOrderId=${slOrderId || 'N/A'}`
      );

      return { tpOrderId, slOrderId };
    } catch (error) {
      const duration = Date.now() - startTime;
      logger.error(
        `[OrderService] ❌ Immediate TP/SL failed for position ${position.id} after ${duration}ms: ${error?.message || error}`
      );
      // Don't throw - let PositionMonitor handle as fallback
      return { tpOrderId, slOrderId };
    }
  }
}

