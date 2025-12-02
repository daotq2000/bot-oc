import WebSocket from 'ws';
import logger from '../utils/logger.js';

/**
 * WebSocket Manager - Handles WebSocket connections and subscriptions for real-time price data
 */
class WebSocketManager {
  constructor() {
    this.ws = null;
    this.subscriptions = new Map(); // symbol -> subscription details
    this.priceCache = new Map(); // symbol -> price
    this.baseUrl = 'wss://fstream.binance.com/stream?streams=';
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = 10;
  }

  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      logger.info('WebSocket already connected.');
      return;
    }

    const streams = Array.from(this.subscriptions.keys()).join('/');
    if (streams.length === 0) {
      logger.warn('No streams to connect to.');
      return;
    }

    const url = this.baseUrl + streams;
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      logger.info('WebSocket connection established.');
      this.reconnectAttempts = 0;
    });

    this.ws.on('message', (data) => {
      const message = JSON.parse(data);
      if (message.data && message.data.s) {
        const symbol = message.data.s;
        const price = parseFloat(message.data.p);
        this.priceCache.set(symbol, price);
        logger.debug(`[WS] ${symbol}: ${price}`);
      }
    });

    this.ws.on('close', () => {
      logger.warn('WebSocket connection closed.');
      this.reconnect();
    });

    this.ws.on('error', (error) => {
      logger.error('WebSocket error:', error);
      this.reconnect();
    });
  }

  reconnect() {
    if (this.reconnectAttempts < this.maxReconnectAttempts) {
      this.reconnectAttempts++;
      const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000);
      logger.info(`Attempting to reconnect in ${delay / 1000}s...`);
      setTimeout(() => this.connect(), delay);
    } else {
      logger.error('Max reconnect attempts reached. Please check the connection.');
    }
  }

  subscribe(symbols) {
    let updated = false;
    for (const symbol of symbols) {
      const streamName = `${symbol.toLowerCase()}@markPrice`;
      if (!this.subscriptions.has(streamName)) {
        this.subscriptions.set(streamName, { symbol });
        updated = true;
      }
    }

    if (updated) {
      logger.info('Subscriptions updated. Reconnecting WebSocket...');
      this.disconnect();
      this.connect();
    }
  }

  disconnect() {
    if (this.ws) {
      this.ws.terminate();
      this.ws = null;
      logger.info('WebSocket disconnected.');
    }
  }

  getPrice(symbol) {
    return this.priceCache.get(symbol.toUpperCase());
  }
}

// Export a singleton instance
export const webSocketManager = new WebSocketManager();

