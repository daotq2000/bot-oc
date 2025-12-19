#!/usr/bin/env node
/**
 * Script: clear_data_test.js
 * 
 * Mục đích: Clear data test để đảm bảo test chạy đúng
 * 
 * Các bảng sẽ được clear:
 * 1. positions - positions test (filter theo bot_id hoặc symbol)
 * 2. entry_orders - entry orders pending (filter theo bot_id hoặc symbol)
 * 3. concurrency_reservations - reservations (filter theo bot_id)
 * 4. strategies - strategies test (filter theo bot_id hoặc symbol, chỉ clear inactive)
 * 
 * Usage:
 *   node scripts/clear_data_test.js --bot_id 3
 *   node scripts/clear_data_test.js --bot_id 3 --symbol BTCUSDT
 *   node scripts/clear_data_test.js --bot_id 3 --symbol BTCUSDT --confirm
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import logger from '../src/utils/logger.js';

dotenv.config();

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.replace(/^--/, '');
      const next = argv[i + 1];
      if (!next || next.startsWith('--')) {
        out[key] = true;
      } else {
        out[key] = next;
        i++;
      }
    }
  }
  return out;
}

const args = parseArgs(process.argv.slice(2));

async function clearTestData() {
  const botId = args.bot_id ? Number(args.bot_id) : null;
  const symbol = args.symbol || null;
  const confirm = args.confirm === true || args.confirm === 'true';

  if (!botId) {
    console.error('❌ Error: --bot_id is required');
    console.log('\nUsage:');
    console.log('  node scripts/clear_data_test.js --bot_id 3');
    console.log('  node scripts/clear_data_test.js --bot_id 3 --symbol BTCUSDT');
    console.log('  node scripts/clear_data_test.js --bot_id 3 --symbol BTCUSDT --confirm');
    process.exit(1);
  }

  console.log('\n🔍 Analyzing data to be cleared...');
  console.log(`   Bot ID: ${botId}`);
  console.log(`   Symbol: ${symbol || 'ALL'}`);
  console.log(`   Confirm: ${confirm ? 'YES (will delete)' : 'NO (dry-run)'}`);

  try {
    // 1. Check positions
    let positionsQuery = 'SELECT COUNT(*) as count FROM positions WHERE bot_id = ?';
    let positionsParams = [botId];
    if (symbol) {
      positionsQuery += ' AND symbol = ?';
      positionsParams.push(symbol);
    }
    const [positionsCount] = await pool.execute(positionsQuery, positionsParams);
    console.log(`\n📊 Positions: ${positionsCount[0].count} found`);

    // 2. Check entry_orders
    let entryOrdersQuery = 'SELECT COUNT(*) as count FROM entry_orders WHERE bot_id = ?';
    let entryOrdersParams = [botId];
    if (symbol) {
      entryOrdersQuery += ' AND symbol = ?';
      entryOrdersParams.push(symbol);
    }
    const [entryOrdersCount] = await pool.execute(entryOrdersQuery, entryOrdersParams);
    console.log(`📊 Entry Orders: ${entryOrdersCount[0].count} found`);

    // 3. Check concurrency_reservations
    const [reservationsCount] = await pool.execute(
      'SELECT COUNT(*) as count FROM concurrency_reservations WHERE bot_id = ?',
      [botId]
    );
    console.log(`📊 Concurrency Reservations: ${reservationsCount[0].count} found`);

    // 4. Check strategies (only inactive test strategies)
    let strategiesQuery = `SELECT COUNT(*) as count FROM strategies 
                           WHERE bot_id = ? AND is_active = 0`;
    let strategiesParams = [botId];
    if (symbol) {
      strategiesQuery += ' AND symbol = ?';
      strategiesParams.push(symbol);
    }
    const [strategiesCount] = await pool.execute(strategiesQuery, strategiesParams);
    console.log(`📊 Inactive Strategies: ${strategiesCount[0].count} found`);

    const totalCount = positionsCount[0].count + entryOrdersCount[0].count + 
                       reservationsCount[0].count + strategiesCount[0].count;

    if (totalCount === 0) {
      console.log('\n✅ No data to clear. Database is already clean.');
      return;
    }

    if (!confirm) {
      console.log('\n⚠️  DRY-RUN MODE: No data will be deleted.');
      console.log('   Add --confirm flag to actually delete the data.');
      console.log(`\n   Would delete:`);
      console.log(`   - ${positionsCount[0].count} positions`);
      console.log(`   - ${entryOrdersCount[0].count} entry orders`);
      console.log(`   - ${reservationsCount[0].count} concurrency reservations`);
      console.log(`   - ${strategiesCount[0].count} inactive strategies`);
      return;
    }

    console.log('\n🗑️  Starting cleanup...');

    // Start transaction
    const connection = await pool.getConnection();
    await connection.beginTransaction();

    try {
      // 1. Delete positions
      if (positionsCount[0].count > 0) {
        let deletePositionsQuery = 'DELETE FROM positions WHERE bot_id = ?';
        let deletePositionsParams = [botId];
        if (symbol) {
          deletePositionsQuery += ' AND symbol = ?';
          deletePositionsParams.push(symbol);
        }
        const [posResult] = await connection.execute(deletePositionsQuery, deletePositionsParams);
        console.log(`✅ Deleted ${posResult.affectedRows} positions`);
      }

      // 2. Delete entry_orders
      if (entryOrdersCount[0].count > 0) {
        let deleteEntryOrdersQuery = 'DELETE FROM entry_orders WHERE bot_id = ?';
        let deleteEntryOrdersParams = [botId];
        if (symbol) {
          deleteEntryOrdersQuery += ' AND symbol = ?';
          deleteEntryOrdersParams.push(symbol);
        }
        const [eoResult] = await connection.execute(deleteEntryOrdersQuery, deleteEntryOrdersParams);
        console.log(`✅ Deleted ${eoResult.affectedRows} entry orders`);
      }

      // 3. Delete concurrency_reservations
      if (reservationsCount[0].count > 0) {
        const [resResult] = await connection.execute(
          'DELETE FROM concurrency_reservations WHERE bot_id = ?',
          [botId]
        );
        console.log(`✅ Deleted ${resResult.affectedRows} concurrency reservations`);
      }

      // 4. Delete inactive strategies (test strategies)
      if (strategiesCount[0].count > 0) {
        let deleteStrategiesQuery = `DELETE FROM strategies 
                                     WHERE bot_id = ? AND is_active = 0`;
        let deleteStrategiesParams = [botId];
        if (symbol) {
          deleteStrategiesQuery += ' AND symbol = ?';
          deleteStrategiesParams.push(symbol);
        }
        const [stratResult] = await connection.execute(deleteStrategiesQuery, deleteStrategiesParams);
        console.log(`✅ Deleted ${stratResult.affectedRows} inactive strategies`);
      }

      await connection.commit();
      console.log('\n✅ Cleanup completed successfully!');

    } catch (error) {
      await connection.rollback();
      throw error;
    } finally {
      connection.release();
    }

  } catch (error) {
    logger.error('Failed to clear test data:', error);
    console.error('\n❌ Error:', error.message);
    process.exit(1);
  }
}

clearTestData()
  .then(() => {
    console.log('\n✨ Done.');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Fatal error:', error);
    process.exit(1);
  });

