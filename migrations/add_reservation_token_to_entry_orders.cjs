import pool from '../src/config/database.js';

/**
 * Migration: Add reservation_token column to entry_orders table
 * This allows EntryOrderMonitor to finalize the correct reservation when creating Position
 */
async function up() {
  try {
    // Check if column already exists
    const [columns] = await pool.execute(`
      SELECT COLUMN_NAME 
      FROM INFORMATION_SCHEMA.COLUMNS 
      WHERE TABLE_SCHEMA = DATABASE() 
      AND TABLE_NAME = 'entry_orders' 
      AND COLUMN_NAME = 'reservation_token'
    `);
    
    if (columns.length === 0) {
      // Add column
      await pool.execute(`
        ALTER TABLE entry_orders 
        ADD COLUMN reservation_token VARCHAR(255) NULL 
        AFTER status
      `);
      console.log('✅ Added reservation_token column to entry_orders table');
    } else {
      console.log('ℹ️  reservation_token column already exists in entry_orders table');
    }
  } catch (error) {
    console.error('❌ Failed to add reservation_token column:', error?.message || error);
    throw error;
  }
}

async function down() {
  try {
    await pool.execute(`
      ALTER TABLE entry_orders 
      DROP COLUMN IF EXISTS reservation_token
    `);
    console.log('✅ Removed reservation_token column from entry_orders table');
  } catch (error) {
    console.error('❌ Failed to remove reservation_token column:', error?.message || error);
    throw error;
  }
}

// Run migration
(async () => {
  try {
    await up();
  } catch (error) {
    console.error('Migration failed:', error);
    process.exit(1);
  } finally {
    try { await pool.end(); } catch (_) {}
  }
  process.exit(0);
})();

