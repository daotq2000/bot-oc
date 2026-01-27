import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * StrategyAdvancedSettings model (raw SQL style, consistent with other models).
 * Table: strategy_advanced_settings
 */
export class StrategyAdvancedSettings {
  static defaults() {
    return {
      enabled: true,
      // 1) ATR + trailing
      atr_enabled: true,
      atr_period: 14,
      atr_timeframe: '1h',
      atr_multiplier_tp: 2.5,
      atr_multiplier_sl: 1.5,
      trailing_stop_enabled: true,
      trailing_lock_in_ratio: 0.5, // 50% of move toward TP

      // 2) Break-even
      break_even_enabled: true,
      break_even_pct: 1.5,
      break_even_buffer_pct: 0.1,

      // 3) Partial TP
      partial_tp_enabled: true,
      partial_tp_levels: [
        { pct: 1.0, close_pct: 30 },
        { pct: 2.0, close_pct: 30 }
      ],

      // 4) Risk/Reward
      rr_enabled: true,
      min_rr_ratio: 2.0,

      // 5) Volume profile
      volume_profile_enabled: true,
      volume_ma_period: 20,
      volume_spike_multiplier: 2.0,
      volume_drop_multiplier: 0.5,

      // 6) Support/Resistance
      sr_enabled: true,
      sr_lookback_period: 50,

      // 7) Low volatility exit
      low_volatility_exit_enabled: false, // safer default
      atr_low_threshold_pct: 0.25, // ATR/price (%)

      // 8) Multi-timeframe
      multi_timeframe_enabled: false,
      mtf_timeframes: ['1h', '4h'],

      // 9) Consecutive losses
      loss_streak_enabled: false,
      max_consecutive_losses: 3,

      // 10) Backtest optimization
      auto_optimize_enabled: false
    };
  }

  static async getByStrategyId(strategyId) {
    try {
      const [rows] = await pool.execute(
        'SELECT * FROM strategy_advanced_settings WHERE strategy_id = ? LIMIT 1',
        [strategyId]
      );
      const row = rows?.[0] || null;
      if (!row) return null;

      // Normalize JSON columns if present
      let partialLevels = row.partial_tp_levels;
      try {
        if (typeof partialLevels === 'string') partialLevels = JSON.parse(partialLevels);
      } catch (_) {}

      return {
        ...this.defaults(),
        ...row,
        partial_tp_levels: Array.isArray(partialLevels) ? partialLevels : this.defaults().partial_tp_levels
      };
    } catch (e) {
      // Missing table: just fallback to defaults (safe)
      if (String(e?.code) === 'ER_NO_SUCH_TABLE') return this.defaults();
      logger.warn(`[StrategyAdvancedSettings] getByStrategyId failed: ${e?.message || e}`);
      return this.defaults();
    }
  }
}
