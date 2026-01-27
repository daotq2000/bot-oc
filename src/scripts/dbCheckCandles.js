import pool from '../config/database.js';
import logger from '../utils/logger.js';

/**
 * Smoke test for candles table + indexes and basic CRUD.
 * Uses current .env (DB_HOST/DB_USER/DB_PASSWORD/DB_NAME).
 */

async function main() {
  const exchange = 'binance';
  const symbol = 'TESTUSDT';
  const interval = '1m';
  const now = Date.now();
  const open_time = now - (now % 60000);

  const candle = {
    exchange,
    symbol,
    interval,
    open_time,
    open: 1.0,
    high: 1.2,
    low: 0.9,
    close: 1.1,
    volume: 123.45,
    close_time: open_time + 60000 - 1
  };

  const conn = await pool.getConnection();
  try {
    // 1) check table exists
    const [tables] = await conn.query(`SHOW TABLES LIKE 'candles'`);
    if (!tables || tables.length === 0) {
      throw new Error('candles table NOT found in current DB. Run migration/schema first.');
    }

    // 2) check indexes
    const [idx] = await conn.query(`SHOW INDEX FROM candles`);
    const indexNames = new Set((idx || []).map(r => r.Key_name));
    logger.info(`[dbCheckCandles] Indexes: ${Array.from(indexNames).sort().join(', ')}`);

    // 3) UPSERT insert
    await conn.query(
      `INSERT INTO candles (exchange, symbol, \`interval\`, open_time, open, high, low, close, volume, close_time)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         open=VALUES(open), high=VALUES(high), low=VALUES(low), close=VALUES(close), volume=VALUES(volume), close_time=VALUES(close_time)`,
      [
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
      ]
    );

    // 4) SELECT
    const [rows] = await conn.query(
      `SELECT exchange, symbol, \`interval\`, open_time, open, high, low, close, volume, close_time
       FROM candles
       WHERE exchange=? AND symbol=? AND \`interval\`=?
       ORDER BY open_time DESC
       LIMIT 5`,
      [exchange, symbol, interval]
    );
    logger.info(`[dbCheckCandles] Selected rows=${rows.length}, latest_open_time=${rows?.[0]?.open_time ?? null}`);

    // 5) DELETE the test row
    const [del] = await conn.query(
      `DELETE FROM candles WHERE exchange=? AND symbol=? AND \`interval\`=? AND open_time=?`,
      [exchange, symbol, interval, open_time]
    );
    logger.info(`[dbCheckCandles] Deleted test row, affectedRows=${del?.affectedRows ?? 0}`);

    logger.info('[dbCheckCandles] ✅ OK');
  } finally {
    conn.release();
  }
}

main().catch(err => {
  logger.error(`[dbCheckCandles] ❌ ${err?.message || err}`);
  process.exit(1);
});


