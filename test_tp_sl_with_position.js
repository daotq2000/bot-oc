import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Test script that:
 * 1. Opens a small MARKET position
 * 2. Tries to create TP order with different types
 * 3. Tries to create SL order with different types
 * 4. Closes the position
 * 
 * This tests REAL order placement on testnet with an open position.
 * 
 * Usage: node test_tp_sl_with_position.js [strategy_id]
 */

const SUPPORTED_TP_TYPES = [];
const FAILED_TP_TYPES = [];
const SUPPORTED_SL_TYPES = [];
const FAILED_SL_TYPES = [];

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testOrderType(binanceClient, endpoint, testConfig, orderCategory) {
  const { name, params, description } = testConfig;
  
  console.log(`\n${'─'.repeat(50)}`);
  console.log(`Testing: ${name}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Parameters:`, JSON.stringify(params, null, 2));
  
  try {
    const data = await binanceClient.makeRequestWithRetry(endpoint, 'POST', params, true);
    
    if (data && data.orderId) {
      console.log(`✅ SUCCESS: Order ID: ${data.orderId}`);
      console.log(`Response:`, JSON.stringify(data, null, 2));
      
      if (orderCategory === 'TP') {
        SUPPORTED_TP_TYPES.push({ name, endpoint, orderId: data.orderId, status: data.status });
      } else {
        SUPPORTED_SL_TYPES.push({ name, endpoint, orderId: data.orderId, status: data.status });
      }
      return data;
    } else {
      console.log(`❌ FAILED: No orderId in response`);
      console.log(`Response:`, JSON.stringify(data, null, 2));
      
      if (orderCategory === 'TP') {
        FAILED_TP_TYPES.push({ name, endpoint, error: 'No orderId in response', response: data });
      } else {
        FAILED_SL_TYPES.push({ name, endpoint, error: 'No orderId in response', response: data });
      }
      return null;
    }
  } catch (error) {
    const errorMsg = error?.message || String(error);
    const errorCode = error?.code || 'unknown';
    console.log(`❌ FAILED: ${errorCode} - ${errorMsg}`);
    
    if (orderCategory === 'TP') {
      FAILED_TP_TYPES.push({ name, endpoint, error: errorMsg, code: errorCode });
    } else {
      FAILED_SL_TYPES.push({ name, endpoint, error: errorMsg, code: errorCode });
    }
    return null;
  }
}

async function cancelOrder(binanceClient, symbol, orderId) {
  try {
    console.log(`Canceling order ${orderId}...`);
    const params = { symbol, orderId };
    const result = await binanceClient.makeRequestWithRetry('/fapi/v1/order', 'DELETE', params, true);
    console.log(`Order ${orderId} canceled:`, result?.status || 'success');
    return true;
  } catch (error) {
    console.log(`Failed to cancel order ${orderId}:`, error?.message || error);
    return false;
  }
}

