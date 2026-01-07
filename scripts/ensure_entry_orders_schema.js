import pool from '../src/config/database.js';

async function ensureEntryOrdersTable() {
  await pool.execute(`
    CREATE TABLE IF NOT EXISTS entry_orders (
      id INT PRIMARY KEY AUTO_INCREMENT,
      strategy_id INT NOT NULL,
      bot_id INT NOT NULL,
      order_id VARCHAR(100) NOT NULL,
      symbol VARCHAR(50) NOT NULL,
      side VARCHAR(10) NOT NULL,
      amount DECIMAL(20,8) NOT NULL,
      entry_price DECIMAL(20,8) NOT NULL,
      status ENUM('open','filled','canceled','expired') NOT NULL DEFAULT 'open',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      UNIQUE KEY uniq_order (order_id),
      INDEX idx_status (status),
      INDEX idx_strategy (strategy_id),
      INDEX idx_bot_status (bot_id, status),
      CONSTRAINT fk_entry_orders_strategy FOREIGN KEY (strategy_id) REFERENCES strategies(id) ON DELETE CASCADE,
      CONSTRAINT fk_entry_orders_bot FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
  `);
  console.log('Ensured table entry_orders exists.');
}

(async () => {
  try {
    await ensureEntryOrdersTable();
  } catch (e) {
    console.error('Schema ensure error (entry_orders):', e?.message || e);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
  process.exit(0);
})();


