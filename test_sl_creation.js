/**
 * Test script to verify SL order creation and software SL fallback
 * This actually tries to create an SL order on testnet
 */

import 'dotenv/config';
import { Bot } from './src/models/Bot.js';
import { Position } from './src/models/Position.js';
import { ExchangeService } from './src/services/ExchangeService.js';

async function main() {
  console.log('='.repeat(60));
  console.log('TEST: SL ORDER CREATION ON TESTNET');
  console.log('='.repeat(60));
  
  try {
    const bots = await Bot.findAll();
    const testBot = bots.find(b => b.exchange === 'binance' && (b.binance_testnet === true || b.binance_testnet === 1));
    
    if (!testBot) {
      console.log('No testnet bot found');
      process.exit(1);
    }
    
    console.log('Using testnet bot: ID=' + testBot.id);
    
    const exchangeService = new ExchangeService(testBot);
    await exchangeService.initialize();
    console.log('ExchangeService initialized');
    
    // Get open positions
    const openPositions = await Position.findOpen();
    const botPositions = openPositions.filter(p => 
      p.bot_id === testBot.id && 
      p.stop_loss_price && 
      !p.sl_order_id
    );
    
    console.log('\nPositions needing SL: ' + botPositions.length);
    
    if (botPositions.length === 0) {
      console.log('No positions need SL order');
      process.exit(0);
    }
    
    // Test with first position
    const testPos = botPositions[0];
    console.log('\nTesting SL creation for position ' + testPos.id + ':');
    console.log('  Symbol: ' + testPos.symbol);
    console.log('  Side: ' + testPos.side);
    console.log('  SL Price: ' + testPos.stop_loss_price);
    console.log('  Amount: ' + testPos.amount);
    
    // Try to create SL order
    console.log('\nAttempting to create SL order...');
    console.log('Expected: Fail with -4120, return null');
    
    try {
      const slResult = await exchangeService.createStopLossLimit(
        testPos.symbol,
        testPos.side,
        testPos.stop_loss_price,
        testPos.amount
      );
      
      if (slResult && slResult.orderId) {
        console.log('\nUNEXPECTED SUCCESS! SL order created:');
        console.log('  Order ID: ' + slResult.orderId);
        console.log('  Status: ' + slResult.status);
        console.log('  Type: ' + slResult.type);
        
        // Update position
        await Position.update(testPos.id, { 
          sl_order_id: String(slResult.orderId),
          use_software_sl: false
        });
        console.log('  Position updated with sl_order_id');
      } else {
        console.log('\nSL order returned null (expected on testnet)');
        console.log('This means exchange conditional orders are not supported');
        console.log('Enabling software SL for this position...');
        
        // Enable software SL
        await Position.update(testPos.id, { 
          use_software_sl: true 
        });
        console.log('  Position ' + testPos.id + ' now using SOFTWARE SL');
        
        // Verify update
        const updatedPos = await Position.findById(testPos.id);
        console.log('  Verified: use_software_sl = ' + updatedPos.use_software_sl);
      }
    } catch (error) {
      console.log('\nSL order failed with error:');
      console.log('  ' + error.message);
      
      if (error.message.includes('-4120') || error.message.includes('Order type not supported')) {
        console.log('\nThis is expected on testnet!');
        console.log('Enabling software SL...');
        
        await Position.update(testPos.id, { 
          use_software_sl: true 
        });
        console.log('  Position ' + testPos.id + ' now using SOFTWARE SL');
      }
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('TEST COMPLETE');
    console.log('='.repeat(60));
    
  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
  }
  
  process.exit(0);
}

main();
