import logger from '../utils/logger.js';

/**
 * Order Status Cache - Stores order status from WebSocket ORDER_TRADE_UPDATE events
 * This avoids REST API calls to check order status, reducing rate limit issues
 */
class OrderStatusCache {
  constructor() {
    // Map: orderId -> { status, filled, avgPrice, symbol, updatedAt }
    this.cache = new Map();
    this.ttl = 3 * 60 * 1000; // 3 minutes TTL for cached entries (reduced from 5)
    this.maxCacheSize = 500; // Maximum number of orders to cache (reduced from 10000 to save memory)
  }

  /**
   * Update order status from WebSocket event
   * @param {string} orderId - Order ID
   * @param {Object} data - Order data from ORDER_TRADE_UPDATE
   */
  updateOrderStatus(orderId, data) {
    if (!orderId) return;

    const status = data.status || data.orderStatus || 'UNKNOWN';
    const filled = Number(data.filled || data.cumQty || data.filledQty || 0);
    const avgPrice = data.avgPrice ? Number(data.avgPrice) : (data.price ? Number(data.price) : null);
    const symbol = data.symbol || data.s || null;

    const normalizedStatus = this._normalizeStatus(status);
    
    // Enforce max cache size (LRU eviction)
    if (this.cache.size >= this.maxCacheSize && !this.cache.has(String(orderId))) {
      // Remove oldest entry
      const oldest = Array.from(this.cache.entries())
        .sort((a, b) => a[1].updatedAt - b[1].updatedAt)[0];
      if (oldest) this.cache.delete(oldest[0]);
    }
    
    this.cache.set(String(orderId), {
      status: normalizedStatus,
      filled: filled,
      avgPrice: avgPrice,
      symbol: symbol,
      updatedAt: Date.now()
    });

    logger.debug(`[OrderStatusCache] Updated order ${orderId}: status=${normalizedStatus}, filled=${filled}, avgPrice=${avgPrice}`);
  }

  /**
   * Get cached order status
   * @param {string} orderId - Order ID
   * @returns {Object|null} { status, filled, avgPrice, symbol } or null if not cached/expired
   */
  getOrderStatus(orderId) {
    if (!orderId) return null;

    const cached = this.cache.get(String(orderId));
    if (!cached) return null;

    // Check TTL
    const age = Date.now() - cached.updatedAt;
    if (age > this.ttl) {
      this.cache.delete(String(orderId));
      return null;
    }

    return {
      status: cached.status,
      filled: cached.filled,
      avgPrice: cached.avgPrice,
      symbol: cached.symbol
    };
  }

  /**
   * Check if order is filled (from cache)
   * @param {string} orderId - Order ID
   * @returns {boolean} True if order is filled
   */
  isOrderFilled(orderId) {
    const cached = this.getOrderStatus(orderId);
    if (!cached) return false;
    return cached.status === 'closed' || cached.status === 'FILLED';
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
    for (const [orderId, data] of this.cache.entries()) {
      if (now - data.updatedAt > this.ttl) {
        this.cache.delete(orderId);
        cleaned++;
      }
    }
    if (cleaned > 0) {
      logger.debug(`[OrderStatusCache] Cleaned up ${cleaned} expired entries`);
    }
  }

  /**
   * Clear all cache
   */
  clear() {
    this.cache.clear();
  }

  /**
   * Get cache size
   */
  size() {
    return this.cache.size;
  }
}

// Singleton instance
export const orderStatusCache = new OrderStatusCache();

// Periodic cleanup (more frequent to save memory)
setInterval(() => orderStatusCache.cleanup(), 30000); // Every 30 seconds (reduced from 1 minute)

export default OrderStatusCache;

