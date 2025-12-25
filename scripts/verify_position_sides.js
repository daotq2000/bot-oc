#!/usr/bin/env node

/**
 * Script to verify position sides match between exchange and database
 * 
 * Usage:
 *   node scripts/verify_position_sides.js --bot_id 2
 */

import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];

if (!botId) {
  console.error('Usage: node scripts/verify_position_sides.js --bot_id <id>');
  process.exit(1);
}

console.log('\n' + '='.repeat(80));
console.log('POSITION SIDE VERIFICATION');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log('='.repeat(80) + '\n');

async function verifySides() {
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
    
    // Create maps for comparison
    const exchangeMap = new Map();
    for (const exPos of exchangePositions) {
      const symbol = (exPos.symbol || exPos.info?.symbol || exPos.market || '').toUpperCase().replace(/[\/:_]/g, '');
      const rawAmt = parseFloat(exPos.positionAmt ?? exPos.contracts ?? exPos.size ?? 0);
      const side = rawAmt > 0 ? 'long' : rawAmt < 0 ? 'short' : null;
      
      if (symbol && side) {
        const key = `${symbol}_${side}`;
        if (!exchangeMap.has(key)) {
          exchangeMap.set(key, []);
        }
        exchangeMap.get(key).push({ symbol, side, rawAmt, positionSide: exPos.positionSide });
      }
    }
    
    const dbMap = new Map();
    for (const dbPos of botDbPositions) {
      const symbol = (dbPos.symbol || '').toUpperCase().replace(/[\/:_]/g, '');
      const side = String(dbPos.side || '').toLowerCase();
      
      if (symbol && side) {
        const key = `${symbol}_${side}`;
        if (!dbMap.has(key)) {
          dbMap.set(key, []);
        }
        dbMap.get(key).push({ id: dbPos.id, symbol, side });
      }
    }
    
    // Compare
    console.log('='.repeat(80));
    console.log('SIDE VERIFICATION RESULTS');
    console.log('='.repeat(80) + '\n');
    
    let matchCount = 0;
    let mismatchCount = 0;
    const mismatches = [];
    
    // Check each exchange position
    for (const [key, exPositions] of exchangeMap.entries()) {
      const [symbol, exSide] = key.split('_');
      const dbPositions = dbMap.get(key) || [];
      
      if (dbPositions.length > 0) {
        matchCount++;
        console.log(`✅ ${symbol} ${exSide}: Found in DB (${dbPositions.length} position(s))`);
      } else {
        // Check if exists with wrong side
        const wrongSideKey = `${symbol}_${exSide === 'long' ? 'short' : 'long'}`;
        const wrongSidePositions = dbMap.get(wrongSideKey) || [];
        
        if (wrongSidePositions.length > 0) {
          mismatchCount++;
          mismatches.push({ symbol, exSide, dbSide: exSide === 'long' ? 'short' : 'long', positions: wrongSidePositions });
          console.error(`❌ ${symbol}: Exchange=${exSide}, DB=${exSide === 'long' ? 'short' : 'long'} - MISMATCH!`);
          wrongSidePositions.forEach(p => {
            console.error(`   - Position ID: ${p.id}, DB side: ${p.side}`);
          });
        } else {
          console.warn(`⚠️  ${symbol} ${exSide}: Not found in DB (may need sync)`);
        }
      }
    }
    
    // Check for positions in DB but not on exchange
    console.log(`\n📋 Checking for positions in DB but not on exchange...\n`);
    let orphanCount = 0;
    for (const [key, dbPositions] of dbMap.entries()) {
      const [symbol, dbSide] = key.split('_');
      const exPositions = exchangeMap.get(key) || [];
      
      if (exPositions.length === 0) {
        orphanCount++;
        console.warn(`⚠️  ${symbol} ${dbSide}: Found in DB but not on exchange (may be closed)`);
        dbPositions.forEach(p => {
          console.warn(`   - Position ID: ${p.id}`);
        });
      }
    }
    
    // Summary
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Exchange positions: ${exchangePositions.length}`);
    console.log(`Database positions: ${botDbPositions.length}`);
    console.log(`Matched: ${matchCount}`);
    console.log(`Side mismatches: ${mismatchCount}`);
    console.log(`Orphan positions (DB only): ${orphanCount}`);
    
    if (mismatchCount > 0) {
      console.log(`\n❌ FOUND ${mismatchCount} SIDE MISMATCH(ES)!`);
      console.log(`   These positions have incorrect side in database.`);
      console.log(`   They need to be fixed manually or re-synced.`);
    } else {
      console.log(`\n✅ No side mismatches found!`);
    }
    
    // Check SHORT positions specifically
    console.log(`\n📋 SHORT Positions Analysis:\n`);
    const shortExchange = Array.from(exchangeMap.entries()).filter(([key]) => key.endsWith('_short'));
    const shortDb = botDbPositions.filter(p => p.side?.toLowerCase() === 'short');
    
    console.log(`Exchange SHORT positions: ${shortExchange.length}`);
    console.log(`Database SHORT positions: ${shortDb.length}`);
    
    if (shortExchange.length > 0 && shortDb.length > 0) {
      console.log(`\n✅ SHORT positions exist in both exchange and database`);
      
      // Verify a few SHORT positions
      console.log(`\n📋 Sample SHORT positions verification:\n`);
      shortExchange.slice(0, 5).forEach(([key, exPositions]) => {
        const [symbol] = key.split('_');
        const dbPos = shortDb.find(p => 
          (p.symbol || '').toUpperCase().replace(/[\/:_]/g, '') === symbol
        );
        
        if (dbPos) {
          const dbSide = String(dbPos.side).toLowerCase();
          if (dbSide === 'short') {
            console.log(`✅ ${symbol}: Exchange=short, DB=${dbSide} - CORRECT`);
          } else {
            console.error(`❌ ${symbol}: Exchange=short, DB=${dbSide} - WRONG!`);
          }
        } else {
          console.warn(`⚠️  ${symbol}: Found on exchange but not in DB`);
        }
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

verifySides().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

