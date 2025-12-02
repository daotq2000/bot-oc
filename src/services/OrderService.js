import { Position } from '../models/Position.js';
import { TelegramService } from './TelegramService.js';
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

      // Check if entry price is still valid
      const currentPrice = await this.exchangeService.getTickerPrice(strategy.symbol);
      
      // For limit orders, we need to check if price is close enough
      // If price already passed entry, use market order
      const orderType = this.shouldUseMarketOrder(side, currentPrice, entryPrice)
        ? 'market'
        : 'limit';

      // Create order
      // Note: amount here is in USDT, ExchangeService will calculate quantity
      const order = await this.exchangeService.createOrder({
        symbol: strategy.symbol,
        side: side === 'long' ? 'buy' : 'sell',
        amount: amount, // Pass USDT amount, not quantity
        type: orderType,
        price: orderType === 'limit' ? entryPrice : undefined
      });

      // Store position in database
      const position = await Position.create({
        strategy_id: strategy.id,
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

      // Send Telegram notification
      await this.telegramService.sendOrderNotification(position, strategy);

      return position;
    } catch (error) {
      logger.error(`Failed to execute signal:`, error);
      // Log detailed error information
      if (error.code) {
        logger.error(`Error code: ${error.code}`);
      }
      if (error.message) {
        logger.error(`Error message: ${error.message}`);
      }
      // Re-throw to let caller handle
      throw error;
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

