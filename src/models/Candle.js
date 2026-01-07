import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Candle model
 */
export class Candle {
  /**
   * Get timeframe in milliseconds (static helper)
   * @param {string} interval - Time interval (1m, 5m, etc.)
   * @returns {number} Milliseconds
   */
  static getTimeframeMs(interval) {
    const units = {
      'm': 60 * 1000,
      'h': 60 * 60 * 1000,
      'd': 24 * 60 * 60 * 1000
    };
    const match = interval.match(/^(\d+)([mhd])$/);
    if (!match) return 60000; // Default 1 minute
    const value = parseInt(match[1]);
    const unit = match[2];
    return value * units[unit];
  }

  /**
   * Get latest candle for symbol and interval
   * @param {string} exchange - Exchange name (mexc, gate, binance)
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @returns {Promise<Object|null>}
   */
  static async getLatest(exchange, symbol, interval) {
    const [rows] = await pool.execute(
      `SELECT * FROM candles 
       WHERE exchange = ? AND symbol = ? AND \`interval\` = ? 
       ORDER BY open_time DESC 
       LIMIT 1`,
      [exchange, symbol, interval]
    );
    return rows[0] || null;
  }

  /**
   * Get previous candle (before latest)
   * @param {string} exchange - Exchange name (mexc, gate, binance)
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @returns {Promise<Object|null>}
   */
  static async getPrevious(exchange, symbol, interval) {
    const [rows] = await pool.execute(
      `SELECT * FROM candles 
       WHERE exchange = ? AND symbol = ? AND \`interval\` = ? 
       ORDER BY open_time DESC 
       LIMIT 1 OFFSET 1`,
      [exchange, symbol, interval]
    );
    return rows[0] || null;
  }

  /**
   * Get candles
   * @param {string} exchange - Exchange name (mexc, gate, binance)
   * @param {string} symbol - Trading symbol
   * @param {string} interval - Time interval
   * @param {number} limit - Number of candles
   * @returns {Promise<Array>}
   */
  static async getCandles(exchange, symbol, interval, limit = 100) {
    // Some MySQL servers do not accept a bound parameter for LIMIT in prepared statements
    // Ensure numeric and inject as literal to avoid ER_WRONG_ARGUMENTS
    const safeLimit = Math.max(1, parseInt(limit, 10) || 100);
    const sql = `SELECT * FROM candles 
       WHERE exchange = ? AND symbol = ? AND \`interval\` = ? 
       ORDER BY open_time DESC 
       LIMIT ${safeLimit}`;
    const [rows] = await pool.execute(sql, [exchange, symbol, interval]);
    return rows.reverse(); // Return in chronological order
  }

  /**
   * Insert or update candle
   * @param {Object} candle - Candle data (must include exchange)
   * @returns {Promise<Object>}
   */
  static async upsert(candle) {
    const {
      exchange,
      symbol,
      interval,
      open_time,
      open,
      high,
      low,
      close,
      volume,
      close_time
    } = candle;

    await pool.execute(
      `INSERT INTO candles (
        exchange, symbol, \`interval\`, open_time, open, high, low, close, volume, close_time
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON DUPLICATE KEY UPDATE
        open = VALUES(open),
        high = VALUES(high),
        low = VALUES(low),
        close = VALUES(close),
        volume = VALUES(volume),
        close_time = VALUES(close_time)`,
      [exchange, symbol, interval, open_time, open, high, low, close, volume, close_time]
    );

    return this.getLatest(exchange, symbol, interval);
  }

