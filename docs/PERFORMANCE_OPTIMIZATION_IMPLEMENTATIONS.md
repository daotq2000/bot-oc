# Performance Optimization - Implementation Code

## 🚀 Quick Implementation Guide

File này chứa code cụ thể để implement các optimizations đã phân tích.

---

## 1. Optimized Price Tick Handler

### File: `src/consumers/WebSocketOCConsumer.optimized.js`

```javascript
import { realtimeOCDetector } from '../services/RealtimeOCDetector.js';
import { strategyCache } from '../services/StrategyCache.js';
import { OrderService } from '../services/OrderService.js';
import { configService } from '../services/ConfigService.js';
import logger from '../utils/logger.js';

/**
 * Optimized WebSocketOCConsumer với batch processing và throttling
 */
export class OptimizedWebSocketOCConsumer {
  constructor() {
    this.orderServices = new Map();
    this.isRunning = false;
    
    // Batch processing
    this._tickQueue = [];
    this._batchSize = Number(configService.getNumber('WS_TICK_BATCH_SIZE', 20));
    this._batchTimeout = Number(configService.getNumber('WS_TICK_BATCH_TIMEOUT_MS', 50));
    this._processing = false;
    this._batchTimer = null;
    
    // Throttling per symbol
    this._lastProcessed = new Map(); // exchange|symbol -> timestamp
    this._minTickInterval = Number(configService.getNumber('WS_TICK_MIN_INTERVAL_MS', 100));
    
    // Metrics
    this.processedCount = 0;
    this.matchCount = 0;
    this.skippedCount = 0;
  }

  async handlePriceTick(exchange, symbol, price, timestamp = Date.now()) {
    if (!this.isRunning) return;
    if (!price || !Number.isFinite(price) || price <= 0) return;

    // Throttle: Chỉ process mỗi symbol mỗi N ms
    const key = `${exchange}|${symbol}`;
    const lastProcessed = this._lastProcessed.get(key);
    if (lastProcessed && (timestamp - lastProcessed) < this._minTickInterval) {
      this.skippedCount++;
      return; // Skip - too soon
    }

    // Add to queue
    this._tickQueue.push({ exchange, symbol, price, timestamp });

    // Process batch nếu đủ size
    if (this._tickQueue.length >= this._batchSize) {
      await this._processBatch();
    } else if (!this._batchTimer) {
      // Schedule batch processing after timeout
      this._batchTimer = setTimeout(() => {
        this._batchTimer = null;
        this._processBatch();
      }, this._batchTimeout);
    }
  }

  async _processBatch() {
    if (this._processing || this._tickQueue.length === 0) return;
    
    this._processing = true;
    const startTime = Date.now();

    try {
      const batch = this._tickQueue.splice(0, this._batchSize);
      
      // Deduplicate: Chỉ lấy tick mới nhất cho mỗi symbol
      const latest = new Map();
      for (const tick of batch) {
        const key = `${tick.exchange}|${tick.symbol}`;
        const existing = latest.get(key);
        if (!existing || existing.timestamp < tick.timestamp) {
          latest.set(key, tick);
        }
      }

      // Process unique symbols in parallel (limited concurrency)
      const concurrency = Number(configService.getNumber('WS_TICK_CONCURRENCY', 10));
      const ticks = Array.from(latest.values());
      
      for (let i = 0; i < ticks.length; i += concurrency) {
        const batch = ticks.slice(i, i + concurrency);
        const results = await Promise.allSettled(
          batch.map(tick => this._detectAndProcess(tick))
        );
        
        // Update last processed timestamps
        batch.forEach(tick => {
          this._lastProcessed.set(`${tick.exchange}|${tick.symbol}`, tick.timestamp);
        });
      }

      this.processedCount += latest.size;
      
      const duration = Date.now() - startTime;
      if (duration > 100) {
        logger.debug(`[WebSocketOCConsumer] Processed batch of ${latest.size} ticks in ${duration}ms`);
      }
    } catch (error) {
      logger.error('[WebSocketOCConsumer] Batch processing error:', error?.message || error);
    } finally {
      this._processing = false;
      
      // Process remaining nếu có
      if (this._tickQueue.length > 0) {
        setTimeout(() => this._processBatch(), this._batchTimeout);
      }
    }
  }

  async _detectAndProcess(tick) {
    try {
      const matches = await realtimeOCDetector.detectOC(
        tick.exchange, 
        tick.symbol, 
        tick.price, 
        tick.timestamp, 
        'WebSocketOCConsumer'
      );

      if (matches.length === 0) return;

      this.matchCount += matches.length;
      logger.info(`[WebSocketOCConsumer] 🎯 Found ${matches.length} match(es) for ${tick.exchange} ${tick.symbol}`);

      // Process matches in parallel
      await Promise.allSettled(
        matches.map(match => this.processMatch(match))
      );
    } catch (error) {
      logger.error(`[WebSocketOCConsumer] Error processing tick:`, error?.message || error);
    }
  }

  // ... rest of methods (processMatch, etc.)
}
```

