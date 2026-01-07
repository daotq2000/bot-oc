import pool from '../src/config/database.js';

async function ensureColumn(table, column, typeSQL) {
  const [rows] = await pool.execute(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = database() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column]
  );
  if (rows.length === 0) {
    const sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${typeSQL}`;
    await pool.execute(sql);
    console.log(`Added column ${table}.${column}`);
  } else {
    console.log(`Column exists ${table}.${column}`);
  }
}

async function ensureTableConcurrencyReservations() {
  // Create table if not exists
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS concurrency_reservations (
      id INT PRIMARY KEY AUTO_INCREMENT,
      bot_id INT NOT NULL,
      token VARCHAR(64) NOT NULL,
      status ENUM('active','released','cancelled') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      released_at TIMESTAMP NULL,
      UNIQUE KEY uniq_token (token),
      INDEX idx_bot_status (bot_id, status),
      CONSTRAINT fk_conc_bot FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('Ensured table concurrency_reservations exists.');
}

(async () => {
  try {
    await ensureColumn('bots', 'max_concurrent_trades', 'INT NOT NULL DEFAULT 5');
    await ensureColumn('bots', 'telegram_alert_channel_id', 'VARCHAR(100) NULL');
    await ensureColumn('bots', 'binance_testnet', 'TINYINT(1) NULL');
    await ensureColumn('bots', 'concurrency_lock_timeout', 'INT NULL');
    await ensureColumn('symbol_filters', 'max_leverage', 'INT NULL DEFAULT 125');
    await ensureTableConcurrencyReservations();
  } catch (e) {
    console.error('Schema ensure error:', e?.message || e);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
  process.exit(0);
})();

