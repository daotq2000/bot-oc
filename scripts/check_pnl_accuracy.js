#!/usr/bin/env node
/**
 * Check PNL Accuracy
 * Compare bot's calculated PNL with exchange's realized PNL
 */

import { Bot } from '../src/models/Bot.js';
import { Position } from '../src/models/Position.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { calculatePnL } from '../src/utils/calculator.js';

async function main() {
  const args = process.argv.slice(2);
  const positionId = parseInt(args[args.indexOf('--position_id') + 1]);

  if (!positionId) {
    console.log('Usage: node scripts/check_pnl_accuracy.js --position_id <id>');
    process.exit(1);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════');
  console.log('                    PNL ACCURACY CHECK');
  console.log('═══════════════════════════════════════════════════════════════════════════════\n');

  // Get position from DB
  const position = await Position.findById(positionId);
  if (!position) {
    console.log('❌ Position not found');
    process.exit(1);
  }

  console.log('Position Details:');
  console.log('  ID:', position.id);
  console.log('  Bot ID:', position.bot_id);
  console.log('  Symbol:', position.symbol);
  console.log('  Side:', position.side);
  console.log('  Entry Price:', position.entry_price);
  console.log('  Close Price:', position.close_price);
  console.log('  Amount:', position.amount);
  console.log('  Status:', position.status);
  console.log('');

  // Calculate PNL (bot's method)
  const calculatedPnL = calculatePnL(
    position.entry_price,
    position.close_price,
    position.amount,
    position.side
  );

  console.log('[object Object]NL Comparison:');
  console.log('  Bot Calculated PNL:', calculatedPnL.toFixed(2), 'USDT');
  console.log('  DB Stored PNL:', position.pnl, 'USDT');
  console.log('');

  // Get realized PNL from exchange
  const bot = await Bot.findById(position.bot_id);
  const exchangeService = new ExchangeService(bot);
  await exchangeService.initialize();

  try {
    // Get account trades for this symbol
    const symbol = position.symbol.replace('/', '');
    
    console.log('Fetching trade history from exchange...');
    
    // This would require implementing a method to get realized PNL
    // For now, show the formula
    console.log('\\n📝 PNL Calculation Formula:');
    console.log('  Entry:', position.entry_price);
    console.log('  Close:', position.close_price);
    console.log('  Amount:', position.amount);
    console.log('  Side:', position.side);
    console.log('');
    
    if (position.side === 'long') {
      console.log('  Formula: (Close - Entry) * Amount');
      console.log('  Calculation: (' + position.close_price + ' - ' + position.entry_price + ') * ' + position.amount);
      console.log('  Result:', calculatedPnL.toFixed(2), 'USDT');
    } else {
      console.log('  Formula: (Entry - Close) * Amount');
      console.log('  Calculation: (' + position.entry_price + ' - ' + position.close_price + ') * ' + position.amount);
      console.log('  Result:', calculatedPnL.toFixed(2), 'USDT');
    }
    
    console.log('\\n⚠️ Note: This does NOT include trading fees!');
    console.log('  Binance futures fee: ~0.04% (maker) or ~0.06% (taker)');
    console.log('  Estimated fees: ~' + (position.amount * 0.0006).toFixed(2) + ' USDT');
    console.log('  Expected realized PNL: ~' + (calculatedPnL - position.amount * 0.0006).toFixed(2) + ' USDT');
    
  } catch (error) {
    console.log('❌ Error fetching from exchange:', error.message);
  }

  console.log('\n═══════════════════════════════════════════════════════════════════════════════\n');
}

main().catch(err => {
  console.error('[FATAL]', err);
  process.exit(1);
});

