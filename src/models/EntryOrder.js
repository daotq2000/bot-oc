import pool from '../config/database.js';

/**
 * EntryOrder model
 * - Tracks entry orders (especially LIMIT) before a real position is confirmed open on the exchange.
 */
export class EntryOrder {
  /**
   * Create new entry order
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  static async create(data) {
    const {
      strategy_id,
      bot_id,
      order_id,
      symbol,
      side,
      amount,
      entry_price,
      status = 'open',
      reservation_token = null
    } = data;

    // Try to insert with reservation_token if provided, fallback if column doesn't exist
    let result;
    try {
      if (reservation_token) {
        [result] = await pool.execute(
          `INSERT INTO entry_orders (
            strategy_id, bot_id, order_id, symbol, side, amount, entry_price, status, reservation_token
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            strategy_id,
            bot_id,
            String(order_id),
            symbol,
            side,
            amount,
            entry_price,
            status,
            reservation_token
          ]
        );
      } else {
        throw new Error('NO_RESERVATION_TOKEN'); // Force fallback path
      }
    } catch (e) {
      // Fallback: insert without reservation_token (column may not exist)
      if (e.message === 'NO_RESERVATION_TOKEN' || e.message?.includes('reservation_token') || e.code === 'ER_BAD_FIELD_ERROR') {
        [result] = await pool.execute(
          `INSERT INTO entry_orders (
            strategy_id, bot_id, order_id, symbol, side, amount, entry_price, status
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          [
            strategy_id,
            bot_id,
            String(order_id),
            symbol,
            side,
            amount,
            entry_price,
            status
          ]
        );
      } else {
        throw e;
      }
    }

    return this.findById(result.insertId);
  }

  /**
   * Find by primary key
   * @param {number} id
   * @returns {Promise<Object|null>}
   */
  static async findById(id) {
    const [rows] = await pool.execute(
      `SELECT * FROM entry_orders WHERE id = ? LIMIT 1`,
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Find open entry orders (status = 'open')
   * @returns {Promise<Array>}
   */
  static async findOpen() {
    const [rows] = await pool.execute(
      `SELECT * FROM entry_orders WHERE status = 'open' ORDER BY created_at ASC`
    );
    return rows;
  }

  /**
   * Find open entry order by bot and order id
   * @param {number} botId
   * @param {string|number} orderId
   * @returns {Promise<Object|null>}
   */
  static async findOpenByBotAndOrder(botId, orderId) {
    const [rows] = await pool.execute(
      `SELECT * FROM entry_orders WHERE bot_id = ? AND order_id = ? AND status = 'open' LIMIT 1`,
      [botId, String(orderId)]
    );
    return rows[0] || null;
  }

  /**
   * Update entry order
   * @param {number} id
   * @param {Object} data
   * @returns {Promise<Object>}
   */
  static async update(id, data) {
    const fields = [];
    const values = [];

    for (const key in data) {
      if (Object.hasOwn(data, key) && data[key] !== undefined) {
        fields.push(`\`${key}\` = ?`);
        values.push(data[key]);
      }
    }

    if (fields.length === 0) {
      return this.findById(id);
    }

    values.push(id);
    await pool.execute(
      `UPDATE entry_orders SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(id);
  }

  /**
   * Mark entry order as filled
   * @param {number} id
   * @returns {Promise<Object>}
   */
  static async markFilled(id) {
    return this.update(id, { status: 'filled' });
  }

  /**
   * Mark entry order as canceled / expired
   * @param {number} id
   * @param {string} status - 'canceled' | 'expired'
   * @returns {Promise<Object>}
   */
  static async markCanceled(id, status = 'canceled') {
    const safeStatus = ['canceled', 'expired'].includes(status) ? status : 'canceled';
    return this.update(id, { status: safeStatus });
  }
}


