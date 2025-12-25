#!/usr/bin/env node

/**
 * Script to test TP creation with different side values to debug the issue
 * 
 * Usage:
 *   node scripts/test_tp_side_debug.js --bot_id 2 --position_id 381
 */

import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];
const positionId = args.find(arg => arg.startsWith('--position_id'))?.split('=')[1] || args[args.indexOf('--position_id') + 1];

if (!botId || !positionId) {
  console.error('Usage: node scripts/test_tp_side_debug.js --bot_id <id> --position_id <id>');
  process.exit(1);
}

async function testTpSide() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('TP SIDE DEBUG TEST');
    console.log('='.repeat(80));
    console.log(`Bot ID: ${botId}`);
    console.log(`Position ID: ${positionId}`);
    console.log('='.repeat(80) + '\n');
    
    // Load position
    const position = await Position.findById(Number(positionId));
    if (!position) {
      console.error(`❌ Position ${positionId} not found`);
      process.exit(1);
    }
    
    console.log(`✅ Position loaded:`);
    console.log(`   - ID: ${position.id}`);
    console.log(`   - Bot ID: ${position.bot_id}`);
    console.log(`   - Symbol: ${position.symbol}`);
    console.log(`   - Side (DB): ${JSON.stringify(position.side)} (type: ${typeof position.side})`);
    console.log(`   - Entry Price: ${position.entry_price}`);
    console.log(`   - Status: ${position.status}\n`);
    
    // Test with different side values
    const testSides = [
      position.side, // Original
      'short',        // Lowercase
      'SHORT',        // Uppercase
      'Short',        // Capitalized
      String(position.side).toLowerCase(), // Normalized
    ];
    
    console.log('📋 Testing TP creation logic with different side values:\n');
    
    for (const testSide of testSides) {
      console.log(`\n${'─'.repeat(80)}`);
      console.log(`Testing with side: ${JSON.stringify(testSide)} (type: ${typeof testSide})`);
      console.log('─'.repeat(80));
      
      // Simulate BinanceDirectClient.createTpLimitOrder logic
      const sideForOrder = String(testSide).toLowerCase();
      const positionSide = sideForOrder === 'long' ? 'LONG' : 'SHORT';
      const orderSide = sideForOrder === 'long' ? 'SELL' : 'BUY';
      
      console.log(`   Input side: ${JSON.stringify(testSide)}`);
      console.log(`   → Normalized: ${sideForOrder}`);
      console.log(`   → positionSide: ${positionSide}`);
      console.log(`   → orderSide: ${orderSide}`);
      
      // Expected for SHORT
      if (position.side?.toLowerCase() === 'short' || testSide?.toLowerCase() === 'short') {
        if (positionSide === 'SHORT' && orderSide === 'BUY') {
          console.log(`   ✅ CORRECT - Will create "Close Short" order`);
        } else {
          console.log(`   ❌ WRONG - Will create "Close ${positionSide === 'LONG' ? 'Long' : 'Short'}" order instead!`);
          console.log(`   ⚠️  This is the bug!`);
        }
      } else {
        // Expected for LONG
        if (positionSide === 'LONG' && orderSide === 'SELL') {
          console.log(`   ✅ CORRECT - Will create "Close Long" order`);
        } else {
          console.log(`   ❌ WRONG - Will create "Close ${positionSide === 'SHORT' ? 'Short' : 'Long'}" order instead!`);
        }
      }
    }
    
    // Check if position.side in DB is actually wrong
    console.log(`\n${'='.repeat(80)}`);
    console.log('DIAGNOSIS');
    console.log('='.repeat(80));
    
    const dbSide = String(position.side).toLowerCase();
    console.log(`Position side in DB: ${JSON.stringify(position.side)} → normalized: ${dbSide}`);
    
    if (dbSide === 'long') {
      console.log(`\n⚠️  Position is stored as LONG in database.`);
      console.log(`   If this should be SHORT, the bug is in PositionSync.js or OrderService.js`);
      console.log(`   when creating the position.`);
    } else if (dbSide === 'short') {
      console.log(`\n✅ Position is stored as SHORT in database.`);
      console.log(`   If TP is still created as "Close Long", the bug is in the TP creation flow.`);
    } else {
      console.log(`\n❌ Position side is invalid: ${JSON.stringify(position.side)}`);
      console.log(`   This will cause TP creation to fail or create wrong order type.`);
    }
    
    // Test actual TP creation flow (dry run)
    console.log(`\n${'='.repeat(80)}`);
    console.log('SIMULATING TP CREATION FLOW');
    console.log('='.repeat(80));
    
    const bot = await Bot.findById(position.bot_id);
    if (!bot) {
      console.error(`❌ Bot ${position.bot_id} not found`);
      process.exit(1);
    }
    
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    // Get fill price
    let fillPrice = position.entry_price;
    try {
      const actualFillPrice = await exchangeService.getOrderAverageFillPrice(position.symbol, position.order_id);
      if (actualFillPrice && Number.isFinite(actualFillPrice) && actualFillPrice > 0) {
        fillPrice = actualFillPrice;
      }
    } catch (e) {
      // Use DB value
    }
    
    // Calculate TP
    const { calculateTakeProfit } = await import('../src/utils/calculator.js');
    const { Strategy } = await import('../src/models/Strategy.js');
    const strategy = await Strategy.findById(position.strategy_id);
    const takeProfit = strategy?.take_profit || 50;
    const tpPrice = calculateTakeProfit(fillPrice, takeProfit, position.side);
    
    console.log(`\nStep 1: PositionMonitor.placeTpSlOrders()`);
    console.log(`   - position.side = ${JSON.stringify(position.side)}`);
    console.log(`   - Calls: exchangeService.createTakeProfitLimit(position.symbol, position.side, tpPrice, quantity)`);
    console.log(`   - Parameters: symbol=${position.symbol}, side=${JSON.stringify(position.side)}, tpPrice=${tpPrice}`);
    
    console.log(`\nStep 2: ExchangeService.createTakeProfitLimit()`);
    console.log(`   - Receives: side=${JSON.stringify(position.side)}`);
    console.log(`   - Calls: binanceDirectClient.createTpLimitOrder(symbol, side, tpPrice, quantity)`);
    console.log(`   - Parameters: side=${JSON.stringify(position.side)} (passed through)`);
    
    console.log(`\nStep 3: BinanceDirectClient.createTpLimitOrder()`);
    const finalSide = String(position.side).toLowerCase();
    const finalPositionSide = finalSide === 'long' ? 'LONG' : 'SHORT';
    const finalOrderSide = finalSide === 'long' ? 'SELL' : 'BUY';
    console.log(`   - Receives: side=${JSON.stringify(position.side)}`);
    console.log(`   - Normalizes: ${finalSide}`);
    console.log(`   - Calculates: positionSide=${finalPositionSide}, orderSide=${finalOrderSide}`);
    console.log(`   - Creates order with: side=${finalOrderSide}, positionSide=${finalPositionSide}`);
    
    if (position.side?.toLowerCase() === 'short') {
      if (finalPositionSide === 'SHORT' && finalOrderSide === 'BUY') {
        console.log(`\n✅ Flow is CORRECT - Will create "Close Short" order`);
      } else {
        console.log(`\n❌ Flow is WRONG - Will create "Close ${finalPositionSide === 'LONG' ? 'Long' : 'Short'}" order!`);
        console.log(`\n🔧 ROOT CAUSE:`);
        console.log(`   The position.side value in DB is: ${JSON.stringify(position.side)}`);
        console.log(`   After normalization: ${finalSide}`);
        console.log(`   This results in: positionSide=${finalPositionSide}, orderSide=${finalOrderSide}`);
        console.log(`   Expected for SHORT: positionSide=SHORT, orderSide=BUY`);
      }
    } else {
      console.log(`\n⚠️  Position is LONG, so "Close Long" is expected.`);
      console.log(`   To test SHORT, you need a position with side='short' in DB.`);
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

testTpSide().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

