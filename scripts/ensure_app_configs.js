import pool from '../src/config/database.js';
import dotenv from 'dotenv';

dotenv.config();

async function ensureAppConfigsTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS app_configs (
      id INT PRIMARY KEY AUTO_INCREMENT,
      config_key VARCHAR(100) NOT NULL UNIQUE,
      config_value TEXT NULL,
      description VARCHAR(255) NULL,
      updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
}

async function upsertConfig(key, value, description = null) {
  const val = value === undefined || value === null ? null : String(value);
  await pool.execute(
    `INSERT INTO app_configs (config_key, config_value, description)
     VALUES (?, ?, ?)
     ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), description = VALUES(description)`,
    [key, val, description]
  );
}

async function seedFromEnv() {
  const entries = [
    ['TELEGRAM_BOT_TOKEN', process.env.TELEGRAM_BOT_TOKEN, 'Telegram bot token'],
    ['TELEGRAM_ALERT_CHANNEL_ID', process.env.TELEGRAM_ALERT_CHANNEL_ID, 'Telegram alert channel ID'],
    ['BINANCE_TESTNET', process.env.BINANCE_TESTNET ?? 'true', 'Use Binance Futures testnet (true/false)'],
    ['BINANCE_FUTURES_ENDPOINT', process.env.BINANCE_FUTURES_ENDPOINT, 'Custom Binance testnet endpoint'],
    ['BINANCE_REST_PRICE_COOLDOWN_MS', process.env.BINANCE_REST_PRICE_COOLDOWN_MS ?? '5000', 'REST price fallback cooldown in ms'],
    ['BINANCE_DEFAULT_MARGIN_TYPE', process.env.BINANCE_DEFAULT_MARGIN_TYPE ?? 'CROSSED', 'Default margin type'],
    ['BINANCE_DEFAULT_LEVERAGE', process.env.BINANCE_DEFAULT_LEVERAGE ?? '5', 'Default leverage'],
    ['SIGNAL_SCAN_INTERVAL_MS', process.env.SIGNAL_SCAN_INTERVAL_MS ?? '30000', 'Signal scanner interval in ms'],
    ['CANDLE_UPDATE_INTERVAL_MS', process.env.CANDLE_UPDATE_INTERVAL_MS ?? '30000', 'Candle updater interval in ms'],
    ['POSITION_MONITOR_INTERVAL_MS', process.env.POSITION_MONITOR_INTERVAL_MS ?? '30000', 'Position monitor interval in ms'],
    ['STRATEGY_CACHE_TTL_MS', process.env.STRATEGY_CACHE_TTL_MS ?? '10000', 'Strategies cache TTL in ms'],
    ['SL_UPDATE_THRESHOLD_TICKS', process.env.SL_UPDATE_THRESHOLD_TICKS ?? '2', 'SL update threshold in ticks'],
    ['TP_UPDATE_THRESHOLD_TICKS', process.env.TP_UPDATE_THRESHOLD_TICKS ?? process.env.SL_UPDATE_THRESHOLD_TICKS ?? '2', 'TP update threshold in ticks'],
    ['SHORT_EXTEND_OVERRIDE', process.env.SHORT_EXTEND_OVERRIDE, 'Override extend for SHORT side'],
    ['LOG_LEVEL', process.env.LOG_LEVEL ?? 'info', 'Logger level'],
    ['CONCURRENCY_LOCK_TIMEOUT', process.env.CONCURRENCY_LOCK_TIMEOUT ?? '5', 'MySQL advisory lock timeout in seconds']
  ];

  for (const [k, v, d] of entries) {
    await upsertConfig(k, v, d);
  }
}

(async () => {
  try {
    await ensureAppConfigsTable();
    await seedFromEnv();
    console.log('✅ app_configs ensured and seeded from .env');
  } catch (e) {
    console.error('❌ ensure_app_configs error:', e?.message || e);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
  process.exit(0);
})();

