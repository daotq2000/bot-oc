/**
 * Application constants
 */

export const EXCHANGES = {
  BINANCE: 'binance',
  MEXC: 'mexc',
  GATE: 'gate'
};

export const TRADE_TYPES = {
  LONG: 'long',
  SHORT: 'short',
  BOTH: 'both'
};

export const POSITION_STATUS = {
  OPEN: 'open',
  CLOSED: 'closed',
  CANCELLED: 'cancelled'
};

export const TRANSACTION_TYPES = {
  SPOT_TO_FUTURE: 'spot_to_future',
  FUTURE_TO_SPOT: 'future_to_spot',
  WITHDRAW: 'withdraw'
};

export const TRANSACTION_STATUS = {
  PENDING: 'pending',
  SUCCESS: 'success',
  FAILED: 'failed'
};

export const CLOSE_REASONS = {
  TP_HIT: 'tp_hit',
  SL_HIT: 'sl_hit',
  MANUAL: 'manual',
  CANDLE_END: 'candle_end'
};

export const INTERVALS = ['1m', '3m', '5m', '15m', '30m', '1h'];

export const MIN_WITHDRAW_AMOUNT = 10.00; // USDT

export const DEFAULT_CRON_PATTERNS = {
  CANDLE_UPDATE: '*/1 * * * *', // Every minute
  SIGNAL_SCAN: '*/1 * * * *', // Every minute (fallback for cron)
  POSITION_MONITOR: '*/1 * * * *', // Every minute (will be overridden by setInterval for 30s)
  BALANCE_CHECK: '*/15 * * * *', // Every 15 minutes
  WITHDRAW_CHECK: '0 * * * *' // Every hour
};

// Scan intervals in milliseconds (for setInterval)
export const SCAN_INTERVALS = {
  SIGNAL_SCAN: parseInt(process.env.SIGNAL_SCAN_INTERVAL_MS || '5000'), // Default: 30 seconds
  POSITION_MONITOR: parseInt(process.env.POSITION_MONITOR_INTERVAL_MS || '30000'), // Default: 30 seconds (move TP/SL once per 30s)
  POSITION_SYNC: parseInt(process.env.POSITION_SYNC_INTERVAL_MS || '30000'), // Default: 30 seconds (reduced for better sync and faster liquidation detection)
  CANDLE_UPDATE: parseInt(process.env.CANDLE_UPDATE_INTERVAL_MS || '10000'), // Default: 30 seconds
  STRATEGY_CACHE_TTL: parseInt(process.env.STRATEGY_CACHE_TTL_MS || '100000') // Default: 10 seconds
};