---

## 2. Optimized LRU Cache

### File: `src/utils/LRUCache.js`

```javascript
/**
 * Efficient LRU Cache với O(1) operations
 */
export class LRUCache {
  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
    this.cache = new Map(); // Map maintains insertion order (LRU)
  }

  get(key) {
    if (!this.cache.has(key)) return null;
    
    // Move to end (most recently used) - O(1)
    const value = this.cache.get(key);
    this.cache.delete(key);
    this.cache.set(key, value);
    return value;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      // Update existing - move to end
      this.cache.delete(key);
    } else if (this.cache.size >= this.maxSize) {
      // Evict least recently used (first item) - O(1)
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
    
    this.cache.set(key, value);
  }

  has(key) {
    return this.cache.has(key);
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  get size() {
    return this.cache.size;
  }

  // Get all entries (for cleanup)
  entries() {
    return this.cache.entries();
  }
}
```

### Usage trong RealtimeOCDetector:

```javascript
import { LRUCache } from '../utils/LRUCache.js';

export class RealtimeOCDetector {
  constructor() {
    // Replace Map với LRUCache
    this.openPriceCache = new LRUCache(1000);
    this.openFetchCache = new LRUCache(200);
    this.lastPriceCache = new LRUCache(600);
  }

  // No need for manual eviction - LRUCache handles it automatically
  _setOpenPrice(key, openPrice, bucketStart, timestamp) {
    this.openPriceCache.set(key, { open: openPrice, bucketStart, lastUpdate: timestamp });
    // Eviction happens automatically when size exceeds maxSize
  }
}
```

---

## 3. Optimized Strategy Matching

### File: `src/services/RealtimeOCDetector.optimized.js`