async function testWithPosition() {
  try {
    const strategyId = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    console.log('═'.repeat(60));
    console.log('=== Test TP/SL With REAL Position ===');
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
    
    // Calculate test quantity (minimum $100 notional required on Binance Futures)
    // For BTCUSDT at ~$76k, we need at least 0.002 BTC ($152)
    const minNotionalQty = 1005 / currentPrice; // $105 to have margin
    const stepSizeNum = parseFloat(stepSize);
    
    // Round UP to step size
    let testQuantity = Math.ceil(minNotionalQty / stepSizeNum) * stepSizeNum;
    
    // Format with correct precision
    const precision = stepSize.includes('.') ? stepSize.split('.')[1].length : 0;
    testQuantity = testQuantity.toFixed(precision);
    
    // Debug: verify notional
    const actualNotional = parseFloat(testQuantity) * currentPrice;
    console.log(`Test Quantity: ${testQuantity}`);
    console.log(`Notional Value: $${actualNotional.toFixed(2)} (minimum required: $100)`);
    
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
    console.log(`Status: ${entryOrder.status}`);
    console.log(`Avg Price: ${entryOrder.avgPrice || 'N/A'}`);
    
    // Wait a moment for position to settle
    await delay(1000);
    
    // Get actual entry price
    const actualEntryPrice = parseFloat(entryOrder.avgPrice) || currentPrice;
    
    // Calculate TP and SL prices
    const tpPrice = binanceClient.formatPrice(actualEntryPrice * 1.01, tickSize); // 1% above entry
    const slPrice = binanceClient.formatPrice(actualEntryPrice * 0.99, tickSize); // 1% below entry
    
    console.log(`\nEntry Price: ${actualEntryPrice}`);
    console.log(`TP Price: ${tpPrice} (1% above)`);
    console.log(`SL Price: ${slPrice} (1% below)`);
    
    // 6. Test TP order types
    console.log('\n' + '═'.repeat(60));
    console.log('STEP 2: Testing TP order types');
    console.log('═'.repeat(60));
    
    const baseParams = { symbol };
    if (dualSide) {
      baseParams.positionSide = 'LONG';
    }
    
    const createdOrders = [];
    
    const tpTests = [
      {
        name: 'LIMIT (as TP)',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'LIMIT',
          price: tpPrice,
          quantity: testQuantity,
          timeInForce: 'GTC'
        }
      },
      {
        name: 'TAKE_PROFIT',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'TAKE_PROFIT',
          stopPrice: tpPrice,
          price: tpPrice,
          quantity: testQuantity,
          timeInForce: 'GTC'
        }
      },
      {
        name: 'TAKE_PROFIT_MARKET',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: tpPrice,
          quantity: testQuantity,
        }
      },
      {
        name: 'TAKE_PROFIT_MARKET with closePosition',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: tpPrice,
          closePosition: 'true',
        }
      },
    ];
    
    for (const test of tpTests) {
      const result = await testOrderType(binanceClient, '/fapi/v1/order', test, 'TP');
      if (result?.orderId) {
        createdOrders.push({ orderId: result.orderId, symbol });
        // Cancel immediately to test next type
        await cancelOrder(binanceClient, symbol, result.orderId);
      }
      await delay(300);
    }
    
    // 7. Test SL order types
    console.log('\n' + '═'.repeat(60));
    console.log('STEP 3: Testing SL order types');
    console.log('═'.repeat(60));
    
    const slTests = [
      {
        name: 'STOP_MARKET',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'STOP_MARKET',
          stopPrice: slPrice,
          quantity: testQuantity,
        }
      },
      {
        name: 'STOP_MARKET with closePosition',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'STOP_MARKET',
          stopPrice: slPrice,
          closePosition: 'true',
        }
      },
      {
        name: 'STOP (stop-limit)',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'STOP',
          stopPrice: slPrice,
          price: slPrice,
          quantity: testQuantity,
          timeInForce: 'GTC'
        }
      },
    ];
    
    for (const test of slTests) {
      const result = await testOrderType(binanceClient, '/fapi/v1/order', test, 'SL');
      if (result?.orderId) {
        createdOrders.push({ orderId: result.orderId, symbol });
        // Cancel immediately
        await cancelOrder(binanceClient, symbol, result.orderId);
      }
      await delay(300);
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
      console.log('Position may already be closed or cancelled');
    }
    
    // 9. Summary
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    
    console.log('\n✅ SUPPORTED TP TYPES:');
    if (SUPPORTED_TP_TYPES.length === 0) {
      console.log('  None - all TP types failed');
    } else {
      SUPPORTED_TP_TYPES.forEach((item, idx) => {
        console.log(`  ${idx + 1}. ${item.name} (Order ID: ${item.orderId})`);
      });
    }
    
    console.log('\n❌ FAILED TP TYPES:');
    FAILED_TP_TYPES.forEach((item, idx) => {
      console.log(`  ${idx + 1}. ${item.name}`);
      console.log(`      Error: ${item.error}`);
    });
    
    console.log('\n✅ SUPPORTED SL TYPES:');
    if (SUPPORTED_SL_TYPES.length === 0) {
      console.log('  None - all SL types failed');
    } else {
      SUPPORTED_SL_TYPES.forEach((item, idx) => {
        console.log(`  ${idx + 1}. ${item.name} (Order ID: ${item.orderId})`);
      });
    }
    
    console.log('\n❌ FAILED SL TYPES:');
    FAILED_SL_TYPES.forEach((item, idx) => {
      console.log(`  ${idx + 1}. ${item.name}`);
      console.log(`      Error: ${item.error}`);
    });
    
    // 10. Recommendations
    console.log('\n' + '═'.repeat(60));
    console.log('RECOMMENDATIONS FOR CODE FIX');
    console.log('═'.repeat(60));
    
    if (SUPPORTED_TP_TYPES.length > 0) {
      const bestTp = SUPPORTED_TP_TYPES[0];
      console.log(`\n✅ For TP orders, use: ${bestTp.name}`);
    } else {
      console.log('\n⚠️ All TP types failed on testnet!');
      console.log('   This might be a TESTNET limitation.');
      console.log('   On PRODUCTION, TAKE_PROFIT_MARKET should work.');
      console.log('   As fallback, use LIMIT orders for TP.');
    }
    
    if (SUPPORTED_SL_TYPES.length > 0) {
      const bestSl = SUPPORTED_SL_TYPES[0];
      console.log(`\n✅ For SL orders, use: ${bestSl.name}`);
    } else {
      console.log('\n⚠️ All SL types failed on testnet!');
      console.log('   This might be a TESTNET limitation.');
      console.log('   On PRODUCTION, STOP_MARKET should work.');
      console.log('   As fallback, implement software-based SL monitoring.');
    }
    
    console.log('\n' + '═'.repeat(60));
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
testWithPosition();
