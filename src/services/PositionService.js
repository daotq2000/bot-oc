import { Position } from '../models/Position.js';
import { calculatePnL, calculatePnLPercent, calculateDynamicStopLoss, calculateTakeProfit, calculateInitialStopLoss, calculateNextTrailingStop, calculateNextTrailingTakeProfit } from '../utils/calculator.js';
import { exchangeInfoService } from './ExchangeInfoService.js';
import { configService } from './ConfigService.js';
import { orderStatusCache } from './OrderStatusCache.js';
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
    // Cache closable quantity for this update cycle to avoid multiple API calls
    let cachedClosableQty = null;
    const getCachedClosableQty = async () => {
      if (cachedClosableQty === null) {
        try {
          cachedClosableQty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
        } catch (e) {
          logger.debug(`[PositionService] Failed to get closable quantity: ${e?.message || e}`);
          cachedClosableQty = 0;
        }
      }
      return cachedClosableQty;
    };

    try {
      // Helper function to get exchange name (normalized to lowercase for cache key consistency)
      const getExchange = () => {
        return (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
      };

      // PRIORITY CHECK 1: Check order status from WebSocket cache (no REST API call)
      // This detects when TP/SL orders are filled via WebSocket ORDER_TRADE_UPDATE events
      // CRITICAL: Cache check is O(1) and avoids rate limits from REST API calls
      const exchange = getExchange();
      
      if (position.exit_order_id) {
        const cachedTpStatus = orderStatusCache.getOrderStatus(position.exit_order_id, exchange);
        
        // Debug logging for cache miss (only at debug level to reduce noise)
        if (!cachedTpStatus) {
          logger.debug(`[TP/SL Check] TP order ${position.exit_order_id} for position ${position.id} not found in cache (exchange: ${exchange})`);
        }
        // CRITICAL FIX: _normalizeStatus() returns 'closed' for FILLED, not 'FILLED'
        if (cachedTpStatus && cachedTpStatus.status === 'closed') {
          // TP order has been filled - position is already closed on exchange
          logger.info(
            `[TP/SL Check] ✅ TP order ${position.exit_order_id} for position ${position.id} filled (from WebSocket cache). ` +
            `Fill price: ${cachedTpStatus.avgPrice || 'N/A'}, symbol: ${position.symbol}. Closing position in DB.`
          );
          
          // Get fill price from cache (preferred) or current price (fallback)
          const fillPrice = cachedTpStatus.avgPrice;
          let currentPrice = fillPrice;
          
          if (!currentPrice || currentPrice <= 0) {
            // Fallback to current market price if cache doesn't have fill price
            try {
              currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
            } catch (priceError) {
              logger.warn(`[TP/SL Check] Failed to get current price for ${position.symbol}: ${priceError?.message || priceError}`);
            }
          }
          
          if (currentPrice && currentPrice > 0) {
            const pnl = calculatePnL(
              position.entry_price,
              currentPrice,
              position.amount,
              position.side
            );
            return await this.closePosition(position, currentPrice, pnl, 'tp_hit');
          } else {
            logger.warn(`[TP/SL Check] Cannot close position ${position.id}: no valid price available`);
          }
        }
      }

      if (position.sl_order_id) {
        const cachedSlStatus = orderStatusCache.getOrderStatus(position.sl_order_id, exchange);
        
        // Debug logging for cache miss
        if (!cachedSlStatus) {
          logger.debug(`[TP/SL Check] SL order ${position.sl_order_id} for position ${position.id} not found in cache (exchange: ${exchange})`);
        }
        // CRITICAL FIX: _normalizeStatus() returns 'closed' for FILLED, not 'FILLED'
        if (cachedSlStatus && cachedSlStatus.status === 'closed') {
          // SL order has been filled - position is already closed on exchange
          logger.info(
            `[TP/SL Check] ✅ SL order ${position.sl_order_id} for position ${position.id} filled (from WebSocket cache). ` +
            `Fill price: ${cachedSlStatus.avgPrice || 'N/A'}, symbol: ${position.symbol}. Closing position in DB.`
          );
          
          // Get fill price from cache (preferred) or current price (fallback)
          const fillPrice = cachedSlStatus.avgPrice;
          let currentPrice = fillPrice;
          
          if (!currentPrice || currentPrice <= 0) {
            // Fallback to current market price if cache doesn't have fill price
            try {
              currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
            } catch (priceError) {
              logger.warn(`[TP/SL Check] Failed to get current price for ${position.symbol}: ${priceError?.message || priceError}`);
            }
          }
          
          if (currentPrice && currentPrice > 0) {
            const pnl = calculatePnL(
              position.entry_price,
              currentPrice,
              position.amount,
              position.side
            );
            return await this.closePosition(position, currentPrice, pnl, 'sl_hit');
          } else {
            logger.warn(`[TP/SL Check] Cannot close position ${position.id}: no valid price available`);
          }
        }
      }

      // PRIORITY CHECK 2: Check if position has been closed on exchange (no exposure)
      // CRITICAL FIX: Only close position if order is FILLED, not CANCELED
      // This prevents false alerts when TP order is cancelled (e.g., during dedupe or trailing TP)
      // Only check if WebSocket cache doesn't have the order status (fallback)
      try {
        const closableQty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
        if (!closableQty || closableQty <= 0) {
          // Position has no exposure on exchange - it's already closed
          // CRITICAL: Verify order status is FILLED, not CANCELED before closing position
          // Get exchange from exchangeService (fallback to 'binance' for backward compatibility)
          const exchange = (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
          
          let closeReason = null;
          let verifiedFillPrice = null;
          
          // Check TP order status first (prefer cache, fallback to REST API)
          if (position.exit_order_id) {
            const cachedTpStatus = orderStatusCache.getOrderStatus(position.exit_order_id, exchange);
            // CRITICAL FIX: Only close if order status is 'closed' (FILLED), not 'canceled'
            if (cachedTpStatus?.status === 'closed') {
              closeReason = 'tp_hit';
              verifiedFillPrice = cachedTpStatus.avgPrice;
              logger.debug(`[TP/SL Check] TP order ${position.exit_order_id} verified FILLED from cache`);
            } else {
              // Fallback to REST API only if cache miss
              try {
                const tpOrderStatus = await this.exchangeService.getOrderStatus(position.symbol, position.exit_order_id);
                const normalizedStatus = tpOrderStatus?.status?.toLowerCase() || '';
                // CRITICAL: Only accept FILLED/closed status, reject CANCELED/EXPIRED
                if (normalizedStatus === 'closed' || normalizedStatus === 'filled') {
                  closeReason = 'tp_hit';
                  verifiedFillPrice = tpOrderStatus.raw?.avgPrice || tpOrderStatus.avgPrice || null;
                  // Update cache for future use (performance optimization)
                  orderStatusCache.updateOrderStatus(position.exit_order_id, {
                    status: tpOrderStatus.status,
                    filled: tpOrderStatus.filled || 0,
                    avgPrice: verifiedFillPrice,
                    symbol: position.symbol
                  }, exchange);
                  logger.debug(`[TP/SL Check] TP order ${position.exit_order_id} verified FILLED via REST API, cache updated`);
                } else if (normalizedStatus === 'canceled' || normalizedStatus === 'cancelled' || normalizedStatus === 'expired') {
                  // Order was cancelled, not filled - DO NOT close position
                  logger.warn(
                    `[TP/SL Check] ⚠️ TP order ${position.exit_order_id} for position ${position.id} was ${normalizedStatus}, NOT FILLED. ` +
                    `Position has no exposure but order was cancelled (likely during dedupe/trailing). ` +
                    `Will NOT close position to prevent false alert.`
                  );
                  return; // Exit early - don't close position
                }
              } catch (e) {
                logger.debug(`[TP/SL Check] Failed to check TP order via REST API: ${e?.message || e}`);
              }
            }
          }
          
          // Check SL order status if TP not filled
          if (!closeReason && position.sl_order_id) {
            const cachedSlStatus = orderStatusCache.getOrderStatus(position.sl_order_id, exchange);
            // CRITICAL FIX: Only close if order status is 'closed' (FILLED), not 'canceled'
            if (cachedSlStatus?.status === 'closed') {
              closeReason = 'sl_hit';
              verifiedFillPrice = cachedSlStatus.avgPrice;
              logger.debug(`[TP/SL Check] SL order ${position.sl_order_id} verified FILLED from cache`);
            } else {
              // Fallback to REST API only if cache miss
              try {
                const slOrderStatus = await this.exchangeService.getOrderStatus(position.symbol, position.sl_order_id);
                const normalizedStatus = slOrderStatus?.status?.toLowerCase() || '';
                // CRITICAL: Only accept FILLED/closed status, reject CANCELED/EXPIRED
                if (normalizedStatus === 'closed' || normalizedStatus === 'filled') {
                  closeReason = 'sl_hit';
                  verifiedFillPrice = slOrderStatus.raw?.avgPrice || slOrderStatus.avgPrice || null;
                  // Update cache for future use (performance optimization)
                  orderStatusCache.updateOrderStatus(position.sl_order_id, {
                    status: slOrderStatus.status,
                    filled: slOrderStatus.filled || 0,
                    avgPrice: verifiedFillPrice,
                    symbol: position.symbol
                  }, exchange);
                  logger.debug(`[TP/SL Check] SL order ${position.sl_order_id} verified FILLED via REST API, cache updated`);
                } else if (normalizedStatus === 'canceled' || normalizedStatus === 'cancelled' || normalizedStatus === 'expired') {
                  // Order was cancelled, not filled - DO NOT close position
                  logger.warn(
                    `[TP/SL Check] ⚠️ SL order ${position.sl_order_id} for position ${position.id} was ${normalizedStatus}, NOT FILLED. ` +
                    `Position has no exposure but order was cancelled. ` +
                    `Will NOT close position to prevent false alert.`
                  );
                  return; // Exit early - don't close position
                }
              } catch (e) {
                logger.debug(`[TP/SL Check] Failed to check SL order via REST API: ${e?.message || e}`);
              }
            }
          }
          
          // CRITICAL: Only close position if we verified order was FILLED (not cancelled)
          if (closeReason) {
            const currentPrice = verifiedFillPrice || await this.exchangeService.getTickerPrice(position.symbol);
            if (currentPrice) {
              const pnl = calculatePnL(
                position.entry_price,
                currentPrice,
                position.amount,
                position.side
              );
              logger.info(
                `[TP/SL Check] ✅ Position ${position.id} closed on exchange with verified ${closeReason}. ` +
                `Order status confirmed FILLED. Closing in DB.`
              );
              return await this.closePosition(position, currentPrice, pnl, closeReason);
            }
          } else {
            // Position has no exposure but no verified fill - likely order was cancelled
            logger.warn(
              `[TP/SL Check] ⚠️ Position ${position.id} has no exposure but no verified TP/SL fill. ` +
              `Orders may have been cancelled. Will NOT close position to prevent false alert.`
            );
          }
        }
      } catch (e) {
        logger.debug(`[TP/SL Check] Failed to check closable quantity for position ${position.id}: ${e?.message || e}`);
      }

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

      // Check if TP hit (price-based check as fallback) - DISABLED to prevent premature closing
      // if (this.isTakeProfitHit(position, currentPrice)) {
      //   // Guard: ensure there is an actual exchange position to close
      //   try {
      //     const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
      //     if (!qty || qty <= 0) {
      //       logger.warn(`[CloseGuard] Skip TP close for position ${position.id} (${position.symbol}) - no exchange exposure`);
      //       return position;
      //     }
      //   } catch (e) {
      //     logger.warn(`[CloseGuard] Unable to verify exchange exposure for position ${position.id}: ${e?.message || e}`);
      //     return position;
      //   }
      //   return await this.closePosition(position, currentPrice, pnl, 'tp_hit');
      // }

      // Check if SL hit - DISABLED to prevent premature closing
      // if (this.isStopLossHit(position, currentPrice)) {
      //   // Guard: ensure there is an actual exchange position to close
      //   try {
      //     const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
      //     if (!qty || qty <= 0) {
      //       logger.warn(`[CloseGuard] Skip SL close for position ${position.id} (${position.symbol}) - no exchange exposure`);
      //       return position;
      //     }
      //   } catch (e) {
      //     logger.warn(`[CloseGuard] Unable to verify exchange exposure for position ${position.id}: ${e?.message || e}`);
      //     return position;
      //   }
      //   return await this.closePosition(position, currentPrice, pnl, 'sl_hit');
      // }

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
      
      let prevMinutes = Number(position.minutes_elapsed || 0);
      let actualMinutesElapsed;
      let minutesToProcess = 1; // Default: process 1 minute per call
      
      if (useTimeBasedCalculation) {
        const now = Date.now();
        const totalMinutesElapsed = Math.floor((now - openedAt) / (60 * 1000)); // Total minutes since position opened
        logger.debug(`[TP Trail] pos=${position.id} Timing check: opened_at=${position.opened_at} openedAt=${openedAt} now=${now} totalMinutesElapsed=${totalMinutesElapsed} prevMinutes=${prevMinutes} timeDiff=${now - openedAt}ms (${Math.floor((now - openedAt) / 1000)}s)`);
        
        // SAFETY CHECK: Reset prevMinutes if gap exceeds 30 minutes to prevent stuck positions
        const minutesGap = totalMinutesElapsed - prevMinutes;
        if (minutesGap > 30) {
          logger.warn(
            `[TP Trail] ⚠️ Large gap detected for position ${position.id}: ` +
            `prevMinutes=${prevMinutes}, totalMinutes=${totalMinutesElapsed}, ` +
            `gap=${minutesGap} minutes (>30). ` +
            `Resetting to process only 1 minute to avoid position being stuck or deeper losses.`
          );
          // Reset prevMinutes to totalMinutesElapsed - 1 so that minutesToProcess will be 1
          // This ensures we only process 1 minute incrementally, not the entire gap
          const adjustedPrevMinutes = totalMinutesElapsed - 1;
          // Update prevMinutes in memory for this calculation
          prevMinutes = adjustedPrevMinutes;
          // Also update in DB to prevent this from happening again
          try {
            await Position.update(position.id, { minutes_elapsed: adjustedPrevMinutes });
            logger.info(`[TP Trail] ✅ Reset minutes_elapsed to ${adjustedPrevMinutes} for position ${position.id}`);
          } catch (updateError) {
            logger.warn(`[TP Trail] Failed to reset minutes_elapsed in DB for position ${position.id}: ${updateError?.message || updateError}`);
          }
        }
        
        // Only update TP if actual minutes have increased (ensures exactly once per minute)
        if (totalMinutesElapsed <= prevMinutes) {
          logger.debug(`[TP Trail] pos=${position.id} totalMinutes=${totalMinutesElapsed} <= prevMinutes=${prevMinutes}, skipping TP trail (not yet time for next step)`);
          // Still update PnL and minutes_elapsed (increment by 0 if no time passed, or by actual difference)
          // CRITICAL FIX: Always update minutes_elapsed to current time, even if no TP trail
          actualMinutesElapsed = totalMinutesElapsed; // Use actual time elapsed
          minutesToProcess = 0; // No minutes to process for trailing
        } else {
          // Calculate how many minutes to process (max 1 minute per call to ensure smooth movement)
          minutesToProcess = Math.min(totalMinutesElapsed - prevMinutes, 1); // Only process 1 minute at a time
          actualMinutesElapsed = prevMinutes + minutesToProcess; // Incremental value for DB update
          
          // WARN if downtime detected (more than 5 minutes skipped)
          if (totalMinutesElapsed - prevMinutes > 5) {
            logger.warn(
              `[TP Trail] ⚠️ Downtime detected for position ${position.id}: ` +
              `prevMinutes=${prevMinutes}, totalMinutes=${totalMinutesElapsed}, ` +
              `skipped=${totalMinutesElapsed - prevMinutes} minutes. ` +
              `Processing only 1 minute to prevent large TP jumps.`
            );
          }
          
          logger.debug(`[TP Trail] pos=${position.id} Proceeding with TP trail: totalMinutes=${totalMinutesElapsed} > prevMinutes=${prevMinutes}, processing ${minutesToProcess} minute(s), targetMinutes=${actualMinutesElapsed}`);
        }
      } else {
        // Fallback: increment-based calculation
        actualMinutesElapsed = prevMinutes + 1;
        minutesToProcess = 1; // Process 1 minute
        logger.debug(`[TP Trail] pos=${position.id} Using increment-based calculation: prevMinutes=${prevMinutes} -> actualMinutesElapsed=${actualMinutesElapsed}, minutesToProcess=${minutesToProcess}`);
      }
      
      // Only set initial SL if it doesn't exist (SL should NOT be moved after initial setup)
      const prevSL = Number(position.stop_loss_price || 0);
      let updatedSL = null;
      if (prevSL <= 0) {
        updatedSL = await this.calculateUpdatedStopLoss(position);
        if (updatedSL !== null && Number.isFinite(updatedSL) && updatedSL > 0) {
          await Position.update(position.id, { stop_loss_price: updatedSL });
          logger.debug(`[TP Trail] Set initial SL for position ${position.id}: ${updatedSL}`);
        }
      }

        // NEW LOGIC: Trailing Take Profit from initial TP towards entry
        try {
          const prevTP = Number(position.take_profit_price || 0);
          const entryPrice = Number(position.entry_price || 0);
          const marketPrice = Number(currentPrice);
          const reduce = Number(position.reduce || 0);
          const upReduce = Number(position.up_reduce || 0);
          
          // CRITICAL FIX: Use minutesToProcess (1 minute) instead of actualMinutesElapsed (total minutes)
          // This ensures TP trails incrementally, not jumping based on total time elapsed
          const minutesForTrailing = minutesToProcess; // Only process 1 minute at a time

          logger.info(
            `[TP Trail] 🎯 Starting TP trail check | pos=${position.id} symbol=${position.symbol} side=${position.side} ` +
            `prevTP=${prevTP.toFixed(8)} entryPrice=${entryPrice.toFixed(8)} marketPrice=${marketPrice.toFixed(8)} ` +
            `reduce=${reduce} upReduce=${upReduce} minutesToProcess=${minutesForTrailing} prevMinutes=${prevMinutes} actualMinutesElapsed=${actualMinutesElapsed} ` +
            `initial_tp_price=${position.initial_tp_price || 'N/A'} timestamp=${new Date().toISOString()}`
          );

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
            // Use stored initial_tp_price (set when position was opened)
            let initialTP = Number(position.initial_tp_price || 0);
            
            // If initial_tp_price is not set (old positions), calculate and save it
            if (!Number.isFinite(initialTP) || initialTP <= 0) {
              const entryPriceForTP = Number(position.entry_price || 0);
              const oc = Number(position.oc || 0);
              const takeProfit = Number(position.take_profit || 0);
              
              if (entryPriceForTP > 0 && takeProfit > 0) {
                // Calculate initial TP from strategy (same calculation as placeExitOrder)
                initialTP = calculateTakeProfit(entryPriceForTP, takeProfit, position.side);
                // Save it to DB for future use
                await Position.update(position.id, { initial_tp_price: initialTP });
                logger.debug(`[TP Trail] Calculated and saved initial TP: ${initialTP.toFixed(2)} (entry=${entryPriceForTP}, take_profit=${takeProfit})`);
              } else {
                // If we can't calculate, use current TP as initial (fallback)
                initialTP = prevTP;
                await Position.update(position.id, { initial_tp_price: initialTP });
                logger.debug(`[TP Trail] Using current TP as initial: ${initialTP.toFixed(2)}`);
              }
            } else {
              logger.debug(`[TP Trail] Using stored initial TP: ${initialTP.toFixed(2)}`);
            }
            
            const trailingPercent = position.side === 'long' ? upReduce : reduce;
            
            // CRITICAL FIX: Only trail TP if there are minutes to process
            if (minutesForTrailing <= 0) {
              logger.debug(`[TP Trail] pos=${position.id} minutesToProcess=${minutesForTrailing}, skipping TP trail calculation`);
            } else {
              // Calculate next TP: trails from initial TP towards entry
              // Trailing is TIME-BASED ONLY (not price-based) for predictable behavior
              // CRITICAL FIX: Use minutesForTrailing (1 minute) instead of total minutes elapsed
              // This ensures incremental movement, not jumping based on total time
              const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, trailingPercent, position.side, minutesForTrailing);
              
              // Calculate step details for debugging
              const totalRange = Math.abs(initialTP - entryPrice);
              const stepPerMinute = totalRange * (trailingPercent / 100);
              const step = stepPerMinute * minutesForTrailing;
              
              logger.info(
                `[TP Trail] 📊 Calculated new TP | pos=${position.id} ${position.symbol} side=${position.side} ` +
                `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} entry=${entryPrice.toFixed(8)} ` +
                `initialTP=${initialTP.toFixed(8)} trailing=${trailingPercent}% minutesToProcess=${minutesForTrailing} ` +
                `totalRange=${totalRange.toFixed(8)} stepPerMinute=${stepPerMinute.toFixed(8)} step=${step.toFixed(8)} ` +
                `change=${((newTP - prevTP) / prevTP * 100).toFixed(3)}% absoluteChange=${Math.abs(newTP - prevTP).toFixed(8)} ` +
                `timestamp=${new Date().toISOString()}`
              );
              
              // Warn if newTP equals prevTP (no movement)
              if (Math.abs(newTP - prevTP) < 0.00000001) {
                logger.warn(
                  `[TP Trail] ⚠️ WARNING: newTP (${newTP.toFixed(8)}) equals prevTP (${prevTP.toFixed(8)})! ` +
                  `No movement detected. Check calculation: totalRange=${totalRange.toFixed(8)} stepPerMinute=${stepPerMinute.toFixed(8)} step=${step.toFixed(8)} ` +
                  `trailingPercent=${trailingPercent}% minutesForTrailing=${minutesForTrailing} | pos=${position.id}`
                );
              }

              // Check if TP has crossed entry (Case 2)
              const hasCrossedEntry = (position.side === 'long' && newTP <= entryPrice) || 
                                     (position.side === 'short' && newTP >= entryPrice);
              
              if (hasCrossedEntry) {
                // Case 2: TP has crossed entry → market has moved against the position.
                // NEW REQUIREMENT: Force close immediately to preserve capital.
                // close_reason = tp_cross_entry_force_close
                logger.warn(
                  `[TP Trail] 🚨 TP crossed entry → FORCE CLOSE | pos=${position.id} symbol=${position.symbol} side=${position.side} ` +
                  `entry=${entryPrice.toFixed(8)} prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} market=${marketPrice.toFixed(8)} ` +
                  `reason=tp_cross_entry_force_close`
                );

                // Persist trailing state for audit/debug even if close fails
                try {
                  await Position.update(position.id, { take_profit_price: newTP });
                } catch (e) {
                  logger.warn(`[TP Trail] Failed to persist take_profit_price before force close | pos=${position.id}: ${e?.message || e}`);
                }

                try {
                  // Use closePosition() method which now bypasses CloseGuard for tp_cross_entry_force_close
                  // This ensures proper cleanup and notification handling
                  const closed = await this.closePosition(position, marketPrice, pnl, 'tp_cross_entry_force_close');
                  logger.info(`[TP Trail] ✅ Force closed position ${position.id} successfully`);
                  return closed;
                } catch (e) {
                  logger.error(`[TP Trail] ❌ FORCE CLOSE FAILED | pos=${position.id}: ${e?.message || e}`);
                  // Keep position open in DB if we couldn't confirm closure.
                  // Position remains open, but take_profit_price has been updated above
                }
              } else {
                // Case 1: TP still in profit zone - continue using TAKE_PROFIT_LIMIT
                // Try to replace TP order, but continue even if it fails
                try {
                  await this._maybeReplaceTpOrder(position, prevTP, newTP, getCachedClosableQty);
                } catch (replaceError) {
                  logger.warn(`[TP Trail] Failed to replace TP order for position ${position.id}: ${replaceError?.message || replaceError}. Continuing with TP price update.`);
                }
                
                // Always update take_profit_price in DB (minutes_elapsed will be updated at the end)
                // This ensures trailing TP works even if order replacement fails
                // CRITICAL: This update must happen regardless of order replacement success/failure
                try {
                  await Position.update(position.id, { 
                    take_profit_price: newTP
                    // NOTE: minutes_elapsed will be updated in final updatePayload below to avoid double update
                  });
                  logger.info(
                    `[TP Trail] ✅ Updated take_profit_price in DB (profit zone) | pos=${position.id} ` +
                    `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} hasCrossedEntry=false`
                  );
                } catch (updateError) {
                  logger.error(
                    `[TP Trail] ❌ CRITICAL: Failed to update take_profit_price in DB | pos=${position.id} ` +
                    `newTP=${newTP.toFixed(8)} error=${updateError?.message || updateError}`
                  );
                }
              }
            }
          }
        } catch (e) {
          logger.warn(`[TP Trail] Error processing TP trail: ${e?.message || e}`);
        }
        
        // NOTE: minutes_elapsed is updated in final updatePayload below (not here) to avoid double update

      // Calculate current_reduce and clamp to prevent overflow (computed above)
      // Re-use clampedReduce computed from reduce + actualMinutesElapsed * up_reduce

      // Update position
      // Calculate current_reduce for tracking (deprecated: kept for backward compatibility only, not used for trailing)
      const currentReduce = Number(position.reduce || 0) + (actualMinutesElapsed * Number(position.up_reduce || 0));
      const clampedReduce = Math.min(Math.max(currentReduce, 0), 999999.99);
      
      // SINGLE UPDATE: Consolidate all updates into one payload to avoid race conditions and double writes
      // CRITICAL FIX: Use soft lock to prevent race condition with PositionSync
      let lockAcquired = false;
      try {
        const pool = (await import('../config/database.js')).default;
        // Try to acquire lock before updating
        const [lockResult] = await pool.execute(
          `UPDATE positions 
           SET is_processing = 1 
           WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
           LIMIT 1`,
          [position.id]
        );
        lockAcquired = lockResult.affectedRows > 0;
        
        if (!lockAcquired) {
          // Another process is handling this position, skip update
          logger.debug(`[PositionService] Position ${position.id} is being processed by another instance, skipping update`);
          return position; // Return original position without changes
        }
      } catch (lockError) {
        // If is_processing column doesn't exist, proceed without lock (backward compatibility)
        logger.debug(`[PositionService] Could not acquire lock for position ${position.id}: ${lockError?.message || lockError}`);
        lockAcquired = true; // Proceed with update
      }
      
      try {
      const updatePayload = {
        pnl: pnl,
        current_reduce: clampedReduce,
          minutes_elapsed: actualMinutesElapsed // Update minutes_elapsed here (only once)
          // Note: is_processing lock is released in finally block, not here
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
      } finally {
        // Always release lock if acquired
        if (lockAcquired) {
          try {
            const pool = (await import('../config/database.js')).default;
            await pool.execute(
              `UPDATE positions SET is_processing = 0 WHERE id = ?`,
              [position.id]
            );
          } catch (releaseError) {
            logger.debug(`[PositionService] Could not release lock for position ${position.id}: ${releaseError?.message || releaseError}`);
          }
        }
      }
    } catch (error) {
      logger.error(`Failed to update position ${position.id}:`, error);
      throw error;
    }
  }

  /**
   * Internal helper: quyết định có cần hủy / đặt lại TP order hay không
   */
  async _maybeReplaceTpOrder(position, prevTP, desiredTP, getCachedClosableQty) {
    try {
          const entryPrice = Number(position.entry_price || 0);
          const newTP = Number(desiredTP || 0);
          
          // logger.debug(`[TP Replace] _maybeReplaceTpOrder called: pos=${position.id} prevTP=${prevTP.toFixed(2)} desiredTP=${newTP.toFixed(2)} entryPrice=${entryPrice.toFixed(2)} side=${position.side}`);
          
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
          
          // logger.debug(`[TP Replace] Threshold check: tickTP=${tickTP} thresholdTicksTP=${thresholdTicksTP} prevTP=${prevTP.toFixed(2)} newTP=${newTP.toFixed(2)}`);
          
          if (tickTP > 0 && newTP > 0 && prevTP > 0) {
            const movedTP = Math.abs(newTP - prevTP);
            const effectiveThreshold = thresholdTicksTP * tickTP;
            
            // Additional cooldown check: only replace if price changed significantly (>0.1% of current price)
            // This prevents unnecessary order replacements that create dangerous gaps
            const minPriceChangePercent = Number(configService.getNumber('EXIT_ORDER_MIN_PRICE_CHANGE_PCT', 0.1)); // 0.1%
            const avgPrice = (newTP + prevTP) / 2;
            const minPriceChange = avgPrice * (minPriceChangePercent / 100);
            const priceChangePercent = (movedTP / avgPrice) * 100;
            
            // logger.info(
            //   `[TP Replace] 🔍 Movement check | pos=${position.id} ` +
            //   `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} ` +
            //   `movedTP=${movedTP.toFixed(8)} effectiveThreshold=${effectiveThreshold.toFixed(8)} ` +
            //   `minPriceChange=${minPriceChange.toFixed(8)} (${minPriceChangePercent}%) ` +
            //   `priceChangePercent=${priceChangePercent.toFixed(3)}% ` +
            //   `tickTP=${tickTP} thresholdTicksTP=${thresholdTicksTP}`
            // );
            
            // Replace only if BOTH conditions are met:
            // 1. Movement >= tick-based threshold (precision requirement)
            // 2. Movement >= minimum price change % (cooldown requirement)
            const tickThresholdMet = movedTP >= effectiveThreshold;
            const priceChangeThresholdMet = movedTP >= minPriceChange;
            
            // logger.info(
            //   `[TP Replace] 🔍 Threshold check result | pos=${position.id} ` +
            //   `tickThresholdMet=${tickThresholdMet} (${movedTP.toFixed(8)} >= ${effectiveThreshold.toFixed(8)}) ` +
            //   `priceChangeThresholdMet=${priceChangeThresholdMet} (${movedTP.toFixed(8)} >= ${minPriceChange.toFixed(8)}) ` +
            //   `willReplace=${tickThresholdMet && priceChangeThresholdMet}`
            // );
            
            if (tickThresholdMet && priceChangeThresholdMet) {
              const replaceStartTime = Date.now();
              const timestamp = new Date().toISOString();
              
              // logger.info(
              //   `[TP Replace] 🎯 THRESHOLD MET: Proceeding with TP order replacement | pos=${position.id} ` +
              //   `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} movedTP=${movedTP.toFixed(8)} ` +
              //   `effectiveThreshold=${effectiveThreshold.toFixed(8)} minPriceChange=${minPriceChange.toFixed(8)} ` +
              //   `priceChangePercent=${priceChangePercent.toFixed(3)}% timestamp=${timestamp}`
              // );
              
              // NOTE: ExitOrderManager.placeOrReplaceExitOrder now uses atomic replace pattern:
              // Creates new order FIRST, then cancels old order. No delay needed.
              
              const qty = getCachedClosableQty ? await getCachedClosableQty() : await this.exchangeService.getClosableQuantity(position.symbol, position.side);
              // logger.debug(
              //   `[TP Replace] Quantity check | pos=${position.id} qty=${qty} ` +
              //   `symbol=${position.symbol} side=${position.side}`
              // );
              
              if (qty > 0) {
                // CRITICAL FIX: Allow TP to cross entry for SHORT positions (early loss-cutting)
                // For SHORT: TP can be above entry (loss zone) to enable early exit when price moves against position
                // For LONG: TP should be above entry (profit zone) - no change
                const entryPrice = Number(position.entry_price || 0);
                let isValidTP = true;
                
                if (Number.isFinite(entryPrice) && entryPrice > 0) {
                  if (position.side === 'long') {
                    // LONG: TP must be >= entry (profit zone)
                    isValidTP = newTP >= entryPrice;
                  } else {
                    // SHORT: TP can be <= entry (profit zone) OR > entry (loss zone for early exit)
                    // No validation needed - allow TP to trail above entry for early loss-cutting
                    isValidTP = true;
                  }
                }
                
                // logger.debug(
                //   `[TP Replace] Validation check | pos=${position.id} ` +
                //   `entryPrice=${entryPrice.toFixed(8)} newTP=${newTP.toFixed(8)} ` +
                //   `side=${position.side} isValidTP=${isValidTP}`
                // );
                
                if (isValidTP) {
                  try {
                    const oldExitOrderId = position.exit_order_id || null;
                    
                    // logger.info(
                    //   `[TP Replace] 🚀 CALLING ExitOrderManager | pos=${position.id} ` +
                    //   `symbol=${position.symbol} side=${position.side} ` +
                    //   `newTP=${newTP.toFixed(8)} entryPrice=${entryPrice.toFixed(8)} ` +
                    //   `oldExitOrderId=${oldExitOrderId || 'null'} timestamp=${new Date().toISOString()}`
                    // );
                    
                    if (position.side !== 'long' && position.side !== 'short') {
                      // logger.error(
                      //   `[TP Replace] ⚠️ INVALID position.side: ${position.side} for position ${position.id}. ` +
                      //   `Expected 'long' or 'short'.`
                      // );
                    }
                    
                    // ✅ Unified exit order: type switches based on profit/loss zone (STOP_MARKET <-> TAKE_PROFIT_MARKET)
                    const { ExitOrderManager } = await import('./ExitOrderManager.js');
                    const mgr = new ExitOrderManager(this.exchangeService);
                    const placed = await mgr.placeOrReplaceExitOrder(position, newTP);

                    const replaceEndTime = Date.now();
                    const replaceDuration = replaceEndTime - replaceStartTime;
                    const newExitOrderId = placed?.orderId ? String(placed.orderId) : null;
                    
                    // logger.info(
                    //   `[TP Replace] ✅ ExitOrderManager returned | pos=${position.id} ` +
                    //   `newExitOrderId=${newExitOrderId || 'null'} oldExitOrderId=${oldExitOrderId || 'null'} ` +
                    //   `orderType=${placed?.orderType || 'n/a'} stopPrice=${placed?.stopPrice?.toFixed(8) || newTP.toFixed(8)} ` +
                    //   `replaceDuration=${replaceDuration}ms timestamp=${new Date().toISOString()}`
                    // );

                    const updatePayload = { 
                      take_profit_price: newTP,
                      // tp_synced may not exist in older DB schemas; only set it when supported
                      ...(Position?.rawAttributes?.tp_synced ? { tp_synced: newExitOrderId ? true : false } : {})
                    };
                    if (newExitOrderId) updatePayload.exit_order_id = newExitOrderId;
                    
                    const dbUpdateStart = Date.now();
                    await Position.update(position.id, updatePayload);
                    const dbUpdateDuration = Date.now() - dbUpdateStart;
                    
                    // logger.info(
                    //   `[TP Replace] ✅ DB UPDATED | pos=${position.id} ` +
                    //   `exit_order_id=${newExitOrderId || 'null'} take_profit_price=${newTP.toFixed(8)} ` +
                    //   `tp_synced=${updatePayload.tp_synced || 'N/A'} ` +
                    //   `dbUpdateDuration=${dbUpdateDuration}ms totalDuration=${Date.now() - replaceStartTime}ms ` +
                    //   `timestamp=${new Date().toISOString()}`
                    // );
                  } catch (tpError) {
                    const replaceEndTime = Date.now();
                    const replaceDuration = replaceEndTime - replaceStartTime;
                    
                    // logger.error(
                    //   `[TP Replace] ❌ FAILED: ExitOrderManager error | pos=${position.id} ` +
                    //   `newTP=${newTP.toFixed(8)} oldExitOrderId=${position.exit_order_id || 'null'} ` +
                    //   `replaceDuration=${replaceDuration}ms error=${tpError?.message || tpError} ` +
                    //   `stack=${tpError?.stack || 'N/A'} timestamp=${new Date().toISOString()}`
                    // );
                    
                    // If TP order creation fails, still update take_profit_price in DB
                    // This allows trailing TP to continue working even if orders can't be placed
                    // Mark as not synced so PositionMonitor can retry later
                    // logger.warn(
                    //   `[TP Replace] ⚠️ FALLBACK: Updating DB only (order not placed) | pos=${position.id} ` +
                    //   `take_profit_price=${newTP.toFixed(8)} tp_synced=false ` +
                    //   `(will retry later via PositionMonitor) timestamp=${new Date().toISOString()}`
                    // );
                    
                    await Position.update(position.id, { 
                      take_profit_price: newTP,
                      ...(Position?.rawAttributes?.tp_synced ? { tp_synced: false } : {}) // Mark as not synced for retry (if supported)
                    });
                    
                    // logger.debug(
                    //   `[TP Replace] ✅ DB updated (fallback) | pos=${position.id} ` +
                    //   `take_profit_price=${newTP.toFixed(8)} timestamp=${new Date().toISOString()}`
                    // );
                  }
                } else {
                  // logger.warn(
                  //   `[TP Replace] ⚠️ SKIP: Invalid TP for LONG position | pos=${position.id} ` +
                  //   `newTP=${newTP.toFixed(8)} entryPrice=${entryPrice.toFixed(8)} ` +
                  //   `(must be >= entry, will be handled by SL conversion) timestamp=${new Date().toISOString()}`
                  // );
                }
              } else {
                // logger.warn(
                //   `[TP Replace] ⚠️ SKIP: Invalid quantity | pos=${position.id} ` +
                //   `qty=${qty} symbol=${position.symbol} side=${position.side} ` +
                //   `timestamp=${new Date().toISOString()}`
                // );
              }
            } else {
              // logger.warn(
              //   `[TP Replace] ⚠️ THRESHOLD NOT MET: Skipping TP order replacement | pos=${position.id} ` +
              //   `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} movedTP=${movedTP.toFixed(8)} ` +
              //   `effectiveThreshold=${effectiveThreshold.toFixed(8)} minPriceChange=${minPriceChange.toFixed(8)} ` +
              //   `tickThresholdMet=${tickThresholdMet} priceChangeThresholdMet=${priceChangeThresholdMet} ` +
              //   `priceChangePercent=${priceChangePercent.toFixed(3)}% ` +
              //   `(Order will NOT be replaced, but DB take_profit_price will be updated)`
              // );
            }
          } else {
            // logger.warn(`[TP Replace] Invalid tickTP (${tickTP}) or TP values (prevTP=${prevTP} newTP=${newTP}), skipping TP order replacement`);
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
  async calculateUpdatedStopLoss(position) {
    const prevSL = Number(position.stop_loss_price || 0);
    const entry = Number(position.entry_price || 0);
    
    logger.debug(`[calculateUpdatedStopLoss] pos=${position.id} prevSL=${prevSL} entry=${entry} side=${position.side}`);
    
    // NEW LOGIC: SL should NOT be moved after initial setup
    // Only calculate initial SL if it doesn't exist yet
    if (!Number.isFinite(prevSL) || prevSL <= 0) {
      // CRITICAL FIX: Get stoploss from Strategy, not from position (position doesn't have stoploss field)
      // Try multiple sources in order of preference:
      // 1. Strategy.stoploss (from JOIN or explicit fetch)
      // 2. position.strategy_stoploss (if JOIN included it)
      // 3. Fetch Strategy explicitly if not available
      let stoploss = null;
      
      if (position.strategy?.stoploss !== undefined) {
        stoploss = Number(position.strategy.stoploss);
      } else if (position.strategy_stoploss !== undefined) {
        stoploss = Number(position.strategy_stoploss);
      } else {
        // Fallback: fetch Strategy explicitly
        try {
          const { Strategy } = await import('../models/Strategy.js');
          const strategy = await Strategy.findById(position.strategy_id);
          if (strategy && strategy.stoploss !== undefined) {
            stoploss = Number(strategy.stoploss);
          }
        } catch (e) {
          logger.warn(`[calculateUpdatedStopLoss] Failed to fetch Strategy ${position.strategy_id} for position ${position.id}: ${e?.message || e}`);
        }
      }
      
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
      
      logger.debug(`[calculateUpdatedStopLoss] Calculated initial SL: ${initialSL} for position ${position.id} (entry=${entry}, stoploss=${stoploss})`);
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
        logger.warn(`[Notification] telegramService: ${!!this.telegramService}, sendCloseSummaryAlert: ${!!this.telegramService?.sendCloseSummaryAlert}`);
        return;
      }
      logger.info(`[Notification] Preparing to send close summary for position ${closedPosition.id} (reason: ${closedPosition.close_reason})`);
      
      // CRITICAL FIX: Always re-fetch position with bot info to ensure we have all required fields
      // Position.close() may not return all fields from JOIN, so we re-fetch to be safe
      let positionWithBotInfo = await Position.findById(closedPosition.id);
      if (!positionWithBotInfo) {
        logger.warn(`[Notification] Could not find position ${closedPosition.id} to send notification`);
        return;
      }

      // Verify required fields and try to get from bot if missing
      if (!positionWithBotInfo.bot_name || !positionWithBotInfo.telegram_alert_channel_id && !positionWithBotInfo.telegram_chat_id) {
        logger.warn(`[Notification] Position ${closedPosition.id} missing bot info, trying to get from bot`);
        if (positionWithBotInfo.bot_id) {
          const { Bot } = await import('../models/Bot.js');
          const bot = await Bot.findById(positionWithBotInfo.bot_id);
          if (bot) {
            positionWithBotInfo.bot_name = bot.bot_name || positionWithBotInfo.bot_name;
            positionWithBotInfo.telegram_chat_id = bot.telegram_chat_id || positionWithBotInfo.telegram_chat_id;
            positionWithBotInfo.telegram_alert_channel_id = bot.telegram_alert_channel_id || positionWithBotInfo.telegram_alert_channel_id;
            logger.debug(`[Notification] Updated position ${closedPosition.id} with bot info: bot_name=${positionWithBotInfo.bot_name}, telegram_chat_id=${positionWithBotInfo.telegram_chat_id}, telegram_alert_channel_id=${positionWithBotInfo.telegram_alert_channel_id}`);
          }
        }
      }
      
      const stats = await Position.getBotStats(positionWithBotInfo.bot_id);
      logger.debug(`[Notification] Fetched bot stats for bot ${positionWithBotInfo.bot_id}: wins=${stats?.wins || 0}, loses=${stats?.loses || 0}, total_pnl=${stats?.total_pnl || 0}`);
      await this.telegramService.sendCloseSummaryAlert(positionWithBotInfo, stats);
      logger.info(`[Notification] ✅ Successfully sent close summary alert for position ${closedPosition.id}`);
    } catch (inner) {
      logger.error(`[Notification] ❌ Failed to send close summary alert for position ${closedPosition.id}:`, inner?.message || inner, inner?.stack);
    }
  }

  async closePosition(position, currentPrice, pnl, reason) {
    try {

      // CRITICAL FIX: Skip CloseGuard for force close reasons (tp_cross_entry_force_close)
      // Force close is intentional and should bypass verification checks
      const isForceClose = reason === 'tp_cross_entry_force_close';
      
      if (isForceClose) {
        logger.info(`[CloseGuard] ⚠️ FORCE CLOSE: Skipping CloseGuard for position ${position.id} (reason: ${reason})`);
      } else {
        // CRITICAL FIX: Verify position is actually closed on exchange before sending alert
        // This prevents false alerts when TP order is cancelled (e.g., during dedupe or trailing TP)
        // Only allow closing if:
        // 1. Order status is FILLED (verified in updatePosition), OR
        // 2. Position has no exposure on exchange (already closed)
        let hasExposure = false;
        let verifiedClose = false;
        
        try {
          const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
          hasExposure = qty && qty > 0;
          
          if (!hasExposure) {
            // Position has no exposure - likely closed on exchange, but closableQty can be 0 due to rounding/mode mismatch.
            // CRITICAL: Double-check the real exchange position before declaring closed.
            let exchangePositions = null;
            try {
              exchangePositions = await this.exchangeService.getOpenPositions(position.symbol);
            } catch (posErr) {
              logger.warn(`[CloseGuard] Failed to fetch open positions for verification: ${posErr?.message || posErr}`);
            }

            const normalizedSymbol = (this.exchangeService?.binanceDirectClient?.normalizeSymbol && this.exchangeService.binanceDirectClient.normalizeSymbol(position.symbol)) || position.symbol;
            const expectedPositionSide = position.side === 'long' ? 'LONG' : 'SHORT';
            const stillOpen = Array.isArray(exchangePositions)
              ? exchangePositions.some(p => {
                  const symOk = (p.symbol === normalizedSymbol || p.symbol === position.symbol);
                  if (!symOk) return false;

                  // Hedge-mode aware: if exchange returns positionSide, ensure it matches our position side.
                  if (p.positionSide && String(p.positionSide).toUpperCase() !== expectedPositionSide) return false;

                  const amt = Math.abs(parseFloat(p.positionAmt ?? p.contracts ?? 0));
                  return amt > 0;
                })
              : false;

            if (stillOpen) {
              // Position still exists on exchange -> do NOT close in DB
              logger.error(
                `[CloseGuard] ❌ BLOCKED: getClosableQuantity=0 but exchange still reports open position for ${position.symbol}. ` +
                `Will NOT close position ${position.id} to prevent false alert.`
              );
              throw new Error(`Exchange still has open position for ${position.symbol}. Blocking DB close.`);
            }

            verifiedClose = true;
            logger.info(`[CloseGuard] ✅ Position ${position.id} (${position.symbol}) verified closed on exchange (no exposure + no open position)`);
          } else {
            // Position still has exposure - verify order was FILLED before closing
            // Check order status from cache or REST API
            const exchange = (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
            
            if (position.exit_order_id) {
              const cachedTpStatus = orderStatusCache.getOrderStatus(position.exit_order_id, exchange);
              if (cachedTpStatus?.status === 'closed') {
                verifiedClose = true;
                logger.info(`[CloseGuard] ✅ TP order ${position.exit_order_id} verified FILLED - safe to close position ${position.id}`);
              } else {
                // Fallback to REST API
                try {
                  const tpOrderStatus = await this.exchangeService.getOrderStatus(position.symbol, position.exit_order_id);
                  const normalizedStatus = tpOrderStatus?.status?.toLowerCase() || '';
                  if (normalizedStatus === 'closed' || normalizedStatus === 'filled') {
                    verifiedClose = true;
                    logger.info(`[CloseGuard] ✅ TP order ${position.exit_order_id} verified FILLED via REST - safe to close position ${position.id}`);
                  } else if (normalizedStatus === 'canceled' || normalizedStatus === 'cancelled' || normalizedStatus === 'expired') {
                    // Order was cancelled, not filled - DO NOT close position
                    logger.error(
                      `[CloseGuard] ❌ BLOCKED: TP order ${position.exit_order_id} for position ${position.id} was ${normalizedStatus}, NOT FILLED. ` +
                      `Position still has exposure. Will NOT close position to prevent false alert.`
                    );
                    throw new Error(`TP order ${position.exit_order_id} was ${normalizedStatus}, not FILLED. Cannot close position ${position.id}.`);
                  }
                } catch (e) {
                  if (e?.message?.includes('BLOCKED')) throw e; // Re-throw our blocking error
                  logger.warn(`[CloseGuard] Failed to verify TP order status: ${e?.message || e}`);
                }
              }
            }
            
            if (!verifiedClose && position.sl_order_id) {
              const cachedSlStatus = orderStatusCache.getOrderStatus(position.sl_order_id, exchange);
              if (cachedSlStatus?.status === 'closed') {
                verifiedClose = true;
                logger.info(`[CloseGuard] ✅ SL order ${position.sl_order_id} verified FILLED - safe to close position ${position.id}`);
              } else {
                // Fallback to REST API
                try {
                  const slOrderStatus = await this.exchangeService.getOrderStatus(position.symbol, position.sl_order_id);
                  const normalizedStatus = slOrderStatus?.status?.toLowerCase() || '';
                  if (normalizedStatus === 'closed' || normalizedStatus === 'filled') {
                    verifiedClose = true;
                    logger.info(`[CloseGuard] ✅ SL order ${position.sl_order_id} verified FILLED via REST - safe to close position ${position.id}`);
                  } else if (normalizedStatus === 'canceled' || normalizedStatus === 'cancelled' || normalizedStatus === 'expired') {
                    // Order was cancelled, not filled - DO NOT close position
                    logger.error(
                      `[CloseGuard] ❌ BLOCKED: SL order ${position.sl_order_id} for position ${position.id} was ${normalizedStatus}, NOT FILLED. ` +
                      `Position still has exposure. Will NOT close position to prevent false alert.`
                    );
                    throw new Error(`SL order ${position.sl_order_id} was ${normalizedStatus}, not FILLED. Cannot close position ${position.id}.`);
                  }
                } catch (e) {
                  if (e?.message?.includes('BLOCKED')) throw e; // Re-throw our blocking error
                  logger.warn(`[CloseGuard] Failed to verify SL order status: ${e?.message || e}`);
                }
              }
            }
            
            // If position has exposure but no verified fill, block closing
            if (!verifiedClose) {
              logger.error(
                `[CloseGuard] ❌ BLOCKED: Position ${position.id} has exposure but no verified TP/SL fill. ` +
                `Orders may have been cancelled. Will NOT close position to prevent false alert.`
              );
              throw new Error(`Position ${position.id} has exposure but no verified fill. Cannot close position.`);
            }
          }
        } catch (e) {
          if (e?.message?.includes('BLOCKED') || e?.message?.includes('Cannot close')) {
            // Re-throw blocking errors
            throw e;
          }
          logger.warn(`[CloseGuard] Unable to verify exchange exposure for position ${position.id}: ${e?.message || e}`);
          // CRITICAL CHANGE: Do NOT close in DB when verification fails.
          // This was causing false "close position" alerts while position is still open on exchange.
          // Fail-safe: keep position open in DB and let PositionSync reconcile later.
          logger.error(
            `[CloseGuard] ❌ BLOCKED: Verification failed; will NOT close position ${position.id} in DB to prevent mismatch.`
          );
          throw new Error(`CloseGuard verification failed for position ${position.id}. Blocking DB close to prevent false alert.`);
        }
      }
      
      // Check exposure for force close (to determine if we need to close on exchange)
      let hasExposure = false;
      if (isForceClose) {
        try {
          const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
          hasExposure = qty && qty > 0;
        } catch (e) {
          logger.warn(`[CloseGuard] Unable to check exposure for force close position ${position.id}: ${e?.message || e}`);
          hasExposure = true; // Assume has exposure to be safe
        }
      } else {
        // For non-force-close, hasExposure was already checked above
        try {
          const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
          hasExposure = qty && qty > 0;
        } catch (e) {
          logger.warn(`[CloseGuard] Unable to check exposure for position ${position.id}: ${e?.message || e}`);
          hasExposure = false; // Assume no exposure for backward compatibility
        }
      }

      // Close on exchange (only if position exists)
      let closeRes = null;
      if (hasExposure) {
        // ExchangeService handles exchange-specific logic (Binance, MEXC, Gate.io)
        // MEXC: Uses CCXT to close position via market order
        // Binance: Uses direct API with reduce-only flag
        closeRes = await this.exchangeService.closePosition(
          position.symbol,
          position.side,
          position.amount
        );

        if (closeRes?.skipped) {
          logger.warn(`[CloseGuard] Exchange reported no position to close for ${position.symbol}; will close in DB only`);
          // Don't return - continue to close in DB
        }
      } else {
        logger.info(`[CloseGuard] Skipping exchange close for position ${position.id} - no exposure (already closed on exchange)`);
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

