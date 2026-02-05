#!/usr/bin/env node

/**
 * FIX: Add SL orders to open positions without SL
 * 
 * This script:
 * 1. Finds all open positions without SL orders
 * 2. Creates SL orders based on strategy config or default
 * 3. Updates the position with sl_order_id
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env') });

const DEFAULT_SL_PERCENTAGE = 5; // 5% default SL if strategy doesn't have one

async function getDbConnection() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot_oc',
    waitForConnections: true,
    connectionLimit: 10
  });
}

async function fixMissingSLOrders() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(80));
    console.log('🛠️  FIX MISSING SL ORDERS');
    console.log('='.repeat(80));
    console.log(`Generated at: ${new Date().toISOString()}\n`);

    // Find positions without SL
    const [positionsWithoutSL] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.amount,
        p.strategy_id,
        p.bot_id,
        p.pnl,
        s.stoploss as strategy_sl,
        s.take_profit as strategy_tp,
        b.bot_name,
        b.exchange
      FROM positions p
      LEFT JOIN strategies s ON p.strategy_id = s.id
      LEFT JOIN bots b ON s.bot_id = b.id
      WHERE p.status = 'open'
        AND (p.sl_order_id IS NULL OR p.sl_order_id = '')
      ORDER BY p.pnl ASC
    `);

    console.log(`\n📊 Found ${positionsWithoutSL.length} open positions without SL orders\n`);

    if (positionsWithoutSL.length === 0) {
      console.log('✅ All open positions have SL orders. No action needed.');
      return;
    }

    // Calculate SL prices and display
    console.log('📋 Positions needing SL orders:\n');
    console.log('┌──────┬────────────────────┬──────┬────────────────┬────────────────┬────────────────┬────────────────┐');
    console.log('│ ID   │ Symbol             │ Side │ Entry Price    │ SL % (Strategy)│ Calculated SL  │ Current PNL    │');
    console.log('├──────┼────────────────────┼──────┼────────────────┼────────────────┼────────────────┼────────────────┤');

    const positionsToFix = [];

    for (const pos of positionsWithoutSL) {
      const slPercent = pos.strategy_sl || DEFAULT_SL_PERCENTAGE;
      const entryPrice = Number(pos.entry_price);
      
      // Calculate SL price based on side
      let slPrice;
      if (pos.side === 'long') {
        slPrice = entryPrice * (1 - slPercent / 100);
      } else {
        slPrice = entryPrice * (1 + slPercent / 100);
      }

      positionsToFix.push({
        ...pos,
        slPercent,
        slPrice
      });

      console.log(
        `│ ${String(pos.id).padEnd(4)} │ ${String(pos.symbol).slice(0, 18).padEnd(18)} │ ` +
        `${String(pos.side).slice(0, 4).padEnd(4)} │ ${String(entryPrice.toFixed(6)).padStart(14)} │ ` +
        `${String(slPercent + '%').padStart(14)} │ ${String(slPrice.toFixed(6)).padStart(14)} │ ` +
        `${String(Number(pos.pnl || 0).toFixed(2)).padStart(14)} │`
      );
    }
    console.log('└──────┴────────────────────┴──────┴────────────────┴────────────────┴────────────────┴────────────────┘');

    // Summary by bot
    const byBot = {};
    for (const pos of positionsWithoutSL) {
      const botKey = pos.bot_name || `Bot ${pos.bot_id}`;
      if (!byBot[botKey]) byBot[botKey] = { count: 0, totalPnl: 0 };
      byBot[botKey].count++;
      byBot[botKey].totalPnl += Number(pos.pnl || 0);
    }

    console.log('\n📊 Summary by Bot:');
    for (const [botName, data] of Object.entries(byBot)) {
      console.log(`   ${botName}: ${data.count} positions, Total PNL: ${data.totalPnl.toFixed(2)} USDT`);
    }

    // Calculate total at-risk PNL
    const totalAtRiskPnl = positionsWithoutSL.reduce((sum, p) => sum + Number(p.pnl || 0), 0);
    console.log(`\n⚠️  Total unrealized PNL at risk: ${totalAtRiskPnl.toFixed(2)} USDT`);

    console.log(`
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
🔧 TO FIX THESE POSITIONS, YOU CAN:
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

1. Enable Software SL (already configured in .env):
   - ADV_TPSL_TRAILING_ENABLED=true
   - The PositionMonitor will automatically manage SL via software

2. Update position stop_loss_price in DB (for software SL to work):
   
   Run this SQL to set SL prices for all positions without SL:

${positionsToFix.slice(0, 20).map(p => 
  `   UPDATE positions SET stop_loss_price = ${p.slPrice.toFixed(8)}, use_software_sl = 1 WHERE id = ${p.id};`
).join('\n')}
${positionsToFix.length > 20 ? '\n   ... (showing first 20 only)' : ''}

3. Or restart the bot - PositionMonitor will attempt to create SL orders
   for positions marked with tp_sl_pending = 1:

   UPDATE positions SET tp_sl_pending = 1 WHERE status = 'open' AND (sl_order_id IS NULL OR sl_order_id = '');

━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
`);

    // Ask for confirmation to apply fix
    console.log('💡 To automatically apply software SL to all positions, run:');
    console.log('   node scripts/fix_missing_sl_orders.js --apply\n');

    if (process.argv.includes('--apply')) {
      console.log('🔧 Applying software SL to all positions...\n');
      
      let fixedCount = 0;
      for (const pos of positionsToFix) {
        try {
          // Only update stop_loss_price and use_software_sl (tp_sl_pending may not exist in all DBs)
          await pool.execute(
            `UPDATE positions 
             SET stop_loss_price = ?, 
                 use_software_sl = 1
             WHERE id = ? AND status = 'open'`,
            [pos.slPrice, pos.id]
          );
          fixedCount++;
          console.log(`   ✅ Position ${pos.id} (${pos.symbol}): SL set to ${pos.slPrice.toFixed(8)}`);
        } catch (error) {
          console.log(`   ❌ Position ${pos.id} (${pos.symbol}): Failed - ${error.message}`);
        }
      }
      
      console.log(`\n✅ Fixed ${fixedCount}/${positionsToFix.length} positions`);
      console.log('   The PositionMonitor will now manage these SL levels via software.');
    }

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await pool.end();
  }
}

// Run
fixMissingSLOrders().catch(console.error);