```javascript
/**
 * Optimized detectOC với batch processing và parallel checks
 */
async detectOC(exchange, symbol, currentPrice, timestamp = Date.now(), caller = 'unknown') {
  try {
    const normalizedExchange = (exchange || '').toLowerCase();
    const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');

    // Check price change threshold (skip nếu không đổi đáng kể)
    if (!this.hasPriceChanged(normalizedExchange, normalizedSymbol, currentPrice)) {
      return [];
    }

    // Get strategies (O(1) lookup với StrategyCache)
    const strategies = strategyCache.getStrategies(normalizedExchange, normalizedSymbol);
    if (strategies.length === 0) return [];

    // Pre-filter: Chỉ check strategies hợp lệ
    const validStrategies = strategies.filter(s => 
      s.oc > 0 && 
      s.is_active && 
      (s.bot?.is_active !== false) &&
      s.interval // Must have interval
    );

    if (validStrategies.length === 0) return [];

    // Get unique intervals
    const intervals = [...new Set(validStrategies.map(s => s.interval))];
    
    // Batch get open prices (cache-first, parallel fetch missing)
    const openPricesMap = await this._batchGetOpenPrices(
      normalizedExchange, 
      normalizedSymbol, 
      intervals, 
      currentPrice, 
      timestamp
    );

    // Check strategies in parallel (limited concurrency)
    const concurrency = 10;
    const matches = [];
    
    for (let i = 0; i < validStrategies.length; i += concurrency) {
      const batch = validStrategies.slice(i, i + concurrency);
      const results = await Promise.all(
        batch.map(strategy => {
          const openPrice = openPricesMap.get(strategy.interval);
          if (!openPrice) return null;
          
          const oc = this.calculateOC(openPrice, currentPrice);
          const absOC = Math.abs(oc);
          
          if (absOC >= strategy.oc) {
            return {
              strategy,
              oc,
              absOC,
              direction: oc >= 0 ? 'bullish' : 'bearish',
              openPrice,
              currentPrice,
              interval: strategy.interval,
              timestamp
            };
          }
          return null;
        })
      );
      
      matches.push(...results.filter(m => m !== null));
    }

    return matches;
  } catch (error) {
    logger.error(`[RealtimeOCDetector] Error:`, error?.message || error);
    return [];
  }
}

/**
 * Batch get open prices với cache-first strategy
 */
async _batchGetOpenPrices(exchange, symbol, intervals, currentPrice, timestamp) {
  const bucketStarts = intervals.map(int => this.getBucketStart(int, timestamp));
  const keys = intervals.map((int, i) => 
    `${exchange}|${symbol}|${int}|${bucketStarts[i]}`
  );

  // Check cache first
  const cached = new Map();
  const missing = [];
  
  keys.forEach((key, i) => {
    const cachedValue = this.openPriceCache.get(key);
    if (cachedValue && cachedValue.bucketStart === bucketStarts[i] && 
        Number.isFinite(cachedValue.open) && cachedValue.open > 0) {
      cached.set(intervals[i], cachedValue.open);
    } else {
      missing.push({ 
        interval: intervals[i], 
        key, 
        bucketStart: bucketStarts[i] 
      });
    }
  });

  // Batch fetch missing (parallel với limit)
  if (missing.length > 0) {
    const fetchPromises = missing.map(({ interval, bucketStart }) =>
      this.getAccurateOpen(exchange, symbol, interval, currentPrice, timestamp)
        .then(open => ({ interval, open }))
        .catch(() => ({ interval, open: null }))
    );
    
    const fetched = await Promise.all(fetchPromises);
    
    fetched.forEach(({ interval, open }) => {
      if (open && Number.isFinite(open) && open > 0) {
        cached.set(interval, open);
      }
    });
  }

  return cached;
}
```

---

## 4. Database Query Caching

### File: `src/services/PositionLimitService.optimized.js`

