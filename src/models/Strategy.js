import pool from '../config/database.js';

/**
 * Strategy model
 */
export class Strategy {
  /**
   * Get all strategies
   * @param {number} botId - Optional bot ID filter
   * @param {boolean} activeOnly - Only return active strategies
   * @returns {Promise<Array>}
   */
  static async findAll(botId = null, activeOnly = false) {
    let query = 'SELECT s.*, b.bot_name, b.exchange, b.is_reverse_strategy, b.max_amount_per_coin FROM strategies s';
    query += ' JOIN bots b ON s.bot_id = b.id';
    
    const conditions = [];
    const params = [];

    if (botId) {
      conditions.push('s.bot_id = ?');
      params.push(botId);
    }

    if (activeOnly) {
      conditions.push('s.is_active = TRUE');
    }

    // Filter only USDT pairs to avoid spam from other currencies
    // Handle both formats: BTCUSDT and BTC/USDT
    conditions.push('(REPLACE(REPLACE(s.symbol, "/", ""), ":", "") LIKE "%USDT")');

    if (conditions.length > 0) {
      query += ' WHERE ' + conditions.join(' AND ');
    }

    query += ' ORDER BY s.created_at DESC';

    const [rows] = await pool.execute(query, params);
    return rows;
  }

  /**
   * Get strategy by ID
   * @param {number} id - Strategy ID
   * @returns {Promise<Object|null>}
   */
  static async findById(id) {
    const [rows] = await pool.execute(
      `SELECT s.*, b.bot_name, b.exchange, b.is_reverse_strategy, b.max_amount_per_coin 
       FROM strategies s 
       JOIN bots b ON s.bot_id = b.id 
       WHERE s.id = ?`,
      [id]
    );
    return rows[0] || null;
  }

  /**
   * Get active strategies for a bot
   * @param {number} botId - Bot ID
   * @returns {Promise<Array>}
   */
  static async findActiveByBot(botId) {
    const [rows] = await pool.execute(
      'SELECT * FROM strategies WHERE bot_id = ? AND is_active = TRUE AND (REPLACE(REPLACE(symbol, "/", ""), ":", "") LIKE "%USDT")',
      [botId]
    );
    return rows;
  }

  /**
   * Get strategy by bot and symbol
   * @param {number} botId - Bot ID
   * @param {string} symbol - Trading symbol
   * @returns {Promise<Object|null>}
   */
  static async findByBotAndSymbol(botId, symbol) {
    const [rows] = await pool.execute(
      'SELECT * FROM strategies WHERE bot_id = ? AND symbol = ?',
      [botId, symbol]
    );
    return rows[0] || null;
  }

  /**
   * Get strategy by unique key for a bot: symbol + interval + trade_type + oc
   * @param {number} botId
   * @param {string} symbol
   * @param {string} interval
   * @param {string} tradeType
   * @param {number} oc
   * @returns {Promise<Object|null>}
   */
  static async findByUniqueKey(botId, symbol, interval, tradeType, oc) {
    const [rows] = await pool.execute(
      'SELECT * FROM strategies WHERE bot_id = ? AND symbol = ? AND `interval` = ? AND trade_type = ? AND oc = ?',
      [botId, symbol, interval, tradeType, oc]
    );
    return rows[0] || null;
  }

