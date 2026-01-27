import pool from '../config/database.js';
import logger from '../utils/logger.js';

export class PositionAdjustment {
  /**
   * Insert one adjustment row (safe if table not migrated yet).
   */
  static async create(row) {
    try {
      await pool.execute(
        'INSERT INTO position_adjustments (position_id, adjustment_type, old_value, new_value, reason, metadata) VALUES (?, ?, ?, ?, ?, ?)',
        [
          row.position_id,
          row.adjustment_type,
          row.old_value ?? null,
          row.new_value ?? null,
          row.reason ?? null,
          row.metadata ? JSON.stringify(row.metadata) : null
        ]
      );
    } catch (e) {
      if (String(e?.code) === 'ER_NO_SUCH_TABLE') return;
      logger.warn(`[PositionAdjustment] create failed: ${e?.message || e}`);
    }
  }
}
