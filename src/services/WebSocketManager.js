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
    this.tickQueueHead = 0;
    this.tickQueueCompactThreshold = Number(configService.getNumber('BINANCE_WS_TICK_QUEUE_COMPACT_THRESHOLD', 5000));
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
    this.tickDrainTimeBudgetMs = Number(configService.getNumber('BINANCE_WS_TICK_DRAIN_TIME_BUDGET_MS', 8));
    this.tickStarvationThresholdMs = Number(configService.getNumber('BINANCE_WS_TICK_STARVATION_MS', 5000));

    // ✅ MARKET WS KEEPALIVE (PING/PONG)
    this.wsPingIntervalMs = Number(configService.getNumber('BINANCE_WS_PING_INTERVAL_MS', 20000));
    this.wsPongTimeoutMs = Number(configService.getNumber('BINANCE_WS_PONG_TIMEOUT_MS', 15000));

    // ✅ PRICE HANDLER PROFILING
    this.priceHandlerSlowThresholdMs = Number(configService.getNumber('BINANCE_WS_PRICE_HANDLER_SLOW_MS', 30));

    // ✅ LOG RATE LIMITING
    this.processingLagLogIntervalMs = Number(configService.getNumber('BINANCE_WS_PROCESSING_LAG_LOG_INTERVAL_MS', 10000));
    this.slowHandlerLogIntervalMs = Number(configService.getNumber('BINANCE_WS_SLOW_HANDLER_LOG_INTERVAL_MS', 10000));
    this._lastProcessingLagLogAt = 0;
    this._slowHandlerAgg = { windowStart: 0, count: 0, maxMs: 0, sampleSymbol: null };
    this._slowHandlersByName = new Map(); // name -> { count, totalMs, maxMs, sampleSymbol }
    this._lastSlowHandlersReportAt = 0;
    this.slowHandlersTopN = Number(configService.getNumber('BINANCE_WS_SLOW_HANDLER_TOP_N', 5));

    // ✅ O(1) stream lookup index: stream -> conn
    this._streamToConn = new Map();

    this.candleAggregator = new CandleAggregator(['1m', '5m', '15m', '30m']);

    this.baseUrl = 'wss://fstream.binance.com/stream?streams=';
    this.maxStreamsPerConn = 20;
    this.maxUrlLength = 8000;
    this.maxReconnectAttempts = 10;
    this.maxPriceCacheSize = 1000;
    this.priceCacheCleanupInterval = 1 * 60 * 1000;
    this._cleanupTimer = null;

    // ✅ LATENCY MONITORING
    this.highLatencyThreshold = 2000;
    this.extremeLatencyThreshold = 4000;
    this.highLatencyCountThreshold = 5;
    this.latencyCheckWindow = 10000;
    this.latencyReconnectCooldownMs = 30000;

    // ✅ LIFO SYMBOL MANAGEMENT
    this.symbolUsage = new Map();
    this.maxTotalStreams = 2000;
    this.symbolUnusedTimeout = 10 * 60 * 1000;
    this.symbolCleanupInterval = 2 * 60 * 1000;
    this._symbolCleanupTimer = null;

    // ✅ BINANCE RATE LIMITING
    this.subscribeRateLimit = 5;
    this.subscribeMessageQueue = [];
    this.subscribeLastSent = 0;
    this._subscribeQueueTimer = null;

    // ✅ BINANCE CONNECTION RATE LIMITING
    this.maxNewConnectionsPer5Min = 300;
    this.connectionHistory = [];
    this.connectionHistoryWindow = 5 * 60 * 1000;

    // ✅ TIME SYNC
    this.serverTimeSyncTTL = Number(configService.getNumber('BINANCE_TIME_SYNC_TTL_MS', 60000));
    this.serverTimeSyncTimeoutMs = Number(configService.getNumber('BINANCE_TIME_SYNC_TIMEOUT_MS', 5000));

    // ✅ RECONNECT policy
    this.minReconnectDelayMs = Number(configService.getNumber('BINANCE_WS_RECONNECT_MIN_DELAY_MS', 1000));
    this.maxReconnectDelayMs = Number(configService.getNumber('BINANCE_WS_RECONNECT_MAX_DELAY_MS', 30000));

    // ✅ RECONNECT STORM PREVENTION
    this.reconnectQueue = [];
    this.reconnectInProgress = new Set();
    this.maxConcurrentReconnects = Number(configService.getNumber('BINANCE_WS_MAX_CONCURRENT_RECONNECTS', 2));
    this.maxReconnectQueueSize = Number(configService.getNumber('BINANCE_WS_MAX_RECONNECT_QUEUE_SIZE', 50));
    this.reconnectQueueProcessorRunning = false;

    // ✅ EVENT LOOP DELAY MONITORING (lightweight)
    this._eventLoopDelay = {
      intervalMs: Number(configService.getNumber('BINANCE_WS_EVENT_LOOP_DELAY_INTERVAL_MS', 1000)),
      samplesMax: Number(configService.getNumber('BINANCE_WS_EVENT_LOOP_DELAY_SAMPLES', 10)),
      lastDelayMs: 0,
      avgDelayMs: 0,
      maxDelayMs: 0,
      lastCheckAt: 0
    };
    this._eventLoopDelaySamples = [];

    this._startCacheCleanup();
    this._startSymbolCleanup();
    this._startSubscribeQueueProcessor();
    this._startReconnectQueueProcessor();
    this._startTickProcessor();
    this._startEventLoopDelayMonitor();
  }

  _indexStream(stream, conn) {
    if (!stream) return;
    this._streamToConn.set(stream, conn);
  }

  _unindexStream(stream, conn) {
    if (!stream) return;
    const mapped = this._streamToConn.get(stream);
    if (mapped === conn) {
      this._streamToConn.delete(stream);
    }
  }

  _startCacheCleanup() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => this._cleanupPriceCache(), this.priceCacheCleanupInterval);
  }

  _startEventLoopDelayMonitor() {
    const intervalMs = Math.max(100, Number(this._eventLoopDelay?.intervalMs || 1000));
    let last = process.hrtime.bigint();

    const tick = () => {
      const now = process.hrtime.bigint();
      const elapsedMs = Number(now - last) / 1e6;
      const delayMs = Math.max(0, elapsedMs - intervalMs);

      last = now;

      this._eventLoopDelay.lastDelayMs = delayMs;
      this._eventLoopDelay.lastCheckAt = Date.now();

      this._eventLoopDelaySamples.push(delayMs);
      const maxSamples = Math.max(1, Number(this._eventLoopDelay?.samplesMax || 10));
      if (this._eventLoopDelaySamples.length > maxSamples) {
        this._eventLoopDelaySamples.splice(0, this._eventLoopDelaySamples.length - maxSamples);
      }

      let sum = 0;
      let max = 0;
      for (const v of this._eventLoopDelaySamples) {
        sum += v;
        if (v > max) max = v;
      }
      this._eventLoopDelay.avgDelayMs = this._eventLoopDelaySamples.length > 0 ? sum / this._eventLoopDelaySamples.length : 0;
      this._eventLoopDelay.maxDelayMs = max;

      setTimeout(tick, intervalMs);
    };

    setTimeout(tick, intervalMs);
  }

  _startSymbolCleanup() {
    if (this._symbolCleanupTimer) clearInterval(this._symbolCleanupTimer);
    this._symbolCleanupTimer = setInterval(() => this._cleanupUnusedSymbols(), this.symbolCleanupInterval);
  }

  _startSubscribeQueueProcessor() {
    if (this._subscribeQueueTimer) clearInterval(this._subscribeQueueTimer);
    this._subscribeQueueTimer = setInterval(() => {
      this._processSubscribeQueue();
    }, 200);
  }

  _startReconnectQueueProcessor() {
    setInterval(() => {
      this._processReconnectQueue();
    }, 100);
  }

  _processReconnectQueue() {
    if (this.reconnectInProgress.size >= this.maxConcurrentReconnects) {
      if (this.reconnectQueue.length > 0) {
        logger.debug(
          `[Binance-WS] Reconnect queue full (${this.reconnectQueue.length} waiting, ${this.reconnectInProgress.size} in-progress)`
        );
      }
      return;
    }
    if (this.reconnectQueue.length === 0) return;

    const conn = this.reconnectQueue.shift();
    if (!conn) return;

    this.reconnectInProgress.add(conn);
    logger.info(
      `[Binance-WS] 🔄 Processing reconnect from queue (remaining: ${this.reconnectQueue.length}, in-progress: ${this.reconnectInProgress.size}, streams: ${conn.streams.size})`
    );

    setImmediate(() => {
      try {
        this._disconnect(conn);

        if (conn.reconnectAttempts >= this.maxReconnectAttempts) {
          logger.error('[Binance-WS] Max reconnect attempts reached for a shard.');
          this.reconnectInProgress.delete(conn);
          return;
        }

        conn.reconnectAttempts += 1;
        const baseDelay = Math.min(this.minReconnectDelayMs * Math.pow(2, conn.reconnectAttempts), this.maxReconnectDelayMs);
        const jitter = Math.floor(Math.random() * Math.min(1000, baseDelay * 0.2));
        const delay = Math.max(100, baseDelay + jitter);

        logger.info(`[Binance-WS] ⏱️ Scheduling reconnect in ${delay}ms (attempt ${conn.reconnectAttempts}/${this.maxReconnectAttempts})`);

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
    const minInterval = 1000 / this.subscribeRateLimit;

    if (timeSinceLastSent >= minInterval) {
      const message = this.subscribeMessageQueue.shift();
      if (message) {
        this.subscribeLastSent = now;
        message();
      }
    }
  }

  _checkConnectionRateLimit() {
    const now = Date.now();
    const cutoff = now - this.connectionHistoryWindow;
    this.connectionHistory = this.connectionHistory.filter(h => h.timestamp > cutoff);

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

  _recordNewConnection() {
    this.connectionHistory.push({ timestamp: Date.now() });
  }

  _cleanupPriceCache() {
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;
    let removed = 0;

    for (const [symbol, data] of this.priceCache.entries()) {
      if (now - data.lastAccess > maxAge) {
        this.priceCache.delete(symbol);
        removed++;
      }
    }

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

  onPrice(handler) {
    try {
      if (typeof handler === 'function') this._priceHandlers.add(handler);
    } catch (_) {}
  }

  _emitPrice(tick) {
    this._enqueueTick(tick);
  }

  _enqueueTick(tick) {
    const now = Date.now();
    this.tickQueueStats.enqueued++;
    this.tickQueueStats.lastEnqueueAt = now;

    if (tick && tick._conn) {
      tick._conn._lastTickEnqueueAt = now;
    }

    const currentSize = this.tickQueue.length - this.tickQueueHead;
    if (currentSize >= this.maxTickQueueSize) {
      if (this.tickQueueDropOldest) {
        this.tickQueue[this.tickQueueHead] = null;
        this.tickQueueHead++;
      }
      this.tickQueueStats.dropped++;
    }

    this.tickQueue.push(tick);

    if (this.tickQueueHead > 0 && this.tickQueueHead >= this.tickQueueCompactThreshold) {
      this.tickQueue = this.tickQueue.slice(this.tickQueueHead);
      this.tickQueueHead = 0;
    }

    if (!this.tickProcessorScheduled) {
      this.tickProcessorScheduled = true;
      setImmediate(() => this._drainTickQueue());
    }
  }

  _startTickProcessor() {
    setInterval(() => {
      const now = Date.now();
      const lastProcessed = Number(this._messageStats.lastProcessedAt || 0);
      const sinceProcessed = lastProcessed > 0 ? now - lastProcessed : null;

      if ((this.tickQueue.length - this.tickQueueHead) > 0 && sinceProcessed != null && sinceProcessed > this.tickStarvationThresholdMs && !this.tickProcessorScheduled) {
        this.tickProcessorScheduled = true;
        setImmediate(() => this._drainTickQueue());
      }

      const noMessageThresholdMs = 15000;
      const reconnectCooldownMs = Math.max(30000, Number(this.latencyReconnectCooldownMs || 30000));

      for (const conn of this.connections) {
        const isOpen = conn.ws && (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING);
        if (!isOpen) continue;

        if (this.reconnectQueue.includes(conn) || this.reconnectInProgress.has(conn)) continue;

        const lastMsgAt = Number(conn._lastWsMessageAt || 0);
        const sinceLastMsg = lastMsgAt > 0 ? now - lastMsgAt : null;

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
          break;
        }
      }
    }, 1000);
  }

  async _drainTickQueue() {
    if (this.tickProcessorRunning) return;
    this.tickProcessorRunning = true;
    this.tickProcessorScheduled = false;

    const startedAt = Date.now();
    const deadlineMs = startedAt + Math.max(1, Number(this.tickDrainTimeBudgetMs || 8));
    let drained = 0;

    const handlers = Array.from(this._priceHandlers);

    try {
      while ((this.tickQueue.length - this.tickQueueHead) > 0 && drained < this.tickDrainBatchSize) {
        if (Date.now() >= deadlineMs) break;

        const tick = this.tickQueue[this.tickQueueHead];
        this.tickQueue[this.tickQueueHead] = null;
        this.tickQueueHead++;
        if (!tick) continue;

        drained++;
        this.tickQueueStats.drained++;
        this.tickQueueStats.lastDrainAt = Date.now();

        for (const h of handlers) {
          try {
            const res = h(tick);
            if (res && typeof res.then === 'function') {
              res.catch(err => {
                logger.error(`[Binance-WS] ❌ Price handler error: ${err?.message || err} | symbol: ${tick?.symbol || 'unknown'}`);
              });
            }
          } catch (err) {
            logger.error(`[Binance-WS] ❌ Price handler error: ${err?.message || err} | symbol: ${tick?.symbol || 'unknown'}`);
          }
        }
      }
    } finally {
      if (this.tickQueueHead > 0 && this.tickQueueHead >= this.tickQueueCompactThreshold) {
        this.tickQueue = this.tickQueue.slice(this.tickQueueHead);
        this.tickQueueHead = 0;
      }

      this.tickProcessorRunning = false;

      if ((this.tickQueue.length - this.tickQueueHead) > 0) {
        this.tickProcessorScheduled = true;
        setImmediate(() => this._drainTickQueue());
      }

      const dt = Date.now() - startedAt;
      if (dt > 50 && drained > 0) {
        logger.warn(
          `[Binance-WS] ⚠️ Tick drain took ${dt}ms | drained=${drained} remaining=${Math.max(0, this.tickQueue.length - this.tickQueueHead)}`
        );
      }
    }
  }

  getPrice(symbol) {
    const key = String(symbol).toUpperCase();
    const cached = this.priceCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
      this._trackSymbolUsage(key);
      return cached.price;
    }
    return null;
  }

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

  getBook(symbol) {
    const key = String(symbol).toUpperCase();
    const cached = this.priceCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
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

  getKlineOpen(symbol, interval, bucketStart) {
    return this.candleAggregator.getOpen(symbol, interval, bucketStart);
  }

  getKlineClose(symbol, interval, bucketStart) {
    return this.candleAggregator.getClose(symbol, interval, bucketStart);
  }

  getLatestCandle(symbol, interval) {
    return this.candleAggregator.getLatestCandle(symbol, interval);
  }

  subscribe(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      logger.debug('[Binance-WS] subscribe() called with empty array');
      return;
    }
    const normalized = symbols.map(s => String(s).toUpperCase());

    const currentTotalStreams = this._getTotalStreams();
    if (currentTotalStreams >= this.maxTotalStreams) {
      logger.warn(
        `[Binance-WS] ⚠️ Max total streams limit reached (${currentTotalStreams}/${this.maxTotalStreams}). ` +
          `Unsubscribing unused symbols...`
      );
      this._cleanupUnusedSymbols(true);
    }

    let hasNewStreams = false;
    let newStreamsCount = 0;
    let skippedCount = 0;
    for (const sym of normalized) {
      this._trackSymbolUsage(sym);

      const streamsForSymbol = [`${sym.toLowerCase()}@bookTicker`, `${sym.toLowerCase()}@kline_1m`];

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
        if (this._hasStream(stream)) {
          skippedCount++;
          continue;
        }

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
        let placed = false;
        for (const conn of this.connections) {
          const maxStreamsForUrl = this._calculateMaxStreamsForUrl();
          if (conn.streams.size < maxStreamsForUrl) {
            const testStreams = Array.from(conn.streams);
            testStreams.push(stream);
            const testPath = testStreams.join('/');
            const testUrl = this.baseUrl + testPath;

            if (testUrl.length <= this.maxUrlLength) {
              conn.streams.add(stream);
              this._indexStream(stream, conn);
              conn._needsReconnect = true;
              placed = true;
              break;
            }
          }
        }
        if (!placed) {
          const conn = this._createConnection();
          conn.streams.add(stream);
          this._indexStream(stream, conn);
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

    if (hasNewStreams) {
      for (const conn of this.connections) {
        if (conn._needsReconnect) {
          this.subscribeMessageQueue.push(() => {
            this._reconnect(conn);
          });
        }
      }

      for (const conn of this.connections) {
        if (conn.streams.size > 0) {
          const isOpen = conn.ws && conn.ws.readyState === WebSocket.OPEN;
          if (!isOpen) {
            this.subscribeMessageQueue.push(() => {
              logger.debug(`[Binance-WS] Connecting connection with ${conn.streams.size} streams...`);
              this._connect(conn);
            });
          }
        }
      }
    }
  }

  _createConnection() {
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
      _lastWsMessageAt: 0,
      _lastTickEnqueueAt: 0,
      _lastPongAt: 0,
      _pingTimer: null,
      _pongTimeoutTimer: null
    };
    this.connections.push(conn);
    this._recordNewConnection();
    return conn;
  }

  _hasStream(stream) {
    return this._streamToConn.has(stream);
  }

  _getTotalStreams() {
    return this.connections.reduce((sum, conn) => sum + conn.streams.size, 0);
  }

  _splitConnection(conn) {
    if (conn.streams.size === 0) return;

    const streams = Array.from(conn.streams);
    const maxStreamsPerSplit = Math.floor(this._calculateMaxStreamsForUrl() * 0.9);

    logger.info(`[Binance-WS] 🔀 Splitting connection with ${streams.length} streams into chunks of ${maxStreamsPerSplit}...`);

    // Unindex streams before removing connection
    for (const s of streams) {
      this._unindexStream(s, conn);
    }

    this._disconnect(conn);
    const index = this.connections.indexOf(conn);
    if (index > -1) this.connections.splice(index, 1);

    for (let i = 0; i < streams.length; i += maxStreamsPerSplit) {
      const chunk = streams.slice(i, i + maxStreamsPerSplit);
      const newConn = this._createConnection();
      chunk.forEach(stream => {
        newConn.streams.add(stream);
        this._indexStream(stream, newConn);
      });
      newConn._needsReconnect = true;

      this.subscribeMessageQueue.push(() => {
        this._connect(newConn);
      });
    }

    logger.info(`[Binance-WS] ✅ Split connection into ${Math.ceil(streams.length / maxStreamsPerSplit)} connections`);
  }

  _cleanupUnusedSymbols(force = false) {
    const now = Date.now();
    const unusedSymbols = [];

    for (const [symbol, usage] of this.symbolUsage.entries()) {
      const timeSinceLastAccess = now - usage.lastAccess;
      if (timeSinceLastAccess > this.symbolUnusedTimeout) {
        unusedSymbols.push({ symbol, usage, timeSinceLastAccess });
      }
    }

    unusedSymbols.sort((a, b) => a.usage.lastAccess - b.usage.lastAccess);

    const currentTotal = this._getTotalStreams();
    const targetReduction = force
      ? Math.max(0, currentTotal - this.maxTotalStreams + 500)
      : Math.max(0, unusedSymbols.length * 6);

    let removedStreams = 0;
    let removedSymbols = 0;

    for (const { symbol, usage } of unusedSymbols) {
      if (removedStreams >= targetReduction && !force) break;

      for (const stream of usage.streams) {
        const conn = this._streamToConn.get(stream);
        if (conn && conn.streams && conn.streams.has(stream)) {
          conn.streams.delete(stream);
          this._unindexStream(stream, conn);
          conn._needsReconnect = true;
          removedStreams++;
        }
      }

      this.symbolUsage.delete(symbol);
      removedSymbols++;
    }

    if (removedStreams > 0) {
      logger.info(
        `[Binance-WS] 🧹 Cleaned up ${removedSymbols} unused symbols (${removedStreams} streams). ` +
          `Total streams: ${this._getTotalStreams()}/${this.maxTotalStreams}`
      );

      for (const conn of this.connections) {
        if (conn._needsReconnect && conn.streams.size === 0) {
          // Unindex safety
          for (const s of Array.from(conn.streams)) {
            this._unindexStream(s, conn);
          }
          this._disconnect(conn);
          const index = this.connections.indexOf(conn);
          if (index > -1) this.connections.splice(index, 1);
        } else if (conn._needsReconnect) {
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

    if (url.length > this.maxUrlLength) {
      logger.warn(
        `[Binance-WS] ⚠️ URL too long (${url.length} > ${this.maxUrlLength} chars) for ${streams.length} streams. ` +
          `Splitting connection...`
      );
      return null;
    }

    return url;
  }

  _calculateMaxStreamsForUrl() {
    const avgStreamLength = 20;
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

    if (!conn.url) {
      logger.error(`[Binance-WS] ❌ URL too long for connection with ${conn.streams.size} streams. Splitting connection...`);
      this._splitConnection(conn);
      return;
    }

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
      conn.latencyHistory = [];
      conn._latencyReconnectScheduled = false;

      conn._lastWsMessageAt = Date.now();
      conn._lastPongAt = Date.now();

      this._startConnKeepalive(conn);

      this.reconnectInProgress.delete(conn);
      const queueIndex = this.reconnectQueue.indexOf(conn);
      if (queueIndex > -1) {
        this.reconnectQueue.splice(queueIndex, 1);
        logger.info(
          `[Binance-WS] ✅ Removed from reconnect queue (remaining: ${this.reconnectQueue.length}, in-progress: ${this.reconnectInProgress.size})`
        );
      }

      this._syncServerTimeOffsetIfNeeded(conn).catch(() => {});
    });

    conn.ws.on('pong', () => {
      conn._lastPongAt = Date.now();
      // Pong received, clear the timeout
      if (conn._pongTimeoutTimer) {
        clearTimeout(conn._pongTimeoutTimer);
      }
    });

    conn.ws.on('message', data => {
      try {
        conn._lastWsMessageAt = Date.now();
        this._messageStats.totalReceived++;

        const message = JSON.parse(data);

        if (message.stream && message.data) {
          const streamType = message.stream.split('@')[1];
          const symbol = message.data.s;

          if (streamType === 'bookTicker') {
            const price = (Number(message.data.b) + Number(message.data.a)) / 2;
            const bid = Number(message.data.b);
            const ask = Number(message.data.a);
            const ts = message.data.E;

            if (Number.isFinite(price) && price > 0) {
              const cacheKey = symbol.toUpperCase();
              let cached = this.priceCache.get(cacheKey);
              if (!cached) {
                cached = { price: 0, bid: 0, ask: 0, lastAccess: 0 };
                this.priceCache.set(cacheKey, cached);
              }
              cached.price = price;
              cached.bid = bid;
              cached.ask = ask;
              cached.lastAccess = Date.now();

              this._emitPrice({ symbol, price, ts, bid, ask, _conn: conn });
            }
          } else if (streamType.startsWith('kline_')) {
            const kline = message.data.k;
            this.candleAggregator.addTradeToCandle(
              symbol,
              kline.t,
              kline.c,
              kline.v,
              kline.i
            );
          }
        }
        this._messageStats.totalProcessed++;
        this._messageStats.lastProcessedAt = Date.now();
      } catch (err) {
        this._messageStats.totalErrors++;
        logger.debug(`[Binance-WS] Failed to parse message: ${err?.message || err}`);
      }
    });

    conn.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'none';
      const codeStr = code || 'unknown';
      logger.warn(`[Binance-WS] Connection closed (code: ${codeStr}, reason: ${reasonStr}, streams: ${conn.streams.size})`);

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
        if (!this.reconnectQueue.includes(conn) && !this.reconnectInProgress.has(conn)) {
          this._scheduleReconnect(conn);
        }
      }
    });
  }

  _disconnect(conn) {
    if (conn._reconnectTimer) {
      clearTimeout(conn._reconnectTimer);
      conn._reconnectTimer = null;
    }

    if (conn._pingTimer) {
      clearInterval(conn._pingTimer);
      conn._pingTimer = null;
    }
    if (conn._pongTimeoutTimer) {
      clearTimeout(conn._pongTimeoutTimer);
      conn._pongTimeoutTimer = null;
    }

    if (conn.ws) {
      try {
        if (conn.ws.readyState === WebSocket.OPEN || conn.ws.readyState === WebSocket.CONNECTING) {
          conn.ws.terminate();
        }
      } catch (err) {
        logger.debug(`[Binance-WS] Error during ws.terminate (non-critical): ${err?.message || err}`);
      } finally {
        conn.ws = null;
      }
    }
  }

  _startConnKeepalive(conn) {
    if (!conn || !conn.ws) return;

    if (conn._pingTimer) {
      clearInterval(conn._pingTimer);
      conn._pingTimer = null;
    }
    if (conn._pongTimeoutTimer) {
      clearTimeout(conn._pongTimeoutTimer);
      conn._pongTimeoutTimer = null;
    }

    const intervalMs = Math.max(5000, Number(this.wsPingIntervalMs || 20000));
    const pongTimeoutMs = Math.max(5000, Number(this.wsPongTimeoutMs || 15000));

    conn._pingTimer = setInterval(() => {
      try {
        if (!conn.ws || conn.ws.readyState !== WebSocket.OPEN) {
          clearInterval(conn._pingTimer);
          clearTimeout(conn._pongTimeoutTimer);
          return;
        }

        // Set a timeout for the pong response
        conn._pongTimeoutTimer = setTimeout(() => {
          logger.warn(`[Binance-WS] ⚠️ Pong not received in ${pongTimeoutMs}ms. Terminating connection. | streams=${conn.streams.size}`);
          conn.ws.terminate(); // Force close, 'close' event will trigger reconnect logic
        }, pongTimeoutMs);

        conn.ws.ping();
      } catch (e) {
        logger.debug(`[Binance-WS] ping error (non-critical): ${e?.message || e}`);
      }
    }, intervalMs);
  }

  _scheduleReconnect(conn) {
    if (this.reconnectQueue.includes(conn) || this.reconnectInProgress.has(conn)) {
      logger.debug(`[Binance-WS] Connection already queued/in-progress for reconnect, skipping duplicate`);
      return;
    }

    if (this.reconnectQueue.length >= this.maxReconnectQueueSize) {
      logger.warn(
        `[Binance-WS] ⚠️ Reconnect queue full (${this.reconnectQueue.length}/${this.maxReconnectQueueSize}), ` +
          `skipping reconnect for connection with ${conn.streams.size} streams. Will retry later.`
      );
      conn._latencyReconnectScheduled = false;
      return;
    }

    if (conn.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[Binance-WS] Max reconnect attempts reached for a shard.');
      return;
    }

    if (conn.ws && conn.ws.readyState !== WebSocket.OPEN && conn.ws.readyState !== WebSocket.CONNECTING) {
      logger.debug(`[Binance-WS] Connection already closed (state: ${conn.ws.readyState}), skipping reconnect scheduling`);
      conn._latencyReconnectScheduled = false;
      return;
    }

    setImmediate(() => {
      try {
        this._disconnect(conn);
      } catch (err) {
        logger.error(`[Binance-WS] Error during async disconnect: ${err?.message || err}`);
      }
    });

    this.reconnectQueue.push(conn);
    logger.info(
      `[Binance-WS] 🔄 Queued connection for reconnect (queue size: ${this.reconnectQueue.length}/${this.maxReconnectQueueSize}, in-progress: ${this.reconnectInProgress.size}, streams: ${conn.streams.size})`
    );
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
    for (const conn of this.connections) {
      // Unindex all streams for safety
      for (const s of Array.from(conn.streams || [])) {
        this._unindexStream(s, conn);
      }
      this._disconnect(conn);
    }
    this.connections = [];

    this._streamToConn.clear();

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
      messageStats: {
        totalReceived: this._messageStats.totalReceived,
        totalProcessed: this._messageStats.totalProcessed,
        totalErrors: this._messageStats.totalErrors,
        processingRate:
          this._messageStats.totalReceived > 0
            ? ((this._messageStats.totalProcessed / this._messageStats.totalReceived) * 100).toFixed(2) + '%'
            : '0%',
        lastMessageAt: this._messageStats.lastMessageAt,
        lastProcessedAt: this._messageStats.lastProcessedAt,
        timeSinceLastMessage: this._messageStats.lastMessageAt > 0 ? Date.now() - this._messageStats.lastMessageAt : null,
        timeSinceLastProcessed: this._messageStats.lastProcessedAt > 0 ? Date.now() - this._messageStats.lastProcessedAt : null
      },
      tickQueue: {
        size: Math.max(0, this.tickQueue.length - this.tickQueueHead),
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
      },
      eventLoopDelay: {
        intervalMs: this._eventLoopDelay?.intervalMs || 0,
        lastDelayMs: this._eventLoopDelay?.lastDelayMs || 0,
        avgDelayMs: this._eventLoopDelay?.avgDelayMs || 0,
        maxDelayMs: this._eventLoopDelay?.maxDelayMs || 0,
        lastCheckAt: this._eventLoopDelay?.lastCheckAt || 0
      },
      streamIndex: {
        size: this._streamToConn.size
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
