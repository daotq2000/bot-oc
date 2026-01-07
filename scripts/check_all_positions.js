#!/usr/bin/env node
import dotenv from 'dotenv';
import pool from '../src/config/database.js';

dotenv.config();

// Check all positions (including closed)
const [allRows] = await pool.execute(
  'SELECT id, bot_id, symbol, side, status, entry_price, stop_loss_price, take_profit_price, minutes_elapsed, opened_at, closed_at, close_reason FROM positions ORDER BY id DESC LIMIT 10'
);

console.log('\n📊 All Recent Positions (including closed):\n');
if (allRows.length === 0) {
  console.log('  No positions found in database.');
} else {
  allRows.forEach(r => {
    console.log(`  ID: ${r.id}`);
    console.log(`     Bot ID: ${r.bot_id}`);
    console.log(`     Symbol: ${r.symbol}`);
    console.log(`     Side: ${r.side}`);
    console.log(`     Status: ${r.status}`);
    console.log(`     Entry: ${r.entry_price}`);
    console.log(`     SL: ${r.stop_loss_price}`);
    console.log(`     TP: ${r.take_profit_price}`);
    console.log(`     Minutes Elapsed: ${r.minutes_elapsed || 0}`);
    console.log(`     Opened At: ${r.opened_at}`);
    console.log(`     Closed At: ${r.closed_at || 'N/A'}`);
    console.log(`     Close Reason: ${r.close_reason || 'N/A'}`);
    console.log('');
  });
}

// Check open positions specifically
const [openRows] = await pool.execute(
  'SELECT COUNT(*) as count FROM positions WHERE status="open"'
);
console.log(`\n📈 Open Positions Count: ${openRows[0].count}`);

// Check closed positions
const [closedRows] = await pool.execute(
  'SELECT COUNT(*) as count FROM positions WHERE status="closed"'
);
console.log(`📉 Closed Positions Count: ${closedRows[0].count}`);

process.exit(0);

