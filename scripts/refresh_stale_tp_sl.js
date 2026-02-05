/**
 * Refresh TP/SL for Stale Positions
 * 
 * This script cancels existing TP/SL orders for positions older than X hours
 * and clears the order IDs in database, allowing PositionMonitor to recreate
 * new TP/SL orders with updated prices based on current market conditions.
 * 
 * Usage:
 *   node scripts/refresh_stale_tp_sl.js [--hours=24] [--dry-run] [--position-id=123]
 * 
 * Options:
 *   --hours=N       Refresh positions older than N hours (default: 24)
 *   --dry-run       Preview changes without executing
 *   --position-id=N Refresh specific position ID only
 */

import dotenv from 'dotenv';
dotenv.config();
import mysql from 'mysql2/promise';
import ccxt from 'ccxt';

// Parse command line arguments
const args = process.argv.slice(2);
const isDryRun = args.includes('--dry-run');
const hoursArg = args.find(a => a.startsWith('--hours='));
const positionIdArg = args.find(a => a.startsWith('--position-id='));

const STALE_HOURS = hoursArg ? parseInt(hoursArg.split('=')[1]) : 24;
const SPECIFIC_POSITION_ID = positionIdArg ? parseInt(positionIdArg.split('=')[1]) : null;

// Database configuration
const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: process.env.DB_PORT || 3306,
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'rootpassword',
  database: process.env.DB_NAME || 'bot_oc_xuoi'
};

// Exchange configurations per bot
const exchangeConfigs = {
  'binance-testnet': {
    exchange: 'binance',
    apiKey: process.env.TESTNET_API_KEY,
    secret: process.env.TESTNET_API_SECRET,
    sandbox: true,
    options: { defaultType: 'future' }
  },
  'binance-mainet': {
    exchange: 'binance',
    apiKey: process.env.MAINNET_API_KEY,
    secret: process.env.MAINNET_API_SECRET,
    sandbox: false,
    options: { defaultType: 'future' }
  }
};

async function createExchange(botName) {
  const config = exchangeConfigs[botName];
  if (!config) {
    console.log(`  ⚠️  No exchange config for bot: ${botName}`);
    return null;
  }

  try {
    const exchange = new ccxt.binance({
      apiKey: config.apiKey,
      secret: config.secret,
      enableRateLimit: true,
      options: config.options
    });
    
    if (config.sandbox) {
      exchange.setSandboxMode(true);
    }
    
    return exchange;
  } catch (e) {
    console.log(`  ⚠️  Failed to create exchange for ${botName}: ${e.message}`);
    return null;
  }
}

async function cancelOrder(exchange, symbol, orderId, orderType) {
  if (!exchange || !orderId) return { success: false, reason: 'no_exchange_or_id' };
  
  try {
    await exchange.cancelOrder(orderId, symbol);
    return { success: true };
  } catch (e) {
    const msg = e.message || '';
    // Order already filled/canceled - consider as success
    if (msg.includes('Unknown order') || msg.includes('order does not exist') || 
        msg.includes('already') || msg.includes('UNKNOWN_ORDER')) {
      return { success: true, reason: 'already_gone' };
    }
    return { success: false, reason: msg };
  }
}