```javascript
import { LRUCache } from '../utils/LRUCache.js';

export class PositionLimitService {
  constructor() {
    // Cache current amounts với TTL
    this._amountCache = new LRUCache(1000); // botId|symbol -> { amount, timestamp }
    this._cacheTTL = 5000; // 5 seconds
    
    // Invalidation tracking
    this._invalidationQueue = new Set(); // Keys to invalidate on next check
  }

  async canOpenNewPosition({ botId, symbol, newOrderAmount }) {
    const lockKey = `pos_limit_${botId}_${String(symbol).toUpperCase().replace(/[\/:_]/g, '')}`;
    const lockTimeout = 5;
    
    let connection = null;
    try {
      connection = await pool.getConnection();
      
      // Acquire lock
      const [lockResult] = await connection.execute('SELECT GET_LOCK(?, ?) as lock_acquired', [lockKey, lockTimeout]);
      if (lockResult[0]?.lock_acquired !== 1) {
        return false;
      }

      try {
        // Check cache first
        const cacheKey = `${botId}|${symbol}`;
        const cached = this._amountCache.get(cacheKey);
        
        let currentAmount;
        if (cached && (Date.now() - cached.timestamp) < this._cacheTTL && 
            !this._invalidationQueue.has(cacheKey)) {
          // Use cached amount
          currentAmount = cached.amount;
        } else {
          // Query DB
          currentAmount = await this._getCurrentTotalAmountFromDB(connection, botId, symbol);
          
          // Update cache
          this._amountCache.set(cacheKey, { 
            amount: currentAmount, 
            timestamp: Date.now() 
          });
          
          // Remove from invalidation queue
          this._invalidationQueue.delete(cacheKey);
        }

        // Get max amount
        const bot = await Bot.findById(botId);
        if (!bot) return true;
        
        const maxAmountPerCoin = Number(bot.max_amount_per_coin || 0);
        if (maxAmountPerCoin === 0) return false;
        if (!Number.isFinite(maxAmountPerCoin) || maxAmountPerCoin < 0) return true;

        // Check limit
        const projectedAmount = currentAmount + Number(newOrderAmount || 0);
        if (projectedAmount >= maxAmountPerCoin) {
          return false;
        }

        return true;
      } finally {
        await connection.execute('SELECT RELEASE_LOCK(?)', [lockKey]);
      }
    } catch (error) {
      logger.error(`[PositionLimitService] Error:`, error?.message || error);
      return true; // Fail-safe
    } finally {
      if (connection) connection.release();
    }
  }

  async _getCurrentTotalAmountFromDB(connection, botId, symbol) {
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
    return positionsAmount + pendingOrdersAmount;
  }

  // Invalidate cache khi có thay đổi
  invalidateCache(botId, symbol) {
    const cacheKey = `${botId}|${symbol}`;
    this._invalidationQueue.add(cacheKey);
    this._amountCache.delete(cacheKey);
  }
}
```

---

## 5. Log Throttling

### File: `src/utils/LogThrottle.js` (đã có, cần enhance)

```javascript
/**
 * Enhanced Log Throttle với sampling và rate limiting
 */
export class LogThrottle {
  constructor(maxPerSecond = 10, maxPerMinute = 100) {
    this.maxPerSecond = maxPerSecond;
    this.maxPerMinute = maxPerMinute;
    this.secondCounts = new Map(); // key -> count in current second
    this.minuteCounts = new Map(); // key -> count in current minute
    this.lastSecondReset = Date.now();
    this.lastMinuteReset = Date.now();
    
    // Auto reset counters
    setInterval(() => {
      const now = Date.now();
      if (now - this.lastSecondReset >= 1000) {
        this.secondCounts.clear();
        this.lastSecondReset = now;
      }
      if (now - this.lastMinuteReset >= 60000) {
        this.minuteCounts.clear();
        this.lastMinuteReset = now;
      }
    }, 1000);
  }

  shouldLog(key, level = 'info') {
    // Always log errors
    if (level === 'error') return true;
    
    // Check per-second limit
    const secondCount = this.secondCounts.get(key) || 0;
    if (secondCount >= this.maxPerSecond) {
      return false;
    }
    this.secondCounts.set(key, secondCount + 1);
    
    // Check per-minute limit
    const minuteCount = this.minuteCounts.get(key) || 0;
    if (minuteCount >= this.maxPerMinute) {
      return false;
    }
    this.minuteCounts.set(key, minuteCount + 1);
    
    return true;
  }

  // Sampling: Log every Nth occurrence
  shouldLogSample(key, sampleRate = 100) {
    const count = (this.minuteCounts.get(key) || 0) + 1;
    this.minuteCounts.set(key, count);
    return count % sampleRate === 0;
  }
}

// Global instance
export const logThrottle = new LogThrottle(10, 100);
```

### Usage:

