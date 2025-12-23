#!/usr/bin/env node
/**
 * Verify Positions on Exchange
 * 
 * This script checks if positions in database actually exist on the exchange
 * 
 * Usage:
 *   node scripts/verify_positions_on_exchange.js --bot_id 3
 */

import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';

async function main() {
  const args = process.argv.slice(2);
  const botId = parseInt(args[args.indexOf('--bot_id') + 1] || '3');

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('              DATABASE vs EXCHANGE POSITION VERIFICATION');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Load bot
  const bot = await Bot.findById(botId);
  if (!bot) {
    throw new Error(`Bot ${botId} not found`);
  }

  console.log(`Bot: ${bot.bot_name} (ID: ${bot.id})`);
  console.log(`Exchange: ${bot.exchange}`);
  console.log(`Testnet: ${bot.binance_testnet ? 'YES' : 'NO'}`);
  console.log('');

  // Initialize exchange service
  const exchangeService = new ExchangeService(bot);
  await exchangeService.initialize();

  // Get positions from database
  const dbPositions = await Position.findAll({ status: 'open' });
  const botPositions = dbPositions.filter(p => p.bot_id === botId);

  console.log(`📊 Positions in Database: ${botPositions.length}\n`);

  if (botPositions.length === 0) {
    console.log('⚠️ No open positions found in database for this bot');
    return;
  }

  // Get positions from exchange
  console.log('🔍 Checking positions on exchange...\n');

  const results = [];

  for (const dbPos of botPositions) {
    try {
      // Get position from exchange
      const symbol = dbPos.symbol.replace('/', '');
      const exchangeQty = await exchangeService.getClosableQuantity(symbol, dbPos.side);
      
      // Check order status
      let orderStatus = 'UNKNOWN';
      if (dbPos.order_id) {
        try {
          const order = await exchangeService.getOrderStatus(symbol, dbPos.order_id);
          orderStatus = order?.status || 'NOT_FOUND';
        } catch (e) {
          orderStatus = 'ERROR: ' + (e.message || 'Unknown');
        }
      }

      const exists = exchangeQty && exchangeQty > 0;

      results.push({
        ID: dbPos.id,
        Symbol: dbPos.symbol,
        Side: dbPos.side,
        'DB Entry': dbPos.entry_price,
        'Exchange Qty': exchangeQty || 0,
        'Order Status': orderStatus,
        'Exists': exists ? '✅ YES' : '❌ NO',
        'Opened': new Date(dbPos.opened_at).toLocaleString()
      });

      // Small delay to avoid rate limits
      await new Promise(resolve => setTimeout(resolve, 200));

    } catch (error) {
      results.push({
        ID: dbPos.id,
        Symbol: dbPos.symbol,
        Side: dbPos.side,
        'DB Entry': dbPos.entry_price,
        'Exchange Qty': 'ERROR',
        'Order Status': 'ERROR',
        'Exists': '❌ ERROR',
        'Opened': new Date(dbPos.opened_at).toLocaleString()
      });
    }
  }

  console.table(results);

  // Summary
  const existsCount = results.filter(r => r.Exists === '✅ YES').length;
  const notExistsCount = results.filter(r => r.Exists === '❌ NO').length;
  const errorCount = results.filter(r => r.Exists === '❌ ERROR').length;

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                              SUMMARY');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  console.log(`Total Positions in DB: ${botPositions.length}`);
  console.log(`  ✅ Exists on Exchange: ${existsCount}`);
  console.log(`  ❌ Not on Exchange: ${notExistsCount}`);
  console.log(`  ❌ Errors: ${errorCount}`);
  console.log('');

  if (notExistsCount > 0) {
    console.log('⚠️ WARNING: Some positions in DB do not exist on exchange!');
    console.log('These positions should be closed in DB to avoid inconsistency.');
    console.log('');
    const idsToClose = results.filter(r => r.Exists === '❌ NO').map(r => r.ID);
    if (idsToClose.length > 0) {
      console.log('To clean up:');
      console.log(`  UPDATE positions SET status = 'closed', close_reason = 'not_on_exchange'`);
      console.log(`  WHERE id IN (${idsToClose.join(', ')});`);
    }
  } else if (existsCount === botPositions.length) {
    console.log('✅ All positions in DB exist on exchange - System is consistent!');
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});
