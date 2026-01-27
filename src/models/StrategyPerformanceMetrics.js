import pool from '../config/database.js';
import logger from '../utils/logger.js';

export class StrategyPerformanceMetrics {
  static async upsert({ strategy_id, symbol = null, timeframe = null, ...data }) {
    try {
      // Use INSERT ... ON DUPLICATE KEY UPDATE (unique: strategy_id,symbol,timeframe)
      const fields = Object.keys(data);
      const assignments = fields.map(f => `\`${f}\`=VALUES(\`${f}\`)`).join(', ');
      const sql =
        `INSERT INTO strategy_performance_metrics (\`strategy_id\`, \`symbol\`, \`timeframe\`${fields.length ? ', ' + fields.map(f => `\`${f}\``).join(', ') : ''})
         VALUES (?, ?, ?${fields.length ? ', ' + fields.map(_ => '?').join(', ') : ''})
         ON DUPLICATE KEY UPDATE ${assignments || 'last_updated=CURRENT_TIMESTAMP'}`;

      const params = [strategy_id, symbol, timeframe, ...fields.map(f => data[f])];
      await pool.execute(sql, params);
    } catch (e) {
      if (String(e?.code) === 'ER_NO_SUCH_TABLE') return;
      logger.warn(`[StrategyPerformanceMetrics] upsert failed: ${e?.message || e}`);
    }
  }
}
