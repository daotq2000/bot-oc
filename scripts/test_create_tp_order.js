#!/usr/bin/env node

/**
 * Script to test creating TP order for a position
 * 
 * Usage:
 *   node scripts/test_create_tp_order.js --bot_id 2 --position_id 492
 */

import { Position } from '../src/models/Position.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { PositionMonitor } from '../src/jobs/PositionMonitor.js';
import logger from '../src/utils/logger.js';

const args = process.argv.slice(2);
const botId = args.find(arg => arg.startsWith('--bot_id'))?.split('=')[1] || args[args.indexOf('--bot_id') + 1];
const positionId = args.find(arg => arg.startsWith('--position_id'))?.split('=')[1] || args[args.indexOf('--position_id') + 1];

if (!botId || !positionId) {
  console.error('Usage: node scripts/test_create_tp_order.js --bot_id <id> --position_id <id>');
  process.exit(1);
}

console.log('\n' + '='.repeat(80));
console.log('TEST CREATE TP ORDER');
console.log('='.repeat(80));
console.log(`Bot ID: ${botId}`);
console.log(`Position ID: ${positionId}`);
console.log('='.repeat(80) + '\n');

async function testCreateTpOrder() {
  try {
    // Step 1: Load position
    console.log('📋 STEP 1: Loading position...');
    const position = await Position.findById(Number(positionId));
    if (!position) {
      console.error(`❌ Position ${positionId} not found`);
      process.exit(1);
    }
    
    if (position.bot_id !== Number(botId)) {
      console.error(`❌ Position ${positionId} belongs to bot ${position.bot_id}, not ${botId}`);
      process.exit(1);
    }
    
    console.log(`✅ Position loaded:`);
    console.log(`   - ID: ${position.id}`);
    console.log(`   - Bot ID: ${position.bot_id}`);
    console.log(`   - Symbol: ${position.symbol}`);
    console.log(`   - Side: ${position.side} (type: ${typeof position.side})`);
    console.log(`   - Entry Price: ${position.entry_price}`);
    console.log(`   - TP Price: ${position.take_profit_price || 'N/A'}`);
    console.log(`   - TP Order ID: ${position.tp_order_id || 'N/A'}`);
    console.log(`   - Status: ${position.status}\n`);
    
    if (position.status !== 'open') {
      console.error(`❌ Position is not open (status: ${position.status})`);
      process.exit(1);
    }
    
    // Step 2: Load bot
    console.log('📋 STEP 2: Loading bot...');
    const bot = await Bot.findById(position.bot_id);
    if (!bot) {
      console.error(`❌ Bot ${position.bot_id} not found`);
      process.exit(1);
    }
    console.log(`✅ Bot: ${bot.bot_name} (${bot.exchange})\n`);
    
    // Step 3: Initialize services
    console.log('📋 STEP 3: Initializing services...');
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    console.log(`✅ ExchangeService initialized\n`);
    
    // Step 4: Verify side value before creating TP
    console.log('📋 STEP 4: Verifying side value...');
    const side = String(position.side).toLowerCase();
    const expectedPositionSide = side === 'long' ? 'LONG' : 'SHORT';
    const expectedOrderSide = side === 'long' ? 'SELL' : 'BUY';
    
    console.log(`   Position side (DB): ${JSON.stringify(position.side)}`);
    console.log(`   Normalized: ${side}`);
    console.log(`   Expected positionSide: ${expectedPositionSide}`);
    console.log(`   Expected orderSide: ${expectedOrderSide}`);
    console.log(`   Expected Binance display: "Close ${expectedPositionSide}"\n`);
    
    if (side !== 'long' && side !== 'short') {
      console.error(`❌ Invalid side value: ${JSON.stringify(position.side)}`);
      process.exit(1);
    }
    
    // Step 5: Get closable quantity
    console.log('📋 STEP 5: Getting closable quantity...');
    let quantity;
    try {
      quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
      console.log(`✅ Closable quantity: ${quantity}\n`);
      
      if (!quantity || quantity <= 0) {
        console.error(`❌ No closable quantity available`);
        process.exit(1);
      }
    } catch (e) {
      console.error(`❌ Error getting closable quantity: ${e?.message || e}`);
      process.exit(1);
    }
    
    // Step 6: Calculate TP price if not set
    console.log('📋 STEP 6: Calculating TP price...');
    let tpPrice = position.take_profit_price;
    
    if (!tpPrice || !Number.isFinite(Number(tpPrice)) || Number(tpPrice) <= 0) {
      const { Strategy } = await import('../src/models/Strategy.js');
      const strategy = await Strategy.findById(position.strategy_id);
      if (!strategy) {
        console.error(`❌ Strategy ${position.strategy_id} not found`);
        process.exit(1);
      }
      
      const { calculateTakeProfit } = await import('../src/utils/calculator.js');
      const entryPrice = position.entry_price || 0;
      const takeProfit = strategy.take_profit || 50;
      tpPrice = calculateTakeProfit(entryPrice, takeProfit, position.side);
      
      console.log(`   Calculated TP price: ${tpPrice}`);
      console.log(`   Entry: ${entryPrice}, Take Profit: ${takeProfit / 10}%\n`);
    } else {
      console.log(`   Using existing TP price: ${tpPrice}\n`);
    }
    
    // Step 7: Create TP order
    console.log('📋 STEP 7: Creating TP order...');
    console.log(`   Parameters:`);
    console.log(`   - symbol: ${position.symbol}`);
    console.log(`   - side: ${JSON.stringify(position.side)}`);
    console.log(`   - tpPrice: ${tpPrice}`);
    console.log(`   - quantity: ${quantity}\n`);
    
    console.log('   ⚠️  Creating TP order on exchange (this will create a real order)...\n');
    
    let tpResult;
    try {
      tpResult = await exchangeService.createTakeProfitLimit(
        position.symbol,
        position.side,
        tpPrice,
        quantity
      );
      
      if (!tpResult) {
        console.error(`❌ TP order creation returned null`);
        console.error(`   This might be due to safety checks (price too close to market)`);
        process.exit(1);
      }
      
      const tpOrderId = tpResult?.orderId ? String(tpResult.orderId) : null;
      
      // Extract values from response
      const orderSide = String(tpResult?.side || '').toUpperCase();
      const orderType = String(tpResult?.type || '').toUpperCase();
      const positionSideFromOrder = String(tpResult?.positionSide || '').toUpperCase();
      
      console.log(`✅ TP order created successfully!`);
      console.log(`   - Order ID: ${tpOrderId}`);
      console.log(`   - Status: ${tpResult?.status || 'N/A'}`);
      console.log(`   - Side: ${orderSide}`);
      console.log(`   - Type: ${orderType}`);
      console.log(`   - Price: ${tpResult?.price || 'N/A'}`);
      console.log(`   - Stop Price: ${tpResult?.stopPrice || 'N/A'}`);
      console.log(`   - Quantity: ${tpResult?.origQty || tpResult?.quantity || 'N/A'}`);
      console.log(`   - Position Side: ${positionSideFromOrder}`);
      console.log(`   - Reduce Only: ${tpResult?.reduceOnly || 'N/A'}\n`);
      
      // Step 8: Verify order on exchange
      console.log('📋 STEP 8: Verifying order on exchange...');
      try {
        const orderStatus = await exchangeService.getOrderStatus(position.symbol, tpOrderId);
        console.log(`✅ Order verified on exchange:`);
        console.log(`   - Order ID: ${orderStatus?.orderId || orderStatus?.id || tpOrderId}`);
        console.log(`   - Status: ${orderStatus?.status || 'N/A'}\n`);
      } catch (e) {
        console.warn(`⚠️  Could not fetch order status from exchange: ${e?.message || e}`);
        console.log(`   Using data from order creation response instead.\n`);
      }
      
      console.log(`   🔍 Order analysis:`);
      console.log(`   - Order side: ${orderSide}`);
      console.log(`   - Order type: ${orderType}`);
      console.log(`   - Position side: ${positionSideFromOrder}`);
      
      if (side === 'short') {
        if (orderSide === 'BUY') {
          console.log(`   ✅ Order side is BUY (correct for closing SHORT)`);
        } else {
          console.error(`   ❌ Order side is ${orderSide}, expected BUY for SHORT position!`);
        }
        
        if (positionSideFromOrder === 'SHORT') {
          console.log(`   ✅ Position side is SHORT (correct)`);
        } else if (positionSideFromOrder) {
          console.error(`   ❌ Position side is ${positionSideFromOrder}, expected SHORT!`);
        }
      } else {
        if (orderSide === 'SELL') {
          console.log(`   ✅ Order side is SELL (correct for closing LONG)`);
        } else {
          console.error(`   ❌ Order side is ${orderSide}, expected SELL for LONG position!`);
        }
        
        if (positionSideFromOrder === 'LONG') {
          console.log(`   ✅ Position side is LONG (correct)`);
        } else if (positionSideFromOrder) {
          console.error(`   ❌ Position side is ${positionSideFromOrder}, expected LONG!`);
        }
      }
      
      console.log(`\n   📊 Expected vs Actual:`);
      console.log(`   - Expected orderSide: ${expectedOrderSide}`);
      console.log(`   - Actual orderSide: ${orderSide}`);
      console.log(`   - Match: ${orderSide === expectedOrderSide ? '✅ YES' : '❌ NO'}`);
      
      if (positionSideFromOrder) {
        console.log(`   - Expected positionSide: ${expectedPositionSide}`);
        console.log(`   - Actual positionSide: ${positionSideFromOrder}`);
        console.log(`   - Match: ${positionSideFromOrder === expectedPositionSide ? '✅ YES' : '❌ NO'}`);
      }
      
      // Step 9: Update position in DB
      console.log(`\n📋 STEP 9: Updating position in DB...`);
      try {
        await Position.update(position.id, {
          tp_order_id: tpOrderId,
          take_profit_price: tpPrice
        });
        console.log(`✅ Position updated with TP order ID: ${tpOrderId}\n`);
      } catch (e) {
        // Try without tp_synced if column doesn't exist
        if (e?.message?.includes('tp_synced')) {
          await Position.update(position.id, {
            tp_order_id: tpOrderId,
            take_profit_price: tpPrice
          });
          console.log(`✅ Position updated with TP order ID: ${tpOrderId} (tp_synced column not available)\n`);
        } else {
          throw e;
        }
      }
      
      // Step 10: Summary
      console.log('='.repeat(80));
      console.log('SUMMARY');
      console.log('='.repeat(80));
      console.log(`Position ID: ${position.id}`);
      console.log(`Position Side (DB): ${position.side}`);
      console.log(`TP Order ID: ${tpOrderId}`);
      console.log(`TP Price: ${tpPrice}`);
      
      if (side === 'short') {
        console.log(`\n✅ TP order created for SHORT position`);
        console.log(`   - Should display as "Close Short" on Binance`);
        console.log(`   - Order side: BUY`);
        console.log(`   - Position side: SHORT`);
      } else {
        console.log(`\n✅ TP order created for LONG position`);
        console.log(`   - Should display as "Close Long" on Binance`);
        console.log(`   - Order side: SELL`);
        console.log(`   - Position side: LONG`);
      }
      
      console.log(`\n⚠️  Please verify on Binance that the order shows as:`);
      console.log(`   "Take Profit Limit - Close ${expectedPositionSide}"`);
      console.log('='.repeat(80) + '\n');
      
    } catch (error) {
      console.error(`\n❌ Error creating TP order:`);
      console.error(error);
      if (error.stack) {
        console.error('\nStack trace:');
        console.error(error.stack);
      }
      
      // Check if it's a side-related error
      const errorMsg = String(error?.message || error).toLowerCase();
      if (errorMsg.includes('side') || errorMsg.includes('position')) {
        console.error(`\n⚠️  This might be a side-related error. Check:`);
        console.error(`   - Position side in DB: ${JSON.stringify(position.side)}`);
        console.error(`   - Expected side: ${side}`);
      }
      
      process.exit(1);
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

testCreateTpOrder().then(() => {
  console.log('✅ Test complete');
  process.exit(0);
}).catch(error => {
  console.error('❌ Test failed:', error);
  process.exit(1);
});

