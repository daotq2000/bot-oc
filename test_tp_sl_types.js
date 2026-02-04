import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Test script to test different TP/SL order types on Binance
 * This script will:
 * 1. Test different endpoints for conditional orders
 * 2. Test LIMIT orders as alternative for TP
 * 3. Report which types are supported
 * 
 * NOTE: Binance Futures has moved conditional orders (STOP, TAKE_PROFIT, etc.) 
 * to the Algo Order API endpoints since approximately 2024-2025.
 * Error -4120 indicates: "Order type not supported for this endpoint. 
 * Please use the Algo Order API endpoints instead."
 * 
 * Possible endpoints:
 * - /fapi/v1/order (standard orders: LIMIT, MARKET)
 * - /fapi/v1/conditional/order (conditional orders - may require different params)
 * - /fapi/v1/algo/futures/newOrder (algo/conditional orders)
 * 
 * Usage: node test_tp_sl_types.js [strategy_id]
 */

const SUPPORTED_ORDER_TYPES = [];
const FAILED_ORDER_TYPES = [];

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testOrderWithEndpoint(binanceClient, endpoint, testConfig) {
  const { name, params, description } = testConfig;
  
  console.log(`\n${'='.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Description: ${description}`);
  console.log(`Parameters:`, JSON.stringify(params, null, 2));
  
  try {
    const data = await binanceClient.makeRequestWithRetry(endpoint, 'POST', params, true);
    
    if (data && (data.orderId || data.clientAlgoId || data.strategyId)) {
      const orderId = data.orderId || data.clientAlgoId || data.strategyId;
      console.log(`✅ SUCCESS: Order ID: ${orderId}`);
      console.log(`Response:`, JSON.stringify(data, null, 2));
      SUPPORTED_ORDER_TYPES.push({ name, endpoint, orderId, status: data.status, data });
      return data;
    } else {
      console.log(`❌ FAILED: No orderId in response`);
      console.log(`Response:`, JSON.stringify(data, null, 2));
      FAILED_ORDER_TYPES.push({ name, endpoint, error: 'No orderId in response', response: data });
      return null;
    }
  } catch (error) {
    const errorMsg = error?.message || String(error);
    const errorCode = error?.code || 'unknown';
    console.log(`❌ FAILED: ${errorCode} - ${errorMsg}`);
    FAILED_ORDER_TYPES.push({ name, endpoint, error: errorMsg, code: errorCode });
    return null;
  }
}

async function cancelOrder(binanceClient, symbol, orderId, endpoint = '/fapi/v1/order') {
  try {
    console.log(`Canceling order ${orderId} via ${endpoint}...`);
    const params = { symbol, orderId };
    const result = await binanceClient.makeRequestWithRetry(endpoint, 'DELETE', params, true);
    console.log(`Order ${orderId} canceled:`, result?.status || 'success');
    return true;
  } catch (error) {
    console.log(`Failed to cancel order ${orderId}:`, error?.message || error);
    return false;
  }
}

