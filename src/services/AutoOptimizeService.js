import { configService } from './ConfigService.js';
import logger from '../utils/logger.js';
import pool from '../config/database.js';

/**
 * AutoOptimizeService
 * Lightweight "online" optimizer that adjusts advanced settings defaults per strategy
 * based on recent closed positions (no ML; just heuristics).
 *
 * Enabled only when ADV_TPSL_AUTO_OPTIMIZE_ENABLED=true AND settings.auto_optimize_enabled=true.
 * Throttled per strategy.
 */
export class AutoOptimizeService {
  constructor() {
    this._lastRun = new Map(); // strategyId -> ts
  }

  async maybeOptimize(strategyId) {
    const globalEnabled = configService.getBoolean('ADV_TPSL_AUTO_OPTIMIZE_ENABLED', false);
    if (!globalEnabled) return { ran: false };

    const everyMs = Number(configService.getNumber('ADV_TPSL_AUTO_OPTIMIZE_EVERY_MS', 60 * 60 * 1000)); // 1h
    const now = Date.now();
    const last = this._lastRun.get(strategyId) || 0;
    if (now - last < everyMs) return { ran: false };
    this._lastRun.set(strategyId, now);

    const limit = Number(configService.getNumber('ADV_TPSL_AUTO_OPTIMIZE_LOOKBACK', 200));
    try {
      const [rows] = await pool.execute(
        `SELECT COALESCE(p.pnl,0) AS pnl, COALESCE(p.entry_price,0) AS entry_price, COALESCE(p.close_price,0) AS close_price
         FROM positions p
         WHERE p.strategy_id = ? AND p.status='closed'
         ORDER BY p.closed_at DESC
         LIMIT ${Math.max(20, limit)}`,
        [strategyId]
      );
      if (!rows || rows.length < 20) return { ran: false, reason: 'not_enough_history' };

      const pnls = rows.map(r => Number(r.pnl || 0));
      const wins = pnls.filter(x => x > 0).length;
      const loses = pnls.filter(x => x < 0).length;
      const total = pnls.length;
      const winRate = total > 0 ? wins / total : 0;
      const avgWin = wins > 0 ? pnls.filter(x => x > 0).reduce((a, b) => a + b, 0) / wins : 0;
      const avgLoss = loses > 0 ? pnls.filter(x => x < 0).reduce((a, b) => a + b, 0) / loses : 0;

      // Heuristic:
      // - Low win rate -> earlier break-even + earlier partials
      // - High win rate -> allow more room (later break-even) and larger TP multiplier
      let breakEvenPct = 1.5;
      let partialLevels = [
        { pct: 1.0, close_pct: 30 },
        { pct: 2.0, close_pct: 30 }
      ];
      let atrTpMult = 2.5;
      let atrSlMult = 1.5;

      if (winRate < 0.35) {
        breakEvenPct = 0.9;
        partialLevels = [
          { pct: 0.7, close_pct: 35 },
          { pct: 1.4, close_pct: 35 }
        ];
        atrTpMult = 2.2;
        atrSlMult = 1.3;
      } else if (winRate < 0.5) {
        breakEvenPct = 1.2;
        partialLevels = [
          { pct: 0.9, close_pct: 30 },
          { pct: 1.8, close_pct: 30 }
        ];
        atrTpMult = 2.4;
        atrSlMult = 1.4;
      } else if (winRate > 0.65) {
        breakEvenPct = 1.8;
        partialLevels = [
          { pct: 1.2, close_pct: 25 },
          { pct: 2.4, close_pct: 25 }
        ];
        atrTpMult = 2.8;
        atrSlMult = 1.6;
      }

      // Persist into strategy_advanced_settings if table exists.
      // We only update a small set of parameters to keep it safe.
      await pool.execute(
        `UPDATE strategy_advanced_settings
         SET break_even_pct = ?, partial_tp_levels = ?, atr_multiplier_tp = ?, atr_multiplier_sl = ?, updated_at = CURRENT_TIMESTAMP
         WHERE strategy_id = ?`,
        [breakEvenPct, JSON.stringify(partialLevels), atrTpMult, atrSlMult, strategyId]
      );

      logger.info(
        `[ADV_TPSL][AutoOptimize] strategy=${strategyId} winRate=${(winRate*100).toFixed(1)}% ` +
        `avgWin=${avgWin.toFixed(3)} avgLoss=${avgLoss.toFixed(3)} -> bePct=${breakEvenPct} atrTp=${atrTpMult} atrSl=${atrSlMult}`
      );

      return { ran: true, winRate, avgWin, avgLoss };
    } catch (e) {
      // Missing table should not crash bot.
      if (String(e?.code) === 'ER_NO_SUCH_TABLE') return { ran: false, reason: 'no_table' };
      logger.warn(`[ADV_TPSL][AutoOptimize] failed: ${e?.message || e}`);
      return { ran: false, reason: 'error' };
    }
  }
}


