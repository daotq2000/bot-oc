import WebSocket from 'ws';
import logger from '../utils/logger.js';

/**
 * Binance Futures WebSocket Manager (public markPrice stream)
 * - Supports thousands of symbols by sharding subscriptions across multiple connections
 * - Parses tick messages and updates an in-memory price cache
 */
class WebSocketManager {
  constructor() {
    this.connections = []; // [{ ws, streams:Set<string>, url, reconnectAttempts }]
    this.priceCache = new Map(); // symbol -> { price, lastAccess }
    this._priceHandlers = new Set(); // listeners for price ticks
    this.klineOpenCache = new Map(); // key: symbol|interval|bucketStart -> { open, lastUpdate }
    this.klineCloseCache = new Map(); // key: symbol|interval|bucketStart -> { close, lastUpdate }

    this.baseUrl = 'wss://fstream.binance.com/stream?streams=';
    this.maxStreamsPerConn = 180; // keep well below 200 limit and URL length issues
    this.maxReconnectAttempts = 10;
    this.maxPriceCacheSize = 1000; // Maximum number of symbols to cache (reduced from 5000 to save memory)
    this.priceCacheCleanupInterval = 1 * 60 * 1000; // Cleanup every 1 minute (reduced from 5 minutes)
    this._cleanupTimer = null;
    this._startCacheCleanup();
  }

