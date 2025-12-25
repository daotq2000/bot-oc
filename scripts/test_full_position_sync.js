#!/usr/bin/env node

/**
 * Full test script for PositionSync - compares DB and exchange, runs sync, and verifies results
 * 
 * Usage:
 *   node scripts/test_full_position_sync.js --bot_id 3
 */

import { PositionSync } from '../src/jobs/PositionSync.js';
import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];

if (!botId) {
  console.error('Usage: node scripts/test_full_position_sync.js --bot_id <id>');
  process.exit(1);
}

console.log('\n' + '='.repeat(80));
console.log('FULL POSITION SYNC TEST');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log('='.repeat(80) + '\n');

async function testFullSync() {
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
    
    // Step 1: Get positions from exchange
    console.log('📋 STEP 1: Fetching positions from exchange...');
    const exchangePositions = await exchangeService.getOpenPositions();
    console.log(`✅ Found ${exchangePositions.length} position(s) on exchange\n`);
    
    // Step 2: Get positions from DB before sync
    console.log('📋 STEP 2: Fetching positions from database (before sync)...');
    const dbPositionsBefore = await Position.findAll({ status: 'open' });
    const botDbPositionsBefore = dbPositionsBefore.filter(p => p.bot_id === Number(botId));
    console.log(`✅ Found ${botDbPositionsBefore.length} open position(s) in database\n`);
    
    // Step 3: Analyze before sync
    console.log('📋 STEP 3: Analyzing positions (before sync)...\n');
    
    const exchangeMap = new Map();
    for (const exPos of exchangePositions) {
      const symbol = (exPos.symbol || exPos.info?.symbol || exPos.market || '').toUpperCase().replace(/[\/:_]/g, '');
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
      const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      if (symbol && side) {
        const key = `${symbol}_${side}`;
        exchangeMap.set(key, (exchangeMap.get(key) || 0) + 1);
      }
    }
    
    const dbMap = new Map();
    for (const dbPos of botDbPositionsBefore) {
      const symbol = (dbPos.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
      const side = String(dbPos.side || '').toLowerCase();
      if (symbol && side) {
        const key = `${symbol}_${side}`;
        dbMap.set(key, (dbMap.get(key) || 0) + 1);
      }
    }
    
    console.log('Exchange positions by symbol+side:');
    for (const [key, count] of exchangeMap.entries()) {
      console.log(`   ${key}: ${count}`);
    }
    console.log('');
    
    console.log('Database positions by symbol+side:');
    for (const [key, count] of dbMap.entries()) {
      console.log(`   ${key}: ${count}`);
    }
    console.log('');
    
    // Find mismatches
    const missingOnExchange = [];
    const missingInDb = [];
    
    for (const [key, dbCount] of dbMap.entries()) {
      const exCount = exchangeMap.get(key) || 0;
      if (exCount === 0) {
        missingOnExchange.push({ key, count: dbCount });
      }
    }
    
    for (const [key, exCount] of exchangeMap.entries()) {
      const dbCount = dbMap.get(key) || 0;
      if (dbCount === 0) {
        missingInDb.push({ key, count: exCount });
      }
    }
    
    if (missingOnExchange.length > 0) {
      console.log(`⚠️  Positions in DB but not on exchange (${missingOnExchange.length}):`);
      missingOnExchange.forEach(({ key, count }) => {
        console.log(`   ${key}: ${count} position(s) - will be closed by sync`);
      });
      console.log('');
    }
    
    if (missingInDb.length > 0) {
      console.log(`⚠️  Positions on exchange but not in DB (${missingInDb.length}):`);
      missingInDb.forEach(({ key, count }) => {
        console.log(`   ${key}: ${count} position(s) - will be created by sync`);
      });
      console.log('');
    }
    
    // Step 4: Run sync
    console.log('📋 STEP 4: Running PositionSync...\n');
    const positionSync = new PositionSync();
    await positionSync.initialize();
    await positionSync.syncPositions();
    console.log('✅ PositionSync completed\n');
    
    // Step 5: Get positions from DB after sync
    console.log('📋 STEP 5: Fetching positions from database (after sync)...');
    const dbPositionsAfter = await Position.findAll({ status: 'open' });
    const botDbPositionsAfter = dbPositionsAfter.filter(p => p.bot_id === Number(botId));
    console.log(`✅ Found ${botDbPositionsAfter.length} open position(s) in database\n`);
    
    // Step 6: Get closed positions
    const closedPositions = await Position.findAll({ 
      status: 'closed'
    });
    const botClosedPositions = closedPositions.filter(p => 
      p.bot_id === Number(botId) && 
      ['sync_not_on_exchange', 'sync_exchange_empty', 'sync_exchange_closed'].includes(p.close_reason)
    );
    
    // Step 7: Final comparison
    console.log('='.repeat(80));
    console.log('FINAL RESULTS');
    console.log('='.repeat(80));
    console.log(`Exchange positions: ${exchangePositions.length}`);
    console.log(`DB positions before: ${botDbPositionsBefore.length}`);
    console.log(`DB positions after: ${botDbPositionsAfter.length}`);
    console.log(`Closed by sync: ${botClosedPositions.length}`);
    console.log(`Created by sync: ${botDbPositionsAfter.length - botDbPositionsBefore.length + botClosedPositions.length}`);
    
    // Verify matching
    const dbMapAfter = new Map();
    for (const dbPos of botDbPositionsAfter) {
      const symbol = (dbPos.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
      const side = String(dbPos.side || '').toLowerCase();
      if (symbol && side) {
        const key = `${symbol}_${side}`;
        dbMapAfter.set(key, (dbMapAfter.get(key) || 0) + 1);
      }
    }
    
    let matchCount = 0;
    let mismatchCount = 0;
    
    for (const [key, exCount] of exchangeMap.entries()) {
      const dbCount = dbMapAfter.get(key) || 0;
      if (dbCount > 0) {
        matchCount++;
        if (dbCount !== exCount) {
          console.log(`⚠️  ${key}: Exchange=${exCount}, DB=${dbCount} (count mismatch but exists)`);
        }
      } else {
        mismatchCount++;
        console.error(`❌ ${key}: Exchange=${exCount}, DB=0 (missing in DB)`);
      }
    }
    
    console.log(`\nMatch summary: ${matchCount} matched, ${mismatchCount} missing`);
    
    if (mismatchCount === 0 && missingOnExchange.length === 0) {
      console.log('\n✅ All positions are synchronized!');
    } else {
      console.log('\n⚠️  Some positions need attention');
    }
    
    if (botClosedPositions.length > 0) {
      console.log(`\n📋 Recently closed positions (last 10):\n`);
      botClosedPositions.slice(-10).forEach(pos => {
        console.log(`   - ID: ${pos.id}, Symbol: ${pos.symbol}, Side: ${pos.side}, Reason: ${pos.close_reason}`);
      });
    }
    
    console.log('\n' + '='.repeat(80) + '\n');
    
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

testFullSync().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

