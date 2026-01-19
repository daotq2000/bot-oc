import WebSocket from 'ws';
import logger from '../utils/logger.js';
import { CandleAggregator } from './CandleAggregator.js';
import { configService } from './ConfigService.js';

/**
 * Binance Futures WebSocket Manager (public markPrice stream)
 * - Supports thousands of symbols by sharding subscriptions across multiple connections
 * - Parses tick messages and updates an in-memory price cache
 */
class WebSocketManager {
  constructor() {
    this.connections = []; // [{ ws, streams:Set<string>, url, reconnectAttempts, latencyHistory }]
    this.priceCache = new Map(); // symbol -> { price, bid, ask, lastAccess }
    this._priceHandlers = new Set(); // listeners for price ticks
    this._latencyHandlers = new Set(); // listeners for ws latency
    this.klineOpenCache = new Map(); // key: symbol|interval|bucketStart -> { open, lastUpdate }
    this.klineCloseCache = new Map(); // key: symbol|interval|bucketStart -> { close, lastUpdate }
    
    // ✅ FIX: Message processing monitoring để đảm bảo bot không ngừng hoạt động
    this._messageStats = {
      totalReceived: 0,
      totalProcessed: 0,
      totalErrors: 0,
      lastMessageAt: 0,
      lastProcessedAt: 0
    };

    // ✅ TICK QUEUE + PROCESSOR: WS thread chỉ parse + update cache + enqueue tick
    // Consumer processing chạy ở loop riêng để WS không bao giờ bị block
    this.tickQueue = [];
    this.maxTickQueueSize = Number(configService.getNumber('BINANCE_WS_MAX_TICK_QUEUE_SIZE', 10000));
    this.tickQueueDropOldest = true;
    this.tickQueueStats = {
      enqueued: 0,
      dropped: 0,
      drained: 0,
      lastEnqueueAt: 0,
      lastDrainAt: 0
    };
    this.tickProcessorRunning = false;
    this.tickProcessorScheduled = false;
    this.tickDrainBatchSize = Number(configService.getNumber('BINANCE_WS_TICK_DRAIN_BATCH_SIZE', 500));
    this.tickStarvationThresholdMs = Number(configService.getNumber('BINANCE_WS_TICK_STARVATION_MS', 5000));

    // ✅ MARKET WS KEEPALIVE (PING/PONG)
    this.wsPingIntervalMs = Number(configService.getNumber('BINANCE_WS_PING_INTERVAL_MS', 20000));
    this.wsPongTimeoutMs = Number(configService.getNumber('BINANCE_WS_PONG_TIMEOUT_MS', 15000));

    // ✅ PRICE HANDLER PROFILING
    this.priceHandlerSlowThresholdMs = Number(configService.getNumber('BINANCE_WS_PRICE_HANDLER_SLOW_MS', 20));

    // ✅ LOG RATE LIMITING
    this.processingLagLogIntervalMs = Number(configService.getNumber('BINANCE_WS_PROCESSING_LAG_LOG_INTERVAL_MS', 10000));
    this.slowHandlerLogIntervalMs = Number(configService.getNumber('BINANCE_WS_SLOW_HANDLER_LOG_INTERVAL_MS', 10000));
    this._lastProcessingLagLogAt = 0;
    this._slowHandlerAgg = { windowStart: 0, count: 0, maxMs: 0, sampleSymbol: null };
    this._slowHandlersByName = new Map(); // name -> { count, totalMs, maxMs, sampleSymbol }
    this._lastSlowHandlersReportAt = 0;
    this.slowHandlersTopN = Number(configService.getNumber('BINANCE_WS_SLOW_HANDLER_TOP_N', 5));

    this.candleAggregator = new CandleAggregator(['1m', '5m', '15m', '30m']);

    this.baseUrl = 'wss://fstream.binance.com/stream?streams=';
    // ✅ BINANCE LIMITS: Theo tài liệu chính thức Binance
    // - Tối đa 1024 streams/connection (theo lý thuyết)
    // - NHƯNG URL có giới hạn độ dài (thường 2048-8192 ký tự)
    // - Với format stream: "btcusdt@bookTicker/" ≈ 20 ký tự/stream
    // - Base URL: ~45 ký tự
    // - Tính toán: 200 streams = 45 + 200*20 = ~4045 ký tự (an toàn)
    // - Giới hạn 5 messages/s cho subscribe/unsubscribe/ping
    // - 300 connections mới mỗi 5 phút trên cùng IP
    // ✅ ROOT CAUSE FIX: Giảm streams/connection để giảm message rate và event loop backlog
    // Với 100 streams, mỗi connection nhận ~100-200 messages/second → quá tải
    // Giảm xuống 50 streams/connection → ~50-100 messages/second → dễ xử lý hơn
    this.maxStreamsPerConn = 50; // Giảm từ 100 xuống 50 để giảm processing lag và latency
    this.maxUrlLength = 8000; // Max URL length (an toàn dưới 8192)
    this.maxReconnectAttempts = 10;
    this.maxPriceCacheSize = 1000; // Maximum number of symbols to cache (reduced from 5000 to save memory)
    this.priceCacheCleanupInterval = 1 * 60 * 1000; // Cleanup every 1 minute (reduced from 5 minutes)
    this._cleanupTimer = null;

    // ✅ LATENCY MONITORING: Track latency và auto-reconnect nếu latency cao liên tục
    this.highLatencyThreshold = 2000; // 2 seconds - threshold để coi là "high latency"
    this.extremeLatencyThreshold = 4000; // 4 seconds - extreme latency, reconnect (kline only)
    this.highLatencyCountThreshold = 5; // Nếu có 5 lần latency cao liên tục → reconnect
    this.latencyCheckWindow = 10000; // 10 seconds window để check latency history
    this.latencyReconnectCooldownMs = 30000; // 30s cooldown after a latency-based reconnect (per-connection)

    // ✅ LIFO SYMBOL MANAGEMENT: Track symbol usage và unsubscribe symbols không được sử dụng
    this.symbolUsage = new Map(); // symbol -> { lastAccess, accessCount, streams: Set<string> }
    // ✅ BINANCE LIMIT: Tính toán maxTotalStreams dựa trên số connections hợp lý
    // Với maxStreamsPerConn = 1000, nếu có 3 connections = 3000 streams (an toàn)
    // Nhưng để tránh quá tải, giữ ở 2000 streams
    // With bookTicker + kline_1m only: 2 streams/symbol.
    // 2000 streams supports ~1000 symbols, enough for current 500+ symbols use-case.
    this.maxTotalStreams = 2000; // Max total streams across all connections
    this.symbolUnusedTimeout = 10 * 60 * 1000; // Unsubscribe symbols không được sử dụng trong 10 phút
    this.symbolCleanupInterval = 2 * 60 * 1000; // Cleanup symbols mỗi 2 phút
    this._symbolCleanupTimer = null;

    // ✅ BINANCE RATE LIMITING: Giới hạn subscribe/unsubscribe messages
    // Binance limit: 5 messages/s cho subscribe/unsubscribe/ping
    this.subscribeRateLimit = 5; // messages per second
    this.subscribeMessageQueue = []; // Queue for subscribe/unsubscribe messages
    this.subscribeLastSent = 0; // Timestamp of last subscribe message
    this._subscribeQueueTimer = null;

    // ✅ BINANCE CONNECTION RATE LIMITING: 300 connections mới mỗi 5 phút
    this.maxNewConnectionsPer5Min = 300; // Binance limit
    this.connectionHistory = []; // [{ timestamp }] - track new connections
    this.connectionHistoryWindow = 5 * 60 * 1000; // 5 minutes

    // ✅ TIME SYNC: giảm false-positive latency do lệch clock local vs Binance
    this.serverTimeSyncTTL = Number(configService.getNumber('BINANCE_TIME_SYNC_TTL_MS', 60000));
    this.serverTimeSyncTimeoutMs = Number(configService.getNumber('BINANCE_TIME_SYNC_TIMEOUT_MS', 5000));

    // ✅ RECONNECT policy
    this.minReconnectDelayMs = Number(configService.getNumber('BINANCE_WS_RECONNECT_MIN_DELAY_MS', 1000));
    this.maxReconnectDelayMs = Number(configService.getNumber('BINANCE_WS_RECONNECT_MAX_DELAY_MS', 30000));

    // ✅ RECONNECT STORM PREVENTION: Queue-based reconnect để tránh block event loop
    this.reconnectQueue = []; // Queue of connections waiting to reconnect
    this.reconnectInProgress = new Set(); // Track connections currently reconnecting
    this.maxConcurrentReconnects = Number(configService.getNumber('BINANCE_WS_MAX_CONCURRENT_RECONNECTS', 2)); // Max 2 concurrent reconnects
    this.maxReconnectQueueSize = Number(configService.getNumber('BINANCE_WS_MAX_RECONNECT_QUEUE_SIZE', 50)); // Max 50 connections in queue
    this.reconnectQueueProcessorRunning = false;

    this._startCacheCleanup();
    this._startSymbolCleanup();
    this._startSubscribeQueueProcessor();
    this._startReconnectQueueProcessor();
    this._startTickProcessor();
  }

