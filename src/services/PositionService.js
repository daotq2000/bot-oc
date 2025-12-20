import { Position } from '../models/Position.js';
import { calculatePnL, calculatePnLPercent, calculateDynamicStopLoss, calculateTakeProfit, calculateInitialStopLoss, calculateNextTrailingStop, calculateNextTrailingTakeProfit } from '../utils/calculator.js';
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

      // NEW LOGIC: Trailing Take Profit (NOT Stop Loss)
      // Calculate minutes_elapsed from actual time elapsed
      // This ensures TP trails exactly once per minute based on real time
      let openedAt;
      let useTimeBasedCalculation = true;
      
      if (position.opened_at) {
        openedAt = new Date(position.opened_at).getTime();
        if (isNaN(openedAt)) {
          logger.warn(`[TP Trail] pos=${position.id} Invalid opened_at format: ${position.opened_at}, falling back to increment-based calculation`);
          useTimeBasedCalculation = false;
        }
      } else {
        logger.warn(`[TP Trail] pos=${position.id} opened_at is null/undefined, falling back to increment-based calculation`);
        useTimeBasedCalculation = false;
      }
      
      const prevMinutes = Number(position.minutes_elapsed || 0);
      let actualMinutesElapsed;
      
      if (useTimeBasedCalculation) {
        const now = Date.now();
        actualMinutesElapsed = Math.floor((now - openedAt) / (60 * 1000)); // Minutes since position opened
        logger.info(`[TP Trail] pos=${position.id} Timing check: opened_at=${position.opened_at} openedAt=${openedAt} now=${now} actualMinutesElapsed=${actualMinutesElapsed} prevMinutes=${prevMinutes} timeDiff=${now - openedAt}ms (${Math.floor((now - openedAt) / 1000)}s)`);
        
        // Only update TP if actual minutes have increased (ensures exactly once per minute)
        if (actualMinutesElapsed <= prevMinutes) {
          logger.info(`[TP Trail] pos=${position.id} actualMinutes=${actualMinutesElapsed} <= prevMinutes=${prevMinutes}, skipping TP trail (not yet time for next step)`);
          // Still update PnL and return without changing TP
          const updatePayload = {
            pnl: pnl
          };
          const updated = await Position.update(position.id, updatePayload);
          return updated;
        }
        
        // Calculate how many minutes to process (max 1 minute per call to ensure smooth movement)
        const minutesToProcess = Math.min(actualMinutesElapsed - prevMinutes, 1); // Only process 1 minute at a time
        actualMinutesElapsed = prevMinutes + minutesToProcess; // Use incremental value
        
        logger.info(`[TP Trail] pos=${position.id} Proceeding with TP trail: actualMinutes=${Math.floor((now - openedAt) / (60 * 1000))} > prevMinutes=${prevMinutes}, processing ${minutesToProcess} minute(s), targetMinutes=${actualMinutesElapsed}`);
      } else {
        // Fallback: increment-based calculation
        actualMinutesElapsed = prevMinutes + 1;
        logger.info(`[TP Trail] pos=${position.id} Using increment-based calculation: prevMinutes=${prevMinutes} -> actualMinutesElapsed=${actualMinutesElapsed}`);
      }
      
      // Only set initial SL if it doesn't exist (SL should NOT be moved after initial setup)
      const prevSL = Number(position.stop_loss_price || 0);
      if (prevSL <= 0) {
        const updatedSL = this.calculateUpdatedStopLoss(position);
        if (updatedSL !== null && Number.isFinite(updatedSL) && updatedSL > 0) {
          await Position.update(position.id, { stop_loss_price: updatedSL });
          logger.info(`[TP Trail] Set initial SL for position ${position.id}: ${updatedSL}`);
        }
      }

        // NEW LOGIC: Trailing Take Profit from initial TP towards entry
        try {
          const prevTP = Number(position.take_profit_price || 0);
          const entryPrice = Number(position.entry_price || 0);
          const marketPrice = Number(currentPrice);
          const reduce = Number(position.reduce || 0);
          const upReduce = Number(position.up_reduce || 0);
          const minutesElapsed = actualMinutesElapsed; // Use calculated minutes

          logger.debug(`[TP Trail] Starting TP trail check for position ${position.id}: prevTP=${prevTP} entryPrice=${entryPrice} marketPrice=${marketPrice} reduce=${reduce} upReduce=${upReduce} minutesElapsed=${minutesElapsed}`);

          // Need initial TP to calculate trailing
          if (!Number.isFinite(prevTP) || prevTP <= 0) {
            logger.warn(`[TP Trail] Skip TP trail for position ${position.id} - no initial TP (prevTP=${prevTP})`);
          } else if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
            logger.warn(`[TP Trail] Skip TP trail for position ${position.id} - invalid entry price (${entryPrice})`);
          } else if (reduce <= 0 && upReduce <= 0) {
            logger.debug(`[TP Trail] Static mode: reduce=${reduce} upReduce=${upReduce}, TP will not trail`);
            // Static mode: TP stays at initial value
          } else {
            // Trailing mode: TP moves from initial TP towards entry
            // Calculate initial TP from strategy (same as when position was opened)
            const entryPriceForTP = Number(position.entry_price || 0);
            const oc = Number(position.oc || 0);
            const takeProfit = Number(position.take_profit || 0);
            let initialTP = prevTP; // Fallback to current TP
            
            if (entryPriceForTP > 0 && takeProfit > 0) {
              // Recalculate initial TP from strategy (same calculation as placeTpSlOrders)
              initialTP = calculateTakeProfit(entryPriceForTP, oc, takeProfit, position.side);
              logger.debug(`[TP Trail] Calculated initial TP from strategy: ${initialTP.toFixed(2)} (entry=${entryPriceForTP}, take_profit=${takeProfit})`);
            } else {
              // If we can't calculate, use current TP as initial (first time)
              initialTP = prevTP;
              logger.debug(`[TP Trail] Using current TP as initial: ${initialTP.toFixed(2)}`);
            }
            
            const trailingPercent = position.side === 'long' ? upReduce : reduce;
            
            // Calculate next TP: trails from initial TP towards entry
            const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, trailingPercent, position.side);
            
            logger.info(
              `[TP Trail] pos=${position.id} ${position.symbol} side=${position.side} ` +
              `prevTP=${prevTP.toFixed(2)} newTP=${newTP.toFixed(2)} entry=${entryPrice.toFixed(2)} ` +
              `initialTP=${initialTP.toFixed(2)} trailing=${trailingPercent} minutesElapsed=${minutesElapsed}`
            );

            // Check if TP has crossed entry (Case 2)
            const hasCrossedEntry = (position.side === 'long' && newTP <= entryPrice) || 
                                   (position.side === 'short' && newTP >= entryPrice);
            
            if (hasCrossedEntry) {
              // Case 2: TP has crossed entry - check if too close to market
              const distanceFromMarket = Math.abs(newTP - marketPrice);
              const distancePercent = (distanceFromMarket / marketPrice) * 100;
              
              logger.info(`[TP Trail] TP ${newTP.toFixed(2)} crossed entry ${entryPrice.toFixed(2)} for ${position.side} position ${position.id}. Distance from market: ${distancePercent.toFixed(3)}%`);
              
              if (distancePercent <= 0.5) {
                // Too close to market - close position immediately
                logger.warn(`[TP Trail] TP too close to market (${distancePercent.toFixed(3)}% <= 0.5%). Closing position ${position.id} by MARKET order.`);
                try {
                  const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
                  if (qty > 0) {
                    const qtyToClose = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
                    if (qtyToClose > 0) {
                      await this.exchangeService.closePosition(position.symbol, position.side, qtyToClose);
                    }
                    await this.closePosition(position, marketPrice, pnl, 'trailing_exit');
                    logger.info(`[TP Trail] Closed position ${position.id} by MARKET order (TP too close to market)`);
                    return await Position.findById(position.id);
                  }
                } catch (e) {
                  logger.error(`[TP Trail] Failed to close position by MARKET: ${e?.message || e}`);
                }
              } else {
                // Convert TP order to STOP_LIMIT order
                await this._convertTpToStopLimit(position, newTP);
              }
            } else {
              // Case 1: TP still in profit zone - continue using TAKE_PROFIT_LIMIT
              await this._maybeReplaceTpOrder(position, prevTP, newTP);
              
              // Update take_profit_price and minutes_elapsed in DB
              await Position.update(position.id, { 
                take_profit_price: newTP,
                minutes_elapsed: actualMinutesElapsed
              });
              logger.debug(`[TP Trail] Updated position ${position.id}: take_profit_price=${newTP.toFixed(2)}, minutes_elapsed=${actualMinutesElapsed}`);
            }
          }
        } catch (e) {
          logger.warn(`[TP Trail] Error processing TP trail: ${e?.message || e}`);
        }
        
        // Update minutes_elapsed even if TP trail was skipped
        await Position.update(position.id, { minutes_elapsed: actualMinutesElapsed });

      // Calculate current_reduce and clamp to prevent overflow (computed above)
      // Re-use clampedReduce computed from reduce + actualMinutesElapsed * up_reduce

      // Update position
      // Calculate current_reduce for tracking (not used for trailing anymore, but kept for compatibility)
      const currentReduce = Number(position.reduce || 0) + (actualMinutesElapsed * Number(position.up_reduce || 0));
      const clampedReduce = Math.min(Math.max(currentReduce, 0), 999999.99);
      
      const updatePayload = {
        pnl: pnl,
        current_reduce: clampedReduce,
        minutes_elapsed: actualMinutesElapsed
      };
      
      // Only update stop_loss_price if SL was calculated (initial SL setup)
      if (updatedSL !== null && Number.isFinite(updatedSL) && updatedSL > 0) {
        const prevSL = Number(position.stop_loss_price || 0);
        // Only update if SL changed (initial setup) or doesn't exist
        if (prevSL <= 0 || Math.abs(updatedSL - prevSL) > 0.0001) {
          updatePayload.stop_loss_price = updatedSL;
        }
      }
      const updated = await Position.update(position.id, updatePayload);

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
          const entryPrice = Number(position.entry_price || 0);
          const newTP = Number(desiredTP || 0);
          
          logger.debug(`[TP Replace] _maybeReplaceTpOrder called: pos=${position.id} prevTP=${prevTP.toFixed(2)} desiredTP=${newTP.toFixed(2)} entryPrice=${entryPrice.toFixed(2)} side=${position.side}`);
          
          // Note: TP→SL conversion is now handled in the main TP trail logic
          // This function only handles TP order replacement when TP is still in profit zone
          
          const thresholdTicksTP = Number(configService.getNumber('TP_UPDATE_THRESHOLD_TICKS', configService.getNumber('SL_UPDATE_THRESHOLD_TICKS', 2)));
          // Try to get tick size from cache first
          let tickSizeStrTP = exchangeInfoService.getTickSize(position.symbol);
          if (!tickSizeStrTP) {
            // Fallback to REST API if cache miss
            tickSizeStrTP = await this.exchangeService.getTickSize(position.symbol);
          }
          const tickTP = parseFloat(tickSizeStrTP || '0') || 0;
          
          logger.debug(`[TP Replace] Threshold check: tickTP=${tickTP} thresholdTicksTP=${thresholdTicksTP} prevTP=${prevTP.toFixed(2)} newTP=${newTP.toFixed(2)}`);
          
          if (tickTP > 0 && newTP > 0 && prevTP > 0) {
            const movedTP = Math.abs(newTP - prevTP);
            const effectiveThreshold = thresholdTicksTP * tickTP;
            logger.debug(`[TP Replace] Movement check: movedTP=${movedTP.toFixed(4)} effectiveThreshold=${effectiveThreshold.toFixed(4)}`);
            
            if (movedTP >= effectiveThreshold) {
              logger.debug(`[TP Replace] Movement threshold met, proceeding with TP order replacement`);
              if (position.tp_order_id) {
                try {
                  await this.exchangeService.cancelOrder(position.tp_order_id, position.symbol);
                  logger.info(`[TP Replace] Cancelled old TP order ${position.tp_order_id} for position ${position.id}`);
                } catch (e) {
                  logger.warn(`[TP Replace] Failed to cancel old TP order ${position.tp_order_id}: ${e?.message || e}`);
                }
              }
              
              // Delay before creating new TP order to avoid rate limits
              const delayMs = configService.getNumber('TP_SL_PLACEMENT_DELAY_MS', 10000);
              if (delayMs > 0) {
                logger.info(`[TP Replace] Waiting ${delayMs}ms before placing new TP order for position ${position.id}...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
              }
              
              const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
              if (qty > 0) {
                // Only create TP order if TP is on the correct side of Entry
                const entryPrice = Number(position.entry_price || 0);
                const isValidTP = Number.isFinite(entryPrice) && entryPrice > 0 &&
                  ((position.side === 'short' && newTP <= entryPrice) || 
                   (position.side === 'long' && newTP >= entryPrice));
                
                if (isValidTP) {
                  const tpRes = await this.exchangeService.createTakeProfitLimit(position.symbol, position.side, newTP, qty);
                  const newTpOrderId = tpRes?.orderId ? String(tpRes.orderId) : null;
                  const updatePayload = { take_profit_price: newTP };
                  if (newTpOrderId) updatePayload.tp_order_id = newTpOrderId;
                  await Position.update(position.id, updatePayload);
                  logger.info(`[TP Replace] Placed new TP ${newTpOrderId || ''} @ ${newTP} for position ${position.id}`);
                } else {
                  logger.debug(`[TP Replace] TP ${newTP} is on wrong side of Entry ${entryPrice}, skipping TP order creation (will be handled by SL conversion)`);
                }
              } else {
                logger.warn(`[TP Replace] Skip placing new TP, qty=${qty}`);
              }
            } else {
              logger.debug(`[TP Replace] Movement ${movedTP.toFixed(4)} < threshold ${effectiveThreshold.toFixed(4)}, skipping TP order replacement`);
            }
          } else {
            logger.warn(`[TP Replace] Invalid tickTP (${tickTP}) or TP values (prevTP=${prevTP} newTP=${newTP}), skipping TP order replacement`);
          }
        } catch (e) {
      logger.warn(`[TP Replace] Error processing TP replace: ${e?.message || e}`);
      logger.error(`[TP Replace] Error stack:`, e?.stack);
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
   * Calculate updated stop loss based on previous SL and up_reduce (trailing stop)
   * This function calculates the next SL step by moving from the previous SL towards entry price
   * @param {Object} position - Position object
   * @returns {number} Updated stop loss price
   */
  calculateUpdatedStopLoss(position) {
    const prevSL = Number(position.stop_loss_price || 0);
    const entry = Number(position.entry_price || 0);
    
    logger.debug(`[calculateUpdatedStopLoss] pos=${position.id} prevSL=${prevSL} entry=${entry} side=${position.side}`);
    
    // NEW LOGIC: SL should NOT be moved after initial setup
    // Only calculate initial SL if it doesn't exist yet
    if (!Number.isFinite(prevSL) || prevSL <= 0) {
      // Get stoploss from strategy (position may have it from JOIN)
      const stoploss = position.stoploss !== undefined ? position.stoploss : null;
      
      if (!Number.isFinite(entry) || entry <= 0) {
        logger.warn(`[calculateUpdatedStopLoss] Invalid entry price: ${entry}, cannot calculate initial SL`);
        return null;
      }
      
      // Check if stoploss is valid (not NULL, not undefined, > 0)
      // Only set SL when strategy.stoploss > 0, no fallback
      const isStoplossValid = stoploss !== null && stoploss !== undefined && Number.isFinite(Number(stoploss)) && Number(stoploss) > 0;
      
      if (!isStoplossValid) {
        logger.debug(`[calculateUpdatedStopLoss] stoploss is NULL or invalid (${stoploss}), skipping SL setup for position ${position.id}`);
        return null; // No stoploss - only set SL when strategy.stoploss > 0
      }
      
      // Only set SL when strategy.stoploss > 0
      const initialSL = calculateInitialStopLoss(entry, stoploss, position.side);
      
      if (initialSL === null || initialSL <= 0) {
        logger.warn(`[calculateUpdatedStopLoss] Calculated SL is invalid: ${initialSL} for position ${position.id} (entry=${entry}, stoploss=${stoploss})`);
        return null;
      }
      
      logger.info(`[calculateUpdatedStopLoss] Calculated initial SL: ${initialSL} for position ${position.id} (entry=${entry}, stoploss=${stoploss})`);
      return initialSL;
    }
    
    // SL already exists - DO NOT MOVE IT (keep it static)
    logger.debug(`[calculateUpdatedStopLoss] SL already exists (${prevSL}), keeping it static (no trailing)`);
    return prevSL;
  }

  /**
   * Close position
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @param {number} pnl - PnL amount
   * @param {string} reason - Close reason
   * @returns {Promise<Object>} Closed position
   */
  async sendTelegramCloseNotification(closedPosition) {
    try {
      if (!this.telegramService?.sendCloseSummaryAlert) {
        logger.warn(`[Notification] TelegramService not available, skipping close summary alert for position ${closedPosition.id}`);
        return;
      }
      logger.info(`[Notification] Preparing to send close summary for position ${closedPosition.id}`);
      const stats = await Position.getBotStats(closedPosition.bot_id);
      logger.debug(`[Notification] Fetched bot stats for bot ${closedPosition.bot_id}:`, stats);
      await this.telegramService.sendCloseSummaryAlert(closedPosition, stats);
      logger.info(`[Notification] ✅ Successfully sent close summary alert for position ${closedPosition.id}`);
    } catch (inner) {
      logger.error(`[Notification] ❌ Failed to send close summary alert for position ${closedPosition.id}:`, inner?.message || inner, inner?.stack);
    }
  }

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

      // After position is confirmed closed, cancel any remaining TP/SL orders
      try {
        logger.info(`[Close Position] Cleaning up any remaining open orders for symbol ${position.symbol}`);
        await this.exchangeService.cancelAllOpenOrders(position.symbol);
      } catch (e) {
        logger.warn(`[Close Position] Failed to clean up open orders for ${position.symbol} after closing: ${e?.message || e}`);
      }

      await this.sendTelegramCloseNotification(closed);

      return closed;
    } catch (error) {
      logger.error(`Failed to close position ${position.id}:`, error);
      throw error;
    }
  }

  /**
   * Convert TP order to STOP_LIMIT order when TP crosses entry
   * @param {Object} position - Position object
   * @param {number} newTP - New TP price (which has crossed entry)
   */
  async _convertTpToStopLimit(position, newTP) {
    try {
      logger.info(`[TP->SL Convert] Converting TP to STOP_LIMIT for position ${position.id} at price ${newTP.toFixed(2)}`);
      
      // Cancel existing TP order
      if (position.tp_order_id) {
        try {
          await this.exchangeService.cancelOrder(position.tp_order_id, position.symbol);
          logger.info(`[TP->SL Convert] Cancelled TP order ${position.tp_order_id} for position ${position.id}`);
        } catch (e) {
          logger.warn(`[TP->SL Convert] Failed to cancel TP order ${position.tp_order_id}: ${e?.message || e}`);
        }
      }
      
      // Delay before creating STOP_LIMIT order to avoid rate limits
      const delayMs = configService.getNumber('TP_SL_PLACEMENT_DELAY_MS', 10000);
      if (delayMs > 0) {
        logger.info(`[TP->SL Convert] Waiting ${delayMs}ms before placing STOP_LIMIT order for position ${position.id}...`);
        await new Promise(resolve => setTimeout(resolve, delayMs));
      }
      
      // Create STOP_LIMIT order at the new TP price
      const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
      if (qty > 0) {
        const slRes = await this.exchangeService.createStopLossLimit(position.symbol, position.side, newTP, qty);
        const newSlOrderId = slRes?.orderId ? String(slRes.orderId) : null;
        if (newSlOrderId) {
          // Update position: clear TP order, set SL order, update TP price (for tracking)
          await Position.update(position.id, { 
            tp_order_id: null, 
            sl_order_id: newSlOrderId,
            take_profit_price: newTP // Keep TP price for reference
          });
          logger.info(`[TP->SL Convert] Created STOP_LIMIT order ${newSlOrderId} @ ${newTP.toFixed(2)} for position ${position.id}`);
        } else {
          logger.warn(`[TP->SL Convert] Failed to create STOP_LIMIT order for position ${position.id}`);
        }
      } else {
        logger.warn(`[TP->SL Convert] Skip creating STOP_LIMIT, qty=${qty}`);
      }
    } catch (e) {
      logger.error(`[TP->SL Convert] Error converting TP to STOP_LIMIT: ${e?.message || e}`);
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

