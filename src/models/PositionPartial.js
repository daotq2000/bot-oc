import pool from '../config/database.js';
import logger from '../utils/logger.js';

export class PositionPartial {
  static async getExecutedLevels(positionId) {
    try {
      const [rows] = await pool.execute(
        'SELECT close_pct FROM position_partials WHERE position_id = ?',
        [positionId]
      );
      return (rows || []).map(r => Number(r.close_pct)).filter(v => Number.isFinite(v));
    } catch (e) {
      if (String(e?.code) === 'ER_NO_SUCH_TABLE') return [];
      logger.warn(`[PositionPartial] getExecutedLevels failed: ${e?.message || e}`);
      return [];
    }
  }

  static async create(row) {
    try {
      await pool.execute(
        'INSERT INTO position_partials (position_id, close_price, close_amount, close_pct, pnl, pnl_pct, reason) VALUES (?, ?, ?, ?, ?, ?, ?)',
        [
          row.position_id,
          row.close_price,
          row.close_amount,
          row.close_pct,
          row.pnl ?? null,
          row.pnl_pct ?? null,
          row.reason ?? null
        ]
      );
    } catch (e) {
      if (String(e?.code) === 'ER_NO_SUCH_TABLE') return;
      logger.warn(`[PositionPartial] create failed: ${e?.message || e}`);
    }
  }
}
