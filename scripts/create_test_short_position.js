#!/usr/bin/env node

/**
 * Script to create a test SHORT position for BEATUSDT on bot_id=2
 * 
 * Usage:
 *   node scripts/create_test_short_position.js --bot_id 2 --symbol BEATUSDT --side SHORT
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { calculateTakeProfit, calculateInitialStopLoss } from '../src/utils/calculator.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];
const symbol = args.find(arg => arg.startsWith('--symbol'))?.split('=')[1] || args[args.indexOf('--symbol') + 1];
const side = args.find(arg => arg.startsWith('--side'))?.split('=')[1] || args[args.indexOf('--side') + 1];

if (!botId || !symbol || !side) {
  console.error('Usage: node scripts/create_test_short_position.js --bot_id <id> --symbol <SYMBOL> --side <LONG|SHORT>');
  process.exit(1);
}

const normalizedSide = side.toLowerCase();
const normalizedSymbol = symbol.toUpperCase().replace(/[\/:_]/g, '');

console.log('\n' + '='.repeat(80));
console.log('CREATE TEST POSITION');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log(`Symbol: ${normalizedSymbol}`);
console.log(`Side: ${normalizedSide}`);
console.log('='.repeat(80) + '\n');

async function createTestPosition() {
  try {
    // Step 1: Load bot
    console.log('📋 STEP 1: Loading bot...');
    const bot = await Bot.findById(Number(botId));
    if (!bot) {
      console.error(`❌ Bot ${botId} not found`);
      process.exit(1);
    }
    console.log(`✅ Bot: ${bot.bot_name} (${bot.exchange})\n`);
    
    // Step 2: Find or create strategy
    console.log('📋 STEP 2: Finding strategy...');
    let strategy = await Strategy.findByBotAndSymbol(Number(botId), normalizedSymbol);
    
    if (!strategy) {
      // Try to find any active strategy for this bot
      const strategies = await Strategy.findAll({ bot_id: Number(botId), is_active: true });
      if (strategies.length > 0) {
        strategy = strategies[0];
        console.log(`⚠️  No strategy found for ${normalizedSymbol}, using strategy ${strategy.id} (${strategy.symbol})`);
      } else {
        console.error(`❌ No active strategy found for bot ${botId}`);
        process.exit(1);
      }
    }
    
    console.log(`✅ Strategy: ID=${strategy.id}, Symbol=${strategy.symbol}`);
    console.log(`   - Take Profit: ${strategy.take_profit || 'N/A'}`);
    console.log(`   - Stop Loss: ${strategy.stoploss || 'N/A'}`);
    console.log(`   - Reduce: ${strategy.reduce || 'N/A'}`);
    console.log(`   - Amount: ${strategy.amount || 'N/A'}\n`);
    
    // Step 3: Initialize ExchangeService and get current price
    console.log('📋 STEP 3: Getting current price from exchange...');
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    let currentPrice;
    try {
      currentPrice = await exchangeService.getTickerPrice(normalizedSymbol);
      if (!currentPrice || !Number.isFinite(Number(currentPrice)) || Number(currentPrice) <= 0) {
        throw new Error('Invalid price');
      }
      currentPrice = Number(currentPrice);
    } catch (e) {
      // Fallback: try Binance Direct Client
      if (exchangeService.binanceDirectClient) {
        const normalized = exchangeService.binanceDirectClient.normalizeSymbol(normalizedSymbol);
        const data = await exchangeService.binanceDirectClient.makeMarketDataRequest('/fapi/v1/ticker/price', 'GET', { symbol: normalized });
        currentPrice = Number(data?.price);
        if (!Number.isFinite(currentPrice) || currentPrice <= 0) {
          throw new Error('Cannot get current price');
        }
      } else {
        throw e;
      }
    }
    
    console.log(`✅ Current price: ${currentPrice}\n`);
    
    // Step 4: Calculate entry price, TP, SL
    console.log('📋 STEP 4: Calculating entry price, TP, SL...');
    
    // For SHORT: entry price should be slightly above current price (to simulate a short entry)
    // For LONG: entry price should be slightly below current price
    const entryPrice = normalizedSide === 'short' 
      ? currentPrice * 1.001  // 0.1% above current (simulating short entry)
      : currentPrice * 0.999;  // 0.1% below current (simulating long entry)
    
    const takeProfit = strategy.take_profit || 50;
    const tpPrice = calculateTakeProfit(entryPrice, takeProfit, normalizedSide);
    
    let slPrice = null;
    if (strategy.stoploss && Number.isFinite(Number(strategy.stoploss)) && Number(strategy.stoploss) > 0) {
      slPrice = calculateInitialStopLoss(entryPrice, Number(strategy.stoploss), normalizedSide);
    }
    
    const amount = strategy.amount || 100;
    
    console.log(`✅ Calculated values:`);
    console.log(`   - Entry Price: ${entryPrice.toFixed(8)}`);
    console.log(`   - TP Price: ${tpPrice.toFixed(8)}`);
    console.log(`   - SL Price: ${slPrice ? slPrice.toFixed(8) : 'N/A'}`);
    console.log(`   - Amount: ${amount}\n`);
    
    // Step 5: Check if position already exists
    console.log('📋 STEP 5: Checking for existing position...');
    const existingPositions = await Position.findAll({
      status: 'open',
      symbol: normalizedSymbol
    });
    
    const existing = existingPositions.find(p => 
      p.bot_id === Number(botId) && 
      p.side?.toLowerCase() === normalizedSide
    );
    
    if (existing) {
      console.log(`⚠️  Position already exists: ID=${existing.id}`);
      console.log(`   - Side: ${existing.side}`);
      console.log(`   - Entry: ${existing.entry_price}`);
      console.log(`   - Status: ${existing.status}`);
      console.log(`\n✅ Using existing position for testing\n`);
      
      // Run verification
      console.log('📋 Running verification...\n');
      const { spawn } = await import('child_process');
      const verify = spawn('node', [
        'scripts/verify_tp_creation_flow.js',
        '--bot_id', String(botId),
        '--symbol', normalizedSymbol,
        '--side', side.toUpperCase()
      ], {
        stdio: 'inherit',
        cwd: process.cwd()
      });
      
      await new Promise((resolve, reject) => {
        verify.on('close', (code) => {
          if (code === 0) resolve();
          else reject(new Error(`Verify script exited with code ${code}`));
        });
        verify.on('error', reject);
      });
      
      return;
    }
    
    // Step 6: Create position
    console.log('📋 STEP 6: Creating position...');
    const position = await Position.create({
      strategy_id: strategy.id,
      bot_id: Number(botId),
      order_id: `test_${normalizedSymbol}_${normalizedSide}_${Date.now()}`,
      symbol: normalizedSymbol,
      side: normalizedSide, // CRITICAL: Use lowercase 'short' or 'long'
      entry_price: entryPrice,
      amount: amount,
      take_profit_price: tpPrice,
      stop_loss_price: slPrice,
      current_reduce: strategy.reduce || 0,
      tp_order_id: null,
      sl_order_id: null,
      tp_sl_pending: true // Flag that TP/SL needs to be placed
    });
    
    console.log(`✅ Position created: ID=${position.id}`);
    console.log(`   - Side: ${position.side} (type: ${typeof position.side})`);
    console.log(`   - Entry Price: ${position.entry_price}`);
    console.log(`   - TP Price: ${position.take_profit_price}`);
    console.log(`   - Status: ${position.status}\n`);
    
    // Verify side is correct
    if (String(position.side).toLowerCase() !== normalizedSide) {
      console.error(`\n❌ ERROR: Position side mismatch!`);
      console.error(`   Expected: ${normalizedSide}`);
      console.error(`   Actual: ${position.side} (${typeof position.side})`);
      console.error(`   This will cause TP to be created with wrong side!\n`);
    } else {
      console.log(`✅ Position side is correct: ${position.side}\n`);
    }
    
    // Step 7: Run verification
    console.log('📋 STEP 7: Running TP creation flow verification...\n');
    const { spawn } = await import('child_process');
    const verify = spawn('node', [
      'scripts/verify_tp_creation_flow.js',
      '--bot_id', String(botId),
      '--symbol', normalizedSymbol,
      '--side', side.toUpperCase()
    ], {
      stdio: 'inherit',
      cwd: process.cwd()
    });
    
    await new Promise((resolve, reject) => {
      verify.on('close', (code) => {
        if (code === 0) resolve();
        else reject(new Error(`Verify script exited with code ${code}`));
      });
      verify.on('error', reject);
    });
    
    console.log('\n' + '='.repeat(80));
    console.log('✅ TEST POSITION CREATED AND VERIFIED');
    console.log('='.repeat(80));
    console.log(`Position ID: ${position.id}`);
    console.log(`You can now test TP creation with this position.`);
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

createTestPosition().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('❌ Failed:', error);
  process.exit(1);
});

