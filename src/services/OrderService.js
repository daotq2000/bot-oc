import { Position } from '../models/Position.js';
import { EntryOrder } from '../models/EntryOrder.js';
import { TelegramService } from './TelegramService.js';
import { concurrencyManager } from './ConcurrencyManager.js';
import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';

/**
 * Order Service - Order execution and management
 */
export class OrderService {
  constructor(exchangeService, telegramService) {
    this.exchangeService = exchangeService;
    this.telegramService = telegramService;
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

      // Acquire concurrency reservation (DB-backed advisory lock)
      let reservationToken;
      try {
        reservationToken = await concurrencyManager.reserveSlot(strategy.bot_id);
      } catch (e) {
        if (e?.code === 'CONCURRENCY_LOCK_TIMEOUT') {
          // Lock contention: skip silently without alert; not a real limit breach
          logger.warn(`[OrderService] Concurrency lock timeout for bot ${strategy.bot_id}, skip placing order (no alert).`);
          await this.sendCentralLog(`Order ConcurrencyLockTimeout | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol}`);
          return null;
        }
        throw e;
      }

      if (!reservationToken) {
        // Real limit reached under lock
        const status = await concurrencyManager.getStatus(strategy.bot_id);
        const msg = `Max concurrent trades limit reached: ${status.currentCount}/${status.maxConcurrent}`;
        logger.warn(`[OrderService] ${msg} for strategy ${strategy.id} (${strategy.symbol})`);
        // Send Telegram alert about rejection
        try {
          if (!strategy.bot && strategy.bot_id) {
            const { Bot } = await import('../models/Bot.js');
            strategy.bot = await Bot.findById(strategy.bot_id);
          }
          await this.telegramService?.sendConcurrencyLimitAlert?.(strategy, status);
          await this.sendCentralLog(`Order Rejected MaxConcurrent | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(signal?.side || side).toUpperCase()} current=${status.currentCount}/${status.maxConcurrent}`);
        } catch (e) {
          logger.warn(`[OrderService] Failed to send concurrency alert: ${e?.message || e}`);
        }
        return null; // treat as soft skip
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
              logger.info(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} filled immediately, using avgFillPrice=${avg} as entry.`);
            } else {
              logger.info(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} filled immediately, fallback to entryPrice=${entryPrice}.`);
              hasImmediateExposure = true;
            }
          } else {
            logger.info(`[OrderService] LIMIT order ${order.id} for ${strategy.symbol} not filled yet (status=${st?.status || 'n/a'}, filled=${filledQty}). Position will track exposure via guards.`);
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
          // This ensures reservation is released even if errors occur later
          orderCreated = true;
          await concurrencyManager.finalizeReservation(strategy.bot_id, reservationToken, 'released');
          logger.debug(`[OrderService] Position ${position.id} created and reservation finalized for bot ${strategy.bot_id}`);
        } catch (posError) {
          // If Position creation failed, cancel reservation
          await concurrencyManager.finalizeReservation(strategy.bot_id, reservationToken, 'cancelled');
          logger.error(`[OrderService] Failed to create Position: ${posError?.message || posError}`);
          throw posError;
        }
      } else {
        // Pending LIMIT (no confirmed fill yet): track in entry_orders table
        // CRITICAL: Do NOT finalize reservation here - keep it active until Position is created
        // EntryOrderMonitor will finalize reservation when it creates Position
        // Store reservation_token in entry_orders for EntryOrderMonitor to finalize later
        try {
          // Try to store reservation_token if column exists, otherwise just create entry_order
          try {
            await EntryOrder.create({
              strategy_id: strategy.id,
              bot_id: strategy.bot_id,
              order_id: order.id,
              symbol: strategy.symbol,
              side,
              amount,
              entry_price: effectiveEntryPrice,
              status: 'open',
              reservation_token: reservationToken // Store reservation token for later finalization
            });
          } catch (schemaError) {
            // If reservation_token column doesn't exist, create without it
            if (schemaError.message?.includes('reservation_token') || schemaError.code === 'ER_BAD_FIELD_ERROR') {
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
              logger.debug(`[OrderService] entry_orders table doesn't have reservation_token column, created entry_order without it`);
            } else {
              throw schemaError;
            }
          }
          logger.info(`[OrderService] Tracked pending LIMIT entry order ${order.id} for strategy ${strategy.id} in entry_orders table. Reservation ${reservationToken} kept active until Position is created.`);
        } catch (e) {
          logger.warn(`[OrderService] Failed to persist entry order ${order.id} into entry_orders: ${e?.message || e}`);
          // If entry_order creation failed, cancel reservation
          await concurrencyManager.finalizeReservation(strategy.bot_id, reservationToken, 'cancelled');
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

      // Send Telegram notification to bot chat
      await this.telegramService.sendOrderNotification(position, strategy);

      // Send entry trade alert to central channel
      try {
        logger.info(`[OrderService] Preparing to send entry trade alert for position ${position.id}`);
        // Ensure bot info present
        if (!strategy.bot && strategy.bot_id) {
          const { Bot } = await import('../models/Bot.js');
          strategy.bot = await Bot.findById(strategy.bot_id);
          logger.info(`[OrderService] Fetched bot info: ${strategy.bot?.bot_name || 'N/A'}`);
        }
        logger.info(`[OrderService] Calling sendEntryTradeAlert for position ${position.id}, strategy ${strategy.id}`);
        await this.telegramService.sendEntryTradeAlert(position, strategy, signal.oc);
        logger.info(`[OrderService] ✅ Entry trade alert sent successfully for position ${position.id}`);
      } catch (e) {
        logger.error(`[OrderService] Failed to send entry trade channel alert for position ${position.id}:`, e);
        logger.error(`[OrderService] Error stack:`, e?.stack);
      }

      // TP/SL creation is now handled by PositionMonitor after entry confirmation.
      logger.info(`Entry order placed for position ${position.id}. TP/SL will be placed by PositionMonitor.`);

        // Central log: success
        await this.sendCentralLog(`Order Success | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} orderId=${order?.id} posId=${position?.id} type=${orderType} entry=${position.entry_price} tp=${tempTpPrice} sl=${tempSlPrice}`);
      } else {
        // Pending LIMIT only (no DB position yet)
        // Reservation is still active and will be finalized by EntryOrderMonitor when Position is created
        await this.sendCentralLog(`Order PendingLimit | bot=${strategy?.bot_id} strat=${strategy?.id} ${strategy?.symbol} ${String(side).toUpperCase()} orderId=${order?.id} type=${orderType} entry=${effectiveEntryPrice} tp=${tempTpPrice} sl=${tempSlPrice} reservation=${reservationToken}`);
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
      try {
        if (typeof reservationToken !== 'undefined' && reservationToken && !orderCreated) {
          await concurrencyManager.finalizeReservation(signal.strategy.bot_id, reservationToken, 'cancelled');
        }
      } catch (_) {}
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

