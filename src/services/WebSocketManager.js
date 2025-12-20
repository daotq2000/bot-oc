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
    this.priceCache = new Map(); // symbol -> price
    this._priceHandlers = new Set(); // listeners for price ticks

    this.baseUrl = 'wss://fstream.binance.com/stream?streams=';
    this.maxStreamsPerConn = 180; // keep well below 200 limit and URL length issues
    this.maxReconnectAttempts = 10;
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
    return this.priceCache.get(String(symbol).toUpperCase());
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
      const stream = `${sym.toLowerCase()}@markPrice`;
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
      logger.error('[Binance-WS] Failed to construct WebSocket:', e?.message || e);
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
        if (payload && payload.s && payload.p !== undefined) {
          const symbol = String(payload.s).toUpperCase();
          const price = parseFloat(payload.p);
          if (Number.isFinite(price)) {
            this.priceCache.set(symbol, price);
            this._emitPrice({ symbol, price, ts: Date.now() });
          }
        }
      } catch (_) {}
    });

    conn.ws.on('close', () => {
      logger.warn('[Binance-WS] Closed');
      this._scheduleReconnect(conn);
    });

    conn.ws.on('error', (err) => {
      logger.error('[Binance-WS] Error:', err?.message || err);
      this._scheduleReconnect(conn);
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

