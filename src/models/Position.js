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
                        s.reduce, s.up_reduce, s.extend, p.bot_id, b.bot_name, b.exchange
                 FROM positions p
                 JOIN strategies s ON p.strategy_id = s.id
                 JOIN bots b ON p.bot_id = b.id`;

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
              s.reduce, s.up_reduce, s.extend, s.bot_id,
              b.bot_name, b.exchange, b.telegram_chat_id, b.telegram_alert_channel_id
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       JOIN bots b ON p.bot_id = b.id
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
                 JOIN bots b ON p.bot_id = b.id
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
    let {
      strategy_id,
      bot_id,
      order_id,
      symbol,
      side,
      entry_price,
      amount,
      take_profit_price,
      stop_loss_price,
      current_reduce,
      tp_order_id = null,
      sl_order_id = null
    } = data;

    const safe = (v) => (v === undefined ? null : v);

    // Resolve bot_id from strategies if not provided
    if ((bot_id === undefined || bot_id === null) && strategy_id) {
      try {
        const [rows] = await pool.execute('SELECT bot_id FROM strategies WHERE id = ? LIMIT 1', [strategy_id]);
        bot_id = rows?.[0]?.bot_id ?? null;
      } catch (_) {}
    }

    const [result] = await pool.execute(
      `INSERT INTO positions (
        strategy_id, bot_id, order_id, symbol, side, entry_price, amount,
        take_profit_price, stop_loss_price, current_reduce, tp_order_id, sl_order_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        safe(strategy_id), safe(bot_id), safe(order_id), safe(symbol), safe(side), safe(entry_price), safe(amount),
        safe(take_profit_price), safe(stop_loss_price), safe(current_reduce), safe(tp_order_id), safe(sl_order_id)
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

  /**
   * Get bot-level stats: wins (tp_hit), loses (sl_hit), total pnl
   * @param {number} botId
   * @returns {Promise<{wins:number,loses:number,total_pnl:number}>}
   */
  static async getBotStats(botId) {
    const [rows] = await pool.execute(
      `SELECT 
         SUM(CASE WHEN p.close_reason='tp_hit' THEN 1 ELSE 0 END) AS wins,
         SUM(CASE WHEN p.close_reason='sl_hit' THEN 1 ELSE 0 END) AS loses,
         SUM(COALESCE(p.pnl,0)) AS total_pnl
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE s.bot_id = ? AND p.status='closed'`,
      [botId]
    );
    const r = rows[0] || {};
    return {
      wins: Number(r.wins || 0),
      loses: Number(r.loses || 0),
      total_pnl: Number(r.total_pnl || 0)
    };
  }

  /**
   * Get count of open positions for a bot
   * @param {number} botId - Bot ID
   * @returns {Promise<number>} Count of open positions
   */
  static async countOpenByBot(botId) {
    const [rows] = await pool.execute(
      `SELECT COUNT(*) as count
       FROM positions p
       WHERE p.bot_id = ? AND p.status = 'open'`,
      [botId]
    );
    return rows[0]?.count || 0;
  }
}
