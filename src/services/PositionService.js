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
      // PRIORITY CHECK 1: Check order status from WebSocket cache (no REST API call)
      // This detects when TP/SL orders are filled via WebSocket ORDER_TRADE_UPDATE events
      if (position.exit_order_id) {
        // Get exchange from exchangeService (fallback to 'binance' for backward compatibility)
        // CRITICAL FIX: Normalize exchange name to lowercase to match cache key format
        const exchange = (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
        const cachedTpStatus = orderStatusCache.getOrderStatus(position.exit_order_id, exchange);
        
        // Debug logging for cache miss
        if (!cachedTpStatus) {
          logger.debug(`[TP/SL Check] TP order ${position.exit_order_id} for position ${position.id} not found in cache (exchange: ${exchange})`);
        }
        // CRITICAL FIX: _normalizeStatus() returns 'closed' for FILLED, not 'FILLED'
        if (cachedTpStatus && cachedTpStatus.status === 'closed') {
          // TP order has been filled - position is already closed on exchange
          logger.info(`[TP/SL Check] TP order ${position.exit_order_id} for position ${position.id} filled (from WebSocket cache). Closing position in DB.`);
          
          // Get fill price from cache or current price
          const fillPrice = cachedTpStatus.avgPrice || await this.exchangeService.getTickerPrice(position.symbol);
          const currentPrice = fillPrice || await this.exchangeService.getTickerPrice(position.symbol);
          
          if (currentPrice) {
            const pnl = calculatePnL(
              position.entry_price,
              currentPrice,
              position.amount,
              position.side
            );
            return await this.closePosition(position, currentPrice, pnl, 'tp_hit');
          }
        }
      }

      if (position.sl_order_id) {
        // Get exchange from exchangeService (fallback to 'binance' for backward compatibility)
        // CRITICAL FIX: Normalize exchange name to lowercase to match cache key format
        const exchange = (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
        const cachedSlStatus = orderStatusCache.getOrderStatus(position.sl_order_id, exchange);
        
        // Debug logging for cache miss
        if (!cachedSlStatus) {
          logger.debug(`[TP/SL Check] SL order ${position.sl_order_id} for position ${position.id} not found in cache (exchange: ${exchange})`);
        }
        // CRITICAL FIX: _normalizeStatus() returns 'closed' for FILLED, not 'FILLED'
        if (cachedSlStatus && cachedSlStatus.status === 'closed') {
          // SL order has been filled - position is already closed on exchange
          logger.info(`[TP/SL Check] SL order ${position.sl_order_id} for position ${position.id} filled (from WebSocket cache). Closing position in DB.`);
          
          // Get fill price from cache or current price
          const fillPrice = cachedSlStatus.avgPrice || await this.exchangeService.getTickerPrice(position.symbol);
          const currentPrice = fillPrice || await this.exchangeService.getTickerPrice(position.symbol);
          
          if (currentPrice) {
            const pnl = calculatePnL(
              position.entry_price,
              currentPrice,
              position.amount,
              position.side
            );
            return await this.closePosition(position, currentPrice, pnl, 'sl_hit');
          }
        }
      }

      // PRIORITY CHECK 2: Check if position has been closed on exchange (no exposure)
      // This detects when position is closed on exchange but DB still shows 'open'
      // Only check if WebSocket cache doesn't have the order status (fallback)
      try {
        const closableQty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
        if (!closableQty || closableQty <= 0) {
          // Position has no exposure on exchange - it's already closed
          // Check cache first, then fallback to REST API only if cache miss
          let closeReason = 'closed_on_exchange';
          
          // Get exchange from exchangeService (fallback to 'binance' for backward compatibility)
          // CRITICAL FIX: Normalize exchange name to lowercase to match cache key format
          const exchange = (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
          
          if (position.exit_order_id) {
            const cachedTpStatus = orderStatusCache.getOrderStatus(position.exit_order_id, exchange);
            // CRITICAL FIX: _normalizeStatus() returns 'closed' for FILLED, not 'FILLED'
            if (cachedTpStatus?.status === 'closed') {
              closeReason = 'tp_hit';
            } else {
              // Fallback to REST API only if cache miss
              try {
                const tpOrderStatus = await this.exchangeService.getOrderStatus(position.symbol, position.exit_order_id);
                if (tpOrderStatus?.status === 'closed' || tpOrderStatus?.status === 'FILLED') {
                  closeReason = 'tp_hit';
                  // Update cache for future use
                  orderStatusCache.updateOrderStatus(position.exit_order_id, {
                    status: tpOrderStatus.status,
                    filled: tpOrderStatus.filled || 0,
                    avgPrice: tpOrderStatus.raw?.avgPrice || null,
                    symbol: position.symbol
                  }, exchange);
                }
              } catch (e) {
                logger.debug(`[TP/SL Check] Failed to check TP order via REST API: ${e?.message || e}`);
              }
            }
          }
          
          if (position.sl_order_id && closeReason !== 'tp_hit') {
            const cachedSlStatus = orderStatusCache.getOrderStatus(position.sl_order_id, exchange);
            // CRITICAL FIX: _normalizeStatus() returns 'closed' for FILLED, not 'FILLED'
            if (cachedSlStatus?.status === 'closed') {
              closeReason = 'sl_hit';
            } else {
              // Fallback to REST API only if cache miss
              try {
                const slOrderStatus = await this.exchangeService.getOrderStatus(position.symbol, position.sl_order_id);
                if (slOrderStatus?.status === 'closed' || slOrderStatus?.status === 'FILLED') {
                  closeReason = 'sl_hit';
                  // Update cache for future use
                  orderStatusCache.updateOrderStatus(position.sl_order_id, {
                    status: slOrderStatus.status,
                    filled: slOrderStatus.filled || 0,
                    avgPrice: slOrderStatus.raw?.avgPrice || null,
                    symbol: position.symbol
                  }, exchange);
                }
              } catch (e) {
                logger.debug(`[TP/SL Check] Failed to check SL order via REST API: ${e?.message || e}`);
              }
            }
          }
          
          const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
          if (currentPrice) {
            const pnl = calculatePnL(
              position.entry_price,
              currentPrice,
              position.amount,
              position.side
            );
            logger.info(`[TP/SL Check] Position ${position.id} has no exposure on exchange (already closed). Closing in DB with reason: ${closeReason}`);
            return await this.closePosition(position, currentPrice, pnl, closeReason);
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
      
      const prevMinutes = Number(position.minutes_elapsed || 0);
      let actualMinutesElapsed;
      
      if (useTimeBasedCalculation) {
        const now = Date.now();
        actualMinutesElapsed = Math.floor((now - openedAt) / (60 * 1000)); // Minutes since position opened
        logger.debug(`[TP Trail] pos=${position.id} Timing check: opened_at=${position.opened_at} openedAt=${openedAt} now=${now} actualMinutesElapsed=${actualMinutesElapsed} prevMinutes=${prevMinutes} timeDiff=${now - openedAt}ms (${Math.floor((now - openedAt) / 1000)}s)`);
        
        // Only update TP if actual minutes have increased (ensures exactly once per minute)
        if (actualMinutesElapsed <= prevMinutes) {
          logger.debug(`[TP Trail] pos=${position.id} actualMinutes=${actualMinutesElapsed} <= prevMinutes=${prevMinutes}, skipping TP trail (not yet time for next step)`);
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
        
        // WARN if downtime detected (more than 5 minutes skipped)
        if (actualMinutesElapsed - prevMinutes > 5) {
          logger.warn(
            `[TP Trail] ⚠️ Downtime detected for position ${position.id}: ` +
            `prevMinutes=${prevMinutes}, actualMinutes=${Math.floor((now - openedAt) / (60 * 1000))}, ` +
            `skipped=${Math.floor((now - openedAt) / (60 * 1000)) - prevMinutes} minutes. ` +
            `Processing only 1 minute to prevent large TP jumps.`
          );
        }
        
        logger.debug(`[TP Trail] pos=${position.id} Proceeding with TP trail: actualMinutes=${Math.floor((now - openedAt) / (60 * 1000))} > prevMinutes=${prevMinutes}, processing ${minutesToProcess} minute(s), targetMinutes=${actualMinutesElapsed}`);
      } else {
        // Fallback: increment-based calculation
        actualMinutesElapsed = prevMinutes + 1;
        logger.debug(`[TP Trail] pos=${position.id} Using increment-based calculation: prevMinutes=${prevMinutes} -> actualMinutesElapsed=${actualMinutesElapsed}`);
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
            // Use stored initial_tp_price (set when position was opened)
            let initialTP = Number(position.initial_tp_price || 0);
            
            // If initial_tp_price is not set (old positions), calculate and save it
            if (!Number.isFinite(initialTP) || initialTP <= 0) {
              const entryPriceForTP = Number(position.entry_price || 0);
              const oc = Number(position.oc || 0);
              const takeProfit = Number(position.take_profit || 0);
              
              if (entryPriceForTP > 0 && takeProfit > 0) {
                // Calculate initial TP from strategy (same calculation as placeTpSlOrders)
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
            
            // Calculate next TP: trails from initial TP towards entry
            // Trailing is TIME-BASED ONLY (not price-based) for predictable behavior
            const newTP = calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, trailingPercent, position.side, minutesElapsed);
            
            logger.debug(
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
              
              logger.debug(`[TP Trail] TP ${newTP.toFixed(2)} crossed entry ${entryPrice.toFixed(2)} for ${position.side} position ${position.id}. Distance from market: ${distancePercent.toFixed(3)}%`);
              
              // Configurable threshold for market close (default 0.5%)
              const marketCloseThreshold = Number(configService.getNumber('TRAILING_MARKET_CLOSE_THRESHOLD', 0.5));
              
              if (distancePercent <= marketCloseThreshold) {
                // Too close to market - close position immediately
                logger.warn(`[TP Trail] TP too close to market (${distancePercent.toFixed(3)}% <= ${marketCloseThreshold}%). Closing position ${position.id} by MARKET order.`);
                try {
                  const qty = await getCachedClosableQty();
                  if (qty > 0) {
                    await this.exchangeService.closePosition(position.symbol, position.side, qty);
                    await this.closePosition(position, marketPrice, pnl, 'trailing_exit');
                    logger.debug(`[TP Trail] Closed position ${position.id} by MARKET order (TP too close to market)`);
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
              // Try to replace TP order, but continue even if it fails
              try {
                await this._maybeReplaceTpOrder(position, prevTP, newTP, getCachedClosableQty);
              } catch (replaceError) {
                logger.warn(`[TP Trail] Failed to replace TP order for position ${position.id}: ${replaceError?.message || replaceError}. Continuing with TP price update.`);
              }
              
              // Always update take_profit_price in DB (minutes_elapsed will be updated at the end)
              // This ensures trailing TP works even if order replacement fails
              await Position.update(position.id, { 
                take_profit_price: newTP
                // NOTE: minutes_elapsed will be updated in final updatePayload below to avoid double update
              });
              logger.debug(`[TP Trail] ✅ Updated position ${position.id}: take_profit_price=${newTP.toFixed(2)} (prev=${prevTP.toFixed(2)})`);
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
        const { pool } = await import('../config/database.js');
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
            const { pool } = await import('../config/database.js');
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
              if (position.exit_order_id) {
                try {
                  await this.exchangeService.cancelOrder(position.exit_order_id, position.symbol);
                  logger.debug(`[TP Replace] Cancelled old TP order ${position.exit_order_id} for position ${position.id}`);
                } catch (e) {
                  logger.warn(`[TP Replace] Failed to cancel old TP order ${position.exit_order_id}: ${e?.message || e}`);
                }
              }
              
              // Delay before creating new TP order to avoid rate limits
              const delayMs = configService.getNumber('TP_SL_PLACEMENT_DELAY_MS', 10000);
              if (delayMs > 0) {
                logger.debug(`[TP Replace] Waiting ${delayMs}ms before placing new TP order for position ${position.id}...`);
                await new Promise(resolve => setTimeout(resolve, delayMs));
              }
              
              const qty = getCachedClosableQty ? await getCachedClosableQty() : await this.exchangeService.getClosableQuantity(position.symbol, position.side);
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
                
                if (isValidTP) {
                  try {
                    // Debug logging to verify position.side is correct
                    logger.debug(`[TP Replace] Creating TP order: position.id=${position.id}, position.side=${position.side}, symbol=${position.symbol}, newTP=${newTP.toFixed(8)}, entryPrice=${entryPrice.toFixed(8)}`);
                    if (position.side !== 'long' && position.side !== 'short') {
                      logger.error(`[TP Replace] ⚠️ Invalid position.side value: ${position.side} for position ${position.id}. Expected 'long' or 'short'.`);
                    }
                    // ✅ Unified exit order: type switches based on profit/loss zone (STOP_MARKET <-> TAKE_PROFIT_MARKET)
                    const { ExitOrderManager } = await import('./ExitOrderManager.js');
                    const mgr = new ExitOrderManager(this.exchangeService);
                    const placed = await mgr.placeOrReplaceExitOrder(position, newTP);

                    const newExitOrderId = placed?.orderId ? String(placed.orderId) : null;
                    const updatePayload = {
                      take_profit_price: newTP,
                      tp_synced: newExitOrderId ? true : false // Track if exit order was successfully placed
                    };
                    if (newExitOrderId) updatePayload.exit_order_id = newExitOrderId;
                    await Position.update(position.id, updatePayload);
                    logger.debug(`[TP Replace] ✅ Placed new EXIT (${placed?.orderType || 'n/a'}) ${newExitOrderId || ''} @ stop=${placed?.stopPrice ?? newTP} for position ${position.id} (tp_synced=${updatePayload.tp_synced})`);
                  } catch (tpError) {
                    // If TP order creation fails, still update take_profit_price in DB
                    // This allows trailing TP to continue working even if orders can't be placed
                    // Mark as not synced so PositionMonitor can retry later
                    logger.warn(`[TP Replace] ⚠️ Failed to place TP order @ ${newTP} for position ${position.id}: ${tpError?.message || tpError}. Updating TP price in DB only (tp_synced=false).`);
                    await Position.update(position.id, { 
                      take_profit_price: newTP,
                      tp_synced: false // Mark as not synced for retry
                    });
                    logger.debug(`[TP Replace] Updated TP price in DB to ${newTP} for position ${position.id} (order not placed, will retry)`);
                  }
                } else {
                  logger.debug(`[TP Replace] TP ${newTP} is invalid for LONG position (must be >= entry ${entryPrice}), skipping TP order creation (will be handled by SL conversion)`);
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

      // Pre-check: ensure there is exposure to close on exchange
      let hasExposure = false;
      try {
        const qty = await this.exchangeService.getClosableQuantity(position.symbol, position.side);
        hasExposure = qty && qty > 0;
        
        if (!hasExposure) {
          logger.warn(`[CloseGuard] Position ${position.id} (${position.symbol}) has no exchange exposure - closing in DB only`);
          // Don't return - continue to close in DB
        }
      } catch (e) {
        logger.warn(`[CloseGuard] Unable to verify exchange exposure for position ${position.id}: ${e?.message || e}`);
        // Continue to close in DB anyway
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
   * Convert TP order to STOP_LIMIT order when TP crosses entry
   * @param {Object} position - Position object
   * @param {number} newTP - New TP price (which has crossed entry)
   */
  async _convertTpToStopLimit(position, newTP) {
    // ❗IMPORTANT CHANGE (duplicate-TP fix):
    // Previously, when trailing TP crossed entry, we converted the TP into a STOP_LIMIT (SL) order.
    // This created 2 different "take profit"-like closing orders on Binance UI (TAKE_PROFIT + STOP),
    // and could lead to conflicts / duplicates.
    //
    // New behavior:
    // - We DO NOT create any STOP/STOP_LIMIT order here.
    // - We simply cancel the existing TP order (if any).
    // - Then we rely on the existing market-close path in the caller when TP gets close to market,
    //   or PositionMonitor/SL logic if stoploss is enabled.
    try {
      logger.warn(
        `[TP->SL Convert] Disabled STOP_LIMIT conversion to avoid duplicate TP orders. ` +
        `Will cancel existing TP order only. position=${position.id} newTP=${Number(newTP).toFixed(2)}`
      );

      if (position.exit_order_id) {
        try {
          await this.exchangeService.cancelOrder(position.exit_order_id, position.symbol);
          logger.info(`[TP->SL Convert] Cancelled TP order ${position.exit_order_id} for position ${position.id}`);
        } catch (e) {
          logger.warn(`[TP->SL Convert] Failed to cancel TP order ${position.exit_order_id}: ${e?.message || e}`);
        }
      }

      // Clear TP order id in DB to prevent any further replacement attempts using the old id.
      await Position.update(position.id, {
        exit_order_id: null,
        tp_synced: false, // mark not synced so monitor can decide what to do next
        take_profit_price: newTP // keep for tracking / trailing state
      });
    } catch (e) {
      logger.error(`[TP->SL Convert] Error in disabled conversion handler: ${e?.message || e}`);
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

