import logger from '../utils/logger.js';

/**
 * Order Status Cache - Stores order status from WebSocket ORDER_TRADE_UPDATE events
 * This avoids REST API calls to check order status, reducing rate limit issues
 * 
 * Features:
 * - LRU eviction using Map insertion order (O(1))
 * - Exchange-aware cache keys to prevent collisions
 * - Terminal state protection (FILLED orders cannot be overwritten)
 * - TTL-based expiration
 */
class OrderStatusCache {
  constructor() {
    // Map: exchange:orderId -> { status, filled, avgPrice, symbol, updatedAt, exchange }
    // Uses Map insertion order for O(1) LRU eviction
    this.cache = new Map();
    this.ttl = 3 * 60 * 1000; // 3 minutes TTL for cached entries (reduced from 5)
    this.maxCacheSize = 500; // Maximum number of orders to cache (reduced from 10000 to save memory)
    this._cleanupTimer = null; // Track cleanup interval to prevent multiple timers
  }

  /**
   * Generate cache key with exchange prefix to prevent collisions
   * @param {string} orderId - Order ID
   * @param {string} exchange - Exchange name (optional, defaults to 'binance' for backward compatibility)
   * @returns {string} Cache key
   */
  _generateCacheKey(orderId, exchange = 'binance') {
    const normalizedExchange = (exchange || 'binance').toLowerCase();
    return `${normalizedExchange}:${String(orderId)}`;
  }

  /**
   * Update order status from WebSocket event
   * @param {string} orderId - Order ID
   * @param {Object} data - Order data from ORDER_TRADE_UPDATE
   * @param {string} exchange - Exchange name (optional, defaults to 'binance')
   */
  updateOrderStatus(orderId, data, exchange = 'binance') {
    if (!orderId) return;

    const cacheKey = this._generateCacheKey(orderId, exchange);
    
    // CRITICAL FIX: Terminal state protection - don't overwrite FILLED/closed orders
    const existing = this.cache.get(cacheKey);
    if (existing && existing.status === 'closed') {
      logger.debug(`[OrderStatusCache] Order ${orderId} already closed, ignoring update`);
      return;
    }

    const status = data.status || data.orderStatus || 'UNKNOWN';
    // CRITICAL FIX: Use cumQty (cumulative quantity) for filled amount
    // Note: Binance WS sends cumQty, some exchanges may send filledQty or filled
    // This represents the total filled quantity so far (important for partial fills)
    const filled = Number(data.filled || data.cumQty || data.filledQty || 0);
    
    // CRITICAL FIX: Don't use price as fallback for avgPrice (semantically incorrect)
    // price = limit price (order price), avgPrice = execution price (actual fill price)
    // Using price as avgPrice would cause incorrect PnL calculation and TP/SL placement
    const avgPrice = data.avgPrice != null ? Number(data.avgPrice) : null;
    const symbol = data.symbol || data.s || null;

    const normalizedStatus = this._normalizeStatus(status);
    
    // CRITICAL FIX: O(1) LRU eviction using Map insertion order
    // Map in JavaScript maintains insertion order, so oldest entry is first
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(cacheKey)) {
      // Remove oldest entry (first in Map)
      const oldestKey = this.cache.keys().next().value;
      if (oldestKey) {
        this.cache.delete(oldestKey);
        logger.debug(`[OrderStatusCache] Evicted oldest order ${oldestKey} (LRU)`);
      }
    }
    
    // CRITICAL FIX: Delete before set to move entry to end (true LRU)
    // This ensures most recently used entries are at the end
    if (this.cache.has(cacheKey)) {
      this.cache.delete(cacheKey);
    }
    
    this.cache.set(cacheKey, {
      status: normalizedStatus,
      filled: filled,
      avgPrice: avgPrice,
      symbol: symbol,
      exchange: (exchange || 'binance').toLowerCase(),
      updatedAt: Date.now()
    });

