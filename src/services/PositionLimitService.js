import pool from '../config/database.js';
import logger from '../utils/logger.js';
import { Bot } from '../models/Bot.js';
import { LRUCache } from '../utils/LRUCache.js';

/**
 * PositionLimitService
 * 
 * Service để kiểm tra giới hạn tổng USDT vào lệnh cho mỗi coin
 * Dựa trên bots.max_amount_per_coin (hard limit)
 * 
 * ✅ OPTIMIZED: Added caching to reduce database queries
 */
export class PositionLimitService {
  constructor() {
    // Cache current amounts với TTL
    // Key: botId|symbol -> { amount, timestamp, maxAmount }
    // ✅ OPTIMIZED: Use LRUCache for automatic eviction
    this._amountCache = new LRUCache(1000);
    this._cacheTTL = 5000; // 5 seconds TTL
    
    // Invalidation tracking - keys to invalidate on next check
    this._invalidationQueue = new Set();
  }
  /**
   * Kiểm tra xem có thể mở position mới không
   * Sử dụng MySQL advisory lock (GET_LOCK) để tránh race condition
   * 
   * @param {Object} params - Parameters
   * @param {number} params.botId - Bot ID
   * @param {string} params.symbol - Trading symbol (e.g., 'BTC/USDT')
   * @param {number} params.newOrderAmount - Amount (USDT) của order mới
   * @returns {Promise<boolean>} true nếu có thể mở, false nếu đã chạm/vượt limit
   */
  async canOpenNewPosition({ botId, symbol, newOrderAmount }) {
    // Generate lock key: botId|symbol (normalized)
    const lockKey = `pos_limit_${botId}_${String(symbol).toUpperCase().replace(/[\/:_]/g, '')}`;
    const lockTimeout = 5; // 5 seconds timeout for lock acquisition
    
    let connection = null;
    try {
      // Get a dedicated connection for transaction
      connection = await pool.getConnection();
      
      // Acquire advisory lock to prevent concurrent access
      const [lockResult] = await connection.execute('SELECT GET_LOCK(?, ?) as lock_acquired', [lockKey, lockTimeout]);
      const lockAcquired = lockResult[0]?.lock_acquired === 1;
      
      if (!lockAcquired) {
        logger.warn(
          `[PositionLimitService] Failed to acquire lock for bot=${botId} symbol=${symbol} after ${lockTimeout}s timeout`
        );
        // If lock acquisition fails, reject to be safe
        return false;
      }

      try {
        // ✅ OPTIMIZED: Check cache first
        const cacheKey = `${botId}|${symbol}`;
        const cached = this._amountCache.get(cacheKey);
        const now = Date.now();
        
        let currentAmount;
        let maxAmountPerCoin;
        
        // Use cache if valid and not in invalidation queue
        if (cached && (now - cached.timestamp) < this._cacheTTL && 
            !this._invalidationQueue.has(cacheKey)) {
          currentAmount = cached.amount;
          maxAmountPerCoin = cached.maxAmount;
        } else {
          // Cache miss or expired - query database
          // Lấy max_amount_per_coin từ bot
          const bot = await Bot.findById(botId);
          if (!bot) {
            logger.warn(`[PositionLimitService] Bot ${botId} not found, allowing order`);
            return true; // Nếu không tìm thấy bot, cho phép để tránh block
          }

          // Check if max_amount_per_coin is set
          const maxAmountPerCoinRaw = bot.max_amount_per_coin;
          
          // Nếu max_amount_per_coin không được set (null/undefined), không có limit
          if (maxAmountPerCoinRaw === null || maxAmountPerCoinRaw === undefined) {
            return true;
          }

          maxAmountPerCoin = Number(maxAmountPerCoinRaw);

          // Nếu max_amount_per_coin = 0, reject toàn bộ
          if (maxAmountPerCoin === 0) {
            logger.warn(
              `[PositionLimitService] [POSITION_LIMIT_REACHED] bot=${botId} symbol=${symbol} ` +
              `max_amount_per_coin=0, rejecting all orders`
            );
            return false;
          }

          // Nếu max_amount_per_coin không hợp lệ (NaN, negative), không có limit
          if (!Number.isFinite(maxAmountPerCoin) || maxAmountPerCoin < 0) {
            return true;
          }

          // Query tổng USDT đang mở + pending cho symbol này (within lock)
          // Include both open positions AND pending LIMIT entry orders
          const [rows] = await connection.execute(
            `SELECT 
              COALESCE(SUM(CASE WHEN p.status = 'open' THEN p.amount ELSE 0 END), 0) AS positions_amount,
              COALESCE(SUM(CASE WHEN eo.status = 'open' THEN eo.amount ELSE 0 END), 0) AS pending_orders_amount
             FROM strategies s
             LEFT JOIN positions p ON p.strategy_id = s.id AND p.status = 'open' AND p.symbol = ?
             LEFT JOIN entry_orders eo ON eo.strategy_id = s.id AND eo.status = 'open' AND eo.symbol = ?
             WHERE s.bot_id = ? AND s.symbol = ?
             GROUP BY s.bot_id, s.symbol`,
            [symbol, symbol, botId, symbol]
          );

          const positionsAmount = Number(rows?.[0]?.positions_amount || 0);
          const pendingOrdersAmount = Number(rows?.[0]?.pending_orders_amount || 0);
          currentAmount = positionsAmount + pendingOrdersAmount;
          
          // Update cache
          this._amountCache.set(cacheKey, {
            amount: currentAmount,
            maxAmount: maxAmountPerCoin,
            timestamp: now
          });
          
          // Remove from invalidation queue
          this._invalidationQueue.delete(cacheKey);
        }

        const projectedAmount = currentAmount + Number(newOrderAmount || 0);

        // Reject nếu projectedAmount > maxAmountPerCoin (chỉ reject khi vượt, cho phép khi bằng)
        // ✅ FIX: Changed from >= to > to allow orders when projected equals max
        if (projectedAmount > maxAmountPerCoin) {
          logger.warn(
            `[PositionLimitService] [POSITION_LIMIT_REACHED] bot=${botId} symbol=${symbol} ` +
            `current=${currentAmount.toFixed(2)} new=${Number(newOrderAmount || 0).toFixed(2)} ` +
            `projected=${projectedAmount.toFixed(2)} max=${maxAmountPerCoin.toFixed(2)}`
          );
          return false;
        }

        return true;
      } finally {
        // Always release lock
        await connection.execute('SELECT RELEASE_LOCK(?)', [lockKey]);
      }
    } catch (error) {
      logger.error(
        `[PositionLimitService] Error checking position limit for bot ${botId}, symbol ${symbol}:`,
        error?.message || error
      );
      // Nếu có lỗi, cho phép để tránh block toàn bộ hệ thống
      // Nhưng log để debug
      return true;
    } finally {
      // Release connection back to pool
      if (connection) {
        connection.release();
      }
    }
  }

