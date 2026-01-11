import { Position } from '../models/Position.js';
import { calculatePnL, calculatePnLPercent, calculateDynamicStopLoss, calculateTakeProfit, calculateInitialStopLoss, calculateInitialStopLossByAmount, calculateNextTrailingStop, calculateNextTrailingTakeProfit } from '../utils/calculator.js';
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
    // A) Memory map for cross-entry exit deduplication
    this.crossEntryExitPending = new Map(); // position.id -> timestamp
    this.crossEntryExitTTL = 60 * 1000; // 60 seconds cooldown
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

        // CRITICAL CHANGE:
        // Do NOT close position in DB / send Telegram from here.
        // We only mark closed + alert when we receive explicit exchange confirmation via WebSocket.
        if (cachedTpStatus && cachedTpStatus.status === 'closed') {
          logger.info(
            `[TP/SL WS] ✅ TP order ${position.exit_order_id} for position ${position.id} FILLED (cache). ` +
            `Waiting for WS-driven close handler to update DB/Telegram. symbol=${position.symbol}`
          );
          return position;
        }
      }

      if (position.sl_order_id) {
        const cachedSlStatus = orderStatusCache.getOrderStatus(position.sl_order_id, exchange);

        // Debug logging for cache miss
        if (!cachedSlStatus) {
          logger.debug(`[TP/SL Check] SL order ${position.sl_order_id} for position ${position.id} not found in cache (exchange: ${exchange})`);
        }

        // CRITICAL CHANGE:
        // Do NOT close position in DB / send Telegram from here.
        // We only mark closed + alert when we receive explicit exchange confirmation via WebSocket.
        if (cachedSlStatus && cachedSlStatus.status === 'closed') {
          logger.info(
            `[TP/SL WS] ✅ SL order ${position.sl_order_id} for position ${position.id} FILLED (cache). ` +
            `Waiting for WS-driven close handler to update DB/Telegram. symbol=${position.symbol}`
          );
          return position;
        }
      }

      // PRIORITY CHECK 2 (DISABLED)
      // CRITICAL CHANGE:
      // Do NOT infer closure from REST exposure checks or order status polling.
      // Only update DB + send Telegram when exchange confirms closure via WebSocket.

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
          logger.info(
            `[TP Trail] ⏸️ Skipping TP trail (not yet time) | pos=${position.id} ` +
            `totalMinutes=${totalMinutesElapsed} <= prevMinutes=${prevMinutes} ` +
            `(will update minutes_elapsed=${totalMinutesElapsed} but no TP movement)`
          );
          // Still update PnL and minutes_elapsed (increment by 0 if no time passed, or by actual difference)
          // CRITICAL FIX: Always update minutes_elapsed to current time, even if no TP trail
          actualMinutesElapsed = totalMinutesElapsed; // Use actual time elapsed
          minutesToProcess = 0; // No minutes to process for trailing
          
          // CRITICAL DEBUG: Log when skipping to understand why TP doesn't trail
          if (totalMinutesElapsed < prevMinutes) {
            logger.warn(
              `[TP Trail] ⚠️ WARNING: totalMinutes (${totalMinutesElapsed}) < prevMinutes (${prevMinutes}) for position ${position.id}! ` +
              `This should not happen. Position may have been manually updated or there's a time sync issue. ` +
              `opened_at=${position.opened_at} now=${new Date().toISOString()}`
            );
          }
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
          
          logger.info(
            `[TP Trail] ✅ Proceeding with TP trail | pos=${position.id} ` +
            `totalMinutes=${totalMinutesElapsed} > prevMinutes=${prevMinutes}, ` +
            `processing ${minutesToProcess} minute(s), targetMinutes=${actualMinutesElapsed}`
          );
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

          // CRITICAL FIX: If take_profit_price is 0 but exit_order_id exists, try to recover TP from exchange or initial_tp_price
          if (!Number.isFinite(prevTP) || prevTP <= 0) {
            logger.warn(
              `[TP Trail] ⚠️ take_profit_price is invalid (${prevTP}) for position ${position.id} ` +
              `(symbol=${position.symbol}, bot_id=${position.bot_id}, exit_order_id=${position.exit_order_id || 'null'}, ` +
              `initial_tp_price=${position.initial_tp_price || 'null'}). Attempting recovery...`
            );
            
            // Try to recover TP from initial_tp_price or exchange order
            if (position.exit_order_id && position.initial_tp_price && Number.isFinite(Number(position.initial_tp_price)) && Number(position.initial_tp_price) > 0) {
              const recoveredTP = Number(position.initial_tp_price);
              logger.warn(
                `[TP Trail] ⚠️ take_profit_price is ${prevTP} but exit_order_id exists. ` +
                `Recovering from initial_tp_price=${recoveredTP} for position ${position.id}`
              );
              // Update take_profit_price from initial_tp_price
              await Position.update(position.id, { take_profit_price: recoveredTP });
              prevTP = recoveredTP;
              logger.info(`[TP Trail] ✅ Recovered take_profit_price=${recoveredTP} from initial_tp_price for position ${position.id}`);
            } else if (position.exit_order_id) {
              // Try to get TP from exchange order
              try {
                const orderStatus = await this.exchangeService.getOrderStatus(position.symbol, position.exit_order_id);
                if (orderStatus && orderStatus.stopPrice && Number.isFinite(Number(orderStatus.stopPrice)) && Number(orderStatus.stopPrice) > 0) {
                  const recoveredTP = Number(orderStatus.stopPrice);
                  logger.warn(
                    `[TP Trail] ⚠️ take_profit_price is ${prevTP} but exit_order_id exists. ` +
                    `Recovering from exchange order stopPrice=${recoveredTP} for position ${position.id}`
                  );
                  await Position.update(position.id, { take_profit_price: recoveredTP });
                  prevTP = recoveredTP;
                  logger.info(`[TP Trail] ✅ Recovered take_profit_price=${recoveredTP} from exchange order for position ${position.id}`);
                } else {
                  // Last resort: calculate from strategy if available
                  if (position.take_profit && Number.isFinite(Number(position.take_profit)) && Number(position.take_profit) > 0 && 
                      entryPrice > 0) {
                    const { calculateTakeProfit } = await import('../utils/calculator.js');
                    const calculatedTP = calculateTakeProfit(entryPrice, Number(position.take_profit), position.side);
                    if (Number.isFinite(calculatedTP) && calculatedTP > 0) {
                      logger.warn(
                        `[TP Trail] ⚠️ take_profit_price is ${prevTP}, cannot recover from exchange. ` +
                        `Calculating from strategy: entry=${entryPrice}, take_profit=${position.take_profit}, calculatedTP=${calculatedTP} for position ${position.id}`
                      );
                      await Position.update(position.id, { 
                        take_profit_price: calculatedTP,
                        initial_tp_price: calculatedTP 
                      });
                      prevTP = calculatedTP;
                      logger.info(`[TP Trail] ✅ Recovered take_profit_price=${calculatedTP} from strategy calculation for position ${position.id}`);
                    } else {
                      logger.warn(
                        `[TP Trail] Skip TP trail for position ${position.id} - no initial TP (prevTP=${prevTP}) ` +
                        `and cannot recover from exchange or strategy (exit_order_id=${position.exit_order_id}, orderStatus=${JSON.stringify(orderStatus)})`
                      );
                    }
                  } else {
                    logger.warn(
                      `[TP Trail] Skip TP trail for position ${position.id} - no initial TP (prevTP=${prevTP}) ` +
                      `and cannot recover from exchange (exit_order_id=${position.exit_order_id}, orderStatus=${JSON.stringify(orderStatus)})`
                    );
                  }
                }
              } catch (recoverError) {
                logger.warn(
                  `[TP Trail] Skip TP trail for position ${position.id} - no initial TP (prevTP=${prevTP}) ` +
                  `and failed to recover from exchange: ${recoverError?.message || recoverError}`
                );
              }
            } else {
              logger.warn(
                `[TP Trail] Skip TP trail for position ${position.id} - no initial TP (prevTP=${prevTP}) and no exit_order_id. ` +
                `Position may need TP order to be created first.`
              );
            }
            
            // If still no valid TP after recovery attempt, skip trailing
            if (!Number.isFinite(prevTP) || prevTP <= 0) {
              // Skip trailing for this cycle
              logger.debug(`[TP Trail] Skipping trailing for position ${position.id} - no valid TP after recovery attempts`);
              return position;
            }
          }
          
          if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
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
              
              // CRITICAL FIX: If newTP has crossed entry (in loss zone) AND currentPrice is better than newTP,
              // close position immediately with MARKET order to avoid worse loss
              // For LONG: newTP <= entry (loss) AND currentPrice < newTP → close now (currentPrice is better)
              // For SHORT: newTP >= entry (loss) AND currentPrice > newTP → close now (currentPrice is better)
              const shouldCloseImmediately = hasCrossedEntry && (
                (position.side === 'long' && marketPrice < newTP) ||
                (position.side === 'short' && marketPrice > newTP)
              );
              
              if (shouldCloseImmediately) {
                // Case 2B: TP crossed entry AND current price is better than newTP
                // Close immediately with MARKET order to minimize loss
                logger.warn(
                  `[TP Trail] 🚨 CRITICAL: TP crossed entry AND currentPrice better than newTP -> immediate MARKET close | ` +
                  `pos=${position.id} symbol=${position.symbol} side=${position.side} ` +
                  `entry=${entryPrice.toFixed(8)} newTP=${newTP.toFixed(8)} currentPrice=${marketPrice.toFixed(8)} ` +
                  `(closing now to avoid worse loss at newTP)`
                );
                
                try {
                  // Calculate PnL at current price
                  const currentPnl = calculatePnL(position.entry_price, marketPrice, position.amount, position.side);
                  
                  // Close position immediately with MARKET order
                  await this.closePosition(position, marketPrice, currentPnl, 'tp_trailing_loss_zone');
                  
                  logger.info(
                    `[TP Trail] ✅ Immediate MARKET close executed | pos=${position.id} ` +
                    `price=${marketPrice.toFixed(8)} pnl=${currentPnl.toFixed(2)} reason=tp_trailing_loss_zone`
                  );
                  
                  // Return early - position is closed
                  return position;
                } catch (closeError) {
                  logger.error(
                    `[TP Trail] ❌ Failed to close position immediately | pos=${position.id} ` +
                    `error=${closeError?.message || closeError}`
                  );
                  // Continue to fallback logic below
                }
              } else if (hasCrossedEntry) {
                // Case 2A: TP has crossed entry, but currentPrice is NOT better than newTP
                // Try to exit as soon as possible based on PnL,
                // but NEVER close DB / send Telegram here. DB/Telegram is WS-driven only.

                // Dedupe: avoid spamming exit attempts
                const lastAttemptAt = this.crossEntryExitPending.get(position.id) || 0;
                const nowAttempt = Date.now();
                if (nowAttempt - lastAttemptAt < this.crossEntryExitTTL) {
                  logger.debug(`[TP Trail] ⏳ Cross-entry exit pending (dedupe) | pos=${position.id} lastAttemptAt=${lastAttemptAt}`);
                } else {
                  this.crossEntryExitPending.set(position.id, nowAttempt);

                  logger.warn(
                    `[TP Trail] ⚠️ TP crossed entry -> attempt fast exit (WS-driven close) | pos=${position.id} symbol=${position.symbol} side=${position.side} ` +
                    `entry=${entryPrice.toFixed(8)} prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} market=${marketPrice.toFixed(8)} ` +
                    `(currentPrice NOT better than newTP, using conditional order)`
                  );

                  // Persist trailing TP value for audit/debug
                  try {
                    await Position.update(position.id, { take_profit_price: newTP });
                  } catch (e) {
                    logger.warn(`[TP Trail] Failed to persist take_profit_price (cross-entry) | pos=${position.id}: ${e?.message || e}`);
                  }

                  try {
                    // Compute current pnl using marketPrice
                    const currentPnl = calculatePnL(position.entry_price, marketPrice, position.amount, position.side);

                    // Helper to detect Binance "would immediately trigger" errors
                    const isImmediateTriggerError = (msg) => {
                      const m = String(msg || '').toLowerCase();
                      return m.includes('-2021') || m.includes('would immediately trigger');
                    };

                    // CRITICAL: Ensure only ONE exit order exists per position.
                    // When TP has crossed entry, we must NOT create a second order type (TP_MARKET/STOP_MARKET)
                    // alongside an existing SL/TP order. Use ExitOrderManager to atomically replace the existing
                    // exit_order_id (cancel old after creating new) and auto-switch order type by zone.
                    try {
                      const { ExitOrderManager } = await import('./ExitOrderManager.js');
                      const mgr = new ExitOrderManager(this.exchangeService);

                      // Decide desiredExitPrice based on zone:
                      // - Profit zone (pnl > 0): place conditional order on the profit side of market (TAKE_PROFIT_MARKET)
                      // - Loss/breakeven zone (pnl <= 0): place conditional order on the loss side of market (STOP_MARKET)
                      const currentPnl = calculatePnL(position.entry_price, marketPrice, position.amount, position.side);

                      const tickSizeStr = exchangeInfoService.getTickSize(position.symbol) || await this.exchangeService.getTickSize(position.symbol);
                      const tickSize = String(tickSizeStr || '0.01');

                      const buffers = currentPnl > 0
                        ? [0.001, 0.002, 0.003] // Profit zone: try a few buffers to avoid -2021
                        : [0.001]; // Loss zone: one attempt is enough; fallback handled inside ExitOrderManager

                      let placed = false;
                      for (let i = 0; i < buffers.length; i++) {
                        const b = buffers[i];

                        // Compute a desired exit price on the correct side of market.
                        // ExitOrderManager will decide STOP vs TAKE_PROFIT by comparing desiredExitPrice vs entry.
                        const rawDesiredExit = (() => {
                          if (currentPnl > 0) {
                            // Profit zone: put stop on profit side of market
                            return position.side === 'long'
                              ? marketPrice * (1 + b)
                              : marketPrice * (1 - b);
                          }
                          // Loss/breakeven zone: put stop on loss side of market
                          return position.side === 'long'
                            ? marketPrice * (1 - b)
                            : marketPrice * (1 + b);
                        })();

                        const desiredExitPrice = (this.exchangeService?.binanceDirectClient?.formatPrice)
                          ? this.exchangeService.binanceDirectClient.formatPrice(rawDesiredExit, tickSize)
                          : Number(rawDesiredExit);

                        try {
                          const res = await mgr.placeOrReplaceExitOrder(position, Number(desiredExitPrice));
                          logger.info(
                            `[TP Trail] ✅ Cross-entry exit order replaced (single-exit) | pos=${position.id} ` +
                            `desiredExit=${desiredExitPrice} pnl=${currentPnl} buffer=${(b * 100).toFixed(2)}% ` +
                            `orderType=${res?.orderType || 'n/a'} orderId=${res?.orderId || 'n/a'}`
                          );
                          placed = true;

                          // Persist new exit order id if returned
                          if (res?.orderId) {
                            try {
                              await Position.update(position.id, { exit_order_id: String(res.orderId) });
                            } catch (dbErr) {
                              logger.warn(`[TP Trail] Failed to persist exit_order_id (cross-entry) | pos=${position.id}: ${dbErr?.message || dbErr}`);
                            }
                          }

                          break;
                        } catch (e) {
                          const em = e?.message || e;
                          logger.warn(`[TP Trail] Cross-entry replace retry ${i + 1}/${buffers.length} failed | pos=${position.id} desiredExit=${desiredExitPrice} err=${em}`);
                          if (!isImmediateTriggerError(em)) break;
                        }
                      }

                      if (!placed) {
                        logger.warn(`[TP Trail] ⚠️ Cross-entry replace failed -> fallback MARKET close | pos=${position.id}`);
                        try {
                          await this.exchangeService.closePosition(position.symbol, position.side, position.amount);
                          logger.info(`[TP Trail] ✅ Cross-entry MARKET close sent | pos=${position.id}`);
                        } catch (e) {
                          logger.error(`[TP Trail] ❌ Cross-entry MARKET close failed | pos=${position.id}: ${e?.message || e}`);
                        }
                      }
                    } catch (e) {
                      logger.error(`[TP Trail] Error attempting cross-entry single-exit replace | pos=${position.id}: ${e?.message || e}`);
                    }
                  } catch (e) {
                    logger.error(`[TP Trail] Error attempting cross-entry exit | pos=${position.id}: ${e?.message || e}`);
                  }
                }
              } else {
                // Case 1: TP still in profit zone - continue using TAKE_PROFIT_LIMIT
                // Try to replace TP order, but continue even if it fails
                try {
                  logger.info(
                    `[TP Trail] 🔄 Attempting to replace TP order on exchange | pos=${position.id} ` +
                    `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} ` +
                    `exit_order_id=${position.exit_order_id || 'null'}`
                  );
                  await this._maybeReplaceTpOrder(position, prevTP, newTP, getCachedClosableQty);
                  logger.info(`[TP Trail] ✅ TP order replacement completed for position ${position.id}`);
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
      // IMPROVEMENT: Auto-release stuck locks (older than 5 minutes) to prevent blocking
      let lockAcquired = false;
      let useLock = true; // Flag to track if lock mechanism is available
      const lockTimeoutMs = 5 * 60 * 1000; // 5 minutes timeout for stuck locks
      
      try {
        const pool = (await import('../config/database.js')).default;
        
        // First, check and release any stuck locks (older than timeout)
        try {
          const [stuckLocks] = await pool.execute(
            `UPDATE positions 
             SET is_processing = 0 
             WHERE id = ? AND status = 'open' AND is_processing = 1 
               AND (updated_at IS NULL OR updated_at < DATE_SUB(NOW(), INTERVAL ? SECOND))
             LIMIT 1`,
            [position.id, lockTimeoutMs / 1000]
          );
          if (stuckLocks.affectedRows > 0) {
            logger.warn(
              `[PositionService] 🔓 Released stuck lock for position ${position.id} (${position.symbol}) ` +
              `(lock was older than ${lockTimeoutMs / 1000}s)`
            );
          }
        } catch (stuckLockError) {
          // Ignore errors when checking for stuck locks (column might not exist)
          logger.debug(`[PositionService] Could not check for stuck locks: ${stuckLockError?.message || stuckLockError}`);
        }
        
        // Try to acquire lock before updating
        const [lockResult] = await pool.execute(
          `UPDATE positions 
           SET is_processing = 1, updated_at = NOW()
           WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
           LIMIT 1`,
          [position.id]
        );
        lockAcquired = lockResult.affectedRows > 0;
        
        if (!lockAcquired) {
          // Another process is handling this position, skip update (non-blocking)
          logger.debug(
            `[PositionService] Position ${position.id} (${position.symbol}) is being processed by another instance, skipping update. ` +
            `This is normal behavior to prevent race conditions.`
          );
          return position; // Return original position without changes (non-blocking)
        }
      } catch (lockError) {
        // If is_processing column doesn't exist, proceed without lock (backward compatibility)
        const errorMsg = lockError?.message || String(lockError);
        if (errorMsg.includes("Unknown column 'is_processing'") || errorMsg.includes("is_processing")) {
          logger.debug(`[PositionService] Column 'is_processing' does not exist, proceeding without lock for position ${position.id}`);
          useLock = false; // Disable lock mechanism
          lockAcquired = false; // Don't try to release lock later
        } else {
          logger.debug(`[PositionService] Could not acquire lock for position ${position.id}: ${errorMsg}`);
          useLock = false; // Disable lock mechanism on other errors too
          lockAcquired = false;
        }
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
        // Always release lock if acquired (CRITICAL: prevents stuck locks)
        // Only try to release if lock mechanism is available (column exists)
        if (lockAcquired && useLock) {
          try {
            const pool = (await import('../config/database.js')).default;
            const [releaseResult] = await pool.execute(
              `UPDATE positions SET is_processing = 0 WHERE id = ?`,
              [position.id]
            );
            if (releaseResult.affectedRows === 0) {
              logger.debug(`[PositionService] Failed to release lock for position ${position.id}: no rows affected (position may not exist or already unlocked)`);
            }
          } catch (releaseError) {
            const errorMsg = releaseError?.message || String(releaseError);
            // If column doesn't exist, just log debug (not error) since we already know column is missing
            if (errorMsg.includes("Unknown column 'is_processing'") || errorMsg.includes("is_processing")) {
              logger.debug(`[PositionService] Column 'is_processing' does not exist, cannot release lock for position ${position.id} (this is expected if column was never created)`);
            } else {
              logger.warn(`[PositionService] ⚠️ Could not release lock for position ${position.id}: ${errorMsg}. Will auto-release on next check.`);
            }
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
   * CRITICAL FIX: For trailing TP, always update order (no threshold check) to ensure order follows TP movement
   */
  async _maybeReplaceTpOrder(position, prevTP, desiredTP, getCachedClosableQty) {
    try {
          const entryPrice = Number(position.entry_price || 0);
          const newTP = Number(desiredTP || 0);
          
          logger.debug(`[TP Replace] _maybeReplaceTpOrder called: pos=${position.id} prevTP=${prevTP.toFixed(8)} desiredTP=${newTP.toFixed(8)} entryPrice=${entryPrice.toFixed(8)} side=${position.side}`);
          
          // Note: TP→SL conversion is now handled in the main TP trail logic
          // This function only handles TP order replacement when TP is still in profit zone
          
          // CRITICAL FIX: For trailing TP, always update order if TP changed (even slightly)
          // This ensures order on exchange follows trailing TP movement every minute
          // Threshold check is only for manual TP updates, not for time-based trailing
          const isTrailingTP = Math.abs(newTP - prevTP) > 0; // Any change indicates trailing
          
          if (isTrailingTP && newTP > 0 && prevTP > 0) {
            const movedTP = Math.abs(newTP - prevTP);
            
            // For trailing TP, use minimal threshold (1 tick) to ensure order updates frequently
            const thresholdTicksTP = Number(configService.getNumber('TP_UPDATE_THRESHOLD_TICKS', 1));
            let tickSizeStrTP = exchangeInfoService.getTickSize(position.symbol);
            if (!tickSizeStrTP) {
              tickSizeStrTP = await this.exchangeService.getTickSize(position.symbol);
            }
            const tickTP = parseFloat(tickSizeStrTP || '0') || 0;
            const effectiveThreshold = thresholdTicksTP * tickTP;
            
            // For trailing TP, use very low minimum price change (0.01% instead of 0.1%)
            // This ensures order updates even with small trailing movements
            const minPriceChangePercent = Number(configService.getNumber('EXIT_ORDER_MIN_PRICE_CHANGE_PCT', 0.01)); // 0.01% for trailing
            const avgPrice = (newTP + prevTP) / 2;
            const minPriceChange = avgPrice * (minPriceChangePercent / 100);
            const priceChangePercent = (movedTP / avgPrice) * 100;
            
            logger.info(
              `[TP Replace] 🔍 Movement check (trailing) | pos=${position.id} ` +
              `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} ` +
              `movedTP=${movedTP.toFixed(8)} effectiveThreshold=${effectiveThreshold.toFixed(8)} ` +
              `minPriceChange=${minPriceChange.toFixed(8)} (${minPriceChangePercent}%) ` +
              `priceChangePercent=${priceChangePercent.toFixed(3)}% ` +
              `tickTP=${tickTP} thresholdTicksTP=${thresholdTicksTP}`
            );
            
            // Replace if movement >= 1 tick (minimal threshold for trailing)
            const tickThresholdMet = movedTP >= effectiveThreshold;
            const priceChangeThresholdMet = movedTP >= minPriceChange;
            
            logger.info(
              `[TP Replace] 🔍 Threshold check result | pos=${position.id} ` +
              `tickThresholdMet=${tickThresholdMet} (${movedTP.toFixed(8)} >= ${effectiveThreshold.toFixed(8)}) ` +
              `priceChangeThresholdMet=${priceChangeThresholdMet} (${movedTP.toFixed(8)} >= ${minPriceChange.toFixed(8)}) ` +
              `willReplace=${tickThresholdMet && priceChangeThresholdMet}`
            );
            
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
                    
                    logger.info(
                      `[TP Replace] 🚀 CALLING ExitOrderManager | pos=${position.id} ` +
                      `symbol=${position.symbol} side=${position.side} ` +
                      `newTP=${newTP.toFixed(8)} entryPrice=${entryPrice.toFixed(8)} ` +
                      `oldExitOrderId=${oldExitOrderId || 'null'} timestamp=${new Date().toISOString()}`
                    );
                    
                    if (position.side !== 'long' && position.side !== 'short') {
                      logger.error(
                        `[TP Replace] ⚠️ INVALID position.side: ${position.side} for position ${position.id}. ` +
                        `Expected 'long' or 'short'.`
                      );
                    }
                    
                    // ✅ Unified exit order: type switches based on profit/loss zone (STOP_MARKET <-> TAKE_PROFIT_MARKET)
                    const { ExitOrderManager } = await import('./ExitOrderManager.js');
                    const mgr = new ExitOrderManager(this.exchangeService);
                    const placed = await mgr.placeOrReplaceExitOrder(position, newTP);

                    const replaceEndTime = Date.now();
                    const replaceDuration = replaceEndTime - replaceStartTime;
                    const newExitOrderId = placed?.orderId ? String(placed.orderId) : null;
                    
                    logger.info(
                      `[TP Replace] ✅ ExitOrderManager returned | pos=${position.id} ` +
                      `newExitOrderId=${newExitOrderId || 'null'} oldExitOrderId=${oldExitOrderId || 'null'} ` +
                      `orderType=${placed?.orderType || 'n/a'} stopPrice=${placed?.stopPrice?.toFixed(8) || newTP.toFixed(8)} ` +
                      `replaceDuration=${replaceDuration}ms timestamp=${new Date().toISOString()}`
                    );

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
                    
                    logger.error(
                      `[TP Replace] ❌ FAILED: ExitOrderManager error | pos=${position.id} ` +
                      `newTP=${newTP.toFixed(8)} oldExitOrderId=${position.exit_order_id || 'null'} ` +
                      `replaceDuration=${replaceDuration}ms error=${tpError?.message || tpError} ` +
                      `stack=${tpError?.stack || 'N/A'} timestamp=${new Date().toISOString()}`
                    );
                    
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
              logger.warn(
                `[TP Replace] ⚠️ THRESHOLD NOT MET: Skipping TP order replacement | pos=${position.id} ` +
                `prevTP=${prevTP.toFixed(8)} newTP=${newTP.toFixed(8)} movedTP=${movedTP.toFixed(8)} ` +
                `effectiveThreshold=${effectiveThreshold.toFixed(8)} minPriceChange=${minPriceChange.toFixed(8)} ` +
                `tickThresholdMet=${tickThresholdMet} priceChangeThresholdMet=${priceChangeThresholdMet} ` +
                `priceChangePercent=${priceChangePercent.toFixed(3)}% ` +
                `(Order will NOT be replaced, but DB take_profit_price will be updated)`
              );
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
      
      // NEW: Calculate SL based on USDT amount (stoploss is now in USDT, not percentage)
      // Need quantity to calculate SL price
      let quantity = null;
      
      // Try to get quantity from exchange first (most accurate)
      try {
        quantity = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
      } catch (e) {
        logger.debug(`[calculateUpdatedStopLoss] Failed to get quantity from exchange: ${e?.message || e}`);
      }
      
      // Fallback: calculate quantity from amount and entry price
      if (!quantity || quantity <= 0) {
        const amount = Number(position.amount || 0);
        if (Number.isFinite(amount) && amount > 0 && Number.isFinite(entry) && entry > 0) {
          quantity = amount / entry;
          logger.debug(`[calculateUpdatedStopLoss] Calculated quantity from amount: ${quantity} (amount=${amount}, entry=${entry})`);
        }
      }
      
      if (!quantity || quantity <= 0) {
        logger.warn(`[calculateUpdatedStopLoss] Cannot get quantity for position ${position.id}, cannot calculate SL by amount`);
        return null;
      }
      
      // Calculate SL price based on USDT amount
      // stoploss is now in USDT (e.g., 100 = 100 USDT loss when SL hit)
      const initialSL = calculateInitialStopLossByAmount(entry, quantity, stoploss, position.side);
      
      if (initialSL === null || initialSL <= 0) {
        logger.warn(`[calculateUpdatedStopLoss] Calculated SL is invalid: ${initialSL} for position ${position.id} (entry=${entry}, quantity=${quantity}, stoploss=${stoploss} USDT)`);
        return null;
      }
      
      logger.debug(`[calculateUpdatedStopLoss] Calculated initial SL: ${initialSL} for position ${position.id} (entry=${entry}, quantity=${quantity}, stoploss=${stoploss} USDT, side=${position.side})`);
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

