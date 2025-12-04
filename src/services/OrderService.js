import { Position } from '../models/Position.js';
import { TelegramService } from './TelegramService.js';
import { concurrencyManager } from './ConcurrencyManager.js';
import logger from '../utils/logger.js';

/**
 * Order Service - Order execution and management
 */
export class OrderService {
  constructor(exchangeService, telegramService) {
    this.exchangeService = exchangeService;
    this.telegramService = telegramService;
  }

  /**
   * Execute signal and create order
   * @param {Object} signal - Signal object from StrategyService
   * @returns {Promise<Object|null>} Position object or null
   */
  async executeSignal(signal) {
    try {
      const { strategy, side, entryPrice, amount, tpPrice, slPrice } = signal;

      // Acquire concurrency reservation (DB-backed advisory lock)
      let reservationToken;
      try {
        reservationToken = await concurrencyManager.reserveSlot(strategy.bot_id);
      } catch (e) {
        if (e?.code === 'CONCURRENCY_LOCK_TIMEOUT') {
          // Lock contention: skip silently without alert; not a real limit breach
          logger.warn(`[OrderService] Concurrency lock timeout for bot ${strategy.bot_id}, skip placing order (no alert).`);
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
      if (side === 'short' && orderType === 'limit' && !signal.forcePassiveLimit) {
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

      // Store position in database
      const position = await Position.create({
        strategy_id: strategy.id,
        bot_id: strategy.bot_id,
        order_id: order.id,
        symbol: strategy.symbol,
        side: side,
        entry_price: orderType === 'market' ? currentPrice : entryPrice,
        amount: amount,
        take_profit_price: tpPrice,
        stop_loss_price: slPrice,
        current_reduce: strategy.reduce
      });

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

      // Create TP limit order (reduce-only) if supported
      try {
        const quantity = Number(order.amount);
        if (Number.isFinite(quantity) && quantity > 0) {
          const tpRes = await this.exchangeService.createTakeProfitLimit(
            strategy.symbol,
            side,
            tpPrice,
            quantity
          );
          const tpOrderId = tpRes?.orderId ? String(tpRes.orderId) : null;
          if (tpOrderId) {
            await Position.update(position.id, { tp_order_id: tpOrderId });
          }
          logger.info(`TP limit order created for position ${position.id}`);
        } else {
          logger.warn(`Skip creating TP: invalid quantity ${order.amount}`);
        }
      } catch (e) {
        logger.warn(`Failed to create TP limit order for position ${position.id}: ${e?.message || e}`);
      }

      // Create SL limit order (initial) if supported
      try {
        const quantity = Number(order.amount);
        if (Number.isFinite(quantity) && quantity > 0 && Number(slPrice) > 0) {
          const slRes = await this.exchangeService.createStopLossLimit(
            strategy.symbol,
            side,
            slPrice,
            quantity
          );
          const slOrderId = slRes?.orderId ? String(slRes.orderId) : null;
          if (slOrderId) {
            await Position.update(position.id, { sl_order_id: slOrderId });
          }
          logger.info(`SL limit order created for position ${position.id}`);
        } else {
          logger.warn(`Skip creating SL: invalid quantity ${order.amount} or slPrice ${slPrice}`);
        }
      } catch (e) {
        logger.warn(`Failed to create SL limit order for position ${position.id}: ${e?.message || e}`);
      }

      // Mark reservation as 'released' (position opened)
      try {
        await concurrencyManager.finalizeReservation(strategy.bot_id, reservationToken, 'released');
      } catch (_) {}

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
        return null; // do not escalate
      }

      logger.error(`Failed to execute signal:`, error);
      if (error.code) {
        logger.error(`Error code: ${error.code}`);
      }
      if (error.message) {
        logger.error(`Error message: ${error.message}`);
      }
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

