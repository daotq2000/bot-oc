import logger from './logger.js';
import { configService } from '../services/ConfigService.js';

/**
 * Memory Monitor
 * 
 * Monitors memory usage and triggers automatic cleanup when memory usage is high.
 * Helps prevent memory leaks and reduces overall memory consumption.
 */
export class MemoryMonitor {
  constructor() {
    this.checkInterval = configService.getNumber('MEMORY_CHECK_INTERVAL_MS', 60000); // Check every minute
    this.warningThreshold = configService.getNumber('MEMORY_WARNING_THRESHOLD_MB', 2048); // 2GB warning
    this.criticalThreshold = configService.getNumber('MEMORY_CRITICAL_THRESHOLD_MB', 3072); // 3GB critical
    this.maxMemoryMB = configService.getNumber('MAX_MEMORY_MB', 4096); // 4GB max
    this.isMonitoring = false;
    this.monitorInterval = null;
    this.lastCleanupTime = 0;
    this.cleanupCooldown = 5 * 60 * 1000; // Don't cleanup more than once per 5 minutes
  }

  /**
   * Start monitoring
   */
  start() {
    if (this.isMonitoring) return;
    
    this.isMonitoring = true;
    this.monitorInterval = setInterval(() => {
      this.checkMemory();
    }, this.checkInterval);

    logger.info(`[MemoryMonitor] Started monitoring (checkInterval=${this.checkInterval}ms, warning=${this.warningThreshold}MB, critical=${this.criticalThreshold}MB)`);
  }

  /**
   * Stop monitoring
   */
  stop() {
    if (!this.isMonitoring) return;
    
    this.isMonitoring = false;
    if (this.monitorInterval) {
      clearInterval(this.monitorInterval);
      this.monitorInterval = null;
    }
    
    logger.info('[MemoryMonitor] Stopped monitoring');
  }

  /**
   * Check memory usage and trigger cleanup if needed
   */
  checkMemory() {
    try {
      const usage = process.memoryUsage();
      const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024);
      const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024);
      const rssMB = Math.round(usage.rss / 1024 / 1024);
      const externalMB = Math.round(usage.external / 1024 / 1024);

      // Log memory stats periodically (every 5 minutes)
      if (Date.now() - this.lastCleanupTime > 5 * 60 * 1000) {
        logger.debug(`[MemoryMonitor] Memory usage: RSS=${rssMB}MB, Heap=${heapUsedMB}MB/${heapTotalMB}MB, External=${externalMB}MB`);
      }

      // Critical threshold: aggressive cleanup
      if (rssMB > this.criticalThreshold) {
        logger.warn(`[MemoryMonitor] ⚠️ CRITICAL: Memory usage ${rssMB}MB exceeds critical threshold ${this.criticalThreshold}MB. Triggering aggressive cleanup...`);
        this.triggerCleanup(true);
        return;
      }

      // Warning threshold: normal cleanup
      if (rssMB > this.warningThreshold) {
        logger.warn(`[MemoryMonitor] ⚠️ WARNING: Memory usage ${rssMB}MB exceeds warning threshold ${this.warningThreshold}MB. Triggering cleanup...`);
        this.triggerCleanup(false);
        return;
      }