    logger.debug(`[OrderStatusCache] Updated order ${orderId} (${exchange}): status=${normalizedStatus}, filled=${filled}, avgPrice=${avgPrice}`);
  }

  /**
   * Get cached order status
   * @param {string} orderId - Order ID
   * @param {string} exchange - Exchange name (optional, defaults to 'binance')
   * @returns {Object|null} { status, filled, avgPrice, symbol, exchange } or null if not cached/expired
   */
  getOrderStatus(orderId, exchange = 'binance') {
    if (!orderId) return null;

    const cacheKey = this._generateCacheKey(orderId, exchange);
    const cached = this.cache.get(cacheKey);
    if (!cached) return null;

    // Check TTL
    const age = Date.now() - cached.updatedAt;
    if (age > this.ttl) {
      this.cache.delete(cacheKey);
      return null;
    }

    // CRITICAL FIX: Move to end on access (true LRU)
    // Delete and re-insert to update insertion order
    this.cache.delete(cacheKey);
    this.cache.set(cacheKey, cached);

    return {
      status: cached.status,
      filled: cached.filled,
      avgPrice: cached.avgPrice,
      symbol: cached.symbol,
      exchange: cached.exchange
    };
  }

  /**
   * Check if order is filled (from cache)
   * @param {string} orderId - Order ID
   * @param {string} exchange - Exchange name (optional, defaults to 'binance')
   * @returns {boolean} True if order is filled
   */
  isOrderFilled(orderId, exchange = 'binance') {
    const cached = this.getOrderStatus(orderId, exchange);
    if (!cached) return false;
    // CRITICAL FIX: _normalizeStatus() returns 'closed' for FILLED, not 'FILLED'
    // Check only normalized status to avoid logic errors
    return cached.status === 'closed';
  }

  /**
   * Normalize Binance order status to our format
   * @param {string} status - Binance status (NEW, PARTIALLY_FILLED, FILLED, etc.)
   * @returns {string} Normalized status
   */
  _normalizeStatus(status) {
    const s = String(status || '').toUpperCase();
    const statusMap = {
      'NEW': 'open',
      'PARTIALLY_FILLED': 'open',
      'FILLED': 'closed',
      'CANCELED': 'canceled',
      'CANCELLED': 'canceled',
      'EXPIRED': 'canceled',
      'REJECTED': 'canceled'
    };
    return statusMap[s] || s;
  }

  /**
   * Clear expired entries
   */
  cleanup() {
    const now = Date.now();
    let cleaned = 0;
    for (const [cacheKey, data] of this.cache.entries()) {
      if (now - data.updatedAt > this.ttl) {
        this.cache.delete(cacheKey);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[OrderStatusCache] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Start periodic cleanup timer
   * CRITICAL FIX: Prevent multiple intervals from being created
   */
  startCleanupTimer() {
    if (this._cleanupTimer) {
      logger.debug('[OrderStatusCache] Cleanup timer already running');
      return;
    }
    
    // Periodic cleanup (more frequent to save memory)
    this._cleanupTimer = setInterval(() => {
      this.cleanup();
    }, 30000); // Every 30 seconds (reduced from 1 minute)
    
    logger.debug('[OrderStatusCache] Cleanup timer started');
  }

  /**
   * Stop periodic cleanup timer
   */
  stopCleanupTimer() {
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
      logger.debug('[OrderStatusCache] Cleanup timer stopped');
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
    logger.debug('[OrderStatusCache] Cache cleared');
  }

  /**
   * Get cache size
   * @returns {number} Number of cached orders
   */
  size() {
    return this.cache.size;
  }

  /**
   * Destroy cache and cleanup resources
   */
  destroy() {
    this.stopCleanupTimer();
    this.clear();
  }
}

// Singleton instance
export const orderStatusCache = new OrderStatusCache();

// CRITICAL FIX: Start cleanup timer explicitly instead of global setInterval
// This prevents multiple intervals when module is reloaded or in tests
orderStatusCache.startCleanupTimer();

export default OrderStatusCache;

