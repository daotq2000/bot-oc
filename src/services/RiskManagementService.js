import logger from '../utils/logger.js';
import { configService } from './ConfigService.js';
import { calculatePnLPercent } from '../utils/calculator.js';

/**
 * Risk Management Service
 * 
 * Provides risk management features to protect capital and optimize profits:
 * - Move SL to breakeven when profit threshold is reached
 * - Trailing SL when profit is large
 * - Drawdown protection
 * - Consecutive losses protection
 */
export class RiskManagementService {
  constructor() {
    // Configurable thresholds
    this.breakevenProfitThreshold = Number(configService.getNumber('RISK_BREAKEVEN_PROFIT_THRESHOLD', 1.0)); // 1%
    this.trailingSLProfitThreshold = Number(configService.getNumber('RISK_TRAILING_SL_PROFIT_THRESHOLD', 2.0)); // 2%
    this.trailingSLPercent = Number(configService.getNumber('RISK_TRAILING_SL_PERCENT', 0.5)); // 0.5% trailing
    this.maxDrawdownPercent = Number(configService.getNumber('RISK_MAX_DRAWDOWN_PERCENT', 20.0)); // 20%
    this.maxConsecutiveLosses = Number(configService.getNumber('RISK_MAX_CONSECUTIVE_LOSSES', 5)); // 5 losses
  }

  /**
   * Check if SL should be moved to breakeven
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {Object} { shouldMove: boolean, newSL: number, reason: string }
   */
  shouldMoveSLToBreakeven(position, currentPrice) {
    try {
      const entryPrice = Number(position.entry_price);
      const currentSL = Number(position.stop_loss_price || 0);
      
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        return { shouldMove: false, reason: 'invalid_entry_price' };
      }
      
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return { shouldMove: false, reason: 'invalid_current_price' };
      }

      // Calculate PnL percentage
      const pnlPercent = calculatePnLPercent(entryPrice, currentPrice, position.side);
      
      // Check if profit threshold is reached
      if (pnlPercent < this.breakevenProfitThreshold) {
        return { shouldMove: false, reason: `profit_${pnlPercent.toFixed(2)}%_below_threshold_${this.breakevenProfitThreshold}%` };
      }

      // Check if SL is already at or better than breakeven
      const breakevenPrice = entryPrice;
      let isAlreadyAtBreakeven = false;
      
      if (position.side === 'long') {
        // LONG: SL should be >= entry (breakeven or better)
        isAlreadyAtBreakeven = currentSL >= breakevenPrice;
      } else {
        // SHORT: SL should be <= entry (breakeven or better)
        isAlreadyAtBreakeven = currentSL <= breakevenPrice && currentSL > 0;
      }

      if (isAlreadyAtBreakeven) {
        return { shouldMove: false, reason: 'sl_already_at_breakeven_or_better' };
      }

      // Move SL to breakeven
      logger.info(
        `[RiskManagement] ✅ Move SL to breakeven | pos=${position.id} symbol=${position.symbol} ` +
        `side=${position.side} pnl=${pnlPercent.toFixed(2)}% >= threshold=${this.breakevenProfitThreshold}% ` +
        `currentSL=${currentSL.toFixed(8)} → breakeven=${breakevenPrice.toFixed(8)}`
      );

