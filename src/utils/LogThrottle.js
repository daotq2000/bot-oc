/**
 * Log Throttle Utility
 * 
 * Throttles log messages to prevent excessive logging and reduce memory usage.
 * Useful for high-frequency operations like WebSocket price ticks, position updates, etc.
 */
export class LogThrottle {
  constructor(options = {}) {
    this.maxMessagesPerInterval = options.maxMessagesPerInterval || 10;
    this.intervalMs = options.intervalMs || 60000; // Default: 1 minute
    this.messageCounts = new Map(); // messageKey -> { count, firstTime, lastTime }
    this.cleanupInterval = null;
    
    // Cleanup old entries every 5 minutes
    this.startCleanup();
  }

  /**
   * Check if a log message should be throttled
   * @param {string} messageKey - Unique key for the message type (e.g., 'price-tick-BTCUSDT')
   * @returns {boolean} - true if message should be logged, false if throttled
   */
  shouldLog(messageKey) {
    const now = Date.now();
    const entry = this.messageCounts.get(messageKey);

    if (!entry) {
      // First time seeing this message
      this.messageCounts.set(messageKey, {
        count: 1,
        firstTime: now,
        lastTime: now
      });
      return true;
    }

    const timeSinceFirst = now - entry.firstTime;

    if (timeSinceFirst >= this.intervalMs) {
      // Interval expired, reset counter
      entry.count = 1;
      entry.firstTime = now;
      entry.lastTime = now;
      return true;
    }

    // Still within interval
    entry.count++;
    entry.lastTime = now;

    if (entry.count <= this.maxMessagesPerInterval) {
      return true;
    }

    // Throttled - log a summary if this is the first time exceeding limit
    if (entry.count === this.maxMessagesPerInterval + 1) {
      const elapsedSeconds = Math.floor(timeSinceFirst / 1000);
      console.warn(`[LogThrottle] Message "${messageKey}" throttled: ${entry.count} messages in ${elapsedSeconds}s (limit: ${this.maxMessagesPerInterval}/${Math.floor(this.intervalMs / 1000)}s)`);
    }

    return false;
  }

  /**
   * Get throttled log function
   * @param {Function} logger - Logger function (e.g., logger.info, logger.debug)
   * @param {string} messageKey - Unique key for throttling
   * @returns {Function} - Throttled logger function
   */
  wrapLogger(logger, messageKey) {
    return (...args) => {
      if (this.shouldLog(messageKey)) {
        logger(...args);
      }
    };
  }

  /**
   * Cleanup old entries to prevent memory leak
   */
  cleanup() {
    const now = Date.now();
    const maxAge = this.intervalMs * 2; // Keep entries for 2 intervals

    for (const [key, entry] of this.messageCounts.entries()) {
      if (now - entry.lastTime > maxAge) {
        this.messageCounts.delete(key);
      }
    }
  }

  /**
   * Start periodic cleanup
   */
  startCleanup() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
    }
    this.cleanupInterval = setInterval(() => {
      this.cleanup();
    }, 5 * 60 * 1000); // Every 5 minutes
  }

  /**
   * Stop cleanup interval
   */
  stop() {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }
    this.messageCounts.clear();
  }

  /**
   * Get statistics
   */
  getStats() {
    return {
      totalMessageTypes: this.messageCounts.size,
      messages: Array.from(this.messageCounts.entries()).map(([key, entry]) => ({
        key,
        count: entry.count,
        age: Date.now() - entry.firstTime
      }))
    };
  }
}

// Export singleton instance
export const logThrottle = new LogThrottle({
  maxMessagesPerInterval: 10,
  intervalMs: 60000 // 1 minute
});

