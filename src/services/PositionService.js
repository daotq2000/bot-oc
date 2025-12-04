import { Position } from '../models/Position.js';
import { calculatePnL, calculateDynamicStopLoss, calculateTakeProfit, calculateInitialStopLoss } from '../utils/calculator.js';
import { exchangeInfoService } from './ExchangeInfoService.js';
import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';

/**
 * Position Service - Position tracking and updates
 */
export class PositionService {
  constructor(exchangeService, telegramService = null) {
    this.exchangeService = exchangeService;
    this.telegramService = telegramService;
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

      // Compute dynamic stop loss (converging from TP)
      const prevMinutes = Number(position.minutes_elapsed || 0);
      const minutesElapsed = prevMinutes + 1;
      const oc = Number(position.oc || 0);
      const baseTP = Number(position.take_profit_price || 0);
      let updatedSL = position.stop_loss_price;

      if (!baseTP || !Number.isFinite(baseTP)) {
        logger.warn(`[SL Update] Position ${position.id} ${position.symbol}: missing TP price, skip SL dynamic update. oc=${oc}, reduce=${position.reduce}, up_reduce=${position.up_reduce}, minutes=${prevMinutes}`);
      } else {
        updatedSL = this.calculateUpdatedStopLoss(position);
        const currentReduce = Number(position.reduce || 0) + (minutesElapsed * Number(position.up_reduce || 0));
        const clampedReduce = Math.min(Math.max(currentReduce, 0), 999999.99);
        logger.info(`[SL Update] pos=${position.id} ${position.symbol} side=${position.side} oc=${oc} reduce=${position.reduce} up_reduce=${position.up_reduce} minutes ${prevMinutes} -> ${minutesElapsed} tp=${baseTP} sl_old=${position.stop_loss_price} sl_new=${updatedSL} currentReduce=${clampedReduce.toFixed(2)}`);

        // Cancel/replace SL pending order on exchange if moved enough ticks
        try {
          const thresholdTicks = Number(configService.getNumber('SL_UPDATE_THRESHOLD_TICKS', 2));
          // Try to get tick size from cache first
          let tickSizeStr = exchangeInfoService.getTickSize(position.symbol);
          if (!tickSizeStr) {
            // Fallback to REST API if cache miss
            tickSizeStr = await this.exchangeService.getTickSize(position.symbol);
          }
          const tick = parseFloat(tickSizeStr || '0') || 0;
          const prevSL = Number(position.stop_loss_price || 0);
          const newSL = Number(updatedSL || 0);
          if (tick > 0 && newSL > 0 && prevSL > 0) {
            const moved = Math.abs(newSL - prevSL);
            if (moved >= thresholdTicks * tick) {
              // Cancel old SL if exists
              if (position.sl_order_id) {
                try {
                  await this.exchangeService.cancelOrder(position.sl_order_id, position.symbol);
                  logger.info(`[SL Replace] Cancelled old SL order ${position.sl_order_id} for position ${position.id}`);
                } catch (e) {
                  logger.warn(`[SL Replace] Failed to cancel old SL order ${position.sl_order_id}: ${e?.message || e}`);
                }
              }
              // Determine current closable qty
              const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
              if (qty > 0) {
                const slRes = await this.exchangeService.createStopLossLimit(position.symbol, position.side, newSL, qty);
                const newSlOrderId = slRes?.orderId ? String(slRes.orderId) : null;
                if (newSlOrderId) {
                  await Position.update(position.id, { sl_order_id: newSlOrderId });
                  logger.info(`[SL Replace] Placed new SL ${newSlOrderId} @ ${newSL} for position ${position.id}`);
                }
              } else {
                logger.warn(`[SL Replace] Skip placing new SL, qty=${qty}`);
              }
            }
          }
        } catch (e) {
          logger.warn(`[SL Replace] Error processing SL update: ${e?.message || e}`);
        }

        // Cancel/replace TP if changed by threshold ticks (due to new TP formula)
        try {
          const desiredTP = calculateTakeProfit(
            Number(position.entry_price),
            Number(position.oc || 0),
            Number(position.take_profit || 0),
            position.side
          );
          const thresholdTicksTP = Number(configService.getNumber('TP_UPDATE_THRESHOLD_TICKS', configService.getNumber('SL_UPDATE_THRESHOLD_TICKS', 2)));
          // Try to get tick size from cache first
          let tickSizeStrTP = exchangeInfoService.getTickSize(position.symbol);
          if (!tickSizeStrTP) {
            // Fallback to REST API if cache miss
            tickSizeStrTP = await this.exchangeService.getTickSize(position.symbol);
          }
          const tickTP = parseFloat(tickSizeStrTP || '0') || 0;
          const prevTP = Number(position.take_profit_price || 0);
          const newTP = Number(desiredTP || 0);
          if (tickTP > 0 && newTP > 0 && prevTP > 0) {
            const movedTP = Math.abs(newTP - prevTP);
            if (movedTP >= thresholdTicksTP * tickTP) {
              if (position.tp_order_id) {
                try {
                  await this.exchangeService.cancelOrder(position.tp_order_id, position.symbol);
                  logger.info(`[TP Replace] Cancelled old TP order ${position.tp_order_id} for position ${position.id}`);
                } catch (e) {
                  logger.warn(`[TP Replace] Failed to cancel old TP order ${position.tp_order_id}: ${e?.message || e}`);
                }
              }
              const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
              if (qty > 0) {
                const tpRes = await this.exchangeService.createTakeProfitLimit(position.symbol, position.side, newTP, qty);
                const newTpOrderId = tpRes?.orderId ? String(tpRes.orderId) : null;
                const updatePayload = { take_profit_price: newTP };
                if (newTpOrderId) updatePayload.tp_order_id = newTpOrderId;
                await Position.update(position.id, updatePayload);
                logger.info(`[TP Replace] Placed new TP ${newTpOrderId || ''} @ ${newTP} for position ${position.id}`);
              } else {
                logger.warn(`[TP Replace] Skip placing new TP, qty=${qty}`);
              }
            }
          }
        } catch (e) {
          logger.warn(`[TP Replace] Error processing TP update: ${e?.message || e}`);
        }
      }

      // Calculate current_reduce and clamp to prevent overflow
      // Formula: reduce + (minutesElapsed * up_reduce)
      // Clamp to DECIMAL(10,2) max value: 99999999.99 (but we'll use a reasonable max)
      const calculatedReduce = Number(position.reduce || 0) + (minutesElapsed * Number(position.up_reduce || 0));
      // Clamp to reasonable max (999999.99) to prevent database overflow
      const clampedReduce = Math.min(Math.max(calculatedReduce, 0), 999999.99);

      // Update position
      const updated = await Position.update(position.id, {
        pnl: pnl,
        stop_loss_price: updatedSL,
        current_reduce: clampedReduce,
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
   * Calculate updated stop loss based on elapsed time (trailing stop from current price)
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {number} Updated stop loss price
   */
  calculateUpdatedStopLoss(position, currentPrice) {
    // Get strategy OC from position data
    const oc = position.oc || 2; // Default if not available
    
    return calculateDynamicStopLoss(
      currentPrice,
      oc,
      position.reduce,
      position.up_reduce,
      position.minutes_elapsed + 1,
      position.side,
      position.stop_loss_price // Previous SL to ensure it only moves in favorable direction
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

      // Send Telegram close summary to central channel with stats
      try {
        const stats = await Position.getBotStats(closed.bot_id);
        if (this.telegramService?.sendCloseSummaryAlert) {
          await this.telegramService.sendCloseSummaryAlert(closed, stats);
        } else {
          const { TelegramService } = await import('./TelegramService.js');
          const tmpTele = new TelegramService();
          await tmpTele.initialize();
          await tmpTele.sendCloseSummaryAlert(closed, stats);
        }
      } catch (inner) {
        logger.warn(`Failed to send close summary alert: ${inner?.message || inner}`);
      }

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

