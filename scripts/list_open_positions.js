#!/usr/bin/env node
import dotenv from 'dotenv';
import pool from '../src/config/database.js';

dotenv.config();

const [rows] = await pool.execute(
  'SELECT id, symbol, side, entry_price, stop_loss_price, minutes_elapsed, opened_at FROM positions WHERE status="open" ORDER BY id DESC LIMIT 5'
);

console.log('\n📊 Recent Open Positions:\n');
if (rows.length === 0) {
  console.log('  No open positions found.');
} else {
  rows.forEach(r => {
    console.log(`  ID: ${r.id}`);
    console.log(`     Symbol: ${r.symbol}`);
    console.log(`     Side: ${r.side}`);
    console.log(`     Entry: ${r.entry_price}`);
    console.log(`     SL: ${r.stop_loss_price}`);
    console.log(`     Minutes Elapsed: ${r.minutes_elapsed || 0}`);
    console.log(`     Opened At: ${r.opened_at}`);
    console.log('');
  });
}

process.exit(0);

