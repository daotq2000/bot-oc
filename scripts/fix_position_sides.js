#!/usr/bin/env node

/**
 * Script to fix position sides that don't match exchange
 * 
 * Usage:
 *   node scripts/fix_position_sides.js --bot_id 2 [--dry-run]
 */

import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];
const dryRun = args.includes('--dry-run') || args.includes('--dry_run');

if (!botId) {
  console.error('Usage: node scripts/fix_position_sides.js --bot_id <id> [--dry-run]');
  process.exit(1);
}

console.log('\n' + '='.repeat(80));
console.log('FIX POSITION SIDES');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log(`Mode: ${dryRun ? 'DRY RUN (no changes will be made)' : 'LIVE (will update database)'}`);
console.log('='.repeat(80) + '\n');

async function fixSides() {
  try {
    // Load bot
    const bot = await Bot.findById(Number(botId));
    if (!bot) {
      console.error(`❌ Bot ${botId} not found`);
      process.exit(1);
    }
    console.log(`✅ Bot: ${bot.bot_name} (${bot.exchange})\n`);
    
    // Initialize ExchangeService
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    // Get positions from exchange
    console.log('📋 Fetching positions from exchange...');
    const exchangePositions = await exchangeService.getOpenPositions();
    console.log(`✅ Found ${exchangePositions.length} position(s) on exchange\n`);
    
    // Get positions from DB
    console.log('📋 Fetching positions from database...');
    const dbPositions = await Position.findAll({ status: 'open' });
    const botDbPositions = dbPositions.filter(p => p.bot_id === Number(botId));
    console.log(`✅ Found ${botDbPositions.length} position(s) in database\n`);
    
    // Create exchange map
    const exchangeMap = new Map();
    for (const exPos of exchangePositions) {
      const symbol = (exPos.symbol || exPos.info?.symbol || exPos.market || '').toUpperCase().replace(/[\/:_]/g, '');
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
      const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      
      if (symbol && side) {
        const key = symbol;
        if (!exchangeMap.has(key)) {
          exchangeMap.set(key, side);
        }
      }
    }
    
    // Find mismatches
    console.log('📋 Finding side mismatches...\n');
    const fixes = [];
    
    for (const dbPos of botDbPositions) {
      const symbol = (dbPos.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
      const dbSide = String(dbPos.side || '').toLowerCase();
      const exSide = exchangeMap.get(symbol);
      
      if (exSide && exSide !== dbSide) {
        fixes.push({
          id: dbPos.id,
          symbol: dbPos.symbol,
          dbSide,
          exSide,
          entryPrice: dbPos.entry_price,
          amount: dbPos.amount
        });
      }
    }
    
    if (fixes.length === 0) {
      console.log('✅ No side mismatches found!\n');
      return;
    }
    
    console.log(`❌ Found ${fixes.length} position(s) with side mismatch:\n`);
    fixes.forEach((fix, idx) => {
      console.log(`${idx + 1}. Position ID: ${fix.id}`);
      console.log(`   Symbol: ${fix.symbol}`);
      console.log(`   Current (DB): ${fix.dbSide}`);
      console.log(`   Correct (Exchange): ${fix.exSide}`);
      console.log(`   Entry: ${fix.entryPrice}, Amount: ${fix.amount}`);
      console.log('');
    });
    
    if (dryRun) {
      console.log('='.repeat(80));
      console.log('DRY RUN - No changes made');
      console.log('='.repeat(80));
      console.log(`Would fix ${fixes.length} position(s)`);
      console.log('Run without --dry-run to apply fixes\n');
      return;
    }
    
    // Apply fixes
    console.log('='.repeat(80));
    console.log('APPLYING FIXES');
    console.log('='.repeat(80) + '\n');
    
    let successCount = 0;
    let errorCount = 0;
    
    for (const fix of fixes) {
      try {
        await Position.update(fix.id, {
          side: fix.exSide
        });
        console.log(`✅ Fixed Position ${fix.id} (${fix.symbol}): ${fix.dbSide} → ${fix.exSide}`);
        successCount++;
      } catch (error) {
        console.error(`❌ Failed to fix Position ${fix.id} (${fix.symbol}): ${error?.message || error}`);
        errorCount++;
      }
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Total mismatches: ${fixes.length}`);
    console.log(`Fixed: ${successCount}`);
    console.log(`Errors: ${errorCount}`);
    console.log('='.repeat(80) + '\n');
    
    if (successCount > 0) {
      console.log('✅ Position sides have been corrected!');
      console.log('   You may need to recreate TP/SL orders for these positions.\n');
    }
    
  } catch (error) {
    console.error('\n❌ Error:');
    console.error(error);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

fixSides().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

