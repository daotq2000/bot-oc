import pool from '../config/database.js';

/**
 * SymbolFilter model
 */
export class SymbolFilter {
  /**
   * Get all filters from the database
   * @returns {Promise<Array>}
   */
  static async findAll({ includeDeleted = false } = {}) {
    const sql = includeDeleted
      ? 'SELECT * FROM symbol_filters'
      : 'SELECT * FROM symbol_filters WHERE deleted = FALSE';
    const [rows] = await pool.execute(sql);
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
      placeholders.push('(?, ?, ?, ?, ?, ?, ?)');
      values.push(
        filter.exchange,
        filter.symbol,
        filter.tick_size,
        filter.step_size,
        filter.min_notional,
        filter.max_leverage || 125,
        false // deleted = false
      );
    }

    const sql = `
      INSERT INTO symbol_filters (exchange, symbol, tick_size, step_size, min_notional, max_leverage, deleted)
      VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE
        tick_size = VALUES(tick_size),
        step_size = VALUES(step_size),
        min_notional = VALUES(min_notional),
        max_leverage = VALUES(max_leverage),
        deleted = VALUES(deleted),
        updated_at = NOW()
    `;

    await pool.execute(sql, values);
  }

  /**
   * Delete symbol filters for a given exchange that are NOT in the provided symbol list.
   * Used to remove delisted or unavailable symbols.
   * @param {string} exchange - Exchange name (e.g., 'binance', 'mexc')
   * @param {Array<string>} keepSymbols - Array of symbols to keep (uppercase, e.g., ['BTCUSDT', 'ETHUSDT'])
   * @returns {Promise<number>} Number of rows deleted
   */
  static async deleteByExchangeAndSymbols(exchange, keepSymbols) {
    // NOTE: legacy name kept for compatibility.
    // New behavior: mark as deleted instead of physical DELETE.
    if (!exchange || !Array.isArray(keepSymbols) || keepSymbols.length === 0) {
      // If keepSymbols is empty, don't delete anything (fail-safe)
      return 0;
    }

    const normalizedSymbols = keepSymbols.map(s => s.toUpperCase()).filter(s => s);
    if (normalizedSymbols.length === 0) {
      return 0;
    }

    const placeholders = normalizedSymbols.map(() => '?').join(',');
    const sql = `
      UPDATE symbol_filters
      SET deleted = TRUE, updated_at = NOW()
      WHERE exchange = ?
        AND deleted = FALSE
        AND symbol NOT IN (${placeholders})
    `;

    const [result] = await pool.execute(sql, [exchange, ...normalizedSymbols]);
    return result.affectedRows || 0;
  }

  /**
   * Get all symbols for a specific exchange from the database.
   * @param {string} exchange - Exchange name (e.g., 'binance', 'mexc')
   * @returns {Promise<Array<string>>} Array of normalized symbols (uppercase)
   */
  static async getSymbolsByExchange(exchange, { includeDeleted = false } = {}) {
    const sql = includeDeleted
      ? 'SELECT symbol FROM symbol_filters WHERE exchange = ?'
      : 'SELECT symbol FROM symbol_filters WHERE exchange = ? AND deleted = FALSE';

    const [rows] = await pool.execute(sql, [exchange]);
    return rows.map(r => (r.symbol || '').toUpperCase()).filter(s => s);
  }

  /**
   * Explicitly mark a symbol as deleted (manual delist override)
   */
  static async markDeleted(exchange, symbol) {
    if (!exchange || !symbol) return 0;
    const ex = String(exchange).toLowerCase();
    const sym = String(symbol).toUpperCase();
    const [res] = await pool.execute(
      'UPDATE symbol_filters SET deleted = TRUE, updated_at = NOW() WHERE exchange = ? AND symbol = ?',
      [ex, sym]
    );
    return res.affectedRows || 0;
  }
}
