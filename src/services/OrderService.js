import { Position } from '../models/Position.js';
import { EntryOrder } from '../models/EntryOrder.js';
import { TelegramService } from './TelegramService.js';

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

  // Send central log to fixed tracking channel
  async sendCentralLog(message) {
    try {
      const channelId = '-1003163801780';
      if (!this.telegramService || !this.telegramService.sendMessage) return;
      await this.telegramService.sendMessage(channelId, String(message || ''));
    } catch (e) {
      logger.warn(`[OrderService] Failed to send central log: ${e?.message || e}`);
    }
  }

  /**
   * Execute signal and create order
   * @param {Object} signal - Signal object from StrategyService
   * @returns {Promise<Object|null>} Position object or null
   */
  async executeSignal(signal) {
    try {
      const { strategy, side, entryPrice, amount, tpPrice, slPrice } = signal;

      // Central log: attempt
      await this.sendCentralLog(`Order Attempt | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} entry=${entryPrice} amt=${amount} tp=${tpPrice ?? 'n/a'} sl=${slPrice ?? 'n/a'} oc=${signal?.oc ?? 'n/a'}`);

      // Simple position limit check (with cache)
      const maxPositions = strategy.bot?.max_concurrent_trades || 100;
      
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

      // Per-coin exposure limit (max_amount_per_coin, in USDT) - configurable per bot
      const maxAmountPerCoin = Number(strategy.bot?.max_amount_per_coin || 0);
      if (Number.isFinite(maxAmountPerCoin) && maxAmountPerCoin > 0) {
        try {
          const pool = (await import('../config/database.js')).default;
          // NOTE: amount is stored in USDT (strategy.amount), so we sum p.amount.
          const [rows] = await pool.execute(
            `SELECT COALESCE(SUM(p.amount), 0) AS total_amount
             FROM positions p
             JOIN strategies s ON p.strategy_id = s.id
             WHERE s.bot_id = ? AND p.status = 'open' AND p.symbol = ?`,
            [strategy.bot_id, strategy.symbol]
          );
          const currentAmount = Number(rows?.[0]?.total_amount || 0);
          const projectedAmount = currentAmount + Number(amount || 0);

          if (projectedAmount > maxAmountPerCoin) {
            logger.warn(
              `[OrderService] max_amount_per_coin exceeded for bot ${strategy.bot_id}, symbol=${strategy.symbol}. ` +
              `current=${currentAmount}, new=${amount}, projected=${projectedAmount}, limit=${maxAmountPerCoin}. Skipping strategy ${strategy.id}`
            );
            await this.sendCentralLog(
              `Order SkipMaxPerCoin | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ` +
              `${String(side).toUpperCase()} current=${currentAmount} new=${amount} limit=${maxAmountPerCoin}`
            );
            return null;
          }
        } catch (exposureErr) {
          logger.warn(
            `[OrderService] Failed to check max_amount_per_coin for bot ${strategy.bot_id}, symbol=${strategy.symbol}:`,
            exposureErr?.message || exposureErr
          );
          // If exposure check fails, we proceed but log the issue.
        }
      }
      
      let orderCreated = false;

      // Check if entry price is still valid
      const currentPrice = await this.exchangeService.getTickerPrice(strategy.symbol);
      
      // For limit orders, we need to check if price is close enough
      // If price already passed entry, use market order
      let orderType = this.shouldUseMarketOrder(side, currentPrice, entryPrice)
        ? 'market'
        : 'limit';

      // Force passive limit if strategy indicates so (fallback when extend not met)
      if (signal.forcePassiveLimit) {
        orderType = 'limit';
      }

      // Create order
      // For SHORT with limit and NOT forced passive limit, use entry trigger STOP_MARKET instead of passive limit
      let order;
      let attemptedMarketFallback = false;
      try {
        if (side === 'short' && orderType === 'limit' && !signal.forcePassiveLimit && this.exchangeService?.bot?.exchange === 'binance') {
          const mktPrice = await this.exchangeService.getTickerPrice(strategy.symbol);
          if (!mktPrice || mktPrice <= 0) throw new Error('Cannot fetch current price for short trigger');
          const qty = amount / mktPrice;
          order = await this.exchangeService.createEntryTriggerOrder(
            strategy.symbol,
            side,
            entryPrice,
            qty
          );
        } else {
          // Note: amount here is in USDT, ExchangeService will calculate quantity
          order = await this.exchangeService.createOrder({
            symbol: strategy.symbol,
            side: side === 'long' ? 'buy' : 'sell',
            positionSide: side === 'long' ? 'LONG' : 'SHORT',
            amount: amount, // USDT amount from strategy config
            type: orderType,
            price: orderType === 'limit' ? entryPrice : undefined
          });
        }
      } catch (e) {
        const em = e?.message || '';
        
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
            logger.debug(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} filled immediately, fallback to entryPrice=${entryPrice}.`);
            hasImmediateExposure = true;
          }
        } else {
          logger.debug(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} not filled yet (status=${st?.status || 'n/a'}, filled=${filledQty}). Position will track exposure via guards.`);
        }
        }
      } catch (e) {
        logger.warn(`[OrderService] Failed to refine entry price from exchange for order ${order?.id} ${strategy.symbol}: ${e?.message || e}`);
      }

      // Calculate temporary TP/SL prices based on the effective entry price
      const { calculateTakeProfit, calculateInitialStopLoss } = await import('../utils/calculator.js');
      const tempTpPrice = calculateTakeProfit(effectiveEntryPrice, strategy.oc, strategy.take_profit, side);
      // Only compute SL when strategy.stoploss > 0. No fallback to reduce/up_reduce
      const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
      const hasValidStoploss = Number.isFinite(rawStoploss) && rawStoploss > 0;
      const tempSlPrice = hasValidStoploss ? calculateInitialStopLoss(effectiveEntryPrice, rawStoploss, side) : null;

      let position = null;

      if (hasImmediateExposure || orderType === 'market') {
        // MARKET or immediately-filled LIMIT: create Position right away
        try {
          position = await Position.create({
            strategy_id: strategy.id,
            bot_id: strategy.bot_id,
            order_id: order.id,
            symbol: strategy.symbol,
            side: side,
            entry_price: effectiveEntryPrice,
            amount: amount,
            take_profit_price: tempTpPrice, // Use temporary TP price
            stop_loss_price: tempSlPrice, // Use temporary SL price
            current_reduce: strategy.reduce
          });
          
          // CRITICAL: Finalize reservation immediately after Position is created
          // Position created successfully
          orderCreated = true;
          logger.debug(`[OrderService] Position ${position.id} created for bot ${strategy.bot_id}`);
        } catch (posError) {
          // If Position creation failed
          logger.error(`[OrderService] Failed to create Position: ${posError?.message || posError}`);
          throw posError;
        }
      } else {
        // Pending LIMIT (no confirmed fill yet): track in entry_orders table
        // CRITICAL: Do NOT finalize reservation here - keep it active until Position is created
        // EntryOrderMonitor will finalize reservation when it creates Position
        // Store entry order for monitoring
        try {
          try {
            await EntryOrder.create({
              strategy_id: strategy.id,
              bot_id: strategy.bot_id,
              order_id: order.id,
              symbol: strategy.symbol,
              side,
              amount,
              entry_price: effectiveEntryPrice,
              status: 'open'
            });
          } catch (schemaError) {
            // Schema error - try without optional fields
            if (schemaError.code === 'ER_BAD_FIELD_ERROR') {
              await EntryOrder.create({
                strategy_id: strategy.id,
                bot_id: strategy.bot_id,
                order_id: order.id,
                symbol: strategy.symbol,
                side,
                amount,
                entry_price: effectiveEntryPrice,
                status: 'open'
              });
              logger.debug(`[OrderService] Created entry_order without optional fields`);
            } else {
              throw schemaError;
            }
          }
          logger.debug(`[OrderService] Tracked pending LIMIT entry order ${order.id} for strategy ${strategy.id} in entry_orders table.`);
        } catch (e) {
          logger.warn(`[OrderService] Failed to persist entry order ${order.id} into entry_orders: ${e?.message || e}`);
        }
      }

      if (position) {
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

      // Send Telegram notification to bot chat
      try {
        await this.telegramService.sendOrderNotification(position, strategy);
        logger.debug(`[OrderService] ✅ Order notification sent successfully for position ${position.id}`);
      } catch (e) {
        logger.error(`[OrderService] Failed to send order notification for position ${position.id}:`, e);
      }

      // Send entry trade alert to central channel
      try {
        await this.telegramService.sendEntryTradeAlert(position, strategy, signal.oc);
        logger.debug(`[OrderService] ✅ Entry trade alert sent successfully for position ${position.id}`);
      } catch (e) {
        logger.error(`[OrderService] Failed to send entry trade channel alert for position ${position.id}:`, e);
        logger.error(`[OrderService] Error stack:`, e?.stack);
      }

      // TP/SL creation is now handled by PositionMonitor after entry confirmation.
      logger.debug(`Entry order placed for position ${position.id}. TP/SL will be placed by PositionMonitor.`);

        // Central log: success
        await this.sendCentralLog(`Order Success | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} orderId=${order?.id} posId=${position?.id} type=${orderType} entry=${position.entry_price} tp=${tempTpPrice} sl=${tempSlPrice}`);
      } else {
        // Pending LIMIT only (no DB position yet)
        // Reservation is still active and will be finalized by EntryOrderMonitor when Position is created
        await this.sendCentralLog(`Order PendingLimit | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} orderId=${order?.id} type=${orderType} entry=${effectiveEntryPrice} tp=${tempTpPrice} sl=${tempSlPrice}`);
      }

      // For compatibility with callers (e.g. WebSocketOCConsumer), always return a truthy value on success:
      // - Position object when exposure is confirmed
      // - Lightweight descriptor when only entry_orders record exists
      if (position) {
      return position;
      }
      return {
        pending: true,
        orderId: order.id,
        strategyId: strategy.id,
        botId: strategy.bot_id,
        type: orderType
      };
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
      if (error.code) {
        logger.error(`Error code: ${error.code}`);
      }
      if (error.message) {
        logger.error(`Error message: ${error.message}`);
      }
      // Central log: failure
      try {
        const strat = signal?.strategy || {};
        await this.sendCentralLog(`Order Error | bot=${strat?.bot_id} strat=${strat?.id} ${strat?.symbol} ${String(signal?.side).toUpperCase()} msg=${error?.message || error} code=${error?.code || ''}`);
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
    const priceDiff = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
    
    // If price is more than 0.5% away, use limit order
    // Otherwise, use market order to ensure execution
    return priceDiff < 0.5;
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
}

