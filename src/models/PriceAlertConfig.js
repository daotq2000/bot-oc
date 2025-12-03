import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Price Alert Config Model
 */
export class PriceAlertConfig {
  /**
   * Get all active configs
   * @param {string} exchange - Optional exchange filter
   * @returns {Promise<Array>}
   */
  static async findAll(exchange = null) {
    let query = 'SELECT * FROM price_alert_config WHERE is_active = TRUE';
    const params = [];

    if (exchange) {
      query += ' AND exchange = ?';
      params.push(exchange);
    }

    query += ' ORDER BY created_at DESC';

    const [rows] = await pool.execute(query, params);
    // Safely parse JSON string fields into arrays
    return rows.map(config => {
      try {
        if (typeof config.symbols === 'string') {
          config.symbols = JSON.parse(config.symbols);
        }
      } catch (e) {
        logger.warn(`Invalid JSON in price_alert_config.symbols for ID ${config.id}: ${config.symbols}`);
        config.symbols = [];
      }
      try {
        if (typeof config.intervals === 'string') {
          config.intervals = JSON.parse(config.intervals);
        }
      } catch (e) {
        logger.warn(`Invalid JSON in price_alert_config.intervals for ID ${config.id}: ${config.intervals}`);
        config.intervals = [];
      }
      return config;
    });
  }

  /**
   * Get config by ID
   * @param {number} id - Config ID
   * @returns {Promise<Object|null>}
   */
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM price_alert_config WHERE id = ?',
      [id]
    );
    if (rows.length === 0) return null;
    
    const row = rows[0];
    return {
      ...row,
      symbols: JSON.parse(row.symbols || '[]'),
      intervals: JSON.parse(row.intervals || '[]')
    };
  }

  /**
   * Create new config
   * @param {Object} data - Config data
   * @returns {Promise<Object>}
   */
  static async create(data) {
    const {
      exchange = 'binance',
      symbols = [],
      intervals = [],
      threshold = 5.00,
      telegram_chat_id,
      is_active = true
    } = data;

    const [result] = await pool.execute(
      `INSERT INTO price_alert_config (
        exchange, symbols, intervals, threshold, telegram_chat_id, is_active
      ) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        exchange,
        JSON.stringify(symbols),
        JSON.stringify(intervals),
        threshold,
        telegram_chat_id,
        is_active
      ]
    );

    return this.findById(result.insertId);
  }

  /**
   * Update config
   * @param {number} id - Config ID
   * @param {Object} data - Update data
   * @returns {Promise<Object>}
   */
  static async update(id, data) {
    const fields = [];
    const values = [];

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        if (key === 'symbols' || key === 'intervals') {
          fields.push(`${key} = ?`);
          values.push(JSON.stringify(data[key]));
        } else {
          fields.push(`${key} = ?`);
          values.push(data[key]);
        }
      }
    });

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    await pool.execute(
      `UPDATE price_alert_config SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(id);
  }

  /**
   * Delete config
   * @param {number} id - Config ID
   * @returns {Promise<boolean>}
   */
  static async delete(id) {
    const [result] = await pool.execute(
      'DELETE FROM price_alert_config WHERE id = ?',
      [id]
    );
    return result.affectedRows > 0;
  }

  /**
   * Update last alert time
   * @param {number} id - Config ID
   * @returns {Promise<void>}
   */
  static async updateLastAlertTime(id) {
    await pool.execute(
      'UPDATE price_alert_config SET last_alert_time = NOW() WHERE id = ?',
      [id]
    );
  }
}
