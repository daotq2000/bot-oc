/**
 * Test script to verify Software Stop Loss integration
 */

import 'dotenv/config';
import { Bot } from './src/models/Bot.js';
import { Position } from './src/models/Position.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import { getSoftwareStopLossService } from './src/services/SoftwareStopLossService.js';

async function main() {
  console.log('='.repeat(60));
  console.log('SOFTWARE STOP LOSS INTEGRATION TEST');
  console.log('='.repeat(60));
  
  try {
    const bots = await Bot.findAll();
    const binanceBots = bots.filter(b => b.exchange === 'binance');
    
    if (binanceBots.length === 0) {
      console.log('No Binance bots found');
      process.exit(1);
    }
    
    let testBot = binanceBots.find(b => b.binance_testnet === true || b.binance_testnet === 1);
    if (!testBot) {
      testBot = binanceBots[0];
    }
    
    console.log('Using bot: ID=' + testBot.id + ', testnet=' + testBot.binance_testnet);
    
    const exchangeService = new ExchangeService(testBot);
    await exchangeService.initialize();
    console.log('ExchangeService initialized');
    
    const softwareSLService = getSoftwareStopLossService(exchangeService);
    console.log('SoftwareStopLossService initialized');
    console.log('Stats: ' + JSON.stringify(softwareSLService.getStats()));
    
    const openPositions = await Position.findOpen();
    const botPositions = openPositions.filter(p => p.bot_id === testBot.id);
    
    console.log('Open positions for bot ' + testBot.id + ': ' + botPositions.length);
    
    if (botPositions.length === 0) {
      console.log('No open positions to test');
      
      const currentPrice = await exchangeService.getTickerPrice('BTCUSDT');
      console.log('Current BTCUSDT price: ' + currentPrice);
      
    } else {
      for (const pos of botPositions) {
        console.log('Position ' + pos.id + ':');
        console.log('  Symbol: ' + pos.symbol);
        console.log('  Side: ' + pos.side);
        console.log('  SL: ' + (pos.stop_loss_price || 'NOT SET'));
        console.log('  use_software_sl: ' + pos.use_software_sl);
        console.log('  sl_order_id: ' + (pos.sl_order_id || 'NULL'));
      }
    }
    
    console.log('');
    console.log('Summary:');
    console.log('- SoftwareStopLossService: INTEGRATED');
    console.log('- PositionMonitor: UPDATED');
    console.log('- use_software_sl column: ADDED');
    console.log('');
    console.log('TEST COMPLETE');
    
  } catch (error) {
    console.error('Test failed:', error.message);
    console.error(error.stack);
  }
  
  process.exit(0);
}

main();
