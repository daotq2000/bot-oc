#!/usr/bin/env node
/**
 * Performance Analysis Script
 * Analyzes database, memory, and system performance
 */

import pool from '../src/config/database.js';

async function main() {
  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                    PERFORMANCE ANALYSIS');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Check database stats
  const [processlist] = await pool.execute('SHOW PROCESSLIST');
  console.log('MySQL Active Connections:', processlist.length);
  console.table(processlist.slice(0, 10).map(p => ({
    Id: p.Id,
    User: p.User,
    Command: p.Command,
    Time: p.Time,
    State: p.State
  })));

  // Check table sizes
  const [tables] = await pool.execute(`
    SELECT 
      table_name,
      ROUND(((data_length + index_length) / 1024 / 1024), 2) AS size_mb,
      table_rows
    FROM information_schema.TABLES
    WHERE table_schema = 'bot_oc'
    ORDER BY (data_length + index_length) DESC
    LIMIT 10
  `);

  console.log('\nTop 10 Largest Tables:');
  console.table(tables);

  // Check strategies count
  const [stratCount] = await pool.execute('SELECT COUNT(*) as total, SUM(is_active) as active FROM strategies');
  console.log('\nStrategies:');
  console.log('  Total:', stratCount[0].total);
  console.log('  Active:', stratCount[0].active);

  // Check positions count
  const [posCount] = await pool.execute('SELECT status, COUNT(*) as count FROM positions GROUP BY status');
  console.log('\nPositions:');
  console.table(posCount);

  // Check indexes
  const [indexes] = await pool.execute(`
    SELECT 
      table_name,
      index_name,
      column_name,
      seq_in_index,
      cardinality
    FROM information_schema.STATISTICS
    WHERE table_schema = 'bot_oc'
      AND table_name IN ('positions', 'strategies', 'symbol_filters')
    ORDER BY table_name, index_name, seq_in_index
  `);

  console.log('\nDatabase Indexes:');
  console.table(indexes);

  await pool.end();
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