  /**
   * Invalidate cache cho một bot/symbol
   * Gọi method này khi có position/order được tạo hoặc đóng
   * 
   * @param {number} botId - Bot ID
   * @param {string} symbol - Trading symbol
   */
  invalidateCache(botId, symbol) {
    const cacheKey = `${botId}|${symbol}`;
    this._invalidationQueue.add(cacheKey);
    this._amountCache.delete(cacheKey);
  }

  /**
   * Lấy tổng amount hiện tại cho một symbol
   * 
   * @param {number} botId - Bot ID
   * @param {string} symbol - Trading symbol
   * @returns {Promise<number>} Tổng amount (USDT)
   */
  async getCurrentTotalAmount(botId, symbol) {
    try {
      const [rows] = await pool.execute(
        `SELECT 
          COALESCE(SUM(CASE WHEN p.status = 'open' THEN p.amount ELSE 0 END), 0) AS positions_amount,
          COALESCE(SUM(CASE WHEN eo.status = 'open' THEN eo.amount ELSE 0 END), 0) AS pending_orders_amount
         FROM strategies s
         LEFT JOIN positions p ON p.strategy_id = s.id AND p.status = 'open' AND p.symbol = ?
         LEFT JOIN entry_orders eo ON eo.strategy_id = s.id AND eo.status = 'open' AND eo.symbol = ?
         WHERE s.bot_id = ? AND s.symbol = ?
         GROUP BY s.bot_id, s.symbol`,
        [symbol, symbol, botId, symbol]
      );

      const positionsAmount = Number(rows?.[0]?.positions_amount || 0);
      const pendingOrdersAmount = Number(rows?.[0]?.pending_orders_amount || 0);
      return positionsAmount + pendingOrdersAmount;
    } catch (error) {
      logger.error(
        `[PositionLimitService] Error getting current total amount for bot ${botId}, symbol ${symbol}:`,
        error?.message || error
      );
      return 0;
    }
  }
}

// Export singleton instance
export const positionLimitService = new PositionLimitService();

