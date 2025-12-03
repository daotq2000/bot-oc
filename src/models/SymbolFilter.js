import pool from '../config/database.js';

/**
 * SymbolFilter model
 */
export class SymbolFilter {
  /**
   * Get all filters from the database
   * @returns {Promise<Array>}
   */
  static async findAll() {
    const [rows] = await pool.execute('SELECT * FROM symbol_filters');
    return rows;
  }

  /**
   * Bulk insert or update symbol filters.
   * This is more efficient than doing it one by one.
   * @param {Array} filters - Array of filter objects
   * @returns {Promise<void>}
   */
  static async bulkUpsert(filters) {
    if (filters.length === 0) return;

    const values = [];
    const placeholders = [];

    for (const filter of filters) {
      placeholders.push('(?, ?, ?, ?, ?)');
      values.push(
        filter.exchange,
        filter.symbol,
        filter.tick_size,
        filter.step_size,
        filter.min_notional
      );
    }

    const sql = `
      INSERT INTO symbol_filters (exchange, symbol, tick_size, step_size, min_notional)
      VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE
        tick_size = VALUES(tick_size),
        step_size = VALUES(step_size),
        min_notional = VALUES(min_notional),
        updated_at = NOW()
    `;

    await pool.execute(sql, values);
  }
}