  /**
   * Create new strategy
   * @param {Object} data - Strategy data
   * @returns {Promise<Object>}
   */
  static async create(data) {
    const {
      bot_id,
      symbol,
      trade_type = 'both',
      interval,
      oc,
      extend,
      amount,
      take_profit,
      reduce,
      up_reduce,
      ignore,
      is_active = true
    } = data;

    const [result] = await pool.execute(
      `INSERT INTO strategies (
        bot_id, symbol, trade_type, \`interval\`, oc, extend,
        amount, take_profit, reduce, up_reduce, \`ignore\`, is_active
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        bot_id, symbol, trade_type, interval, oc, extend,
        amount, take_profit, reduce, up_reduce, ignore, is_active
      ]
    );

    return this.findById(result.insertId);
  }

  /**
   * Update strategy
   * @param {number} id - Strategy ID
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
      `UPDATE strategies SET ${fields.join(', ')} WHERE id = ?`,
      values
    );

    return this.findById(id);
  }

  /**
   * Delete strategy
   * CRITICAL: Check for open positions before deletion to prevent CASCADE DELETE
   * @param {number} id - Strategy ID
   * @returns {Promise<boolean>}
   * @throws {Error} If strategy has open positions
   */
  static async delete(id) {
    // CRITICAL PROTECTION: Check for open positions before deletion
    // Foreign key constraint may have ON DELETE CASCADE which will delete all positions
    // This protection prevents accidental deletion of open positions
    const { Position } = await import('./Position.js');
    const openPositions = await Position.findOpen(id);
    
    if (openPositions.length > 0) {
      throw new Error(
        `Cannot delete strategy ${id}: Strategy has ${openPositions.length} open position(s). ` +
        `Please close all positions before deleting the strategy. ` +
        `Deleting strategy with open positions may cause CASCADE DELETE of positions. ` +
        `Open positions: ${openPositions.map(p => `pos=${p.id} symbol=${p.symbol}`).join(', ')}`
      );
    }
    
    const [result] = await pool.execute(
      'DELETE FROM strategies WHERE id = ?',
      [id]
    );
    return result.affectedRows > 0;
  }

  /**
   * Delete strategies for delisted symbols
   * CRITICAL: Check for open positions before deletion to prevent CASCADE DELETE
   * @param {string} exchange - Exchange name (binance, mexc)
   * @param {Array<string>} delistedSymbols - Array of delisted symbols
   * @returns {Promise<number>} Number of deleted strategies
   * @throws {Error} If any strategy has open positions
   */
  static async deleteBySymbols(exchange, delistedSymbols) {
    if (!Array.isArray(delistedSymbols) || delistedSymbols.length === 0) {
      return 0;
    }

    const normalizedSymbols = delistedSymbols.map(s => s.toUpperCase()).filter(s => s);
    if (normalizedSymbols.length === 0) {
      return 0;
    }

    // CRITICAL PROTECTION: Check for open positions before deletion
    // Find all strategies that will be deleted
    const placeholders = normalizedSymbols.map(() => '?').join(',');
    const [strategiesToDelete] = await pool.execute(
      `SELECT s.id, s.symbol, s.bot_id
       FROM strategies s
       JOIN bots b ON s.bot_id = b.id
       WHERE b.exchange = ? AND s.symbol IN (${placeholders})`,
      [exchange, ...normalizedSymbols]
    );

    if (strategiesToDelete.length === 0) {
      return 0;
    }

    // Check for open positions for these strategies
    const strategyIds = strategiesToDelete.map(s => s.id);
    const strategyPlaceholders = strategyIds.map(() => '?').join(',');
    const { Position } = await import('./Position.js');
    const [openPositions] = await pool.execute(
      `SELECT p.id, p.strategy_id, p.symbol, s.symbol as strategy_symbol
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE p.strategy_id IN (${strategyPlaceholders}) AND p.status = 'open'`,
      strategyIds
    );

    if (openPositions.length > 0) {
      const affectedStrategies = new Set(openPositions.map(p => p.strategy_id));
      const affectedSymbols = Array.from(new Set(openPositions.map(p => p.strategy_symbol || p.symbol)));
      throw new Error(
        `Cannot delete strategies for delisted symbols ${normalizedSymbols.join(', ')}: ` +
        `${openPositions.length} open position(s) found. ` +
        `Please close all positions before deleting strategies. ` +
        `Affected strategies: ${Array.from(affectedStrategies).join(', ')}, ` +
        `Affected symbols: ${affectedSymbols.join(', ')}. ` +
        `Open positions: ${openPositions.map(p => `pos=${p.id} strategy=${p.strategy_id} symbol=${p.symbol || p.strategy_symbol}`).join(', ')}`
      );
    }

    // Safe to delete - no open positions
    const sql = `
      DELETE s FROM strategies s
      JOIN bots b ON s.bot_id = b.id
      WHERE b.exchange = ? AND s.symbol IN (${placeholders})
    `;

    const [result] = await pool.execute(sql, [exchange, ...normalizedSymbols]);
    return result.affectedRows || 0;
  }
}

