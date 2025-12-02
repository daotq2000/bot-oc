import { Position } from '../models/Position.js';
import { calculatePnL, calculateDynamicStopLoss } from '../utils/calculator.js';
import logger from '../utils/logger.js';

/**
 * Position Service - Position tracking and updates
 */
export class PositionService {
  constructor(exchangeService) {
    this.exchangeService = exchangeService;
  }

  /**
   * Update position PnL and check TP/SL
   * @param {Object} position - Position object
   * @returns {Promise<Object>} Updated position with close info if triggered
   */
  async updatePosition(position) {
    try {
      // Get current price
      const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);

      // If price is not available from WebSocket cache, skip this update
      if (currentPrice === null) {
        logger.debug(`Price for ${position.symbol} not available in cache, skipping position update.`);
        return position; // Return original position without changes
      }

      // Calculate PnL
      const pnl = calculatePnL(
        position.entry_price,
        currentPrice,
        position.amount,
        position.side
      );

      // Check if TP hit
      if (this.isTakeProfitHit(position, currentPrice)) {
        return await this.closePosition(position, currentPrice, pnl, 'tp_hit');
      }

      // Check if SL hit
      if (this.isStopLossHit(position, currentPrice)) {
        return await this.closePosition(position, currentPrice, pnl, 'sl_hit');
      }

      // Update dynamic stop loss
      const updatedSL = this.calculateUpdatedStopLoss(position);
      
      // Increment minutes elapsed
      const minutesElapsed = position.minutes_elapsed + 1;

      // Update position
      const updated = await Position.update(position.id, {
        pnl: pnl,
        stop_loss_price: updatedSL,
        current_reduce: position.reduce + (minutesElapsed * position.up_reduce),
        minutes_elapsed: minutesElapsed
      });

      return updated;
    } catch (error) {
      logger.error(`Failed to update position ${position.id}:`, error);
      throw error;
    }
  }

  /**
   * Check if take profit is hit
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {boolean}
   */
  isTakeProfitHit(position, currentPrice) {
    if (position.side === 'long') {
      return currentPrice >= position.take_profit_price;
    } else {
      return currentPrice <= position.take_profit_price;
    }
  }

  /**
   * Check if stop loss is hit
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {boolean}
   */
  isStopLossHit(position, currentPrice) {
    if (!position.stop_loss_price) return false;

    if (position.side === 'long') {
      return currentPrice <= position.stop_loss_price;
    } else {
      return currentPrice >= position.stop_loss_price;
    }
  }

  /**
   * Calculate updated stop loss based on elapsed time
   * @param {Object} position - Position object
   * @returns {number} Updated stop loss price
   */
  calculateUpdatedStopLoss(position) {
    // Get strategy OC from position data
    const oc = position.oc || 2; // Default if not available
    
    return calculateDynamicStopLoss(
      position.take_profit_price,
      oc,
      position.reduce,
      position.up_reduce,
      position.minutes_elapsed + 1,
      position.side
    );
  }

  /**
   * Close position
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @param {number} pnl - PnL amount
   * @param {string} reason - Close reason
   * @returns {Promise<Object>} Closed position
   */
  async closePosition(position, currentPrice, pnl, reason) {
    try {
      // Close on exchange
      await this.exchangeService.closePosition(
        position.symbol,
        position.side,
        position.amount
      );

      // Update in database
      const closed = await Position.close(position.id, currentPrice, pnl, reason);

      logger.info(`Position closed:`, {
        positionId: position.id,
        symbol: position.symbol,
        reason,
        pnl
      });

      return closed;
    } catch (error) {
      logger.error(`Failed to close position ${position.id}:`, error);
      throw error;
    }
  }

  /**
   * Check if position order should be cancelled (candle ended without fill)
   * @param {Object} position - Position object
   * @param {Object} candle - Current candle
   * @returns {boolean}
   */
  shouldCancelOnCandleEnd(position, candle) {
    // If candle has closed and order wasn't filled, cancel it
    // This logic should be handled by checking order status
    // For now, we'll rely on the PositionMonitor to handle this
    return false;
  }
}