async function testTpSlTypes() {
  try {
    // Get strategy ID from command line or use first active strategy
    const strategyId = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    console.log('='.repeat(60));
    console.log('=== Test TP/SL Order Types on Binance Futures ===');
    console.log('='.repeat(60));
    
    // 1. Get strategy
    let strategy;
    if (strategyId) {
      strategy = await Strategy.findById(strategyId);
      if (!strategy) {
        console.error(`Strategy ${strategyId} not found`);
        process.exit(1);
      }
    } else {
      // Get first active USDT strategy, prefer BTCUSDT or ETHUSDT
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
    
    if (bot.exchange !== 'binance') {
      console.error(`This test only works with Binance exchange. Bot ${bot.id} uses ${bot.exchange}`);
      process.exit(1);
    }
    
    console.log(`\nBot: ${bot.bot_name} (${bot.exchange})`);
    console.log(`Symbol: ${strategy.symbol}`);
    console.log(`Is Testnet: ${bot.testnet ? 'YES' : 'NO'}`);
    
    // 3. Initialize services
    console.log('\nInitializing services...');
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    const binanceClient = exchangeService.binanceDirectClient;
    if (!binanceClient) {
      throw new Error('BinanceDirectClient not initialized');
    }
    
    console.log(`Base URL (Trading): ${binanceClient.baseURL}`);
    console.log(`Production URL: ${binanceClient.productionDataURL}`);
    
    // IMPORTANT: Test if testnet supports conditional orders
    // Binance testnet may have different API support than production
    if (binanceClient.isTestnet) {
      console.log('\n⚠️ WARNING: Running on TESTNET');
      console.log('   Testnet may NOT support all order types that production supports.');
      console.log('   Error -4120 on testnet may be due to testnet limitations, not API changes.');
    }
    
    // 4. Get current market info
    const symbol = binanceClient.normalizeSymbol(strategy.symbol);
    console.log(`Normalized symbol: ${symbol}`);
    
    const [currentPrice, tickSize, stepSize, dualSide] = await Promise.all([
      binanceClient.getPrice(symbol),
      binanceClient.getTickSize(symbol),
      binanceClient.getStepSize(symbol),
      binanceClient.getDualSidePosition()
    ]);
    
    console.log(`\nMarket Info:`);
    console.log(`  Current Price: ${currentPrice}`);
    console.log(`  Tick Size: ${tickSize}`);
    console.log(`  Step Size: ${stepSize}`);
    console.log(`  Dual Side Position (Hedge Mode): ${dualSide}`);
    
    // 5. Calculate test prices
    // For LONG position testing:
    const longEntryPrice = currentPrice;
    const longTpPrice = currentPrice * 1.02; // 2% above entry
    const longSlPrice = currentPrice * 0.98; // 2% below entry
    
    // Format prices and quantity
    const formattedTpPrice = binanceClient.formatPrice(longTpPrice, tickSize);
    const formattedSlPrice = binanceClient.formatPrice(longSlPrice, tickSize);
    
    // Use minimum tradeable quantity (for low-risk testing)
    const minQty = parseFloat(stepSize);
    const testQuantity = binanceClient.formatQuantity(Math.max(minQty * 10, strategy.amount / currentPrice), stepSize);
    
    console.log(`\nTest Parameters (for LONG position simulation):`);
    console.log(`  Entry Price: ${longEntryPrice}`);
    console.log(`  TP Price: ${formattedTpPrice} (2% above entry)`);
    console.log(`  SL Price: ${formattedSlPrice} (2% below entry)`);
    console.log(`  Test Quantity: ${testQuantity}`);
    
    // 6. Test different order types
    console.log('\n' + '='.repeat(60));
    console.log('PART 1: Testing LIMIT orders on /fapi/v1/order');
    console.log('(LIMIT orders can be used as TP/SL alternatives)');
    console.log('='.repeat(60));
    
    const baseParams = {
      symbol: symbol,
    };
    
    if (dualSide) {
      baseParams.positionSide = 'LONG';
    }
    
    const createdOrders = [];
    
    // Test 1: LIMIT order (can be used as TP)
    const limitTpTest = {
      name: 'LIMIT order (as TP alternative)',
      description: 'LIMIT order placed above current price - can act as TP when closing a LONG position',
      params: {
        ...baseParams,
        side: 'SELL',
        type: 'LIMIT',
        price: formattedTpPrice,
        quantity: testQuantity,
        timeInForce: 'GTC'
      }
    };
    
    let result = await testOrderWithEndpoint(binanceClient, '/fapi/v1/order', limitTpTest);
    if (result?.orderId) {
      createdOrders.push({ orderId: result.orderId, symbol, endpoint: '/fapi/v1/order' });
    }
    await delay(500);
    
    // Test 2: MARKET order (check basic order functionality)
    console.log('\n' + '='.repeat(60));
    console.log('PART 2: Testing MARKET orders');
    console.log('='.repeat(60));
    
    // Skip market order test as it will immediately execute
    console.log('Skipping MARKET order test (would immediately execute)');
    
    // Test 3: Standard order endpoint with conditional types
    console.log('\n' + '='.repeat(60));
    console.log('PART 3: Testing conditional orders on /fapi/v1/order');
    console.log('='.repeat(60));
    
    const conditionalTests = [
      {
        name: 'TAKE_PROFIT on /fapi/v1/order',
        description: 'Standard TAKE_PROFIT order',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'TAKE_PROFIT',
          stopPrice: formattedTpPrice,
          price: formattedTpPrice,
          quantity: testQuantity,
          timeInForce: 'GTC'
        }
      },
      {
        name: 'TAKE_PROFIT_MARKET on /fapi/v1/order',
        description: 'TAKE_PROFIT_MARKET order',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: formattedTpPrice,
          quantity: testQuantity,
        }
      },
      {
        name: 'STOP_MARKET on /fapi/v1/order',
        description: 'STOP_MARKET order (Stop Loss)',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'STOP_MARKET',
          stopPrice: formattedSlPrice,
          quantity: testQuantity,
        }
      },
      {
        name: 'STOP on /fapi/v1/order',
        description: 'STOP (Stop Limit) order',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'STOP',
          stopPrice: formattedSlPrice,
          price: formattedSlPrice,
          quantity: testQuantity,
          timeInForce: 'GTC'
        }
      },
    ];
    
    for (const test of conditionalTests) {
      result = await testOrderWithEndpoint(binanceClient, '/fapi/v1/order', test);
      if (result?.orderId) {
        createdOrders.push({ orderId: result.orderId, symbol, endpoint: '/fapi/v1/order' });
      }
      await delay(500);
    }
    
    // Test 4: Try conditional order endpoint (if exists)
    console.log('\n' + '='.repeat(60));
    console.log('PART 4: Testing /fapi/v1/conditional/order endpoint');
    console.log('='.repeat(60));
    
    const conditionalEndpointTests = [
      {
        name: 'TAKE_PROFIT_MARKET on /fapi/v1/conditional/order',
        description: 'Conditional endpoint for TP',
        params: {
          ...baseParams,
          side: 'SELL',
          strategyType: 'TAKE_PROFIT_MARKET',
          stopPrice: formattedTpPrice,
          quantity: testQuantity,
          workingType: 'MARK_PRICE'
        }
      },
      {
        name: 'STOP_MARKET on /fapi/v1/conditional/order',
        description: 'Conditional endpoint for SL',
        params: {
          ...baseParams,
          side: 'SELL',
          strategyType: 'STOP_MARKET',
          stopPrice: formattedSlPrice,
          quantity: testQuantity,
          workingType: 'MARK_PRICE'
        }
      },
    ];
    
    for (const test of conditionalEndpointTests) {
      result = await testOrderWithEndpoint(binanceClient, '/fapi/v1/conditional/order', test);
      if (result?.orderId || result?.strategyId) {
        createdOrders.push({ orderId: result.orderId || result.strategyId, symbol, endpoint: '/fapi/v1/conditional/order' });
      }
      await delay(500);
    }
    
    // Test 5: Try algo order endpoint
    console.log('\n' + '='.repeat(60));
    console.log('PART 5: Testing /fapi/v1/algo/futures/newOrder endpoint');
    console.log('='.repeat(60));
    
    const algoEndpointTests = [
      {
        name: 'Algo TAKE_PROFIT_MARKET',
        description: 'Algo endpoint for TP',
        params: {
          ...baseParams,
          side: 'SELL',
          strategyType: 'TAKE_PROFIT_MARKET',
          stopPrice: formattedTpPrice,
          quantity: testQuantity,
        }
      },
    ];
    
    for (const test of algoEndpointTests) {
      result = await testOrderWithEndpoint(binanceClient, '/fapi/v1/algo/futures/newOrder', test);
      if (result?.orderId || result?.clientAlgoId) {
        createdOrders.push({ orderId: result.orderId || result.clientAlgoId, symbol, endpoint: '/fapi/v1/algo/futures/newOrder' });
      }
      await delay(500);
    }
    
    // Test 6: Test with strategyType parameter on standard endpoint
    console.log('\n' + '='.repeat(60));
    console.log('PART 6: Testing with strategyType parameter');
    console.log('='.repeat(60));
    
    const strategyTypeTests = [
      {
        name: 'TAKE_PROFIT_MARKET with strategyType on /fapi/v1/order',
        description: 'Using strategyType=tp',
        params: {
          ...baseParams,
          side: 'SELL',
          type: 'TAKE_PROFIT_MARKET',
          stopPrice: formattedTpPrice,
          quantity: testQuantity,
          strategyType: 'tp'
        }
      },
    ];
    
    for (const test of strategyTypeTests) {
      result = await testOrderWithEndpoint(binanceClient, '/fapi/v1/order', test);
      if (result?.orderId) {
        createdOrders.push({ orderId: result.orderId, symbol, endpoint: '/fapi/v1/order' });
      }
      await delay(500);
    }
    
    // Cancel all created orders
    console.log('\n' + '='.repeat(60));
    console.log('CLEANING UP - Canceling test orders');
    console.log('='.repeat(60));
    
    for (const order of createdOrders) {
      await cancelOrder(binanceClient, order.symbol, order.orderId, order.endpoint);
      await delay(200);
    }
    
    // 7. Print summary
    console.log('\n' + '='.repeat(60));
    console.log('SUMMARY');
    console.log('='.repeat(60));
    
    console.log('\n✅ SUPPORTED ORDER TYPES:');
    if (SUPPORTED_ORDER_TYPES.length === 0) {
      console.log('  None - all order types failed');
    } else {
      SUPPORTED_ORDER_TYPES.forEach((item, idx) => {
        console.log(`  ${idx + 1}. ${item.name}`);
        console.log(`      Endpoint: ${item.endpoint}`);
        console.log(`      Order ID: ${item.orderId}, Status: ${item.status}`);
      });
    }
    
    console.log('\n❌ FAILED ORDER TYPES:');
    if (FAILED_ORDER_TYPES.length === 0) {
      console.log('  None - all order types succeeded');
    } else {
      FAILED_ORDER_TYPES.forEach((item, idx) => {
        console.log(`  ${idx + 1}. ${item.name}`);
        console.log(`      Endpoint: ${item.endpoint}`);
        console.log(`      Error: ${item.error}`);
        if (item.code) console.log(`      Code: ${item.code}`);
      });
    }
    
    // 8. Recommendations
    console.log('\n' + '='.repeat(60));
    console.log('RECOMMENDATIONS');
    console.log('='.repeat(60));
    
    const supportedTp = SUPPORTED_ORDER_TYPES.filter(t => 
      t.name.includes('TAKE_PROFIT') || t.name.includes('LIMIT')
    );
    const supportedSl = SUPPORTED_ORDER_TYPES.filter(t => 
      t.name.includes('STOP') && !t.name.includes('TAKE_PROFIT')
    );
    
    if (supportedTp.length > 0) {
      console.log('\nFor Take Profit orders, use:');
      supportedTp.forEach(t => console.log(`  - ${t.name} (${t.endpoint})`));
    } else {
      console.log('\n⚠️ No Take Profit conditional order types are supported!');
      console.log('   SOLUTION: Use LIMIT orders as TP alternative:');
      console.log('   - Place SELL LIMIT order above entry for LONG positions');
      console.log('   - Place BUY LIMIT order below entry for SHORT positions');
    }
    
    if (supportedSl.length > 0) {
      console.log('\nFor Stop Loss orders, use:');
      supportedSl.forEach(t => console.log(`  - ${t.name} (${t.endpoint})`));
    } else {
      console.log('\n⚠️ No Stop Loss conditional order types are supported!');
      console.log('   SOLUTION: Implement software-based stop loss:');
      console.log('   - Monitor price via WebSocket');
      console.log('   - Place MARKET order when price hits SL level');
    }
    
    console.log('\n' + '='.repeat(60));
    console.log('TEST COMPLETED');
    console.log('='.repeat(60));
    
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
testTpSlTypes();
