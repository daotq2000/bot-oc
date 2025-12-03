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

(async () => {
  try {
    await ensureColumn('positions', 'tp_order_id', 'VARCHAR(100) NULL');
    await ensureColumn('positions', 'sl_order_id', 'VARCHAR(100) NULL');
  } catch (e) {
    console.error('Schema update error:', e?.message || e);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
  process.exit(0);
})();

