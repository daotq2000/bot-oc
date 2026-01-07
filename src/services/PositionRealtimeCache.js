import logger from '../utils/logger.js';

/**
 * In-memory realtime position cache updated from Binance user-data WebSocket ACCOUNT_UPDATE.
 * Keyed by botId|symbol|positionSide.
 */
class PositionRealtimeCache {
  constructor() {
    this._cache = new Map();
    this.ttlMs = 5000; // entries older than 5s are considered stale
  }

  _key(botId, symbol, positionSide) {
    return `${botId}|${String(symbol || '').toUpperCase()}|${String(positionSide || 'BOTH').toUpperCase()}`;
  }

  upsert({ botId, symbol, positionSide, positionAmt, entryPrice, unrealizedPnl, marginType, updatedAt }) {
    if (!botId || !symbol) return;
    const key = this._key(botId, symbol, positionSide || 'BOTH');
    this._cache.set(key, {
      botId,
      symbol: String(symbol).toUpperCase(),
      positionSide: String(positionSide || 'BOTH').toUpperCase(),
      positionAmt: Number(positionAmt || 0),
      entryPrice: Number(entryPrice || 0),
      unrealizedPnl: Number(unrealizedPnl || 0),
      marginType: marginType || null,
      updatedAt: updatedAt || Date.now(),
    });
  }

  get({ botId, symbol, positionSide }) {
    const key = this._key(botId, symbol, positionSide || 'BOTH');
    const v = this._cache.get(key);
    if (!v) return null;
    if (Date.now() - (v.updatedAt || 0) > this.ttlMs) return null;
    return v;
  }

  cleanup() {
    const now = Date.now();
    let removed = 0;
    for (const [k, v] of this._cache.entries()) {
      if (now - (v?.updatedAt || 0) > this.ttlMs * 6) { // Clean up entries older than 30s
        this._cache.delete(k);
        removed++;
      }
    }
    if (removed > 0) logger.debug(`[PositionRealtimeCache] Cleaned ${removed} stale entries`);
  }
}

export const positionRealtimeCache = new PositionRealtimeCache();