  /**
   * Bulk insert candles
   * @param {Array} candles - Array of candle data
   * @returns {Promise<number>} Number of inserted rows
   */
  static async bulkInsert(candles) {
    if (candles.length === 0) return 0;

    const values = [];
    const placeholders = [];

    candles.forEach(candle => {
      // Validate and ensure all required fields are present
      if (!candle.exchange || !candle.symbol || !candle.interval) {
        logger.warn(`Skipping invalid candle: missing required fields`, candle);
        return;
      }
      
      // Ensure all numeric values are valid numbers
      const open_time = candle.open_time || candle.openTime;
      const open = parseFloat(candle.open);
      const high = parseFloat(candle.high);
      const low = parseFloat(candle.low);
      const close = parseFloat(candle.close);
      const volume = parseFloat(candle.volume || 0);
      
      // Calculate close_time if not provided
      let close_time = candle.close_time || candle.closeTime;
      if (!close_time || isNaN(close_time)) {
        // Calculate close_time from open_time and interval
        const interval = candle.interval || '1m';
        const timeframeMs = Candle.getTimeframeMs(interval);
        close_time = open_time + timeframeMs - 1;
      }
      close_time = parseFloat(close_time);
      
      // Skip if any required numeric value is invalid
      if (isNaN(open_time) || isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close) || isNaN(volume) || isNaN(close_time)) {
        logger.warn(`Skipping invalid candle: invalid numeric values`, candle);
        return;
      }
      
      placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
      values.push(
        candle.exchange,
        candle.symbol,
        candle.interval,
        open_time,
        open,
        high,
        low,
        close,
        volume,
        close_time
      );
    });
    
    // If no valid candles after filtering, return 0
    if (placeholders.length === 0) {
      logger.warn('No valid candles to insert after validation');
      return 0;
    }

    const sql = `INSERT INTO candles (
        exchange, symbol, \`interval\`, open_time, open, high, low, close, volume, close_time
      ) VALUES ${placeholders.join(', ')}
      ON DUPLICATE KEY UPDATE
        open = VALUES(open),
        high = VALUES(high),
        low = VALUES(low),
        close = VALUES(close),
        volume = VALUES(volume),
        close_time = VALUES(close_time)`;

    const maxRetries = 3;
    let attempt = 0;

    // Retry on deadlock errors to avoid losing candle updates
    // MySQL error code 1213 = ER_LOCK_DEADLOCK
    while (true) {
      try {
        const [result] = await pool.execute(sql, values);
        return result.affectedRows;
      } catch (error) {
        if (error.code === 'ER_LOCK_DEADLOCK' && attempt < maxRetries) {
          attempt += 1;
          const delay = 100 * attempt;
          await new Promise(resolve => setTimeout(resolve, delay));
          continue;
        }
        throw error;
      }
    }
  }

  /**
   * Prune candles older than retentionMs (by close_time)
   * @returns {Promise<number>} number of deleted rows
   */
  static async pruneByAge(exchange, symbol, interval, retentionMs) {
    try {
      const threshold = Date.now() - Math.max(0, Number(retentionMs) || 0);
      const [result] = await pool.execute(
        `DELETE FROM candles WHERE exchange = ? AND symbol = ? AND \`interval\` = ? AND close_time < ?`,
        [exchange, symbol, interval, threshold]
      );
      return result?.affectedRows || 0;
    } catch (e) {
      logger.warn(`[Candle.pruneByAge] failed for ${exchange}/${symbol}/${interval}: ${e?.message || e}`);
      return 0;
    }
  }

  /**
   * Keep only the last N candles (by open_time) for a key; delete older ones
   * @returns {Promise<number>} number of deleted rows
   */
  static async pruneByLimit(exchange, symbol, interval, keepLast) {
    const n = Math.max(0, parseInt(keepLast, 10) || 0);
    if (n <= 0) return 0;

    try {
      // Find cutoff open_time at offset n-1 (0-based) from newest
      const offset = Math.max(0, n - 1);
      const sql = `SELECT open_time FROM candles WHERE exchange = ? AND symbol = ? AND \`interval\` = ? ORDER BY open_time DESC LIMIT ${offset}, 1`;
      const [rows] = await pool.execute(sql, [exchange, symbol, interval]);
      if (!rows || rows.length === 0) return 0; // fewer than n rows -> nothing to prune
      const cutoff = rows[0].open_time;

      const [result] = await pool.execute(
        `DELETE FROM candles WHERE exchange = ? AND symbol = ? AND \`interval\` = ? AND open_time < ?`,
        [exchange, symbol, interval, cutoff]
      );
      return result?.affectedRows || 0;
    } catch (e) {
      logger.warn(`[Candle.pruneByLimit] failed for ${exchange}/${symbol}/${interval}: ${e?.message || e}`);
      return 0;
    }
  }
}

