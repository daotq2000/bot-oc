#!/usr/bin/env node

/**
 * Script to test PositionSync and verify side determination
 * 
 * Usage:
 *   node scripts/test_position_sync.js --bot_id 2
 */

import { PositionSync } from '../src/jobs/PositionSync.js';
import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];

if (!botId) {
  console.error('Usage: node scripts/test_position_sync.js --bot_id <id>');
  process.exit(1);
}

console.log('\n' + '='.repeat(80));
console.log('POSITION SYNC TEST');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log('='.repeat(80) + '\n');

async function testPositionSync() {
  try {
    // Step 1: Load bot
    console.log('📋 STEP 1: Loading bot...');
    const bot = await Bot.findById(Number(botId));
    if (!bot) {
      console.error(`❌ Bot ${botId} not found`);
      process.exit(1);
    }
    console.log(`✅ Bot: ${bot.bot_name} (${bot.exchange})\n`);
    
    // Step 2: Initialize PositionSync
    console.log('📋 STEP 2: Initializing PositionSync...');
    const positionSync = new PositionSync();
    await positionSync.initialize();
    console.log(`✅ PositionSync initialized\n`);
    
    // Step 3: Get positions from exchange before sync
    console.log('📋 STEP 3: Fetching positions from exchange...');
    const exchangeService = positionSync.exchangeServices.get(Number(botId));
    if (!exchangeService) {
      console.error(`❌ ExchangeService not found for bot ${botId}`);
      process.exit(1);
    }
    
    let exchangePositions = [];
    try {
      exchangePositions = await exchangeService.getOpenPositions();
      console.log(`✅ Found ${exchangePositions.length} position(s) on exchange:\n`);
      
      exchangePositions.forEach((exPos, idx) => {
        const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
        const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
        const contracts = Math.abs(rawAmt);
        const symbol = exPos.symbol || exPos.info?.symbol || exPos.market || 'N/A';
        
        console.log(`Position ${idx + 1}:`);
        console.log(`   - Symbol: ${symbol}`);
        console.log(`   - Raw Amount: ${rawAmt}`);
        console.log(`   - Side (calculated): ${side}`);
        console.log(`   - Contracts: ${contracts}`);
        console.log(`   - Entry Price: ${parseFloat(exPos.entryPrice || exPos.info?.entryPrice || 0)}`);
        console.log(`   - Mark Price: ${parseFloat(exPos.markPrice || exPos.info?.markPrice || 0)}`);
        console.log(`   - Unrealized PnL: ${parseFloat(exPos.unrealizedPnl || exPos.info?.unrealizedPnl || 0)}`);
        if (exPos.positionSide) {
          console.log(`   - Position Side (from exchange): ${exPos.positionSide}`);
        }
        console.log('');
      });
    } catch (e) {
      console.error(`❌ Error fetching positions: ${e?.message || e}`);
      process.exit(1);
    }
    
    // Step 4: Get positions from DB before sync
    console.log('📋 STEP 4: Checking positions in database before sync...');
    const dbPositionsBefore = await Position.findAll({
      status: 'open'
    });
    const botDbPositionsBefore = dbPositionsBefore.filter(p => p.bot_id === Number(botId));
    console.log(`✅ Found ${botDbPositionsBefore.length} open position(s) in database:\n`);
    
    botDbPositionsBefore.forEach((pos, idx) => {
      console.log(`Position ${idx + 1}:`);
      console.log(`   - ID: ${pos.id}`);
      console.log(`   - Symbol: ${pos.symbol}`);
      console.log(`   - Side: ${pos.side} (type: ${typeof pos.side})`);
      console.log(`   - Entry Price: ${pos.entry_price || 'N/A'}`);
      console.log(`   - Amount: ${pos.amount || 'N/A'}`);
      console.log('');
    });
    
    // Step 5: Run sync
    console.log('📋 STEP 5: Running position sync...');
    console.log('   This will sync positions from exchange to database...\n');
    
    await positionSync.syncPositions();
    
    console.log(`✅ Position sync completed\n`);
    
    // Step 6: Get positions from DB after sync
    console.log('📋 STEP 6: Checking positions in database after sync...');
    const dbPositionsAfter = await Position.findAll({
      status: 'open'
    });
    const botDbPositionsAfter = dbPositionsAfter.filter(p => p.bot_id === Number(botId));
    console.log(`✅ Found ${botDbPositionsAfter.length} open position(s) in database:\n`);
    
    botDbPositionsAfter.forEach((pos, idx) => {
      console.log(`Position ${idx + 1}:`);
      console.log(`   - ID: ${pos.id}`);
      console.log(`   - Symbol: ${pos.symbol}`);
      console.log(`   - Side: ${pos.side} (type: ${typeof pos.side})`);
      console.log(`   - Entry Price: ${pos.entry_price || 'N/A'}`);
      console.log(`   - Amount: ${pos.amount || 'N/A'}`);
      console.log(`   - Order ID: ${pos.order_id || 'N/A'}`);
      console.log('');
    });
    
    // Step 7: Compare and verify
    console.log('='.repeat(80));
    console.log('COMPARISON & VERIFICATION');
    console.log('='.repeat(80));
    
    const newPositions = botDbPositionsAfter.filter(pAfter => 
      !botDbPositionsBefore.find(pBefore => pBefore.id === pAfter.id)
    );
    
    if (newPositions.length > 0) {
      console.log(`\n✅ ${newPositions.length} new position(s) created during sync:\n`);
      newPositions.forEach(pos => {
        console.log(`   - Position ID: ${pos.id}, Symbol: ${pos.symbol}, Side: ${pos.side}`);
      });
    } else {
      console.log(`\n✅ No new positions created (all positions already exist in DB)`);
    }
    
    // Verify side for each exchange position
    console.log(`\n📋 Verifying side for exchange positions:\n`);
    for (const exPos of exchangePositions) {
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
      const exSide = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      const symbol = exPos.symbol || exPos.info?.symbol || exPos.market || 'N/A';
      
      // Find matching DB position
      const dbPos = botDbPositionsAfter.find(p => {
        const pSymbol = p.symbol?.toUpperCase().replace(/[\/:_]/g, '');
        const eSymbol = symbol.toUpperCase().replace(/[\/:_]/g, '');
        return pSymbol === eSymbol && p.side?.toLowerCase() === exSide;
      });
      
      if (dbPos) {
        const dbSide = String(dbPos.side).toLowerCase();
        if (dbSide === exSide) {
          console.log(`✅ ${symbol} ${exSide}: DB side matches exchange side`);
        } else {
          console.error(`❌ ${symbol}: DB side=${dbSide}, Exchange side=${exSide} - MISMATCH!`);
        }
      } else {
        console.warn(`⚠️  ${symbol} ${exSide}: No matching position found in DB`);
      }
    }
    
    // Check for SHORT positions specifically
    console.log(`\n📋 Checking for SHORT positions:\n`);
    const shortPositions = botDbPositionsAfter.filter(p => p.side?.toLowerCase() === 'short');
    if (shortPositions.length > 0) {
      console.log(`✅ Found ${shortPositions.length} SHORT position(s) in database:\n`);
      shortPositions.forEach(pos => {
        console.log(`   - Position ID: ${pos.id}, Symbol: ${pos.symbol}, Side: ${pos.side}`);
        console.log(`     Entry: ${pos.entry_price}, Amount: ${pos.amount}`);
      });
    } else {
      console.log(`⚠️  No SHORT positions found in database`);
      console.log(`   This could mean:`);
      console.log(`   1. No SHORT positions exist on exchange`);
      console.log(`   2. SHORT positions were not synced (check logs for errors)`);
    }
    
    console.log('\n' + '='.repeat(80));
    console.log('SYNC TEST COMPLETE');
    console.log('='.repeat(80) + '\n');
    
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

testPositionSync().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

