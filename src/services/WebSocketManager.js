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
    this.maxStreamsPerConn = 100; // Giảm xuống 100 để ổn định hơn và tránh quá tải/lỗi latency
    this.maxUrlLength = 8000; // Max URL length (an toàn dưới 8192)
    this.maxReconnectAttempts = 10;
    this.maxPriceCacheSize = 1000; // Maximum number of symbols to cache (reduced from 5000 to save memory)
    this.priceCacheCleanupInterval = 1 * 60 * 1000; // Cleanup every 1 minute (reduced from 5 minutes)
    this._cleanupTimer = null;

    // ✅ LATENCY MONITORING: Track latency và auto-reconnect nếu latency cao liên tục
    this.highLatencyThreshold = 2000; // 2 seconds - threshold để coi là "high latency"
    this.extremeLatencyThreshold = 5000; // 5 seconds - extreme latency, reconnect immediately
    this.highLatencyCountThreshold = 5; // Nếu có 5 lần latency cao liên tục → reconnect (giảm từ 10)
    this.latencyCheckWindow = 10000; // 10 seconds window để check latency history (giảm từ 30s để phản ứng nhanh hơn)

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

    this._startCacheCleanup();
    this._startSymbolCleanup();
    this._startSubscribeQueueProcessor();
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
    for (const h of Array.from(this._priceHandlers)) {
      try {
        h(tick);
      } catch (_) {}
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
      latencyHistory: []
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

      // best-effort sync time on open
      this._syncServerTimeOffsetIfNeeded(conn).catch(() => {});
    });

    conn.ws.on('message', raw => {
      const receivedAt = Date.now();
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

          const cutoff = receivedAt - this.latencyCheckWindow;
          conn.latencyHistory = conn.latencyHistory.filter(h => h.timestamp > cutoff);

          const extremeCount = conn.latencyHistory.filter(h => h.latency > this.extremeLatencyThreshold).length;
          if (extremeCount >= 2 && !conn._latencyReconnectScheduled) {
            logger.error(
              `[Binance-WS] 🚨 EXTREME latency detected: ${latency}ms (threshold: ${this.extremeLatencyThreshold}ms) ` +
                `| stream: ${streamName}. Reconnecting...`
            );
            conn._latencyReconnectScheduled = true;
            setImmediate(() => {
              this._scheduleReconnect(conn);
            });
            return;
          }

          const highLatencyCount = conn.latencyHistory.filter(h => h.latency > this.highLatencyThreshold).length;
          if (highLatencyCount >= this.highLatencyCountThreshold && !conn._latencyReconnectScheduled) {
            const avgLatency = conn.latencyHistory.reduce((sum, h) => sum + h.latency, 0) / conn.latencyHistory.length;
            logger.warn(
              `[Binance-WS] ⚠️ Persistent high latency detected: ${highLatencyCount} high-latency events in last ${this.latencyCheckWindow /
                1000}s ` +
                `(avg: ${avgLatency.toFixed(0)}ms, threshold: ${this.highLatencyThreshold}ms). Reconnecting...`
            );
            conn._latencyReconnectScheduled = true;
            setImmediate(() => {
              this._scheduleReconnect(conn);
            });
          }

          if (latency > 3000) {
            logger.debug(
              `[Binance-WS] ⏭️ Skipping stale message: latency=${latency}ms > 3000ms | stream: ${streamName}`
            );
            return;
          }
        }

        if (latency > 1000) {
          logger.debug(`[Binance-WS] High latency detected: ${latency}ms | stream: ${msg?.stream || 'unknown'}`);
        }

        setImmediate(() => {
          try {
            // bookTicker stream
            if (payload && payload.u && payload.s && payload.b && payload.a) {
              const symbol = String(payload.s).toUpperCase();
              const bid = parseFloat(payload.b);
              const ask = parseFloat(payload.a);
              if (Number.isFinite(bid) && Number.isFinite(ask)) {
                this.priceCache.set(symbol, { price: bid, bid, ask, lastAccess: receivedAt });
                this._trackSymbolUsage(symbol);
                this._emitPrice({ symbol, price: bid, bid, ask, ts: eventTime });
              }
            }
            // trade stream
            else if (payload && payload.e === 'trade') {
              const symbol = String(payload.s).toUpperCase();
              const price = parseFloat(payload.p);
              const volume = parseFloat(payload.q);
              if (Number.isFinite(price) && Number.isFinite(volume)) {
                this.candleAggregator.ingestTick({ symbol, price, volume, ts: eventTime });
                const cached = this.priceCache.get(symbol) || { lastAccess: 0 };
                cached.price = price;
                cached.lastAccess = receivedAt;
                this.priceCache.set(symbol, cached);
                this._trackSymbolUsage(symbol);
                this._emitPrice({ symbol, price, ts: eventTime });
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
                ts: eventTime
              });
            }
          } catch (e) {
            logger.debug(`[Binance-WS] Error processing message payload: ${e?.message || e}`);
          }
        });
      } catch (e) {
        logger.debug(`[Binance-WS] Failed to handle message: ${e?.message || e}`);
      }
    });

    conn.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'none';
      const codeStr = code || 'unknown';
      logger.warn(`[Binance-WS] Connection closed (code: ${codeStr}, reason: ${reasonStr}, streams: ${conn.streams.size})`);
      this._scheduleReconnect(conn);
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
        this._scheduleReconnect(conn);
      }
    });
  }

  _disconnect(conn) {
    if (conn._reconnectTimer) {
      clearTimeout(conn._reconnectTimer);
      conn._reconnectTimer = null;
    }
    if (conn.ws) {
      try {
        conn.ws.terminate();
      } catch (_) {}
      conn.ws = null;
    }
  }

  _scheduleReconnect(conn) {
    this._disconnect(conn);
    if (conn.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[Binance-WS] Max reconnect attempts reached for a shard.');
      return;
    }
    conn.reconnectAttempts += 1;

    const baseDelay = Math.min(this.minReconnectDelayMs * Math.pow(2, conn.reconnectAttempts), this.maxReconnectDelayMs);
    const jitter = Math.floor(Math.random() * Math.min(1000, baseDelay * 0.2));
    const delay = baseDelay + jitter;

    conn._reconnectTimer = setTimeout(() => this._connect(conn), delay);
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
      connections: []
    };

    for (const conn of this.connections) {
      const isConnected = conn.ws && conn.ws.readyState === WebSocket.OPEN;
      status.connectedCount += isConnected ? 1 : 0;
      status.totalStreams += conn.streams.size;
      status.connections.push({
        streams: conn.streams.size,
        connected: isConnected,
        state: conn.ws?.readyState || 'null'
      });
    }

    return status;
  }
}

export const webSocketManager = new WebSocketManager();
