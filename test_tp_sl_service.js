import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Test script to verify the createTpLimitOrder and createSlLimitOrder fix
 * This opens a position and uses the actual service methods
 * 
 * Usage: node test_tp_sl_service.js [strategy_id]
 */

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testTpSlService() {
  try {
    const strategyId = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    console.log('═'.repeat(60));
    console.log('=== Test createTpLimitOrder & createSlLimitOrder ===');
    console.log('═'.repeat(60));
    
    // 1. Get strategy
    let strategy;
    if (strategyId) {
      strategy = await Strategy.findById(strategyId);
      if (!strategy) {
        console.error(`Strategy ${strategyId} not found`);
        process.exit(1);
      }
    } else {
      const strategies = await Strategy.findAll(null, true);
      if (strategies.length === 0) {
        console.error('No active strategies found');
        process.exit(1);
      }
      
      strategy = strategies.find(s => s.symbol === 'BTCUSDT' || s.symbol === 'BTC/USDT') ||
                 strategies.find(s => s.symbol === 'ETHUSDT' || s.symbol === 'ETH/USDT') ||
                 strategies[0];
      
      console.log(`Using strategy: ID ${strategy.id} (${strategy.symbol})`);
    }
    
    // 2. Get bot
    const bot = await Bot.findById(strategy.bot_id);
    if (!bot) {
      console.error(`Bot ${strategy.bot_id} not found`);
      process.exit(1);
    }
    
    console.log(`\nBot: ${bot.bot_name}`);
    console.log(`Exchange: ${bot.exchange}`);
    console.log(`Testnet: ${bot.binance_testnet ? 'YES' : 'NO'}`);
    
    // 3. Initialize
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    const binanceClient = exchangeService.binanceDirectClient;
    if (!binanceClient) {
      throw new Error('BinanceDirectClient not initialized');
    }
    
    console.log(`\nBase URL: ${binanceClient.baseURL}`);
    console.log(`Is Testnet: ${binanceClient.isTestnet}`);
    
    // 4. Get market info
    const symbol = binanceClient.normalizeSymbol(strategy.symbol);
    
    const [currentPrice, tickSize, stepSize, dualSide] = await Promise.all([
      binanceClient.getPrice(symbol),
      binanceClient.getTickSize(symbol),
      binanceClient.getStepSize(symbol),
      binanceClient.getDualSidePosition()
    ]);
    
    console.log(`\n${'─'.repeat(50)}`);
    console.log(`Symbol: ${symbol}`);
    console.log(`Current Price: ${currentPrice}`);
    console.log(`Tick Size: ${tickSize}`);
    console.log(`Step Size: ${stepSize}`);
    console.log(`Hedge Mode: ${dualSide}`);
    
    // Calculate test quantity (minimum $100 notional)
    const minNotionalQty = 105 / currentPrice;
    const stepSizeNum = parseFloat(stepSize);
    let testQuantity = Math.ceil(minNotionalQty / stepSizeNum) * stepSizeNum;
    const precision = stepSize.includes('.') ? stepSize.split('.')[1].length : 0;
    testQuantity = testQuantity.toFixed(precision);
    
    const actualNotional = parseFloat(testQuantity) * currentPrice;
    console.log(`Test Quantity: ${testQuantity}`);
    console.log(`Notional Value: $${actualNotional.toFixed(2)}`);
    
    // 5. Open a LONG position
    console.log('\n' + '═'.repeat(60));
    console.log('STEP 1: Opening LONG position');
    console.log('═'.repeat(60));
    
    const entryParams = {
      symbol: symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity: testQuantity
    };
    
    if (dualSide) {
      entryParams.positionSide = 'LONG';
    }
    
    console.log('Entry order params:', JSON.stringify(entryParams, null, 2));
    
    const entryOrder = await binanceClient.makeRequestWithRetry('/fapi/v1/order', 'POST', entryParams, true);
    
    if (!entryOrder || !entryOrder.orderId) {
      console.error('Failed to open position:', entryOrder);
      process.exit(1);
    }
    
    console.log(`✅ Position opened! Order ID: ${entryOrder.orderId}`);
    
    await delay(1000);
    
    // Get actual entry price
    const actualEntryPrice = parseFloat(entryOrder.avgPrice) || currentPrice;
    
    // Calculate TP and SL prices
    const tpPrice = actualEntryPrice * 1.01; // 1% above entry
    const slPrice = actualEntryPrice * 0.99; // 1% below entry
    
    console.log(`\nEntry Price: ${actualEntryPrice}`);
    console.log(`TP Price: ${tpPrice.toFixed(2)} (1% above)`);
    console.log(`SL Price: ${slPrice.toFixed(2)} (1% below)`);
    
    // 6. Test createTpLimitOrder (the fixed method)
    console.log('\n' + '═'.repeat(60));
    console.log('STEP 2: Testing createTpLimitOrder()');
    console.log('═'.repeat(60));
    
    try {
      console.log(`\nCalling createTpLimitOrder(${symbol}, 'long', ${tpPrice.toFixed(2)}, ${testQuantity})`);
      
      const tpOrder = await binanceClient.createTpLimitOrder(
        symbol,
        'long', // position side
        tpPrice,
        parseFloat(testQuantity)
      );
      
      if (tpOrder && tpOrder.orderId) {
        console.log(`\n✅ createTpLimitOrder SUCCESS!`);
        console.log(`   Order ID: ${tpOrder.orderId}`);
        console.log(`   Type: ${tpOrder.type}`);
        console.log(`   Price: ${tpOrder.price}`);
        console.log(`   Status: ${tpOrder.status}`);
        
        // Cancel the TP order
        await delay(500);
        try {
          await binanceClient.cancelOrder(symbol, tpOrder.orderId);
          console.log(`   (Order canceled for cleanup)`);
        } catch (e) {
          console.log(`   (Failed to cancel order: ${e?.message})`);
        }
      } else {
        console.log(`\n⚠️ createTpLimitOrder returned null or no orderId`);
        console.log(`   Response:`, tpOrder);
      }
    } catch (error) {
      console.log(`\n❌ createTpLimitOrder FAILED!`);
      console.log(`   Error: ${error?.message || error}`);
    }
    
    // 7. Test createSlLimitOrder (should return null on testnet)
    console.log('\n' + '═'.repeat(60));
    console.log('STEP 3: Testing createSlLimitOrder()');
    console.log('═'.repeat(60));
    
    try {
      console.log(`\nCalling createSlLimitOrder(${symbol}, 'long', ${slPrice.toFixed(2)}, ${testQuantity})`);
      
      const slOrder = await binanceClient.createSlLimitOrder(
        symbol,
        'long', // position side
        slPrice,
        parseFloat(testQuantity)
      );
      
      if (slOrder && slOrder.orderId) {
        console.log(`\n✅ createSlLimitOrder SUCCESS!`);
        console.log(`   Order ID: ${slOrder.orderId}`);
        console.log(`   Type: ${slOrder.type}`);
        console.log(`   Stop Price: ${slOrder.stopPrice}`);
        console.log(`   Status: ${slOrder.status}`);
        
        // Cancel the SL order
        await delay(500);
        try {
          await binanceClient.cancelOrder(symbol, slOrder.orderId);
          console.log(`   (Order canceled for cleanup)`);
        } catch (e) {
          console.log(`   (Failed to cancel order: ${e?.message})`);
        }
      } else {
        console.log(`\n⚠️ createSlLimitOrder returned null (expected on testnet)`);
        console.log(`   This is NORMAL behavior - conditional orders not supported on testnet.`);
        console.log(`   SL should be handled by PositionMonitor software-based monitoring.`);
      }
    } catch (error) {
      console.log(`\n❌ createSlLimitOrder FAILED!`);
      console.log(`   Error: ${error?.message || error}`);
    }
    
    // 8. Close the position
    console.log('\n' + '═'.repeat(60));
    console.log('STEP 4: Closing position');
    console.log('═'.repeat(60));
    
    const closeParams = {
      symbol: symbol,
      side: 'SELL',
      type: 'MARKET',
      quantity: testQuantity
    };
    
    if (dualSide) {
      closeParams.positionSide = 'LONG';
    }
    
    try {
      const closeOrder = await binanceClient.makeRequestWithRetry('/fapi/v1/order', 'POST', closeParams, true);
      console.log(`✅ Position closed! Order ID: ${closeOrder.orderId}`);
    } catch (error) {
      console.log(`⚠️ Failed to close position: ${error?.message || error}`);
    }
    
    // 9. Summary
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    
    console.log(`
On Binance Testnet:
- createTpLimitOrder: Will use LIMIT order as fallback (works!)
- createSlLimitOrder: Will return null (expected - conditional orders not supported)

On Binance Production (mainnet):
- createTpLimitOrder: Will use TAKE_PROFIT order if supported, LIMIT as fallback
- createSlLimitOrder: Will use STOP_MARKET order if supported, return null as fallback

For Stop Loss on testnet:
- PositionMonitor should monitor price via WebSocket
- When price hits SL level, place MARKET order to close
`);
    
    console.log('═'.repeat(60));
    console.log('TEST COMPLETED');
    console.log('═'.repeat(60));
    
    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error);
    if (error.stack) {
      console.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run test
testTpSlService();
