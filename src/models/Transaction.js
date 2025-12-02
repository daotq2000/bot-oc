import pool from '../config/database.js';

/**
 * Transaction model
 */
export class Transaction {
  /**
   * Get all transactions
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>}
   */
  static async findAll(filters = {}) {
    let query = `SELECT t.*, b.bot_name, b.exchange
                 FROM transactions t
                 JOIN bots b ON t.bot_id = b.id`;

    const conditions = [];
    const params = [];

    if (filters.bot_id) {
      conditions.push('t.bot_id = ?');
      params.push(filters.bot_id);
    }

    if (filters.type) {
      conditions.push('t.type = ?');
      params.push(filters.type);
    }

    if (filters.status) {
      conditions.push('t.status = ?');
      params.push(filters.status);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY t.created_at DESC LIMIT 100';

    const [rows] = await pool.execute(query, params);
    return rows;
  }

  /**
   * Get transaction by ID
   * @param {number} id - Transaction ID
   * @returns {Promise<Object|null>}
   */
  static async findById(id) {
    const [rows] = await pool.execute(
      `SELECT t.*, b.bot_name, b.exchange
       FROM transactions t
       JOIN bots b ON t.bot_id = b.id
       WHERE t.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Create new transaction
   * @param {Object} data - Transaction data
   * @returns {Promise<Object>}
   */
  static async create(data) {
    const {
      bot_id,
      type,
      amount,
      status = 'pending',
      error_message = null
    } = data;

    const [result] = await pool.execute(
      `INSERT INTO transactions (bot_id, type, amount, status, error_message)
       VALUES (?, ?, ?, ?, ?)`,
      [bot_id, type, amount, status, error_message]
    );

    return this.findById(result.insertId);
  }

  /**
   * Update transaction status
   * @param {number} id - Transaction ID
   * @param {string} status - New status
   * @param {string} errorMessage - Optional error message
   * @returns {Promise<Object>}
   */
  static async updateStatus(id, status, errorMessage = null) {
    await pool.execute(
      'UPDATE transactions SET status = ?, error_message = ? WHERE id = ?',
      [status, errorMessage, id]
    );

    return this.findById(id);
  }
}