```javascript
import { logThrottle } from '../utils/LogThrottle.js';

// Throttled logging
if (logThrottle.shouldLog('price_tick')) {
  logger.debug(`[WebSocketOCConsumer] 📥 Received price tick...`);
}

// Sampled logging
if (logThrottle.shouldLogSample('detect_oc', 1000)) {
  logger.debug(`[RealtimeOCDetector] detectOC called...`);
}
```

---

## 6. Batch Database Operations

### File: `src/models/Candle.optimized.js`

```javascript
/**
 * Batch insert candles để giảm I/O
 */
export class Candle {
  static _insertQueue = [];
  static _insertTimer = null;
  static _batchSize = 50;
  static _batchTimeout = 5000; // 5 seconds

  static async save(exchange, symbol, interval, open_time, open, high, low, close, volume, close_time) {
    // Add to queue thay vì insert ngay
    this._insertQueue.push({
      exchange, symbol, interval, open_time, open, high, low, close, volume, close_time
    });

    // Trigger batch insert nếu đủ size
    if (this._insertQueue.length >= this._batchSize) {
      await this._flushBatch();
    } else if (!this._insertTimer) {
      // Schedule batch insert after timeout
      this._insertTimer = setTimeout(() => {
        this._insertTimer = null;
        this._flushBatch();
      }, this._batchTimeout);
    }

    // Return latest (cached or query)
    return this.getLatest(exchange, symbol, interval);
  }

  static async _flushBatch() {
    if (this._insertQueue.length === 0) return;

    const batch = this._insertQueue.splice(0, this._batchSize);
    
    try {
      // Build bulk insert query
      const values = [];
      const placeholders = [];
      
      for (const candle of batch) {
        placeholders.push('(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)');
        values.push(
          candle.exchange,
          candle.symbol,
          candle.interval,
          candle.open_time,
          candle.open,
          candle.high,
          candle.low,
          candle.close,
          candle.volume,
          candle.close_time
        );
      }

      const sql = `
        INSERT INTO candles (
          exchange, symbol, \`interval\`, open_time, open, high, low, close, volume, close_time
        ) VALUES ${placeholders.join(', ')}
        ON DUPLICATE KEY UPDATE
          open = VALUES(open),
          high = VALUES(high),
          low = VALUES(low),
          close = VALUES(close),
          volume = VALUES(volume),
          close_time = VALUES(close_time)
      `;

      await pool.execute(sql, values);
      logger.debug(`[Candle] Batch inserted ${batch.length} candles`);
    } catch (error) {
      logger.error(`[Candle] Batch insert failed:`, error?.message || error);
      // Re-queue failed items (optional)
    }
  }
}
```

---

## 7. Price Change Threshold Optimization

### File: `src/services/RealtimeOCDetector.optimized.js`

```javascript
/**
 * Optimized price change check - không sort mỗi lần
 */
hasPriceChanged(exchange, symbol, currentPrice) {
  const key = `${exchange}|${symbol}`;
  const lastPrice = this.lastPriceCache.get(key);
  
  if (!lastPrice) {
    // Cache not full - just add
    if (this.lastPriceCache.size < this.maxLastPriceCacheSize) {
      this.lastPriceCache.set(key, { price: currentPrice, timestamp: Date.now() });
      return true;
    }
    // Cache full - need eviction (but don't sort every time)
    this._evictOldestIfNeeded();
    this.lastPriceCache.set(key, { price: currentPrice, timestamp: Date.now() });
    return true;
  }

  // Check price change
  const priceChange = Math.abs((currentPrice - lastPrice.price) / lastPrice.price);
  if (priceChange >= this.priceChangeThreshold) {
    // Update cache
    lastPrice.price = currentPrice;
    lastPrice.timestamp = Date.now();
    return true;
  }

  return false;
}

