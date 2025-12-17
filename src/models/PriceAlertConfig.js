import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Price Alert Config Model
 */
export class PriceAlertConfig {
  // Cache for findAll() results
  static _cache = {
    all: null, // Cache for findAll() without exchange filter
    byExchange: new Map(), // Cache for findAll(exchange)
    lastRefresh: 0,
    ttl: 30 * 60 * 1000 // 30 minutes in milliseconds
  };

  /**
   * Clear cache (call after create/update/delete)
   */
  static clearCache() {
    this._cache.all = null;
    this._cache.byExchange.clear();
    this._cache.lastRefresh = 0;
    logger.debug('[PriceAlertConfig] Cache cleared');
  }

  /**
   * Check if cache is valid
   * @param {string|null} exchange - Optional exchange filter
   * @returns {boolean} True if cache is valid
   */
  static _isCacheValid(exchange = null) {
    const now = Date.now();
    const age = now - this._cache.lastRefresh;
    
    if (age >= this._cache.ttl) {
      return false; // Cache expired
    }

    if (exchange === null) {
      return this._cache.all !== null;
    } else {
      return this._cache.byExchange.has(exchange);
    }
  }

  /**
   * Get cached configs
   * @param {string|null} exchange - Optional exchange filter
   * @returns {Array|null} Cached configs or null
   */
  static _getCached(exchange = null) {
    if (exchange === null) {
      return this._cache.all;
    } else {
      return this._cache.byExchange.get(exchange) || null;
    }
  }

  /**
   * Set cache
   * @param {Array} configs - Configs to cache
   * @param {string|null} exchange - Optional exchange filter
   */
  static _setCache(configs, exchange = null) {
    this._cache.lastRefresh = Date.now();
    if (exchange === null) {
      this._cache.all = configs;
      // Also cache by exchange for faster lookup
      const byExchange = new Map();
      for (const cfg of configs) {
        const ex = (cfg.exchange || 'mexc').toLowerCase();
        if (!byExchange.has(ex)) {
          byExchange.set(ex, []);
        }
        byExchange.get(ex).push(cfg);
      }
      // Update byExchange cache
      for (const [ex, cfgs] of byExchange.entries()) {
        this._cache.byExchange.set(ex, cfgs);
      }
    } else {
      this._cache.byExchange.set(exchange, configs);
      // If we have all configs cached, we can also update the all cache
      if (this._cache.all !== null) {
        // Update all cache by replacing configs for this exchange
        const allWithoutExchange = this._cache.all.filter(cfg => 
          (cfg.exchange || 'mexc').toLowerCase() !== exchange
        );
        this._cache.all = [...allWithoutExchange, ...configs];
      }
    }
  }

  /**
   * Get all active configs (with caching)
   * @param {string} exchange - Optional exchange filter
   * @returns {Promise<Array>}
   */
  static async findAll(exchange = null) {
    // Check cache first
    if (this._isCacheValid(exchange)) {
      const cached = this._getCached(exchange);
      if (cached !== null) {
        logger.debug(`[PriceAlertConfig] Using cached configs${exchange ? ` for ${exchange}` : ''} (${cached.length} configs)`);
        return cached;
      }
    }

    // Cache miss or expired, fetch from database
    logger.debug(`[PriceAlertConfig] Cache miss${exchange ? ` for ${exchange}` : ''}, fetching from database...`);
    
    let query = 'SELECT * FROM price_alert_config WHERE is_active = TRUE';
    const params = [];

    if (exchange) {
      query += ' AND exchange = ?';
      params.push(exchange);
    }

    query += ' ORDER BY created_at DESC';

    const [rows] = await pool.execute(query, params);
    // Safely parse JSON string fields into arrays
    const configs = rows.map(config => {
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

    // Update cache
    this._setCache(configs, exchange);
    logger.info(`[PriceAlertConfig] Cached ${configs.length} configs${exchange ? ` for ${exchange}` : ''} (TTL: 30 minutes)`);

    return configs;
  }

  /**
   * Get all configs (active or inactive)
   * @param {string|null} exchange - Optional exchange filter
   * @returns {Promise<Array>}
   */
  static async findAllAny(exchange = null) {
    let query = 'SELECT * FROM price_alert_config';
    const params = [];
    if (exchange) {
      query += ' WHERE exchange = ?';
      params.push(exchange);
    }
    query += ' ORDER BY created_at DESC';
    const [rows] = await pool.execute(query, params);
    return rows.map(config => {
      try {
        if (typeof config.symbols === 'string') config.symbols = JSON.parse(config.symbols);
      } catch (_) { config.symbols = []; }
      try {
        if (typeof config.intervals === 'string') config.intervals = JSON.parse(config.intervals);
      } catch (_) { config.intervals = []; }
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
    // Clear cache after create
    this.clearCache();
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

    // Clear cache after update
    this.clearCache();

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
    
    // Clear cache after delete
    if (result.affectedRows > 0) {
      this.clearCache();
    }
    
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