      return {
        shouldMove: true,
        newSL: breakevenPrice,
        reason: `profit_${pnlPercent.toFixed(2)}%_reached_breakeven_threshold`
      };
    } catch (error) {
      logger.error(`[RiskManagement] Error checking breakeven SL: ${error?.message || error}`);
      return { shouldMove: false, reason: 'error', error: error?.message || error };
    }
  }

  /**
   * Calculate trailing SL when profit is large
   * @param {Object} position - Position object
   * @param {number} currentPrice - Current market price
   * @returns {Object} { shouldTrail: boolean, newSL: number, reason: string }
   */
  calculateTrailingSL(position, currentPrice) {
    try {
      const entryPrice = Number(position.entry_price);
      const currentSL = Number(position.stop_loss_price || 0);
      
      if (!Number.isFinite(entryPrice) || entryPrice <= 0) {
        return { shouldTrail: false, reason: 'invalid_entry_price' };
      }
      
      if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
        return { shouldTrail: false, reason: 'invalid_current_price' };
      }

      if (currentSL <= 0) {
        return { shouldTrail: false, reason: 'no_sl_set' };
      }

      // Calculate PnL percentage
      const pnlPercent = calculatePnLPercent(entryPrice, currentPrice, position.side);
      
      // Check if profit threshold is reached
      if (pnlPercent < this.trailingSLProfitThreshold) {
        return { shouldTrail: false, reason: `profit_${pnlPercent.toFixed(2)}%_below_threshold_${this.trailingSLProfitThreshold}%` };
      }

      // Calculate new trailing SL
      let newSL;
      if (position.side === 'long') {
        // LONG: SL = currentPrice * (1 - trailingPercent%)
        newSL = currentPrice * (1 - this.trailingSLPercent / 100);
        // Only move SL up, never down
        if (newSL < currentSL) {
          return { shouldTrail: false, reason: 'new_sl_would_be_lower_than_current' };
        }
      } else {
        // SHORT: SL = currentPrice * (1 + trailingPercent%)
        newSL = currentPrice * (1 + this.trailingSLPercent / 100);
        // Only move SL down, never up
        if (newSL > currentSL || newSL <= 0) {
          return { shouldTrail: false, reason: 'new_sl_would_be_higher_than_current' };
        }
      }

      // Check if new SL is significantly different (at least 0.1% change)
      const slChangePercent = Math.abs((newSL - currentSL) / currentSL) * 100;
      if (slChangePercent < 0.1) {
        return { shouldTrail: false, reason: `sl_change_${slChangePercent.toFixed(3)}%_too_small` };
      }

      logger.info(
        `[RiskManagement] ✅ Trailing SL | pos=${position.id} symbol=${position.symbol} ` +
        `side=${position.side} pnl=${pnlPercent.toFixed(2)}% >= threshold=${this.trailingSLProfitThreshold}% ` +
        `currentSL=${currentSL.toFixed(8)} → newSL=${newSL.toFixed(8)} (trailing=${this.trailingSLPercent}%)`
      );

      return {
        shouldTrail: true,
        newSL: newSL,
        reason: `profit_${pnlPercent.toFixed(2)}%_trailing_${this.trailingSLPercent}%`
      };
    } catch (error) {
      logger.error(`[RiskManagement] Error calculating trailing SL: ${error?.message || error}`);
      return { shouldTrail: false, reason: 'error', error: error?.message || error };
    }
  }

  /**
   * Check drawdown protection
   * @param {number} accountBalance - Current account balance
   * @param {number} initialBalance - Initial/peak account balance
   * @returns {Object} { reducePositionSize: number, pauseTrading: boolean, drawdown: number }
   */
  checkDrawdownProtection(accountBalance, initialBalance) {
    try {
      const balance = Number(accountBalance);
      const initial = Number(initialBalance);
      
      if (!Number.isFinite(balance) || !Number.isFinite(initial) || initial <= 0) {
        return { reducePositionSize: 1.0, pauseTrading: false, drawdown: 0, reason: 'invalid_balance' };
      }

      const drawdown = ((initial - balance) / initial) * 100;
      
      // Critical drawdown: >= 30% → pause trading
      if (drawdown >= this.maxDrawdownPercent * 1.5) {
        logger.warn(
          `[RiskManagement] 🚨 CRITICAL DRAWDOWN: ${drawdown.toFixed(2)}% >= ${(this.maxDrawdownPercent * 1.5).toFixed(2)}% → PAUSING TRADING`
        );
        return {
          reducePositionSize: 0,
          pauseTrading: true,
          drawdown: drawdown,
          reason: `critical_drawdown_${drawdown.toFixed(2)}%`
        };
      }
      
      // High drawdown: >= 20% → reduce position size 50%
      if (drawdown >= this.maxDrawdownPercent) {
        logger.warn(
          `[RiskManagement] ⚠️ HIGH DRAWDOWN: ${drawdown.toFixed(2)}% >= ${this.maxDrawdownPercent}% → REDUCING POSITION SIZE 50%`
        );
        return {
          reducePositionSize: 0.5,
          pauseTrading: false,
          drawdown: drawdown,
          reason: `high_drawdown_${drawdown.toFixed(2)}%`
        };
      }
      
      // Moderate drawdown: >= 14% → reduce position size 30%
      if (drawdown >= this.maxDrawdownPercent * 0.7) {
        logger.info(
          `[RiskManagement] ⚠️ MODERATE DRAWDOWN: ${drawdown.toFixed(2)}% >= ${(this.maxDrawdownPercent * 0.7).toFixed(2)}% → REDUCING POSITION SIZE 30%`
        );
        return {
          reducePositionSize: 0.7,
          pauseTrading: false,
          drawdown: drawdown,
          reason: `moderate_drawdown_${drawdown.toFixed(2)}%`
        };
      }
      
      return {
        reducePositionSize: 1.0,
        pauseTrading: false,
        drawdown: drawdown,
        reason: 'normal'
      };
    } catch (error) {
      logger.error(`[RiskManagement] Error checking drawdown: ${error?.message || error}`);
      return { reducePositionSize: 1.0, pauseTrading: false, drawdown: 0, reason: 'error', error: error?.message || error };
    }
  }

  /**
   * Check consecutive losses protection
   * @param {number} consecutiveLosses - Number of consecutive losses
   * @returns {Object} { pauseTrading: boolean, reducePositionSize: number }
   */
  checkConsecutiveLosses(consecutiveLosses) {
    try {
      const losses = Number(consecutiveLosses);
      
      if (!Number.isFinite(losses) || losses < 0) {
        return { pauseTrading: false, reducePositionSize: 1.0, reason: 'invalid_losses_count' };
      }

      // Critical: >= 5 losses → pause trading
      if (losses >= this.maxConsecutiveLosses) {
        logger.warn(
          `[RiskManagement] 🚨 CRITICAL: ${losses} consecutive losses >= ${this.maxConsecutiveLosses} → PAUSING TRADING`
        );
        return {
          pauseTrading: true,
          reducePositionSize: 0.5,
          reason: `critical_losses_${losses}`
        };
      }
      
      // Warning: >= 3 losses → reduce position size
      if (losses >= this.maxConsecutiveLosses * 0.6) {
        const threshold = Math.floor(this.maxConsecutiveLosses * 0.6);
        logger.warn(
          `[RiskManagement] ⚠️ WARNING: ${losses} consecutive losses >= ${threshold} → REDUCING POSITION SIZE 30%`
        );
        return {
          pauseTrading: false,
          reducePositionSize: 0.7,
          reason: `warning_losses_${losses}`
        };
      }
      
      return {
        pauseTrading: false,
        reducePositionSize: 1.0,
        reason: 'normal'
      };
    } catch (error) {
      logger.error(`[RiskManagement] Error checking consecutive losses: ${error?.message || error}`);
      return { pauseTrading: false, reducePositionSize: 1.0, reason: 'error', error: error?.message || error };
    }
  }
}

export const riskManagementService = new RiskManagementService();

