#!/usr/bin/env node

/**
 * Script to verify TP creation flow for a specific position
 * 
 * Usage:
 *   node scripts/verify_tp_creation_flow.js --bot_id 3 --symbol BEATUSDT --side SHORT
 * 
 * This script traces the entire TP creation flow without actually creating orders
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionMonitor } from '../src/jobs/PositionMonitor.js';
import { calculateTakeProfit } from '../src/utils/calculator.js';
import logger from '../src/utils/logger.js';

// Parse command line arguments
const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];
const symbol = args.find(arg => arg.startsWith('--symbol'))?.split('=')[1] || args[args.indexOf('--symbol') + 1];
const side = args.find(arg => arg.startsWith('--side'))?.split('=')[1] || args[args.indexOf('--side') + 1];

if (!botId || !symbol || !side) {
  console.error('Usage: node scripts/verify_tp_creation_flow.js --bot_id <id> --symbol <SYMBOL> --side <LONG|SHORT>');
  process.exit(1);
}

const normalizedSide = side.toLowerCase();

console.log('\n' + '='.repeat(80));
console.log('TP CREATION FLOW VERIFICATION');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log(`Symbol: ${symbol}`);
console.log(`Side: ${side} (normalized: ${normalizedSide})`);
console.log('='.repeat(80) + '\n');

async function verifyTpFlow() {
  try {
    // Step 1: Load position from DB
    console.log('📋 STEP 1: Loading position from database...');
    const positions = await Position.findAll({ 
      status: 'open',
      symbol: symbol.toUpperCase()
    });
    
    let position = positions.find(p => 
      p.bot_id === Number(botId) && 
      p.side?.toLowerCase() === normalizedSide &&
      p.symbol?.toUpperCase() === symbol.toUpperCase()
    );
    
    // If exact match not found, try to find any position with same bot_id and symbol
    // This helps debug when side might be stored incorrectly
    if (!position) {
      const candidates = positions.filter(p => 
        p.bot_id === Number(botId) && 
        p.symbol?.toUpperCase() === symbol.toUpperCase()
      );
      
      if (candidates.length > 0) {
        console.warn(`⚠️  Exact match not found, but found ${candidates.length} position(s) with same bot_id and symbol:`);
        candidates.forEach(p => {
          console.warn(`  - Position ID: ${p.id}, Side: ${p.side} (expected: ${normalizedSide}), Status: ${p.status}`);
        });
        console.warn(`\n  Using first candidate for debugging...`);
        position = candidates[0];
      } else {
        console.error(`❌ Position not found: bot_id=${botId}, symbol=${symbol}, side=${side}`);
        console.log('\nAvailable positions:');
        positions.forEach(p => {
          console.log(`  - Position ID: ${p.id}, Bot: ${p.bot_id}, Symbol: ${p.symbol}, Side: ${p.side}, Status: ${p.status}`);
        });
        process.exit(1);
      }
    }
    
    console.log(`✅ Position found: ID=${position.id}`);
    console.log(`   - Bot ID: ${position.bot_id}`);
    console.log(`   - Symbol: ${position.symbol}`);
    console.log(`   - Side: ${position.side} (type: ${typeof position.side})`);
    console.log(`   - Entry Price: ${position.entry_price || 'N/A'}`);
    console.log(`   - Current TP Price: ${position.take_profit_price || 'N/A'}`);
    console.log(`   - TP Order ID: ${position.tp_order_id || 'N/A'}`);
    console.log(`   - Status: ${position.status}`);
    console.log(`   - Order ID: ${position.order_id || 'N/A'}`);
    console.log(`   - Amount: ${position.amount || 'N/A'}`);
    
    // Verify side value
    if (position.side?.toLowerCase() !== normalizedSide) {
      console.error(`\n⚠️  WARNING: Position side mismatch!`);
      console.error(`   Expected: ${normalizedSide}`);
      console.error(`   Actual: ${position.side} (${typeof position.side})`);
      console.error(`   This could cause TP to be created with wrong side!\n`);
    }
    
    // Step 2: Load bot and strategy
    console.log('\n📋 STEP 2: Loading bot and strategy...');
    const bot = await Bot.findById(position.bot_id);
    if (!bot) {
      console.error(`❌ Bot ${position.bot_id} not found`);
      process.exit(1);
    }
    console.log(`✅ Bot found: ${bot.bot_name} (${bot.exchange})`);
    
    const strategy = await Strategy.findById(position.strategy_id);
    if (!strategy) {
      console.error(`❌ Strategy ${position.strategy_id} not found`);
      process.exit(1);
    }
    console.log(`✅ Strategy found: ID=${strategy.id}`);
    console.log(`   - Take Profit: ${strategy.take_profit || 'N/A'}`);
    console.log(`   - Stop Loss: ${strategy.stoploss || 'N/A'}`);
    console.log(`   - Reduce: ${strategy.reduce || 'N/A'}`);
    console.log(`   - Up Reduce: ${strategy.up_reduce || 'N/A'}`);
    
    // Step 3: Initialize ExchangeService (mock - don't actually create orders)
    console.log('\n📋 STEP 3: Initializing ExchangeService...');
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    console.log(`✅ ExchangeService initialized for ${bot.exchange}`);
    
    // Step 4: Get fill price
    console.log('\n📋 STEP 4: Getting fill price from exchange...');
    let fillPrice = position.entry_price;
    try {
      const actualFillPrice = await exchangeService.getOrderAverageFillPrice(position.symbol, position.order_id);
      if (actualFillPrice && Number.isFinite(actualFillPrice) && actualFillPrice > 0) {
        fillPrice = actualFillPrice;
        console.log(`✅ Fill price from exchange: ${fillPrice}`);
      } else {
        console.log(`⚠️  Could not get fill price from exchange, using DB entry_price: ${fillPrice}`);
      }
    } catch (e) {
      console.log(`⚠️  Error getting fill price: ${e?.message || e}, using DB entry_price: ${fillPrice}`);
    }
    
    // Step 5: Calculate TP price
    console.log('\n📋 STEP 5: Calculating TP price...');
    const takeProfit = strategy.take_profit || 50;
    const tpPrice = calculateTakeProfit(fillPrice, takeProfit, position.side);
    console.log(`✅ Calculated TP price: ${tpPrice}`);
    console.log(`   - Entry Price: ${fillPrice}`);
    console.log(`   - Take Profit %: ${takeProfit / 10}%`);
    console.log(`   - Position Side: ${position.side}`);
    console.log(`   - TP Price: ${tpPrice}`);
    
    // Verify TP price direction
    if (normalizedSide === 'short') {
      if (tpPrice >= fillPrice) {
        console.log(`   ⚠️  WARNING: TP price (${tpPrice}) >= Entry (${fillPrice}) for SHORT position!`);
        console.log(`   This means TP is in loss zone (for early exit), which is OK for trailing TP.`);
      } else {
        console.log(`   ✅ TP price is below entry (profit zone)`);
      }
    } else {
      if (tpPrice <= fillPrice) {
        console.log(`   ⚠️  WARNING: TP price (${tpPrice}) <= Entry (${fillPrice}) for LONG position!`);
      } else {
        console.log(`   ✅ TP price is above entry (profit zone)`);
      }
    }
    
    // Step 6: Get closable quantity
    console.log('\n📋 STEP 6: Getting closable quantity from exchange...');
    let quantity;
    try {
      quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
      console.log(`✅ Closable quantity: ${quantity}`);
    } catch (e) {
      console.error(`❌ Error getting closable quantity: ${e?.message || e}`);
      quantity = 0;
    }
    
    // Step 7: Trace through createTakeProfitLimit (without actually creating)
    console.log('\n📋 STEP 7: Tracing createTakeProfitLimit flow...');
    console.log(`   Input parameters:`);
    console.log(`   - symbol: ${position.symbol}`);
    console.log(`   - side: ${position.side} (type: ${typeof position.side})`);
    console.log(`   - tpPrice: ${tpPrice}`);
    console.log(`   - quantity: ${quantity}`);
    
    // Check side value before passing to ExchangeService
    const sideBeforeExchange = position.side;
    console.log(`\n   🔍 Side value check before ExchangeService:`);
    console.log(`   - Raw value: ${JSON.stringify(sideBeforeExchange)}`);
    console.log(`   - Type: ${typeof sideBeforeExchange}`);
    console.log(`   - Lowercase: ${String(sideBeforeExchange).toLowerCase()}`);
    console.log(`   - Is 'long'?: ${String(sideBeforeExchange).toLowerCase() === 'long'}`);
    console.log(`   - Is 'short'?: ${String(sideBeforeExchange).toLowerCase() === 'short'}`);
    
    // Step 8: Trace through BinanceDirectClient.createTpLimitOrder logic
    console.log('\n📋 STEP 8: Tracing BinanceDirectClient.createTpLimitOrder logic...');
    const normalizedSymbol = symbol.toUpperCase().replace('/', '').replace('_', '');
    console.log(`   - Normalized symbol: ${normalizedSymbol}`);
    
    // Simulate the logic from BinanceDirectClient.js
    const sideForOrder = String(position.side).toLowerCase();
    const positionSide = sideForOrder === 'long' ? 'LONG' : 'SHORT';
    const orderSide = sideForOrder === 'long' ? 'SELL' : 'BUY';
    
    console.log(`\n   🔍 Side transformation in BinanceDirectClient:`);
    console.log(`   - Input side: ${JSON.stringify(position.side)}`);
    console.log(`   - Normalized to lowercase: ${sideForOrder}`);
    console.log(`   - positionSide: ${positionSide}`);
    console.log(`   - orderSide: ${orderSide}`);
    
    // Verify expected vs actual
    console.log(`\n   ✅ Expected values for ${normalizedSide.toUpperCase()} position:`);
    if (normalizedSide === 'short') {
      console.log(`   - positionSide should be: SHORT`);
      console.log(`   - orderSide should be: BUY (to close SHORT)`);
      console.log(`   - Binance will show: "Close Short"`);
    } else {
      console.log(`   - positionSide should be: LONG`);
      console.log(`   - orderSide should be: SELL (to close LONG)`);
      console.log(`   - Binance will show: "Close Long"`);
    }
    
    console.log(`\n   🔍 Actual values:`);
    console.log(`   - positionSide: ${positionSide}`);
    console.log(`   - orderSide: ${orderSide}`);
    
    if (normalizedSide === 'short' && positionSide !== 'SHORT') {
      console.error(`\n   ❌ ERROR: positionSide is ${positionSide}, expected SHORT!`);
      console.error(`   This means the side value passed to createTpLimitOrder is wrong.`);
    } else if (normalizedSide === 'long' && positionSide !== 'LONG') {
      console.error(`\n   ❌ ERROR: positionSide is ${positionSide}, expected LONG!`);
      console.error(`   This means the side value passed to createTpLimitOrder is wrong.`);
    } else {
      console.log(`   ✅ positionSide is correct`);
    }
    
    if (normalizedSide === 'short' && orderSide !== 'BUY') {
      console.error(`\n   ❌ ERROR: orderSide is ${orderSide}, expected BUY!`);
      console.error(`   This will create "Close Long" instead of "Close Short"!`);
    } else if (normalizedSide === 'long' && orderSide !== 'SELL') {
      console.error(`\n   ❌ ERROR: orderSide is ${orderSide}, expected SELL!`);
      console.error(`   This will create "Close Short" instead of "Close Long"!`);
    } else {
      console.log(`   ✅ orderSide is correct`);
    }
    
    // Step 9: Summary
    console.log('\n' + '='.repeat(80));
    console.log('SUMMARY');
    console.log('='.repeat(80));
    console.log(`Position ID: ${position.id}`);
    console.log(`Position Side (DB): ${position.side} (${typeof position.side})`);
    console.log(`Expected Side: ${normalizedSide}`);
    console.log(`Calculated positionSide: ${positionSide}`);
    console.log(`Calculated orderSide: ${orderSide}`);
    console.log(`TP Price: ${tpPrice}`);
    console.log(`Entry Price: ${fillPrice}`);
    
    if (normalizedSide === 'short') {
      if (positionSide === 'SHORT' && orderSide === 'BUY') {
        console.log(`\n✅ TP creation flow is CORRECT - will create "Close Short" order`);
      } else {
        console.log(`\n❌ TP creation flow is WRONG - will create "Close Long" order instead!`);
        console.log(`\n🔧 FIX NEEDED:`);
        console.log(`   The position.side value in DB is: ${JSON.stringify(position.side)}`);
        console.log(`   It should be exactly: "short" (lowercase)`);
        console.log(`   Check PositionSync.js or the code that creates positions.`);
      }
    } else {
      if (positionSide === 'LONG' && orderSide === 'SELL') {
        console.log(`\n✅ TP creation flow is CORRECT - will create "Close Long" order`);
      } else {
        console.log(`\n❌ TP creation flow is WRONG - will create "Close Short" order instead!`);
        console.log(`\n🔧 FIX NEEDED:`);
        console.log(`   The position.side value in DB is: ${JSON.stringify(position.side)}`);
        console.log(`   It should be exactly: "long" (lowercase)`);
        console.log(`   Check PositionSync.js or the code that creates positions.`);
      }
    }
    
    console.log('='.repeat(80) + '\n');
    
  } catch (error) {
    console.error('\n❌ Error during verification:');
    console.error(error);
    if (error.stack) {
      console.error('\nStack trace:');
      console.error(error.stack);
    }
    process.exit(1);
  }
}

// Run verification
verifyTpFlow().then(() => {
  console.log('✅ Verification complete');
  process.exit(0);
}).catch(error => {
  console.error('❌ Verification failed:', error);
  process.exit(1);
});