  _startCacheCleanup() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => this._cleanupPriceCache(), this.priceCacheCleanupInterval);
  }

  _startSymbolCleanup() {
    if (this._symbolCleanupTimer) clearInterval(this._symbolCleanupTimer);
    this._symbolCleanupTimer = setInterval(() => this._cleanupUnusedSymbols(), this.symbolCleanupInterval);
  }

  // ✅ Process subscribe/unsubscribe queue với rate limiting (5 messages/s)
  _startSubscribeQueueProcessor() {
    if (this._subscribeQueueTimer) clearInterval(this._subscribeQueueTimer);
    this._subscribeQueueTimer = setInterval(() => {
      this._processSubscribeQueue();
    }, 200); // Check every 200ms (5 messages/s = 1 message per 200ms)
  }

  // ✅ Process reconnect queue để tránh reconnect storm (block event loop)
  _startReconnectQueueProcessor() {
    // Process queue mỗi 100ms để đảm bảo reconnect không block event loop
    setInterval(() => {
      this._processReconnectQueue();
    }, 100);
  }

  _processReconnectQueue() {
    // Chỉ process nếu có slot available và có connections trong queue
    if (this.reconnectInProgress.size >= this.maxConcurrentReconnects) {
      if (this.reconnectQueue.length > 0) {
        logger.debug(`[Binance-WS] Reconnect queue full (${this.reconnectQueue.length} waiting, ${this.reconnectInProgress.size} in-progress)`);
      }
      return;
    }
    if (this.reconnectQueue.length === 0) return;

    // Lấy connection đầu tiên từ queue
    const conn = this.reconnectQueue.shift();
    if (!conn) return;

    // Mark as in progress
    this.reconnectInProgress.add(conn);
    logger.info(`[Binance-WS] 🔄 Processing reconnect from queue (remaining: ${this.reconnectQueue.length}, in-progress: ${this.reconnectInProgress.size}, streams: ${conn.streams.size})`);

    // ✅ CRITICAL: Disconnect và reconnect hoàn toàn async để không block event loop
    setImmediate(() => {
      try {
        // Disconnect đã được gọi trong _scheduleReconnect, nhưng đảm bảo cleanup
        this._disconnect(conn);
        
        if (conn.reconnectAttempts >= this.maxReconnectAttempts) {
          logger.error('[Binance-WS] Max reconnect attempts reached for a shard.');
          this.reconnectInProgress.delete(conn);
          return;
        }

        conn.reconnectAttempts += 1;
        const baseDelay = Math.min(this.minReconnectDelayMs * Math.pow(2, conn.reconnectAttempts), this.maxReconnectDelayMs);
        const jitter = Math.floor(Math.random() * Math.min(1000, baseDelay * 0.2));
        const delay = Math.max(100, baseDelay + jitter); // Minimum 100ms delay

        logger.info(`[Binance-WS] ⏱️ Scheduling reconnect in ${delay}ms (attempt ${conn.reconnectAttempts}/${this.maxReconnectAttempts})`);

        // Schedule reconnect với delay
        conn._reconnectTimer = setTimeout(() => {
          try {
            this._connect(conn);
          } catch (err) {
            logger.error(`[Binance-WS] Error during reconnect connect: ${err?.message || err}`);
            this.reconnectInProgress.delete(conn);
          }
        }, delay);
      } catch (err) {
        logger.error(`[Binance-WS] Error in reconnect queue processor: ${err?.message || err}`);
        this.reconnectInProgress.delete(conn);
      }
    });
  }

  _processSubscribeQueue() {
    if (this.subscribeMessageQueue.length === 0) return;

    const now = Date.now();
    const timeSinceLastSent = now - this.subscribeLastSent;
    const minInterval = 1000 / this.subscribeRateLimit; // 200ms per message

    if (timeSinceLastSent >= minInterval) {
      const message = this.subscribeMessageQueue.shift();
      if (message) {
        this.subscribeLastSent = now;
        message(); // Execute subscribe/unsubscribe action
      }
    }
  }

  // ✅ Check connection rate limit (300 connections/5 phút)
  _checkConnectionRateLimit() {
    const now = Date.now();
    const cutoff = now - this.connectionHistoryWindow;

    // Cleanup old connection history
    this.connectionHistory = this.connectionHistory.filter(h => h.timestamp > cutoff);

    // Check if we can create new connection
    if (this.connectionHistory.length >= this.maxNewConnectionsPer5Min) {
      const oldestConnection = this.connectionHistory[0];
      const waitTime = oldestConnection.timestamp + this.connectionHistoryWindow - now;
      logger.warn(
        `[Binance-WS] ⚠️ Connection rate limit reached (${this.connectionHistory.length}/${this.maxNewConnectionsPer5Min} in 5min). ` +
          `Wait ${Math.ceil(waitTime / 1000)}s before creating new connection.`
      );
      return false;
    }

    return true;
  }

  // ✅ Record new connection
  _recordNewConnection() {
    this.connectionHistory.push({ timestamp: Date.now() });
  }

  _cleanupPriceCache() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000; // Remove entries older than 5 minutes (reduced from 10 minutes)
    let removed = 0;

    // Remove old entries
    for (const [symbol, data] of this.priceCache.entries()) {
      if (now - data.lastAccess > maxAge) {
        this.priceCache.delete(symbol);
        removed++;
      }
    }

    // If still over limit, remove least recently used
    if (this.priceCache.size > this.maxPriceCacheSize) {
      const entries = Array.from(this.priceCache.entries()).sort((a, b) => a[1].lastAccess - b[1].lastAccess);
      const toRemove = entries.slice(0, this.priceCache.size - this.maxPriceCacheSize);
      for (const [symbol] of toRemove) {
        this.priceCache.delete(symbol);
        removed++;
      }
    }

    if (removed > 0) {
      logger.debug(`[Binance-WS] Cleaned up ${removed} price cache entries. Current size: ${this.priceCache.size}`);
    }
  }

  // Register listener for price ticks
  onPrice(handler) {
    try {
      if (typeof handler === 'function') this._priceHandlers.add(handler);
    } catch (_) {}
  }

  _emitPrice(tick) {
    // ✅ NEW ARCH: Không emit trực tiếp trong WS thread.
    // WS thread chỉ enqueue tick, tick processor sẽ drain và chạy handlers.
    this._enqueueTick(tick);
  }

  _enqueueTick(tick) {
    const now = Date.now();
    this.tickQueueStats.enqueued++;
    this.tickQueueStats.lastEnqueueAt = now;

    // Track enqueue time per connection if possible (best-effort)
    if (tick && tick._conn) {
      tick._conn._lastTickEnqueueAt = now;
    }

    if (this.tickQueue.length >= this.maxTickQueueSize) {
      if (this.tickQueueDropOldest) {
        this.tickQueue.shift();
      }
      this.tickQueueStats.dropped++;
    }

    this.tickQueue.push(tick);

    if (!this.tickProcessorScheduled) {
      this.tickProcessorScheduled = true;
      setImmediate(() => this._drainTickQueue());
    }
  }

  _startTickProcessor() {
    // Processor is scheduled on-demand by enqueue; this timer detects starvation and dead connections.
    setInterval(() => {
      const now = Date.now();
      const lastProcessed = Number(this._messageStats.lastProcessedAt || 0);
      const sinceProcessed = lastProcessed > 0 ? now - lastProcessed : null;

      // If we are starving but have queued ticks, force a drain.
      if (this.tickQueue.length > 0 && sinceProcessed != null && sinceProcessed > this.tickStarvationThresholdMs && !this.tickProcessorScheduled) {
        this.tickProcessorScheduled = true;
        setImmediate(() => this._drainTickQueue());
      }

      // ✅ Option 1: Only reconnect when per-connection has no WS messages for > 15s.
      const noMessageThresholdMs = 15000;
      const reconnectCooldownMs = Math.max(30000, Number(this.latencyReconnectCooldownMs || 30000));

      for (const conn of this.connections) {
        const isOpen = conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING);
        if (!isOpen) continue;

        // Avoid duplicates
        if (this.reconnectQueue.includes(conn) || this.reconnectInProgress.has(conn)) continue;

        const lastMsgAt = Number(conn._lastWsMessageAt || 0);
        const sinceLastMsg = lastMsgAt > 0 ? now - lastMsgAt : null;

        // Per-connection cooldown reuse existing field
        const lastReconnectAt = Number(conn._lastLatencyReconnectAt || 0);
        const inCooldown = lastReconnectAt > 0 && (now - lastReconnectAt) < reconnectCooldownMs;
        if (inCooldown) continue;

        if (sinceLastMsg != null && sinceLastMsg > noMessageThresholdMs) {
          conn._lastLatencyReconnectAt = now;
          logger.warn(
            `[Binance-WS] ⚠️ Connection starvation: no WS message for ${Math.round(sinceLastMsg / 1000)}s ` +
              `(threshold ${Math.round(noMessageThresholdMs / 1000)}s) | streams=${conn.streams.size}. Reconnecting...`
          );
          this._scheduleReconnect(conn);
          break; // only one reconnect per second
        }
      }
    }, 1000);
  }

  async _runPriceHandler(handler, tick) {
    const start = Date.now();
    let handlerName = 'anonymous';
    try {
      handlerName = String(handler?.name || 'anonymous');

      const res = handler(tick);
      if (res && typeof res.then === 'function') {
        await res;
      }
    } finally {
      const dt = Date.now() - start;
      if (dt > this.priceHandlerSlowThresholdMs) {
        const now = Date.now();
        const intervalMs = Math.max(1000, Number(this.slowHandlerLogIntervalMs || 10000));

        // Aggregate by handler name
        if (!this._slowHandlersByName.has(handlerName)) {
          this._slowHandlersByName.set(handlerName, { count: 0, totalMs: 0, maxMs: 0, sampleSymbol: null });
        }
        const agg = this._slowHandlersByName.get(handlerName);
        agg.count++;
        agg.totalMs += dt;
        if (dt > agg.maxMs) {
          agg.maxMs = dt;
          agg.sampleSymbol = tick?.symbol || 'unknown';
        }

        // Windowed summary (overall)
        if (!this._slowHandlerAgg.windowStart || (now - this._slowHandlerAgg.windowStart) >= intervalMs) {
          // flush old window
          if (this._slowHandlerAgg.count > 0) {
            logger.warn(
              `[Binance-WS] ⚠️ Slow price handler (rate-limited) | count=${this._slowHandlerAgg.count} ` +
                `max=${this._slowHandlerAgg.maxMs}ms sample=${this._slowHandlerAgg.sampleSymbol || 'n/a'}`
            );
          }
          this._slowHandlerAgg.windowStart = now;
          this._slowHandlerAgg.count = 0;
          this._slowHandlerAgg.maxMs = 0;
          this._slowHandlerAgg.sampleSymbol = null;
        }

        this._slowHandlerAgg.count++;
        if (dt > this._slowHandlerAgg.maxMs) {
          this._slowHandlerAgg.maxMs = dt;
          this._slowHandlerAgg.sampleSymbol = tick?.symbol || 'unknown';
        }

        // Periodic top-N report by handler
        const reportIntervalMs = intervalMs;
        if (now - Number(this._lastSlowHandlersReportAt || 0) >= reportIntervalMs) {
          this._lastSlowHandlersReportAt = now;
          const entries = Array.from(this._slowHandlersByName.entries());
          entries.sort((a, b) => (b[1].maxMs - a[1].maxMs) || (b[1].totalMs - a[1].totalMs));
          const top = entries.slice(0, Math.max(1, this.slowHandlersTopN || 5));
          const topStr = top
            .map(([name, s]) => {
              const avg = s.count > 0 ? (s.totalMs / s.count).toFixed(1) : '0.0';
              return `${name}: count=${s.count} avg=${avg}ms max=${s.maxMs}ms sample=${s.sampleSymbol || 'n/a'}`;
            })
            .join(' | ');
          if (topStr) {
            logger.warn(`[Binance-WS] ⚠️ Slow handlers top | ${topStr}`);
          }

          // reset window
          this._slowHandlersByName.clear();
        }
      }
    }
  }

  _drainTickQueue() {
    if (this.tickProcessorRunning) return;
    this.tickProcessorRunning = true;
    this.tickProcessorScheduled = false;

    const startedAt = Date.now();
    let drained = 0;

    try {
      while (this.tickQueue.length > 0 && drained < this.tickDrainBatchSize) {
        const tick = this.tickQueue.shift();
        if (!tick) break;
        drained++;
        this.tickQueueStats.drained++;
        this.tickQueueStats.lastDrainAt = Date.now();

        const handlers = Array.from(this._priceHandlers);
        for (const h of handlers) {
          // Fire-and-forget per handler (do not block drain)
          setImmediate(() => {
            this._runPriceHandler(h, tick).catch(err => {
              logger.error(`[Binance-WS] ❌ Price handler error: ${err?.message || err} | symbol: ${tick?.symbol || 'unknown'}`);
            });
          });
        }
      }
    } finally {
      this.tickProcessorRunning = false;

      // If more ticks remain, schedule next drain.
      if (this.tickQueue.length > 0) {
        this.tickProcessorScheduled = true;
        setImmediate(() => this._drainTickQueue());
      }

      const dt = Date.now() - startedAt;
      if (dt > 50 && drained > 0) {
        logger.warn(`[Binance-WS] ⚠️ Tick drain took ${dt}ms | drained=${drained} remaining=${this.tickQueue.length}`);
      }
    }
  }

  // Return latest cached price
  getPrice(symbol) {
    const key = String(symbol).toUpperCase();
    const cached = this.priceCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
      // ✅ Track symbol usage for LIFO management
      this._trackSymbolUsage(key);
      return cached.price;
    }
    return null;
  }

  // ✅ Track symbol usage for LIFO management
  _trackSymbolUsage(symbol) {
    const now = Date.now();
    if (!this.symbolUsage.has(symbol)) {
      this.symbolUsage.set(symbol, {
        lastAccess: now,
        accessCount: 0,
        streams: new Set()
      });
    }
    const usage = this.symbolUsage.get(symbol);
    usage.lastAccess = now;
    usage.accessCount++;
  }

  // Return latest best bid/ask if available
  getBook(symbol) {
    const key = String(symbol).toUpperCase();
    const cached = this.priceCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
      // ✅ Track symbol usage for LIFO management
      this._trackSymbolUsage(key);
      const bid = Number(cached.bid);
      const ask = Number(cached.ask);
      return {
        bid: Number.isFinite(bid) ? bid : null,
        ask: Number.isFinite(ask) ? ask : null,
        ts: cached.lastAccess
      };
    }
    return { bid: null, ask: null, ts: null };
  }

  onLatency(handler) {
    try {
      if (typeof handler === 'function') this._latencyHandlers.add(handler);
    } catch (_) {}
  }

  _emitLatency(tick) {
    for (const h of Array.from(this._latencyHandlers)) {
      try {
        h(tick);
      } catch (_) {}
    }
  }

  /**
   * Get cached kline OPEN price for a given symbol/interval/bucket.
   * @param {string} symbol - e.g. 'BTCUSDT'
   * @param {string} interval - e.g. '1m' or '5m'
   * @param {number} bucketStart - bucket start timestamp (ms)
   * @returns {number|null}
   */
  getKlineOpen(symbol, interval, bucketStart) {
    return this.candleAggregator.getOpen(symbol, interval, bucketStart);
  }

  getKlineClose(symbol, interval, bucketStart) {
    return this.candleAggregator.getClose(symbol, interval, bucketStart);
  }

  getLatestCandle(symbol, interval) {
    return this.candleAggregator.getLatestCandle(symbol, interval);
  }

  // Subscribe a list of symbols (normalized like BTCUSDT)
  subscribe(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      logger.debug('[Binance-WS] subscribe() called with empty array');
      return;
    }
    const normalized = symbols.map(s => String(s).toUpperCase());
    logger.debug(
      `[Binance-WS] subscribe() called with ${normalized.length} symbols (${normalized
        .slice(0, 5)
        .join(', ')}${normalized.length > 5 ? '...' : ''})`
    );

    // ✅ Check total streams limit - unsubscribe unused symbols if needed
    const currentTotalStreams = this._getTotalStreams();
    if (currentTotalStreams >= this.maxTotalStreams) {
      logger.warn(
        `[Binance-WS] ⚠️ Max total streams limit reached (${currentTotalStreams}/${this.maxTotalStreams}). ` +
          `Unsubscribing unused symbols...`
      );
      this._cleanupUnusedSymbols(true); // Force cleanup
    }

    let hasNewStreams = false;
    let newStreamsCount = 0;
    let skippedCount = 0;
    for (const sym of normalized) {
      // ✅ Track symbol usage
      this._trackSymbolUsage(sym);

      // Realtime streams: bookTicker for best bid/ask (maker entry) + trade for tick-level aggregation
      // Kline streams to get authoritative OHLC for multi-timeframes.
      const streamsForSymbol = [
        `${sym.toLowerCase()}@bookTicker`,
        `${sym.toLowerCase()}@kline_1m`
      ];

      // ✅ Store streams for this symbol
      if (!this.symbolUsage.has(sym)) {
        this.symbolUsage.set(sym, {
          lastAccess: Date.now(),
          accessCount: 0,
          streams: new Set()
        });
      }
      const usage = this.symbolUsage.get(sym);
      streamsForSymbol.forEach(s => usage.streams.add(s));

      for (const stream of streamsForSymbol) {
        // If already in any connection, skip
        if (this._hasStream(stream)) {
          skippedCount++;
          continue;
        }

        // ✅ Check total streams limit before adding
        if (this._getTotalStreams() >= this.maxTotalStreams) {
          logger.warn(
            `[Binance-WS] ⚠️ Max total streams limit reached (${this._getTotalStreams()}/${this.maxTotalStreams}). ` +
              `Skipping subscription for ${sym}`
          );
          skippedCount++;
          continue;
        }

        hasNewStreams = true;
        newStreamsCount++;
        // Put into an existing connection with space, else create new
        let placed = false;
        for (const conn of this.connections) {
          // ✅ Check both stream count limit AND URL length limit
          const maxStreamsForUrl = this._calculateMaxStreamsForUrl();
          if (conn.streams.size < maxStreamsForUrl) {
            // Test if adding this stream would exceed URL length
            const testStreams = Array.from(conn.streams);
            testStreams.push(stream);
            const testPath = testStreams.join('/');
            const testUrl = this.baseUrl + testPath;

            if (testUrl.length <= this.maxUrlLength) {
              conn.streams.add(stream);
              conn._needsReconnect = true;
              placed = true;
              break;
            }
          }
        }
        if (!placed) {
          const conn = this._createConnection();
          conn.streams.add(stream);
          logger.debug(
            `[Binance-WS] Created new connection for stream ${stream} (total connections: ${this.connections.length})`
          );
        }
      }
    }
    if (newStreamsCount > 0) {
      logger.debug(
        `[Binance-WS] Added ${newStreamsCount} new streams, skipped ${skippedCount} existing streams. Total connections: ${this.connections.length}`
      );
    }

    // ✅ Reconnect connections that had stream changes (với rate limiting)
    // Queue reconnect actions để tránh vượt quá 5 messages/s
    if (hasNewStreams) {
      for (const conn of this.connections) {
        if (conn._needsReconnect) {
          // Queue reconnect để rate limiting
          this.subscribeMessageQueue.push(() => {
            this._reconnect(conn);
          });
        }
      }

      // Queue connect actions cho connections chưa mở
      for (const conn of this.connections) {
        if (conn.streams.size > 0) {
          const isOpen = conn.ws && conn.ws.readyState === WebSocket.OPEN;
          if (!isOpen) {
            // Queue connect để rate limiting
            this.subscribeMessageQueue.push(() => {
              logger.debug(`[Binance-WS] Connecting connection with ${conn.streams.size} streams...`);
              this._connect(conn);
            });
          }
        }
      }
    }
  }

  // Create a new WS connection shell (without connecting yet)
  _createConnection() {
    // ✅ Check connection rate limit (300 connections/5 phút)
    if (!this._checkConnectionRateLimit()) {
      throw new Error('Connection rate limit reached. Cannot create new connection.');
    }

    const conn = {
      ws: null,
      streams: new Set(),
      url: '',
      reconnectAttempts: 0,
      _needsReconnect: true,
      serverTimeOffsetMs: 0,
      _lastServerTimeSyncAt: 0,
      _serverTimeSyncInFlight: false,
      _reconnectTimer: null,
      _latencyReconnectScheduled: false,
      _lastLatencyReconnectAt: 0,
      _lastLatencySummaryAt: 0,
      latencyHistory: [],
      // ✅ Heartbeat / starvation
      _lastWsMessageAt: 0,
      _lastTickEnqueueAt: 0,
      // ✅ Ping/pong keepalive
      _lastPongAt: 0,
      _pingTimer: null,
      _pongTimeoutTimer: null
    };
    this.connections.push(conn);
    this._recordNewConnection(); // Record new connection for rate limiting
    return conn;
  }

  _hasStream(stream) {
    for (const c of this.connections) {
      if (c.streams.has(stream)) return true;
    }
    return false;
  }

  // ✅ Get total streams across all connections
  _getTotalStreams() {
    return this.connections.reduce((sum, conn) => sum + conn.streams.size, 0);
  }

  // ✅ Split connection that has URL too long into smaller connections
  _splitConnection(conn) {
    if (conn.streams.size === 0) return;

    const streams = Array.from(conn.streams);
    const maxStreamsPerSplit = Math.floor(this._calculateMaxStreamsForUrl() * 0.9); // 90% để an toàn

    logger.info(
      `[Binance-WS] 🔀 Splitting connection with ${streams.length} streams into chunks of ${maxStreamsPerSplit}...`
    );

    // Remove old connection
    this._disconnect(conn);
    const index = this.connections.indexOf(conn);
    if (index > -1) this.connections.splice(index, 1);

    // Create new connections with split streams
    for (let i = 0; i < streams.length; i += maxStreamsPerSplit) {
      const chunk = streams.slice(i, i + maxStreamsPerSplit);
      const newConn = this._createConnection();
      chunk.forEach(stream => newConn.streams.add(stream));
      newConn._needsReconnect = true;

      // Queue connect để rate limiting
      this.subscribeMessageQueue.push(() => {
        this._connect(newConn);
      });
    }

    logger.info(`[Binance-WS] ✅ Split connection into ${Math.ceil(streams.length / maxStreamsPerSplit)} connections`);
  }

  // ✅ Cleanup unused symbols (LIFO - unsubscribe symbols không được sử dụng lâu nhất)
  _cleanupUnusedSymbols(force = false) {
    const now = Date.now();
    const unusedSymbols = [];

    // Find unused symbols
    for (const [symbol, usage] of this.symbolUsage.entries()) {
      const timeSinceLastAccess = now - usage.lastAccess;
      if (timeSinceLastAccess > this.symbolUnusedTimeout) {
        unusedSymbols.push({ symbol, usage, timeSinceLastAccess });
      }
    }

    // Sort by lastAccess (oldest first - LIFO)
    unusedSymbols.sort((a, b) => a.usage.lastAccess - b.usage.lastAccess);

    // Calculate how many streams to remove
    const currentTotal = this._getTotalStreams();
    const targetReduction = force
      ? Math.max(0, currentTotal - this.maxTotalStreams + 500) // Free up 500 streams if forcing
      : Math.max(0, unusedSymbols.length * 6); // Remove all unused symbols' streams (6 per symbol)

    let removedStreams = 0;
    let removedSymbols = 0;

    for (const { symbol, usage } of unusedSymbols) {
      if (removedStreams >= targetReduction && !force) break;

      // Unsubscribe all streams for this symbol
      for (const stream of usage.streams) {
        for (const conn of this.connections) {
          if (conn.streams.has(stream)) {
            conn.streams.delete(stream);
            conn._needsReconnect = true;
            removedStreams++;
          }
        }
      }

      // Remove symbol from tracking
      this.symbolUsage.delete(symbol);
      removedSymbols++;
    }

    // Reconnect connections that had streams removed (với rate limiting)
    if (removedStreams > 0) {
      logger.info(
        `[Binance-WS] 🧹 Cleaned up ${removedSymbols} unused symbols (${removedStreams} streams). ` +
          `Total streams: ${this._getTotalStreams()}/${this.maxTotalStreams}`
      );

      for (const conn of this.connections) {
        if (conn._needsReconnect && conn.streams.size === 0) {
          // Remove empty connections (không cần rate limit vì chỉ là disconnect)
          this._disconnect(conn);
          const index = this.connections.indexOf(conn);
          if (index > -1) this.connections.splice(index, 1);
        } else if (conn._needsReconnect) {
          // ✅ Queue reconnect để rate limiting (5 messages/s)
          this.subscribeMessageQueue.push(() => {
            this._reconnect(conn);
          });
        }
      }
    }
  }

  _buildUrl(conn) {
    const streams = Array.from(conn.streams);
    const path = streams.join('/');
    const url = this.baseUrl + path;

    // ✅ Check URL length to avoid 414 error (URI Too Long)
    if (url.length > this.maxUrlLength) {
      logger.warn(
        `[Binance-WS] ⚠️ URL too long (${url.length} > ${this.maxUrlLength} chars) for ${streams.length} streams. ` +
          `Splitting connection...`
      );
      // Return null to indicate URL is too long, need to split
      return null;
    }

    return url;
  }

  // ✅ Calculate max streams that fit in URL
  _calculateMaxStreamsForUrl() {
    // Estimate: base URL (~45) + average stream length (~20 chars) + safety margin
    const avgStreamLength = 20; // e.g., "btcusdt@bookTicker/"
    const baseUrlLength = this.baseUrl.length;
    const availableLength = this.maxUrlLength - baseUrlLength;
    const maxStreams = Math.floor(availableLength / avgStreamLength);
    return Math.min(maxStreams, this.maxStreamsPerConn);
  }

  async _syncServerTimeOffsetIfNeeded(conn) {
    if (!conn) return;

    const now = Date.now();
    if (conn._serverTimeSyncInFlight) return;
    if (Number.isFinite(conn._lastServerTimeSyncAt) && now - conn._lastServerTimeSyncAt < this.serverTimeSyncTTL) return;

    conn._serverTimeSyncInFlight = true;
    try {
      const before = Date.now();
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.serverTimeSyncTimeoutMs);
      const res = await fetch('https://fapi.binance.com/fapi/v1/time', {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal
      });
      clearTimeout(timeoutId);
      const json = await res.json().catch(() => null);
      const after = Date.now();
      const serverTime = Number(json?.serverTime || json?.server_time || 0);
      if (Number.isFinite(serverTime) && serverTime > 0) {
        const mid = Math.round((before + after) / 2);
        conn.serverTimeOffsetMs = serverTime - mid;
        conn._lastServerTimeSyncAt = Date.now();
      }
    } catch (_) {
      // ignore; time sync best-effort
    } finally {
      conn._serverTimeSyncInFlight = false;
    }
  }

  _connect(conn) {
    if (!conn || conn.streams.size === 0) {
      logger.debug(`[Binance-WS] Skipping connect: conn=${!!conn}, streams=${conn?.streams?.size || 0}`);
      return;
    }
    if (conn.ws && conn.ws.readyState === WebSocket.OPEN) {
      logger.debug(`[Binance-WS] Connection already open (${conn.streams.size} streams)`);
      return;
    }

    conn.url = this._buildUrl(conn);

    // ✅ Check if URL is too long (414 error prevention)
    if (!conn.url) {
      logger.error(
        `[Binance-WS] ❌ URL too long for connection with ${conn.streams.size} streams. ` + `Splitting connection...`
      );
      // Split connection into smaller ones
      this._splitConnection(conn);
      return;
    }

    // ✅ Log URL length for monitoring
    if (conn.url.length > 7000) {
      logger.warn(
        `[Binance-WS] ⚠️ URL length is ${conn.url.length} chars (close to limit ${this.maxUrlLength}) ` +
          `for ${conn.streams.size} streams`
      );
    }

    logger.debug(
      `[Binance-WS] Connecting to ${conn.url.substring(0, 80)}... (${conn.streams.size} streams, URL length: ${conn.url.length})`
    );
    try {
      conn.ws = new WebSocket(conn.url, {
        perMessageDeflate: false,
        handshakeTimeout: 15000
      });
    } catch (e) {
      logger.error('[Binance-WS] Failed to construct WebSocket:', {
        error: e?.message || String(e),
        code: e?.code || 'unknown',
        url: conn.url?.substring(0, 100),
        urlLength: conn.url?.length,
        streams: conn.streams.size
      });
      this._scheduleReconnect(conn);
      return;
    }

    conn.ws.on('open', () => {
      logger.info(`[Binance-WS] ✅ Connected successfully (${conn.streams.size} streams)`);
      conn.reconnectAttempts = 0;
      conn._needsReconnect = false;
      // ✅ Reset latency history và reconnect flag khi reconnect
      conn.latencyHistory = [];
      conn._latencyReconnectScheduled = false;

      // ✅ Reset heartbeat/pong markers
      conn._lastWsMessageAt = Date.now();
      conn._lastPongAt = Date.now();

      // ✅ Start ping/pong keepalive
      this._startConnKeepalive(conn);

      // ✅ Remove from reconnect tracking khi connect thành công
      this.reconnectInProgress.delete(conn);
      const queueIndex = this.reconnectQueue.indexOf(conn);
      if (queueIndex > -1) {
        this.reconnectQueue.splice(queueIndex, 1);
        logger.info(`[Binance-WS] ✅ Removed from reconnect queue (remaining: ${this.reconnectQueue.length}, in-progress: ${this.reconnectInProgress.size})`);
      }

      // best-effort sync time on open
      this._syncServerTimeOffsetIfNeeded(conn).catch(() => {});
    });

    conn.ws.on('pong', () => {
      conn._lastPongAt = Date.now();
    });

    conn.ws.on('message', raw => {
      const receivedAt = Date.now();
      // ✅ FIX: Track message stats để monitor bot hoạt động
      this._messageStats.totalReceived++;
      this._messageStats.lastMessageAt = receivedAt;
      // ✅ Per-connection heartbeat
      conn._lastWsMessageAt = receivedAt;
      
      try {
        const msg = JSON.parse(raw);
        const payload = msg?.data || msg;

        // Keep time offset fresh (best-effort, throttled)
        this._syncServerTimeOffsetIfNeeded(conn).catch(() => {});

        const streamName = String(msg?.stream || 'unknown');

        // Only measure latency for streams that carry a reliable event time (kline has E).
        // bookTicker does NOT provide E, so measuring latency there causes false positives.
        const isKlineStream = /@kline_/i.test(streamName) || payload?.e === 'kline';

        // Prefer Binance stream event time if present, but normalize with server time offset
        const eventTime = isKlineStream ? Number(payload?.E || payload?.T || 0) : 0;
        const offsetMs = Number.isFinite(conn.serverTimeOffsetMs) ? conn.serverTimeOffsetMs : 0;
        const latency = eventTime > 0 ? receivedAt - (eventTime + offsetMs) : -1;

        if (latency >= 0) {
          this._emitLatency({
            stream: streamName,
            latencyMs: latency,
            receivedAt,
            eventTime,
            offsetMs
          });

          if (!conn.latencyHistory) {
            conn.latencyHistory = [];
          }
          conn.latencyHistory.push({ latency, timestamp: receivedAt });

          // ✅ OPTIMIZE: Cleanup old entries nhưng không sort mỗi message (tốn CPU)
          // Chỉ cleanup khi history quá lớn (>200 entries) để tránh memory leak
          if (conn.latencyHistory.length > 200) {
            const cutoff = receivedAt - this.latencyCheckWindow;
            conn.latencyHistory = conn.latencyHistory.filter(h => h.timestamp > cutoff);
          }

          const nowMs = receivedAt;

          // Cooldown guard: avoid reconnect storm on transient spikes.
          const lastLatencyReconnectAt = Number(conn._lastLatencyReconnectAt || 0);
          const inCooldown = lastLatencyReconnectAt > 0 && (nowMs - lastLatencyReconnectAt) < this.latencyReconnectCooldownMs;

          // ✅ OPTIMIZE: Chỉ tính stats khi cần (không phải mỗi message)
          // Defer expensive calculation để không block message handler
          // Chỉ tính khi:
          // 1. Cần check reconnect (không trong cooldown và chưa scheduled)
          // 2. Hoặc cần log summary (rate-limited)
          let p95 = null;
          let median = null;
          let avgLatency = null;
          let maxLatency = null;
          const n = conn.latencyHistory.length;
          
          // ✅ OPTIMIZE: Chỉ tính stats khi cần check reconnect hoặc log summary
          // Tính stats nếu:
          // 1. Cần check reconnect (không trong cooldown và chưa scheduled)
          // 2. Hoặc cần log summary (rate-limited, mỗi 10s)
          const needsReconnectCheck = !inCooldown && !conn._latencyReconnectScheduled;
          const needsSummaryLog = !inCooldown && n > 0 && (nowMs - Number(conn._lastLatencySummaryAt || 0)) > 10000;
          const needsStats = needsReconnectCheck || needsSummaryLog;
          
          if (needsStats && n > 0) {
            // ✅ OPTIMIZE: Sử dụng typed array và chỉ sort khi cần
            const latArr = conn.latencyHistory.map(h => h.latency).filter(v => Number.isFinite(v));
            if (latArr.length > 0) {
              // Sort chỉ khi cần (không phải mỗi message)
              latArr.sort((a, b) => a - b);
              const sortedN = latArr.length;
              p95 = latArr[Math.min(sortedN - 1, Math.floor(sortedN * 0.95))];
              median = latArr[Math.floor(sortedN * 0.5)];
              avgLatency = latArr.reduce((s, v) => s + v, 0) / sortedN;
              maxLatency = latArr[sortedN - 1];
            }
          }

          // Rate-limit summary logs (once per 10s per connection)
          // ✅ OPTIMIZE: Chỉ tính stats khi cần log (đã tính ở trên nếu needsStats)
          if (!inCooldown && n > 0 && (nowMs - Number(conn._lastLatencySummaryAt || 0)) > 10000) {
            // Nếu chưa tính stats (vì không needsStats), tính lại cho log
            if (avgLatency === null && n > 0) {
              const latArr = conn.latencyHistory.map(h => h.latency).filter(v => Number.isFinite(v));
              if (latArr.length > 0) {
                latArr.sort((a, b) => a - b);
                const sortedN = latArr.length;
                p95 = latArr[Math.min(sortedN - 1, Math.floor(sortedN * 0.95))];
                median = latArr[Math.floor(sortedN * 0.5)];
                avgLatency = latArr.reduce((s, v) => s + v, 0) / sortedN;
                maxLatency = latArr[sortedN - 1];
              }
            }
            
            conn._lastLatencySummaryAt = nowMs;
            if (avgLatency !== null) {
              logger.info(
                `[Binance-WS] Latency window stats | streams=${conn.streams.size} n=${n} ` +
                  `avg=${avgLatency.toFixed(0)}ms med=${median.toFixed(0)}ms p95=${p95.toFixed(0)}ms max=${maxLatency.toFixed(0)}ms ` +
                  `threshold=${this.highLatencyThreshold}ms extreme=${this.extremeLatencyThreshold}ms offsetMs=${offsetMs.toFixed(0)}`
              );
            }
          }

          if (!conn._latencyReconnectScheduled && !inCooldown) {
            // ✅ NEW POLICY: Latency chỉ là tín hiệu quan sát.
            // Không reconnect chỉ vì latency cao, vì khi event-loop backlog thì reconnect storm sẽ làm mọi thứ tệ hơn.
            // Reconnect theo starvation/heartbeat sẽ được xử lý ở tick processor monitor.

            // Extreme condition (p95) - chỉ log
            if (p95 != null && p95 > this.extremeLatencyThreshold) {
              logger.error(
                `[Binance-WS] 🚨 EXTREME latency (p95) detected: p95=${p95.toFixed(0)}ms (threshold: ${this.extremeLatencyThreshold}ms) ` +
                  `| stream: ${streamName}. (no reconnect - latency is metric only)`
              );
            }

            // Persistent condition (median) - chỉ log
            if (median != null && median > this.highLatencyThreshold) {
              logger.warn(
                `[Binance-WS] ⚠️ Persistent high latency (median) detected: med=${median.toFixed(0)}ms ` +
                  `(threshold: ${this.highLatencyThreshold}ms, p95=${p95?.toFixed(0) ?? 'n/a'}ms). (no reconnect - latency is metric only)`
              );
            }
          }

          // ✅ FIX: Không skip message ngay cả khi latency cao
          // Chỉ log warning, nhưng vẫn process message để không mất dữ liệu
          if (latency > 3000) {
            logger.warn(
              `[Binance-WS] ⚠️ Stale message detected: latency=${latency}ms > 3000ms | stream: ${streamName}. ` +
              `Still processing to avoid data loss.`
            );
            // Không return - tiếp tục process message
          }
        }

        if (latency > 1000 && latency <= 3000) {
          logger.debug(`[Binance-WS] High latency detected: ${latency}ms | stream: ${msg?.stream || 'unknown'}`);
        }

        // ✅ NEW ARCH: WS thread chỉ làm việc tối thiểu
        // - parse + update cache/candle (sync, cực nhẹ)
        // - enqueue tick để tick processor xử lý consumers
        try {
          this._messageStats.totalProcessed++;
          this._messageStats.lastProcessedAt = Date.now();

          // bookTicker stream
          if (payload && payload.u && payload.s && payload.b && payload.a) {
            const symbol = String(payload.s).toUpperCase();
            const bid = parseFloat(payload.b);
            const ask = parseFloat(payload.a);
            if (Number.isFinite(bid) && Number.isFinite(ask)) {
              this.priceCache.set(symbol, { price: bid, bid, ask, lastAccess: receivedAt });
              this._trackSymbolUsage(symbol);
              this._enqueueTick({ symbol, price: bid, bid, ask, ts: receivedAt, _conn: conn });
            }
          }
          // trade stream
          else if (payload && payload.e === 'trade') {
            const symbol = String(payload.s).toUpperCase();
            const price = parseFloat(payload.p);
            const volume = parseFloat(payload.q);
            if (Number.isFinite(price) && Number.isFinite(volume)) {
              this.candleAggregator.ingestTick({ symbol, price, volume, ts: eventTime || receivedAt });
              const cached = this.priceCache.get(symbol) || { lastAccess: 0 };
              cached.price = price;
              cached.lastAccess = receivedAt;
              this.priceCache.set(symbol, cached);
              this._trackSymbolUsage(symbol);
              this._enqueueTick({ symbol, price, ts: eventTime || receivedAt, _conn: conn });
            }
          }
          // kline stream
          else if (payload && payload.e === 'kline' && payload.s && payload.k) {
            const k = payload.k;
            this.candleAggregator.ingestKline({
              symbol: k.s,
              interval: k.i,
              startTime: k.t,
              open: k.o,
              high: k.h,
              low: k.l,
              close: k.c,
              volume: k.v,
              isClosed: k.x,
              ts: eventTime || receivedAt
            });
          }
        } catch (e) {
          this._messageStats.totalErrors++;
          logger.error(
            `[Binance-WS] ❌ Error processing message payload: ${e?.message || e} | ` +
            `stream: ${streamName} | receivedAt: ${receivedAt} | stack: ${e?.stack || 'N/A'}`
          );
        }

        // ✅ Defer non-critical operations (logging) sang setImmediate để không block
        setImmediate(() => {
          const processedAt = Date.now();
          const processingLagMs = processedAt - receivedAt;

          // Only log processing lag when it is suspiciously high (helps distinguish network vs event-loop backlog)
          // ✅ Rate-limit log để tránh spam khi event loop bị nghẽn
          if (processingLagMs > 250) {
            const now = Date.now();
            const intervalMs = Math.max(1000, Number(this.processingLagLogIntervalMs || 10000));
            if (now - Number(this._lastProcessingLagLogAt || 0) >= intervalMs) {
              this._lastProcessingLagLogAt = now;
              logger.warn(
                `[Binance-WS] ⚠️ Processing lag detected: ${processingLagMs}ms | stream=${streamName} ` +
                  `latencyMs=${latency >= 0 ? latency : 'n/a'} offsetMs=${offsetMs.toFixed(0)} streams=${conn.streams.size}`
              );
            }
          }
        });
      } catch (e) {
        // ✅ FIX: Track errors trong message parsing
        this._messageStats.totalErrors++;
        logger.error(
          `[Binance-WS] ❌ Failed to parse/handle message: ${e?.message || e} | ` +
          `receivedAt: ${receivedAt} | stack: ${e?.stack || 'N/A'}`
        );
        // ✅ FIX: Không throw để không crash bot, tiếp tục process messages tiếp theo
      }
    });

    conn.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'none';
      const codeStr = code || 'unknown';
      logger.warn(`[Binance-WS] Connection closed (code: ${codeStr}, reason: ${reasonStr}, streams: ${conn.streams.size})`);
      
      // ✅ Cleanup reconnect tracking nếu connection đóng không phải do scheduled reconnect
      // (scheduled reconnect đã cleanup trong _scheduleReconnect)
      if (!this.reconnectQueue.includes(conn) && !this.reconnectInProgress.has(conn)) {
        this._scheduleReconnect(conn);
      }
    });

    conn.ws.on('error', err => {
      const errorInfo = {
        message: err?.message || String(err),
        code: err?.code || 'unknown',
        readyState: conn.ws?.readyState || 'unknown',
        streams: conn.streams.size,
        url: conn.url?.substring(0, 100) || 'unknown'
      };

      const isCommonError =
        err?.message?.includes('closed before') || err?.message?.includes('ECONNREFUSED') || err?.code === 'ECONNREFUSED';

      if (isCommonError) {
        logger.debug(
          `[Binance-WS] Connection error (will retry): ${errorInfo.message} (code: ${errorInfo.code}, state: ${errorInfo.readyState})`
        );
      } else {
        logger.error(`[Binance-WS] Error:`, errorInfo);
      }

      if (conn.ws?.readyState !== WebSocket.CLOSED && conn.ws?.readyState !== WebSocket.CLOSING) {
        // ✅ Chỉ schedule reconnect nếu chưa trong queue/in-progress (tránh duplicate)
        if (!this.reconnectQueue.includes(conn) && !this.reconnectInProgress.has(conn)) {
          this._scheduleReconnect(conn);
        }
      }
    });
  }

  _disconnect(conn) {
    // ✅ CRITICAL: Đảm bảo disconnect không block event loop
    // Clear timer trước
    if (conn._reconnectTimer) {
      clearTimeout(conn._reconnectTimer);
      conn._reconnectTimer = null;
    }

    // ✅ Stop keepalive timers
    if (conn._pingTimer) {
      clearInterval(conn._pingTimer);
      conn._pingTimer = null;
    }
    if (conn._pongTimeoutTimer) {
      clearTimeout(conn._pongTimeoutTimer);
      conn._pongTimeoutTimer = null;
    }
    
    // Disconnect WebSocket với error handling tốt hơn
    if (conn.ws) {
      try {
        // Check readyState trước khi terminate để tránh lỗi
        if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
          conn.ws.terminate();
        }
      } catch (err) {
        // Ignore errors during terminate (connection might already be closed)
        logger.debug(`[Binance-WS] Error during ws.terminate (non-critical): ${err?.message || err}`);
      } finally {
        // Always clear reference để tránh memory leak
        conn.ws = null;
      }
    }
  }

  _startConnKeepalive(conn) {
    if (!conn || !conn.ws) return;

    // Clear existing timers
    if (conn._pingTimer) {
      clearInterval(conn._pingTimer);
      conn._pingTimer = null;
    }
    if (conn._pongTimeoutTimer) {
      clearTimeout(conn._pongTimeoutTimer);
      conn._pongTimeoutTimer = null;
    }

    // Skip if interval disabled
    const intervalMs = Math.max(5000, Number(this.wsPingIntervalMs || 20000));
    const pongTimeoutMs = Math.max(5000, Number(this.wsPongTimeoutMs || 15000));

    conn._pingTimer = setInterval(() => {
      try {
        if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) return;

        // send ping
        conn.ws.ping();

        // schedule pong timeout
        if (conn._pongTimeoutTimer) clearTimeout(conn._pongTimeoutTimer);
        const pingSentAt = Date.now();
        conn._pongTimeoutTimer = setTimeout(() => {
          const lastPong = Number(conn._lastPongAt || 0);
          if (lastPong < pingSentAt) {
            logger.warn(
              `[Binance-WS] ⚠️ Pong timeout (${pongTimeoutMs}ms) - scheduling reconnect | streams=${conn.streams.size}`
            );
            this._scheduleReconnect(conn);
          }
        }, pongTimeoutMs);
      } catch (e) {
        logger.debug(`[Binance-WS] ping error (non-critical): ${e?.message || e}`);
      }
    }, intervalMs);
  }

  _scheduleReconnect(conn) {
    // ✅ PREVENT RECONNECT STORM: Queue reconnect thay vì execute ngay lập tức
    // Điều này tránh block event loop khi nhiều connections cùng reconnect
    
    // Skip nếu connection đã trong queue hoặc đang reconnect
    if (this.reconnectQueue.includes(conn) || this.reconnectInProgress.has(conn)) {
      logger.debug(`[Binance-WS] Connection already queued/in-progress for reconnect, skipping duplicate`);
      return;
    }

    // ✅ FIX: Check queue size limit để tránh reconnect storm
    if (this.reconnectQueue.length >= this.maxReconnectQueueSize) {
      logger.warn(
        `[Binance-WS] ⚠️ Reconnect queue full (${this.reconnectQueue.length}/${this.maxReconnectQueueSize}), ` +
        `skipping reconnect for connection with ${conn.streams.size} streams. Will retry later.`
      );
      // Reset flag để có thể retry sau
      conn._latencyReconnectScheduled = false;
      return;
    }

    // Check max attempts trước khi queue
    if (conn.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[Binance-WS] Max reconnect attempts reached for a shard.');
      return;
    }

    // ✅ FIX: Check connection state trước khi schedule reconnect
    if (conn.ws && conn.ws.readyState !== WebSocket.OPEN && conn.ws.readyState !== WebSocket.CONNECTING) {
      logger.debug(`[Binance-WS] Connection already closed (state: ${conn.ws.readyState}), skipping reconnect scheduling`);
      conn._latencyReconnectScheduled = false;
      return;
    }

    // ✅ CRITICAL: Disconnect async để không block event loop
    // Wrap trong setImmediate để đảm bảo không block message handler
    setImmediate(() => {
      try {
        this._disconnect(conn);
      } catch (err) {
        logger.error(`[Binance-WS] Error during async disconnect: ${err?.message || err}`);
      }
    });

    // Add to queue (sẽ được process bởi _processReconnectQueue với rate limiting)
    this.reconnectQueue.push(conn);
    logger.info(`[Binance-WS] 🔄 Queued connection for reconnect (queue size: ${this.reconnectQueue.length}/${this.maxReconnectQueueSize}, in-progress: ${this.reconnectInProgress.size}, streams: ${conn.streams.size})`);
  }

  _reconnect(conn) {
    conn._needsReconnect = false;
    this._disconnect(conn);
    this._connect(conn);
  }

  connect() {
    logger.info(`[Binance-WS] connect() called: ${this.connections.length} existing connections`);
    if (this.connections.length === 0) {
      logger.warn('[Binance-WS] No connections exist yet. Connections will be created when symbols are subscribed.');
      return;
    }
    for (const conn of this.connections) {
      this.subscribeMessageQueue.push(() => {
        this._reconnect(conn);
      });
    }
  }

  disconnect() {
    for (const conn of this.connections) this._disconnect(conn);
    this.connections = [];
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    if (this._symbolCleanupTimer) {
      clearInterval(this._symbolCleanupTimer);
      this._symbolCleanupTimer = null;
    }
    if (this._subscribeQueueTimer) {
      clearInterval(this._subscribeQueueTimer);
      this._subscribeQueueTimer = null;
    }
    logger.info('[Binance-WS] All shards disconnected.');
  }

  getStatus() {
    const status = {
      totalConnections: this.connections.length,
      connectedCount: 0,
      totalStreams: 0,
      maxTotalStreams: this.maxTotalStreams,
      trackedSymbols: this.symbolUsage.size,
      connections: [],
      // ✅ FIX: Thêm message processing stats để monitor bot hoạt động
      messageStats: {
        totalReceived: this._messageStats.totalReceived,
        totalProcessed: this._messageStats.totalProcessed,
        totalErrors: this._messageStats.totalErrors,
        processingRate: this._messageStats.totalReceived > 0 
          ? ((this._messageStats.totalProcessed / this._messageStats.totalReceived) * 100).toFixed(2) + '%'
          : '0%',
        lastMessageAt: this._messageStats.lastMessageAt,
        lastProcessedAt: this._messageStats.lastProcessedAt,
        timeSinceLastMessage: this._messageStats.lastMessageAt > 0 
          ? Date.now() - this._messageStats.lastMessageAt 
          : null,
        timeSinceLastProcessed: this._messageStats.lastProcessedAt > 0 
          ? Date.now() - this._messageStats.lastProcessedAt 
          : null
      },
      tickQueue: {
        size: this.tickQueue.length,
        maxSize: this.maxTickQueueSize,
        enqueued: this.tickQueueStats.enqueued,
        drained: this.tickQueueStats.drained,
        dropped: this.tickQueueStats.dropped,
        lastEnqueueAt: this.tickQueueStats.lastEnqueueAt,
        lastDrainAt: this.tickQueueStats.lastDrainAt,
        timeSinceLastDrain: this.tickQueueStats.lastDrainAt > 0 ? Date.now() - this.tickQueueStats.lastDrainAt : null
      },
      reconnectQueue: {
        size: this.reconnectQueue.length,
        maxSize: this.maxReconnectQueueSize,
        inProgress: this.reconnectInProgress.size,
        maxConcurrent: this.maxConcurrentReconnects
      }
    };

    for (const conn of this.connections) {
      const isConnected = conn.ws && conn.ws.readyState === WebSocket.OPEN;
      status.connectedCount += isConnected ? 1 : 0;
      status.totalStreams += conn.streams.size;
      status.connections.push({
        streams: conn.streams.size,
        connected: isConnected,
        state: conn.ws?.readyState || 'null',
        lastWsMessageAt: conn._lastWsMessageAt || 0,
        lastPongAt: conn._lastPongAt || 0,
        timeSinceLastWsMessage: conn._lastWsMessageAt ? Date.now() - conn._lastWsMessageAt : null,
        timeSinceLastPong: conn._lastPongAt ? Date.now() - conn._lastPongAt : null
      });
    }

    return status;
  }
}

export const webSocketManager = new WebSocketManager();