async function main() {
  console.log('='.repeat(80));
  console.log('🔄 REFRESH STALE POSITION TP/SL');
  console.log('='.repeat(80));
  console.log(`📋 Config:`);
  console.log(`   - Stale threshold: ${STALE_HOURS} hours`);
  console.log(`   - Dry run: ${isDryRun ? 'YES (preview only)' : 'NO (will execute)'}`);
  console.log(`   - Specific position: ${SPECIFIC_POSITION_ID || 'ALL stale positions'}`);
  console.log('');

  const pool = await mysql.createPool(dbConfig);

  try {
    // Get stale positions with TP/SL orders
    let query = `
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.take_profit_price,
        p.stop_loss_price,
        p.exit_order_id,
        p.sl_order_id,
        p.pnl,
        p.opened_at,
        TIMESTAMPDIFF(HOUR, p.opened_at, NOW()) as hours_open,
        b.bot_name as bot_name
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      LEFT JOIN bots b ON s.bot_id = b.id
      WHERE p.status = 'open'
    `;
    
    const params = [];
    
    if (SPECIFIC_POSITION_ID) {
      query += ` AND p.id = ?`;
      params.push(SPECIFIC_POSITION_ID);
    } else {
      query += ` AND TIMESTAMPDIFF(HOUR, p.opened_at, NOW()) >= ?`;
      params.push(STALE_HOURS);
    }
    
    query += ` AND (p.exit_order_id IS NOT NULL OR p.sl_order_id IS NOT NULL)
      ORDER BY hours_open DESC`;

    const [positions] = await pool.query(query, params);

    if (positions.length === 0) {
      console.log(`✅ No stale positions found (> ${STALE_HOURS}h with TP/SL orders)`);
      return;
    }

    console.log(`📊 Found ${positions.length} positions to refresh:\n`);
    console.log('ID    | Symbol       | Side  | Hours | PnL       | TP Order      | SL Order');
    console.log('-'.repeat(85));
    
    for (const p of positions) {
      console.log(
        `${String(p.id).padStart(5)} | ` +
        `${p.symbol.padEnd(12)} | ` +
        `${p.side.padEnd(5)} | ` +
        `${String(p.hours_open).padStart(5)} | ` +
        `${(p.pnl >= 0 ? '+' : '') + Number(p.pnl).toFixed(2).padStart(8)} | ` +
        `${(p.exit_order_id || 'NULL').toString().padEnd(13)} | ` +
        `${p.sl_order_id || 'NULL'}`
      );
    }

    if (isDryRun) {
      console.log('\n🔍 DRY RUN MODE - No changes will be made');
      console.log('   Run without --dry-run to execute\n');
      return;
    }

    console.log('\n' + '='.repeat(80));
    console.log('🚀 EXECUTING REFRESH...\n');

    // Group positions by bot for exchange connection
    const exchangeCache = new Map();
    let successCount = 0;
    let failCount = 0;

    for (const p of positions) {
      console.log(`\n📍 Position ${p.id} (${p.symbol} ${p.side}):`);
      
      // Get or create exchange
      let exchange = exchangeCache.get(p.bot_name);
      if (!exchange && p.bot_name) {
        exchange = await createExchange(p.bot_name);
        if (exchange) exchangeCache.set(p.bot_name, exchange);
      }

      let tpCanceled = false;
      let slCanceled = false;

      // Cancel TP order
      if (p.exit_order_id) {
        console.log(`   Canceling TP order ${p.exit_order_id}...`);
        const result = await cancelOrder(exchange, p.symbol, p.exit_order_id, 'TP');
        if (result.success) {
          console.log(`   ✅ TP canceled ${result.reason === 'already_gone' ? '(already filled/canceled)' : ''}`);
          tpCanceled = true;
        } else {
          console.log(`   ❌ TP cancel failed: ${result.reason}`);
        }
      }

      // Cancel SL order
      if (p.sl_order_id) {
        console.log(`   Canceling SL order ${p.sl_order_id}...`);
        const result = await cancelOrder(exchange, p.symbol, p.sl_order_id, 'SL');
        if (result.success) {
          console.log(`   ✅ SL canceled ${result.reason === 'already_gone' ? '(already filled/canceled)' : ''}`);
          slCanceled = true;
        } else {
          console.log(`   ❌ SL cancel failed: ${result.reason}`);
        }
      }

      // Update database to clear order IDs
      const updates = {};
      if (tpCanceled || !p.exit_order_id) {
        updates.exit_order_id = null;
        updates.take_profit_price = null; // Clear so bot recalculates
      }
      if (slCanceled || !p.sl_order_id) {
        updates.sl_order_id = null;
        updates.stop_loss_price = null; // Clear so bot recalculates
      }
      updates.tp_sl_pending = 1; // Force bot to recreate TP/SL

      if (Object.keys(updates).length > 0) {
        const setClauses = Object.entries(updates)
          .map(([k, v]) => `${k} = ${v === null ? 'NULL' : v}`)
          .join(', ');
        
        await pool.query(`UPDATE positions SET ${setClauses} WHERE id = ?`, [p.id]);
        console.log(`   ✅ Database updated: ${setClauses}`);
        successCount++;
      }
    }

    console.log('\n' + '='.repeat(80));
    console.log('📊 SUMMARY');
    console.log('='.repeat(80));
    console.log(`   ✅ Refreshed: ${successCount} positions`);
    console.log(`   ❌ Failed: ${failCount} positions`);
    console.log(`\n💡 Bot will automatically recreate TP/SL orders in the next monitoring cycle.`);
    console.log(`   New TP/SL prices will be calculated based on current ATR settings.`);

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

main().catch(console.error);
