import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Bot model
 */
export class Bot {
  /**
   * Parse bot row from database, converting config_filter JSON string to object
   * @param {Object} row - Raw database row
   * @returns {Object} Parsed bot object with config_filter as object
   */
  static _parseBotRow(row) {
    if (!row) return row;
    
    // Parse config_filter from JSON string to object
    if (row.config_filter !== null && row.config_filter !== undefined) {
      try {
        if (typeof row.config_filter === 'string') {
          row.config_filter = JSON.parse(row.config_filter);
        }
        // If already an object, keep it as is
      } catch (e) {
        logger.warn(`[Bot] Failed to parse config_filter for bot ${row.id}: ${e?.message || e}`);
        row.config_filter = {}; // Fallback to empty object
      }
    } else {
      row.config_filter = {}; // Default to empty object if null
    }
    
    return row;
  }

  /**
   * Get all bots (with parsed config_filter)
   * @param {boolean} activeOnly - Only return active bots
   * @returns {Promise<Array>}
   */
  static async findAll(activeOnly = false) {
    let query = 'SELECT * FROM bots';
    if (activeOnly) {
      query += ' WHERE is_active = TRUE';
    }
    query += ' ORDER BY created_at DESC';
    
    const [rows] = await pool.execute(query);
    return rows.map(row => this._parseBotRow(row));
  }

  /**
   * Get bot by ID (with parsed config_filter)
   * @param {number} id - Bot ID
   * @returns {Promise<Object|null>}
   */
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM bots WHERE id = ?',
      [id]
    );
    return rows[0] ? this._parseBotRow(rows[0]) : null;
  }

  /**
   * Create new bot
   * @param {Object} data - Bot data
   * @returns {Promise<Object>}
   */
  static async create(data) {
    const {
      bot_name,
      exchange,
      uid,
      access_key,
      secret_key,
      proxy,
      telegram_chat_id,
      future_balance_target = 20.00,
      spot_transfer_threshold = 10.00,
      transfer_frequency = 15,
      withdraw_enabled = false,
      withdraw_address,
      withdraw_network = 'BEP20',
      spot_balance_threshold = 10.00,
      max_concurrent_trades = 5,
      telegram_alert_channel_id = null,
      binance_testnet = null,
      concurrency_lock_timeout = null,
      is_active = true,
      is_reverse_strategy = true, // Default to reverse strategy
      config_filter = null // Default to {} in DB, but allow override
    } = data;

    // Parse config_filter to JSON string if provided as object
    let configFilterValue = null;
    if (config_filter !== null && config_filter !== undefined) {
      configFilterValue = typeof config_filter === 'string' ? config_filter : JSON.stringify(config_filter);
    }

    const [result] = await pool.execute(
      `INSERT INTO bots (
        bot_name, exchange, uid, access_key, secret_key, proxy,
        telegram_chat_id, future_balance_target, spot_transfer_threshold,
        transfer_frequency, withdraw_enabled, withdraw_address,
        withdraw_network, spot_balance_threshold, max_concurrent_trades,
        telegram_alert_channel_id, binance_testnet, concurrency_lock_timeout, is_active, is_reverse_strategy, config_filter
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bot_name, exchange, uid, access_key, secret_key, proxy,
        telegram_chat_id, future_balance_target, spot_transfer_threshold,
        transfer_frequency, withdraw_enabled, withdraw_address,
        withdraw_network, spot_balance_threshold, max_concurrent_trades,
        telegram_alert_channel_id, binance_testnet, concurrency_lock_timeout, is_active, is_reverse_strategy, configFilterValue
      ]
    );

    return this.findById(result.insertId);
  }

  /**
   * Update bot
   * @param {number} id - Bot ID
   * @param {Object} data - Update data
   * @returns {Promise<Object>}
   */
  static async update(id, data) {
    const fields = [];
    const values = [];

    Object.keys(data).forEach(key => {
      if (data[key] !== undefined) {
        // Special handling for config_filter: convert object to JSON string
        if (key === 'config_filter' && typeof data[key] === 'object') {
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
      `UPDATE bots SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(id);
  }

  /**
   * Delete bot
   * CRITICAL: Check for open positions before deletion to prevent CASCADE DELETE
   * @param {number} id - Bot ID
   * @returns {Promise<boolean>}
   * @throws {Error} If bot has open positions
   */
  static async delete(id) {
    // CRITICAL PROTECTION: Check for open positions before deletion
    // Foreign key constraint has ON DELETE CASCADE which will delete all positions
    // This protection prevents accidental deletion of open positions
    const { Position } = await import('./Position.js');
    const openPositionsCount = await Position.countOpenByBot(id);
    
    if (openPositionsCount > 0) {
      throw new Error(
        `Cannot delete bot ${id}: Bot has ${openPositionsCount} open position(s). ` +
        `Please close all positions before deleting the bot. ` +
        `Deleting bot with open positions will cause CASCADE DELETE of all positions (including open ones).`
      );
    }
    
    // Also check for closed positions (optional - just for logging)
    const [closedCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM positions WHERE bot_id = ? AND status = ?',
      [id, 'closed']
    );
    const closedPositionsCount = closedCount[0]?.count || 0;
    
    if (closedPositionsCount > 0) {
      logger.warn(
        `[Bot.delete] Bot ${id} has ${closedPositionsCount} closed position(s) that will be deleted via CASCADE. ` +
        `This is acceptable but may affect historical data.`
      );
    }
    
    const [result] = await pool.execute(
      'DELETE FROM bots WHERE id = ?',
      [id]
    );
    return result.affectedRows > 0;
  }

  /**
   * Get active bots by exchange
   * @param {string} exchange - Exchange name
   * @returns {Promise<Array>}
   */
  static async findActiveByExchange(exchange) {
    const [rows] = await pool.execute(
      'SELECT * FROM bots WHERE exchange = ? AND is_active = TRUE',
      [exchange]
    );
    return rows.map(row => this._parseBotRow(row));
  }
}
