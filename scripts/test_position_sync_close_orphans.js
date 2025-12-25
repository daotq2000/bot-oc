#!/usr/bin/env node

/**
 * Script to test PositionSync closing orphan positions
 * 
 * Usage:
 *   node scripts/test_position_sync_close_orphans.js --bot_id 3
 */

import { PositionSync } from '../src/jobs/PositionSync.js';
import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];

if (!botId) {
  console.error('Usage: node scripts/test_position_sync_close_orphans.js --bot_id <id>');
  process.exit(1);
}

console.log('\n' + '='.repeat(80));
console.log('TEST POSITION SYNC - CLOSE ORPHAN POSITIONS');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log('='.repeat(80) + '\n');

async function testSync() {
  try {
    // Load bot
    const bot = await Bot.findById(Number(botId));
    if (!bot) {
      console.error(`❌ Bot ${botId} not found`);
      process.exit(1);
    }
    console.log(`✅ Bot: ${bot.bot_name} (${bot.exchange})\n`);
    
    // Get positions before sync
    console.log('📋 Positions in DB before sync:');
    const positionsBefore = await Position.findAll({ status: 'open' });
    const botPositionsBefore = positionsBefore.filter(p => p.bot_id === Number(botId));
    console.log(`   Total open positions: ${botPositionsBefore.length}\n`);
    
    // Initialize and run sync
    console.log('📋 Running PositionSync...\n');
    const positionSync = new PositionSync();
    await positionSync.initialize();
    await positionSync.syncPositions();
    
    // Get positions after sync
    console.log('\n📋 Positions in DB after sync:');
    const positionsAfter = await Position.findAll({ status: 'open' });
    const botPositionsAfter = positionsAfter.filter(p => p.bot_id === Number(botId));
    console.log(`   Total open positions: ${botPositionsAfter.length}\n`);
    
    // Get closed positions
    const closedPositions = await Position.findAll({ 
      status: 'closed',
      close_reason: ['sync_not_on_exchange', 'sync_exchange_empty', 'sync_exchange_closed']
    });
    const botClosedPositions = closedPositions.filter(p => p.bot_id === Number(botId));
    
    console.log('='.repeat(80));
    console.log('RESULTS');
    console.log('='.repeat(80));
    console.log(`Open positions before: ${botPositionsBefore.length}`);
    console.log(`Open positions after: ${botPositionsAfter.length}`);
    console.log(`Closed by sync: ${botClosedPositions.length}`);
    
    if (botClosedPositions.length > 0) {
      console.log(`\n📋 Recently closed positions:\n`);
      botClosedPositions.slice(0, 10).forEach(pos => {
        console.log(`   - ID: ${pos.id}, Symbol: ${pos.symbol}, Side: ${pos.side}, Reason: ${pos.close_reason}`);
      });
      if (botClosedPositions.length > 10) {
        console.log(`   ... and ${botClosedPositions.length - 10} more`);
      }
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

testSync().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

