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
        // Guard: ensure there is an actual exchange position to close
        try {
          const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
          if (!qty || qty <= 0) {
            logger.warn(`[CloseGuard] Skip TP close for position ${position.id} (${position.symbol}) - no exchange exposure`);
            return position;
          }
        } catch (e) {
          logger.warn(`[CloseGuard] Unable to verify exchange exposure for position ${position.id}: ${e?.message || e}`);
          return position;
        }
        return await this.closePosition(position, currentPrice, pnl, 'tp_hit');
      }

      // Check if SL hit
      if (this.isStopLossHit(position, currentPrice)) {
        // Guard: ensure there is an actual exchange position to close
        try {
          const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
          if (!qty || qty <= 0) {
            logger.warn(`[CloseGuard] Skip SL close for position ${position.id} (${position.symbol}) - no exchange exposure`);
            return position;
          }
        } catch (e) {
          logger.warn(`[CloseGuard] Unable to verify exchange exposure for position ${position.id}: ${e?.message || e}`);
          return position;
        }
        return await this.closePosition(position, currentPrice, pnl, 'sl_hit');
      }

      // Compute dynamic stop loss (converging from TP)
      const prevMinutes = Number(position.minutes_elapsed || 0);
      const minutesElapsed = prevMinutes + 1;
      const oc = Number(position.oc || 0);
      let updatedSL = this.calculateUpdatedStopLoss(position);
      const currentReduce = Number(position.reduce || 0) + (minutesElapsed * Number(position.up_reduce || 0));
      const clampedReduce = Math.min(Math.max(currentReduce, 0), 999999.99);
      logger.info(`[SL Update] pos=${position.id} ${position.symbol} side=${position.side} oc=${oc} reduce=${position.reduce} up_reduce=${position.up_reduce} minutes ${prevMinutes} -> ${minutesElapsed} sl_old=${position.stop_loss_price} sl_new=${updatedSL} currentReduce=${clampedReduce.toFixed(2)}`);

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

        // Cancel/replace TP theo chiến thuật Reduce / Up Reduce (đuổi TP về phía giá market)
        try {
          const prevTP = Number(position.take_profit_price || 0);
          const marketPrice = Number(currentPrice);
          const reduce = Number(position.reduce || 0);
          const upReduce = Number(position.up_reduce || 0);

          // Nếu không có TP hiện tại hoặc giá market không hợp lệ thì bỏ qua
          if (!Number.isFinite(prevTP) || prevTP <= 0 || !Number.isFinite(marketPrice) || marketPrice <= 0) {
            logger.debug(`[TP Replace] Skip TP chase for position ${position.id} - invalid prevTP=${prevTP} or marketPrice=${marketPrice}`);
          } else if (reduce <= 0 && upReduce <= 0) {
            // Chế độ tĩnh: TP không đuổi giá, giữ TP theo cấu hình ban đầu (fallback cũ)
            const desiredTPStatic = calculateTakeProfit(
            Number(position.entry_price),
            Number(position.oc || 0),
            Number(position.take_profit || 0),
            position.side
          );
            await this._maybeReplaceTpOrder(position, prevTP, desiredTPStatic);
          } else {
            // Chế độ đuổi TP: P_n = P_{n-1} + (P_market - P_{n-1}) * Rate
            // Rate được suy ra từ reduce + up_reduce * minutesElapsed
            const rawRate = reduce + minutesElapsed * upReduce;
            const rate = Math.min(Math.max(rawRate / 100, 0), 1); // 10 -> 10%, clamp 0..100%

            let targetTp = prevTP + (marketPrice - prevTP) * rate;

            // Offset an toàn quanh market để tránh khớp ngay tại giá market
            const offsetPct = Number(configService.getNumber('TP_CHASE_OFFSET_PCT', 0.1)); // %
            const offset = marketPrice * (offsetPct / 100);

            if (position.side === 'short') {
              // TP phải luôn <= market - offset
              const maxTp = marketPrice - offset;
              targetTp = Math.min(targetTp, maxTp);
            } else {
              // LONG: TP phải luôn >= market + offset
              const minTp = marketPrice + offset;
              targetTp = Math.max(targetTp, minTp);
            }

            // Giới hạn bước nhảy mỗi lần (Max Step) để tránh nhảy quá xa
            const maxStepPct = Number(configService.getNumber('TP_CHASE_MAX_STEP_PCT', 0.5)); // %
            const maxStep = marketPrice * (maxStepPct / 100);
            const delta = targetTp - prevTP;
            const absDelta = Math.abs(delta);
            let newTP = prevTP;
            if (absDelta > 0) {
              const step = Math.sign(delta) * Math.min(absDelta, maxStep);
              newTP = prevTP + step;
            }

            logger.info(
              `[TP Chase] pos=${position.id} ${position.symbol} side=${position.side} ` +
              `prevTP=${prevTP} market=${marketPrice} rawRate=${rawRate.toFixed(2)}% ` +
              `targetTp=${targetTp} newTP=${newTP}`
            );

            await this._maybeReplaceTpOrder(position, prevTP, newTP);
          }
        } catch (e) {
          logger.warn(`[TP Replace] Error processing TP update: ${e?.message || e}`);
        }

      // Calculate current_reduce and clamp to prevent overflow (computed above)
      // Re-use clampedReduce computed from reduce + minutesElapsed * up_reduce

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
   * Internal helper: quyết định có cần hủy / đặt lại TP order hay không
   */
  async _maybeReplaceTpOrder(position, prevTP, desiredTP) {
    try {
          const thresholdTicksTP = Number(configService.getNumber('TP_UPDATE_THRESHOLD_TICKS', configService.getNumber('SL_UPDATE_THRESHOLD_TICKS', 2)));
          // Try to get tick size from cache first
          let tickSizeStrTP = exchangeInfoService.getTickSize(position.symbol);
          if (!tickSizeStrTP) {
            // Fallback to REST API if cache miss
            tickSizeStrTP = await this.exchangeService.getTickSize(position.symbol);
          }
          const tickTP = parseFloat(tickSizeStrTP || '0') || 0;
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
      logger.warn(`[TP Replace] Error processing TP replace: ${e?.message || e}`);
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
  calculateUpdatedStopLoss(position) {
    const oc = Number(position.oc || 0);
    const tp = Number(position.take_profit_price || 0);
    if (!Number.isFinite(tp) || tp <= 0 || !Number.isFinite(oc)) {
      return position.stop_loss_price; // cannot compute without valid TP/OC
    }
    const nextSL = calculateDynamicStopLoss(
      tp,
      oc,
      Number(position.reduce || 0),
      Number(position.up_reduce || 0),
      Number(position.minutes_elapsed || 0) + 1,
      position.side
    );
    // Monotonic constraint: move only in favorable direction
    const prevSL = Number(position.stop_loss_price || 0);
    if (Number.isFinite(prevSL) && prevSL > 0) {
      if (position.side === 'long' && nextSL < prevSL) return prevSL;
      if (position.side === 'short' && nextSL > prevSL) return prevSL;
    }
    return nextSL;
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
      // Pre-check: ensure there is exposure to close on exchange
      try {
        const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
        if (!qty || qty <= 0) {
          logger.warn(`[CloseGuard] Skip close for position ${position.id} (${position.symbol}) - no exchange exposure`);
          return position;
        }
      } catch (e) {
        logger.warn(`[CloseGuard] Unable to verify exchange exposure for position ${position.id}: ${e?.message || e}`);
        return position;
      }

      // Close on exchange
      // ExchangeService handles exchange-specific logic (Binance, MEXC, Gate.io)
      // MEXC: Uses CCXT to close position via market order
      // Binance: Uses direct API with reduce-only flag
      const closeRes = await this.exchangeService.closePosition(
        position.symbol,
        position.side,
        position.amount
      );

      if (closeRes?.skipped) {
        logger.warn(`[CloseGuard] Exchange reported no position to close for ${position.symbol}; skipping DB close for ${position.id}`);
        return position;
      }

      // Prefer actual fill price if available and recompute PnL
      const fillPrice = Number(closeRes?.avgFillPrice || closeRes?.average || closeRes?.price || currentPrice);
      const safeClosePrice = Number.isFinite(fillPrice) && fillPrice > 0 ? fillPrice : Number(currentPrice);

      const recomputedPnL = calculatePnL(
        position.entry_price,
        safeClosePrice,
        position.amount,
        position.side
      );

      // Update in database
      const closed = await Position.close(position.id, safeClosePrice, recomputedPnL, reason);

      logger.info(`Position closed:`, {
        positionId: position.id,
        symbol: position.symbol,
        reason,
        pnl: recomputedPnL,
        closePrice: safeClosePrice
      });

      // Send Telegram close summary to central channel with stats
      try {
        logger.info(`[Notification] Preparing to send close summary for position ${closed.id}`);
        const stats = await Position.getBotStats(closed.bot_id);
        logger.debug(`[Notification] Fetched bot stats for bot ${closed.bot_id}:`, stats);

        if (this.telegramService?.sendCloseSummaryAlert) {
          logger.info(`[Notification] Using existing TelegramService to send close summary for position ${closed.id}`);
          await this.telegramService.sendCloseSummaryAlert(closed, stats);
        } else {
          logger.warn(`[Notification] No existing TelegramService found, creating temporary instance.`);
          const { TelegramService } = await import('./TelegramService.js');
          const tmpTele = new TelegramService();
          await tmpTele.initialize();
          await tmpTele.sendCloseSummaryAlert(closed, stats);
        }
        logger.info(`[Notification] ✅ Successfully sent close summary alert for position ${closed.id}`);
      } catch (inner) {
        logger.error(`[Notification] ❌ Failed to send close summary alert for position ${closed.id}:`, inner?.message || inner, inner?.stack);
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

