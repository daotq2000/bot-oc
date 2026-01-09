import pool from '../src/config/database.js';

async function ensureColumn(table, column, typeSQL) {
  const [rows] = await pool.execute(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = database() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column]
  );
  if (rows.length === 0) {
    const sql = `ALTER TABLE ${table} ADD COLUMN ${column} ${typeSQL}`;
    await pool.execute(sql);
    console.log(`✅ Added column ${table}.${column}`);
  } else {
    console.log(`ℹ️  Column already exists ${table}.${column}`);
  }
}

(async () => {
  try {
    // Add config_filter column as JSON with default empty object {}
    await ensureColumn(
      'bots',
      'config_filter',
      "JSON DEFAULT (JSON_OBJECT()) COMMENT 'Bot-specific filter configuration (e.g., EMA timeframe, trend filter settings)'"
    );
    
    // Update existing rows to have empty JSON object if NULL
    const [rows] = await pool.execute(
      "SELECT id FROM bots WHERE config_filter IS NULL OR config_filter = 'null'"
    );
    if (rows.length > 0) {
      await pool.execute(
        "UPDATE bots SET config_filter = JSON_OBJECT() WHERE config_filter IS NULL OR config_filter = 'null'"
      );
      console.log(`✅ Updated ${rows.length} existing bot(s) with empty config_filter`);
    }
    
    console.log('✅ Migration completed successfully');
  } catch (e) {
    console.error('❌ Schema update error:', e?.message || e);
    console.error('Stack:', e?.stack);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
  process.exit(0);
})();