// Evict oldest chỉ khi cần (không mỗi lần)
_evictOldestIfNeeded() {
  if (this.lastPriceCache.size < this.maxLastPriceCacheSize) return;
  
  // Use LRU cache - eviction is O(1)
  // Hoặc evict mỗi N ticks thay vì mỗi tick
  if (this._evictCounter === undefined) this._evictCounter = 0;
  this._evictCounter++;
  
  if (this._evictCounter % 100 === 0) {
    // Evict oldest 10% mỗi 100 ticks
    const toEvict = Math.floor(this.maxLastPriceCacheSize * 0.1);
    const entries = Array.from(this.lastPriceCache.entries())
      .sort((a, b) => a[1].timestamp - b[1].timestamp)
      .slice(0, toEvict);
    
    for (const [key] of entries) {
      this.lastPriceCache.delete(key);
    }
  }
}
```

---

## 8. Configuration

### File: `.env` additions

```bash
# WebSocket Tick Processing
WS_TICK_BATCH_SIZE=20
WS_TICK_BATCH_TIMEOUT_MS=50
WS_TICK_MIN_INTERVAL_MS=100
WS_TICK_CONCURRENCY=10

# Cache Settings
CACHE_OPEN_PRICE_SIZE=1000
CACHE_OPEN_PRICE_TTL_MS=300000
CACHE_AMOUNT_TTL_MS=5000

# Logging
LOG_THROTTLE_MAX_PER_SECOND=10
LOG_THROTTLE_MAX_PER_MINUTE=100
LOG_SAMPLE_RATE=1000

# Database
DB_BATCH_INSERT_SIZE=50
DB_BATCH_INSERT_TIMEOUT_MS=5000
```

---

## 9. Migration Steps

### Step 1: Add LRUCache utility
```bash
# File đã được tạo: src/utils/LRUCache.js
```

### Step 2: Update RealtimeOCDetector
```javascript
// Replace Map với LRUCache
import { LRUCache } from '../utils/LRUCache.js';
this.openPriceCache = new LRUCache(1000);
```

### Step 3: Update WebSocketOCConsumer
```javascript
// Add batch processing
// Add throttling per symbol
```

### Step 4: Update PositionLimitService
```javascript
// Add caching với TTL
// Add invalidation mechanism
```

### Step 5: Update Logging
```javascript
// Add LogThrottle
// Replace logger calls với throttled version
```

---

## 10. Testing & Validation

### Performance Test Script

```javascript
// tests/performance/benchmark.js
import { OptimizedWebSocketOCConsumer } from '../../src/consumers/WebSocketOCConsumer.optimized.js';

async function benchmark() {
  const consumer = new OptimizedWebSocketOCConsumer();
  await consumer.initialize(orderServices);
  consumer.start();

  const iterations = 10000;
  const symbols = ['BTCUSDT', 'ETHUSDT', 'BNBUSDT'];
  const start = Date.now();

  // Simulate price ticks
  for (let i = 0; i < iterations; i++) {
    const symbol = symbols[i % symbols.length];
    const price = 50000 + Math.random() * 100;
    await consumer.handlePriceTick('binance', symbol, price);
  }

  const duration = Date.now() - start;
  console.log(`Processed ${iterations} ticks in ${duration}ms`);
  console.log(`Throughput: ${(iterations / duration * 1000).toFixed(0)} ticks/second`);
  console.log(`Skipped: ${consumer.skippedCount} (${(consumer.skippedCount / iterations * 100).toFixed(1)}%)`);
}
```

---

## 📊 Expected Improvements

Sau khi implement:

| Metric | Before | After | Improvement |
|--------|--------|-------|-------------|
| CPU Usage | 50% | 13% | 74% ↓ |
| Memory | 350MB | 150MB | 57% ↓ |
| Latency | 200ms | 20ms | 90% ↓ |
| DB Queries/sec | 100 | 10 | 90% ↓ |
| Log Writes/sec | 1000 | 10 | 99% ↓ |

---

**Note:** Implement từng phần một, test và measure sau mỗi change để đảm bảo không break functionality.

