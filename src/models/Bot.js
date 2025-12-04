import pool from '../config/database.js';

/**
 * Bot model
 */
export class Bot {
  /**
   * Get all bots
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
    return rows;
  }

  /**
   * Get bot by ID
   * @param {number} id - Bot ID
   * @returns {Promise<Object|null>}
   */
  static async findById(id) {
    const [rows] = await pool.execute(
      'SELECT * FROM bots WHERE id = ?',
      [id]
    );
    return rows[0] || null;
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
      is_active = true
    } = data;

    const [result] = await pool.execute(
      `INSERT INTO bots (
        bot_name, exchange, uid, access_key, secret_key, proxy,
        telegram_chat_id, future_balance_target, spot_transfer_threshold,
        transfer_frequency, withdraw_enabled, withdraw_address,
        withdraw_network, spot_balance_threshold, max_concurrent_trades,
        telegram_alert_channel_id, binance_testnet, concurrency_lock_timeout, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bot_name, exchange, uid, access_key, secret_key, proxy,
        telegram_chat_id, future_balance_target, spot_transfer_threshold,
        transfer_frequency, withdraw_enabled, withdraw_address,
        withdraw_network, spot_balance_threshold, max_concurrent_trades,
        telegram_alert_channel_id, binance_testnet, concurrency_lock_timeout, is_active
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
        fields.push(`${key} = ?`);
        values.push(data[key]);
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
   * @param {number} id - Bot ID
   * @returns {Promise<boolean>}
   */
  static async delete(id) {
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
    return rows;
  }
}