  _startCacheCleanup() {
    if (this._cleanupTimer) clearInterval(this._cleanupTimer);
    this._cleanupTimer = setInterval(() => this._cleanupPriceCache(), this.priceCacheCleanupInterval);
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
      const entries = Array.from(this.priceCache.entries())
        .sort((a, b) => a[1].lastAccess - b[1].lastAccess);
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
      try { h(tick); } catch (_) {}
    }
  }

  // Return latest cached price
  getPrice(symbol) {
    const key = String(symbol).toUpperCase();
    const cached = this.priceCache.get(key);
    if (cached) {
      cached.lastAccess = Date.now();
      return cached.price;
    }
    return null;
  }

  /**
   * Get cached kline OPEN price for a given symbol/interval/bucket.
   * @param {string} symbol - e.g. 'BTCUSDT'
   * @param {string} interval - e.g. '1m' or '5m'
   * @param {number} bucketStart - bucket start timestamp (ms)
   * @returns {number|null}
   */
  getKlineOpen(symbol, interval, bucketStart) {
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${bucketStart}`;
    const cached = this.klineOpenCache.get(key);
    if (!cached || !Number.isFinite(cached.open) || cached.open <= 0) {
      return null;
    }
    cached.lastUpdate = Date.now();
    return cached.open;
  }

  _storeKlineClose(symbol, interval, close, startTime) {
    if (!Number.isFinite(close) || close <= 0 || !startTime) return;
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${startTime}`;
    this.klineCloseCache.set(key, {
      close,
      lastUpdate: Date.now()
    });
  }

  _storeKlineOpen(symbol, interval, open, startTime) {
    if (!Number.isFinite(open) || open <= 0 || !startTime) return;
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${startTime}`;
    this.klineOpenCache.set(key, {
      open,
      lastUpdate: Date.now()
    });
  }

  /**
   * Get cached kline CLOSE price for a given symbol/interval/bucket.
   * @param {string} symbol - e.g. 'BTCUSDT'
   * @param {string} interval - e.g. '1m' or '5m'
   * @param {number} bucketStart - bucket start timestamp (ms)
   * @returns {number|null}
   */
  getKlineClose(symbol, interval, bucketStart) {
    const sym = String(symbol).toUpperCase();
    const key = `${sym}|${interval}|${bucketStart}`;
    const cached = this.klineCloseCache.get(key);
    if (!cached || !Number.isFinite(cached.close) || cached.close <= 0) {
      return null;
    }
    cached.lastUpdate = Date.now();
    return cached.close;
  }

  // Subscribe a list of symbols (normalized like BTCUSDT)
  subscribe(symbols) {
    if (!Array.isArray(symbols) || symbols.length === 0) {
      logger.debug('[Binance-WS] subscribe() called with empty array');
      return;
    }
    const normalized = symbols.map(s => String(s).toUpperCase());
    logger.debug(`[Binance-WS] subscribe() called with ${normalized.length} symbols (${normalized.slice(0, 5).join(', ')}${normalized.length > 5 ? '...' : ''})`);

    let hasNewStreams = false;
    let newStreamsCount = 0;
    let skippedCount = 0;
    for (const sym of normalized) {
      // We subscribe both markPrice and kline (1m, 5m) to build accurate OPEN cache.
      const streamsForSymbol = [
        `${sym.toLowerCase()}@markPrice`,
        `${sym.toLowerCase()}@kline_1m`,
        `${sym.toLowerCase()}@kline_5m`
      ];

      for (const stream of streamsForSymbol) {
      // If already in any connection, skip
      if (this._hasStream(stream)) {
        skippedCount++;
        continue;
      }

      hasNewStreams = true;
      newStreamsCount++;
      // Put into an existing connection with space, else create new
      let placed = false;
      for (const conn of this.connections) {
        if (conn.streams.size < this.maxStreamsPerConn) {
          conn.streams.add(stream);
          placed = true;
          break;
        }
      }
      if (!placed) {
        const conn = this._createConnection();
        conn.streams.add(stream);
        logger.debug(`[Binance-WS] Created new connection for stream ${stream} (total connections: ${this.connections.length})`);
        }
      }
    }
    if (newStreamsCount > 0) {
      logger.debug(`[Binance-WS] Added ${newStreamsCount} new streams, skipped ${skippedCount} existing streams. Total connections: ${this.connections.length}`);
    }

    // Reconnect connections that had stream changes
    for (const conn of this.connections) {
      if (conn._needsReconnect) {
        this._reconnect(conn);
      }
    }

    // If new streams were added, ensure connections are established
    if (hasNewStreams) {
      logger.debug(`[Binance-WS] New streams added, ensuring ${this.connections.length} connections are open...`);
      for (const conn of this.connections) {
        if (conn.streams.size > 0) {
          const isOpen = conn.ws && conn.ws.readyState === WebSocket.OPEN;
          if (!isOpen) {
            logger.debug(`[Binance-WS] Connecting connection with ${conn.streams.size} streams...`);
            this._connect(conn);
          }
        }
      }
    }
  }

  // Create a new WS connection shell (without connecting yet)
  _createConnection() {
    const conn = {
      ws: null,
      streams: new Set(),
      url: '',
      reconnectAttempts: 0,
      _needsReconnect: true
    };
    this.connections.push(conn);
    return conn;
  }

  _hasStream(stream) {
    for (const c of this.connections) {
      if (c.streams.has(stream)) return true;
    }
    return false;
  }

  _buildUrl(conn) {
    const streams = Array.from(conn.streams);
    const path = streams.join('/');
    return this.baseUrl + path;
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
    logger.debug(`[Binance-WS] Connecting to ${conn.url.substring(0, 80)}... (${conn.streams.size} streams)`);
    try {
      conn.ws = new WebSocket(conn.url);
    } catch (e) {
      logger.error('[Binance-WS] Failed to construct WebSocket:', {
        error: e?.message || String(e),
        code: e?.code || 'unknown',
        url: conn.url?.substring(0, 100),
        streams: conn.streams.size
      });
      this._scheduleReconnect(conn);
      return;
    }

    conn.ws.on('open', () => {
      logger.info(`[Binance-WS] ✅ Connected successfully (${conn.streams.size} streams)`);
      conn.reconnectAttempts = 0;
      conn._needsReconnect = false;
    });

    conn.ws.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw);
        const payload = msg?.data || msg; // combined stream or direct

        // Mark price tick (markPrice stream)
        if (payload && payload.s && payload.p !== undefined) {
          const symbol = String(payload.s).toUpperCase();
          const price = parseFloat(payload.p);
          if (Number.isFinite(price)) {
            // Use LRU-style caching with size limit
            if (this.priceCache.size >= this.maxPriceCacheSize && !this.priceCache.has(symbol)) {
              // Remove oldest entry if at limit
              const oldest = Array.from(this.priceCache.entries())
                .sort((a, b) => a[1].lastAccess - b[1].lastAccess)[0];
              if (oldest) this.priceCache.delete(oldest[0]);
            }
            this.priceCache.set(symbol, { price, lastAccess: Date.now() });
            this._emitPrice({ symbol, price, ts: Date.now() });
          }
        }

        // Kline stream (for OPEN caching)
        if (payload && payload.e === 'kline' && payload.s && payload.k) {
          const symbol = String(payload.s).toUpperCase();
          const k = payload.k;
          const interval = String(k.i || '').toLowerCase(); // e.g. '1m', '5m'
          const openStr = k.o;
          const startTime = Number(k.t); // candle start time (ms)
          const open = parseFloat(openStr);
          if (Number.isFinite(open) && open > 0 && startTime > 0 && (interval === '1m' || interval === '5m')) {
            this._storeKlineOpen(symbol, interval, open, startTime);
          }

          // Store CLOSE when candle is closed (k.x === true)
          const isClosed = Boolean(k.x);
          if (isClosed) {
            const close = parseFloat(k.c);
            if (Number.isFinite(close) && close > 0 && startTime > 0 && (interval === '1m' || interval === '5m')) {
              this._storeKlineClose(symbol, interval, close, startTime);
            }
          }
        }
      } catch (_) {}
    });

    conn.ws.on('close', (code, reason) => {
      const reasonStr = reason?.toString() || 'none';
      const codeStr = code || 'unknown';
      logger.warn(`[Binance-WS] Connection closed (code: ${codeStr}, reason: ${reasonStr}, streams: ${conn.streams.size})`);
      this._scheduleReconnect(conn);
    });

    conn.ws.on('error', (err) => {
      // Log detailed error information
      const errorInfo = {
        message: err?.message || String(err),
        code: err?.code || 'unknown',
        readyState: conn.ws?.readyState || 'unknown',
        streams: conn.streams.size,
        url: conn.url?.substring(0, 100) || 'unknown'
      };
      
      // Only log if not a common "closed before connection" error to avoid spam
      const isCommonError = err?.message?.includes('closed before') || 
                          err?.message?.includes('ECONNREFUSED') ||
                          err?.code === 'ECONNREFUSED';
      
      if (isCommonError) {
        logger.debug(`[Binance-WS] Connection error (will retry): ${errorInfo.message} (code: ${errorInfo.code}, state: ${errorInfo.readyState})`);
      } else {
        logger.error(`[Binance-WS] Error:`, errorInfo);
      }
      
      // Only schedule reconnect if not already closed
      if (conn.ws?.readyState !== WebSocket.CLOSED && conn.ws?.readyState !== WebSocket.CLOSING) {
        this._scheduleReconnect(conn);
      }
    });
  }

  _disconnect(conn) {
    if (conn.ws) {
      try { conn.ws.terminate(); } catch (_) {}
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
    const delay = Math.min(1000 * Math.pow(2, conn.reconnectAttempts), 15000);
    setTimeout(() => this._connect(conn), delay);
  }

  _reconnect(conn) {
    conn._needsReconnect = false;
    this._disconnect(conn);
    this._connect(conn);
  }

  // Forcibly reconnect all shards (used after bulk subscription changes)
  connect() {
    logger.info(`[Binance-WS] connect() called: ${this.connections.length} existing connections`);
    if (this.connections.length === 0) {
      logger.warn('[Binance-WS] No connections exist yet. Connections will be created when symbols are subscribed.');
      return;
    }
    for (const conn of this.connections) {
      this._reconnect(conn);
    }
  }

  // Terminate all connections
  disconnect() {
    for (const conn of this.connections) this._disconnect(conn);
    this.connections = [];
    if (this._cleanupTimer) {
      clearInterval(this._cleanupTimer);
      this._cleanupTimer = null;
    }
    logger.info('[Binance-WS] All shards disconnected.');
  }

  // Get connection status for debugging
  getStatus() {
    const status = {
      totalConnections: this.connections.length,
      connectedCount: 0,
      totalStreams: 0,
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

