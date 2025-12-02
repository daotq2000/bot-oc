import pool from '../config/database.js';

/**
 * Position model
 */
export class Position {
  /**
   * Get all positions
   * @param {Object} filters - Filter options
   * @returns {Promise<Array>}
   */
  static async findAll(filters = {}) {
    let query = `SELECT p.*, s.symbol, s.\`interval\`, s.oc, s.take_profit, 
                        s.reduce, s.up_reduce, s.bot_id, b.bot_name, b.exchange
                 FROM positions p
                 JOIN strategies s ON p.strategy_id = s.id
                 JOIN bots b ON s.bot_id = b.id`;

    const conditions = [];
    const params = [];

    if (filters.status) {
      conditions.push('p.status = ?');
      params.push(filters.status);
    }

    if (filters.symbol) {
      conditions.push('p.symbol = ?');
      params.push(filters.symbol);
    }

    if (filters.strategy_id) {
      conditions.push('p.strategy_id = ?');
      params.push(filters.strategy_id);
    }

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY p.opened_at DESC';

    const [rows] = await pool.execute(query, params);
    return rows;
  }

  /**
   * Get position by ID
   * @param {number} id - Position ID
   * @returns {Promise<Object|null>}
   */
  static async findById(id) {
    const [rows] = await pool.execute(
      `SELECT p.*, s.symbol, s.interval, s.oc, s.take_profit,
              s.reduce, s.up_reduce, s.bot_id, b.bot_name, b.exchange
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       JOIN bots b ON s.bot_id = b.id
       WHERE p.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Get open positions
   * @param {number} strategyId - Optional strategy ID filter
   * @returns {Promise<Array>}
   */
  static async findOpen(strategyId = null) {
    let query = `SELECT p.*, s.symbol, s.\`interval\`, s.oc, s.take_profit,
                        s.reduce, s.up_reduce, s.bot_id, b.bot_name, b.exchange
                 FROM positions p
                 JOIN strategies s ON p.strategy_id = s.id
                 JOIN bots b ON s.bot_id = b.id
                 WHERE p.status = 'open'`;

    const params = [];
    if (strategyId) {
      query += ' AND p.strategy_id = ?';
      params.push(strategyId);
    }

    query += ' ORDER BY p.opened_at ASC';

    const [rows] = await pool.execute(query, params);
    return rows;
  }

  /**
   * Get open positions by symbol
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Array>}
   */
  static async findOpenBySymbol(symbol) {
    const [rows] = await pool.execute(
      `SELECT p.*, s.oc, s.take_profit, s.reduce, s.up_reduce
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE p.symbol = ? AND p.status = 'open'`,
      [symbol]
    );
    return rows;
  }

  /**
   * Create new position
   * @param {Object} data - Position data
   * @returns {Promise<Object>}
   */
  static async create(data) {
    const {
      strategy_id,
      order_id,
      symbol,
      side,
      entry_price,
      amount,
      take_profit_price,
      stop_loss_price,
      current_reduce
    } = data;

    const [result] = await pool.execute(
      `INSERT INTO positions (
        strategy_id, order_id, symbol, side, entry_price, amount,
        take_profit_price, stop_loss_price, current_reduce
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        strategy_id, order_id, symbol, side, entry_price, amount,
        take_profit_price, stop_loss_price, current_reduce
      ]
    );

    return this.findById(result.insertId);
  }

  /**
   * Update position
   * @param {number} id - Position ID
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
      `UPDATE positions SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(id);
  }

  /**
   * Close position
   * @param {number} id - Position ID
   * @param {number} closePrice - Close price
   * @param {number} pnl - PnL amount
   * @param {string} reason - Close reason
   * @returns {Promise<Object>}
   */
  static async close(id, closePrice, pnl, reason) {
    return this.update(id, {
      status: 'closed',
      close_price: closePrice,
      pnl: pnl,
      close_reason: reason,
      closed_at: new Date()
    });
  }

  /**
   * Cancel position
   * @param {number} id - Position ID
   * @param {string} reason - Cancel reason
   * @returns {Promise<Object>}
   */
  static async cancel(id, reason) {
    return this.update(id, {
      status: 'cancelled',
      close_reason: reason,
      closed_at: new Date()
    });
  }
}