      // Max memory threshold: force GC and aggressive cleanup
      if (rssMB > this.maxMemoryMB) {
        logger.error(`[MemoryMonitor] 🚨 MAX MEMORY: Memory usage ${rssMB}MB exceeds max ${this.maxMemoryMB}MB. Forcing GC and aggressive cleanup...`);
        this.forceGarbageCollection();
        this.triggerCleanup(true);
        return;
      }
    } catch (error) {
      logger.error('[MemoryMonitor] Error checking memory:', error?.message || error);
    }
  }

  /**
   * Trigger cleanup of all caches
   * @param {boolean} aggressive - If true, more aggressive cleanup
   */
  async triggerCleanup(aggressive = false) {
    // Prevent too frequent cleanups
    if (Date.now() - this.lastCleanupTime < this.cleanupCooldown && !aggressive) {
      return;
    }

    this.lastCleanupTime = Date.now();

    try {
      logger.info(`[MemoryMonitor] Starting ${aggressive ? 'aggressive' : 'normal'} cache cleanup...`);

      // Cleanup all caches
      const cleanupPromises = [];

      // WebSocketManager
      try {
        const { webSocketManager } = await import('../services/WebSocketManager.js');
        if (webSocketManager && typeof webSocketManager._cleanupPriceCache === 'function') {
          webSocketManager._cleanupPriceCache();
        }
      } catch (e) {}

      // OrderStatusCache
      try {
        const { orderStatusCache } = await import('../services/OrderStatusCache.js');
        if (orderStatusCache && typeof orderStatusCache.cleanup === 'function') {
          orderStatusCache.cleanup();
        }
      } catch (e) {}

      // ExchangeInfoService
      try {
        const { exchangeInfoService } = await import('../services/ExchangeInfoService.js');
        if (exchangeInfoService && typeof exchangeInfoService._cleanupCache === 'function') {
          exchangeInfoService._cleanupCache();
        }
      } catch (e) {}

      // BinanceDirectClient
      try {
        // BinanceDirectClient instances are per-bot, so we can't easily cleanup here
        // But the cache cleanup should happen automatically
      } catch (e) {}

      // ExchangeService
      try {
        // ExchangeService instances are per-bot, cleanup happens automatically
      } catch (e) {}

      // RealtimeOCDetector
      try {
        const { realtimeOCDetector } = await import('../services/RealtimeOCDetector.js');
        if (realtimeOCDetector && typeof realtimeOCDetector.cleanup === 'function') {
          realtimeOCDetector.cleanup();
        }
      } catch (e) {}

      // MexcWebSocketManager
      try {
        const { mexcPriceWs } = await import('../services/MexcWebSocketManager.js');
        if (mexcPriceWs && typeof mexcPriceWs._cleanupPriceCache === 'function') {
          mexcPriceWs._cleanupPriceCache();
        }
      } catch (e) {}

      // StrategyCache (only if aggressive)
      if (aggressive) {
        try {
          const { strategyCache } = await import('../services/StrategyCache.js');
          // Don't clear strategy cache, just log size
          if (strategyCache) {
            logger.debug(`[MemoryMonitor] StrategyCache size: ${strategyCache.size()}`);
          }
        } catch (e) {}
      }

      await Promise.allSettled(cleanupPromises);

      // Force GC if aggressive
      if (aggressive) {
        this.forceGarbageCollection();
      }

      // Log memory after cleanup
      const usage = process.memoryUsage();
      const rssMB = Math.round(usage.rss / 1024 / 1024);
      logger.info(`[MemoryMonitor] ✅ Cleanup completed. Memory after cleanup: ${rssMB}MB`);

    } catch (error) {
      logger.error('[MemoryMonitor] Error during cleanup:', error?.message || error);
    }
  }

  /**
   * Force garbage collection (if --expose-gc flag is enabled)
   */
  forceGarbageCollection() {
    if (global.gc && typeof global.gc === 'function') {
      try {
        global.gc();
        logger.debug('[MemoryMonitor] Forced garbage collection');
      } catch (e) {
        logger.debug('[MemoryMonitor] GC not available (run with --expose-gc flag)');
      }
    }
  }

  /**
   * Get current memory stats
   */
  getMemoryStats() {
    const usage = process.memoryUsage();
    return {
      rss: Math.round(usage.rss / 1024 / 1024), // MB
      heapUsed: Math.round(usage.heapUsed / 1024 / 1024), // MB
      heapTotal: Math.round(usage.heapTotal / 1024 / 1024), // MB
      external: Math.round(usage.external / 1024 / 1024), // MB
      arrayBuffers: Math.round(usage.arrayBuffers / 1024 / 1024) // MB
    };
  }
}

// Export singleton instance
export const memoryMonitor = new MemoryMonitor();

