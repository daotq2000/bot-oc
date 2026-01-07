#!/usr/bin/env node
/**
 * Drop Concurrency Reservations Table
 * 
 * This script drops the concurrency_reservations table after code has been updated
 */

import pool from '../src/config/database.js';

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('              DROP CONCURRENCY RESERVATIONS TABLE');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Check table size
  // Get row count
  const [count] = await pool.execute('SELECT COUNT(*) as row_count FROM concurrency_reservations');
  
  // Get table size
  const [size] = await pool.execute(`
    SELECT 
      ROUND(((data_length + index_length) / 1024 / 1024), 2) AS size_mb
    FROM information_schema.TABLES
    WHERE table_schema = 'bot_oc' AND table_name = 'concurrency_reservations'
  `);

  if (count.length > 0 && count[0].row_count > 0) {
    const rowCount = count[0].row_count;
    const sizeMb = size.length > 0 ? size[0].size_mb : 0;
    
    console.log('📊 Table Statistics:');
    console.log('  Rows:', rowCount);
    console.log('  Size:', sizeMb, 'MB');
    console.log('');

    // Backup first
    console.log('📦 Creating backup...');
    await pool.execute(`
      CREATE TABLE IF NOT EXISTS concurrency_reservations_backup_${Date.now()} 
      AS SELECT * FROM concurrency_reservations
    `);
    console.log('✅ Backup created');
    console.log('');

    // Drop table
    console.log('[object Object]Dropping table...');
    await pool.execute('DROP TABLE concurrency_reservations');
    console.log('✅ Table dropped');
    console.log('');

    // Remove configs
    console.log('[object Object]Removing related configs...');
    const [result] = await pool.execute(`
      DELETE FROM app_configs 
      WHERE config_key IN (
        'CONCURRENCY_RESERVATION_TTL_SEC',
        'CONCURRENCY_LOCK_TIMEOUT'
      )
    `);
    console.log('✅ Removed', result.affectedRows, 'config(s)');
    console.log('');

    console.log('═══════════════════════════════════════════════════════════════════════════════');
    console.log('                              SUMMARY');
    console.log('═══════════════════════════════════════════════════════════════════════════════\n');

    console.log('✅ Concurrency Reservations System Removed:');
    console.log('  - Table dropped:', rowCount, 'rows freed');
    console.log('  - Disk space freed:', sizeMb, 'MB');
    console.log('  - Configs removed:', result.affectedRows);
    console.log('  - Backup created: concurrency_reservations_backup_*');
    console.log('');
    console.log('📝 Next Steps:');
    console.log('  1. Monitor bot for any issues');
    console.log('  2. Adjust leverage if needed (default: 5x)');
    console.log('  3. Monitor margin usage');
    console.log('  4. Set balance alerts');
    console.log('');
    console.log('✅ System now uses leverage + margin for risk control');
    console.log('');

  } else {
    console.log('⚠️ Table not found or already empty');
  }

  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  await pool.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

