import pool from '../src/config/database.js';

async function columnExists(table, column) {
  const [rows] = await pool.execute(
    "SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = database() AND TABLE_NAME = ? AND COLUMN_NAME = ?",
    [table, column]
  );
  return rows.length > 0;
}

async function indexExists(table, indexName) {
  const [rows] = await pool.execute(
    'SHOW INDEX FROM `' + table + '` WHERE Key_name = ?',
    [indexName]
  );
  return rows.length > 0;
}

async function ensureBotIdColumn() {
  const hasCol = await columnExists('positions', 'bot_id');
  if (!hasCol) {
    await pool.execute('ALTER TABLE positions ADD COLUMN bot_id INT NULL AFTER strategy_id');
    console.log('Added positions.bot_id');
  } else {
    console.log('Column exists positions.bot_id');
  }
}

async function backfillBotId() {
  // Set positions.bot_id from strategies.bot_id where null
  await pool.execute(`
    UPDATE positions p
    JOIN strategies s ON p.strategy_id = s.id
    SET p.bot_id = s.bot_id
    WHERE p.bot_id IS NULL
  `);
  console.log('Backfilled positions.bot_id from strategies.bot_id');
}

async function addForeignKeyAndIndex() {
  const hasIdx = await indexExists('positions', 'idx_positions_bot_id');
  if (!hasIdx) {
    await pool.execute('CREATE INDEX idx_positions_bot_id ON positions(bot_id)');
    console.log('Created index idx_positions_bot_id');
  } else {
    console.log('Index exists idx_positions_bot_id');
  }

  // Add FK if not exists (MySQL no easy way to check; try-catch)
  // CRITICAL FIX: Use RESTRICT instead of CASCADE to prevent automatic deletion of positions
  // RESTRICT prevents deletion of bot if there are positions referencing it
  try {
    await pool.execute('ALTER TABLE positions ADD CONSTRAINT fk_positions_bot_id FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE RESTRICT');
    console.log('Added FK fk_positions_bot_id with ON DELETE RESTRICT (prevents CASCADE DELETE)');
  } catch (e) {
    if (!String(e?.message || '').toLowerCase().includes('duplicate')) {
      console.log('FK add warning:', e.message || e);
    } else {
      console.log('FK fk_positions_bot_id already exists');
      // Check if existing FK uses CASCADE and warn
      try {
        const [fkInfo] = await pool.execute(`
          SELECT CONSTRAINT_NAME, DELETE_RULE
          FROM information_schema.KEY_COLUMN_USAGE k
          JOIN information_schema.REFERENTIAL_CONSTRAINTS r
            ON k.CONSTRAINT_NAME = r.CONSTRAINT_NAME
          WHERE k.TABLE_NAME = 'positions'
            AND k.CONSTRAINT_NAME = 'fk_positions_bot_id'
        `);
        if (fkInfo.length > 0 && fkInfo[0].DELETE_RULE === 'CASCADE') {
          console.warn('⚠️  WARNING: Existing FK uses CASCADE DELETE. Run migration to change to RESTRICT.');
        }
      } catch (checkError) {
        // Ignore check errors
      }
    }
  }
}

async function setNotNull() {
  // Ensure all rows have bot_id filled
  await backfillBotId();
  await pool.execute('ALTER TABLE positions MODIFY COLUMN bot_id INT NOT NULL');
  console.log('Set positions.bot_id NOT NULL');
}

(async () => {
  try {
    await ensureBotIdColumn();
    await backfillBotId();
    await addForeignKeyAndIndex();
    await setNotNull();
    console.log('✅ positions.bot_id ensured and backfilled');
  } catch (e) {
    console.error('❌ ensure_positions_bot_id error:', e?.message || e);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
  process.exit(0);
})();

