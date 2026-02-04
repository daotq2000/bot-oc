import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Test ALL possible SL order methods on Binance Testnet
 * Including different endpoints and parameter combinations
 * 
 * Usage: node test_all_sl_methods.js [strategy_id]
 */

const RESULTS = [];

async function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function testOrder(binanceClient, name, endpoint, params) {
  console.log(`\n${'─'.repeat(60)}`);
  console.log(`Testing: ${name}`);
  console.log(`Endpoint: ${endpoint}`);
  console.log(`Params:`, JSON.stringify(params, null, 2));
  
  try {
    const data = await binanceClient.makeRequestWithRetry(endpoint, 'POST', params, true);
    
    if (data && data.orderId) {
      console.log(`✅ SUCCESS! Order ID: ${data.orderId}, Status: ${data.status}`);
      RESULTS.push({ name, endpoint, success: true, orderId: data.orderId, status: data.status });
      return data;
    } else {
      console.log(`⚠️ No orderId:`, JSON.stringify(data, null, 2));
      RESULTS.push({ name, endpoint, success: false, error: 'No orderId', response: data });
      return null;
    }
  } catch (error) {
    const msg = error?.message || String(error);
    const code = error?.code || 'unknown';
    console.log(`❌ FAILED: [${code}] ${msg.substring(0, 100)}`);
    RESULTS.push({ name, endpoint, success: false, error: msg, code });
    return null;
  }
}

async function main() {
  try {
    const strategyId = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    console.log('═'.repeat(60));
    console.log('=== Test ALL SL Methods on Binance ===');
    console.log('═'.repeat(60));
    
    // Get strategy and bot
    let strategy;
    if (strategyId) {
      strategy = await Strategy.findById(strategyId);
    } else {
      const strategies = await Strategy.findAll(null, true);
      strategy = strategies.find(s => s.symbol === 'BTCUSDT' || s.symbol === 'BTC/USDT') ||
                 strategies.find(s => s.symbol === 'ETHUSDT' || s.symbol === 'ETH/USDT') ||
                 strategies[0];
    }
    
    if (!strategy) {
      console.error('No strategy found');
      process.exit(1);
    }
    
    const bot = await Bot.findById(strategy.bot_id);
    console.log(`\nBot: ${bot.bot_name} | Symbol: ${strategy.symbol}`);
    
    // Initialize
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    const binanceClient = exchangeService.binanceDirectClient;
    const symbol = binanceClient.normalizeSymbol(strategy.symbol);
    
    const [currentPrice, tickSize, stepSize, dualSide] = await Promise.all([
      binanceClient.getPrice(symbol),
      binanceClient.getTickSize(symbol),
      binanceClient.getStepSize(symbol),
      binanceClient.getDualSidePosition()
    ]);
    
    console.log(`\nCurrent Price: ${currentPrice}`);
    console.log(`Hedge Mode: ${dualSide}`);
    
    // Calculate quantities
    const minNotionalQty = 105 / currentPrice;
    const stepSizeNum = parseFloat(stepSize);
    let qty = Math.ceil(minNotionalQty / stepSizeNum) * stepSizeNum;
    const precision = stepSize.includes('.') ? stepSize.split('.')[1].length : 0;
    qty = qty.toFixed(precision);
    
    // SL price (2% below current for LONG)
    const slPrice = binanceClient.formatPrice(currentPrice * 0.98, tickSize);
    
    console.log(`Quantity: ${qty}`);
    console.log(`SL Price: ${slPrice} (2% below current)`);
    
    // Open LONG position first
    console.log('\n' + '═'.repeat(60));
    console.log('Opening LONG position...');
    console.log('═'.repeat(60));
    
    const entryParams = {
      symbol,
      side: 'BUY',
      type: 'MARKET',
      quantity: qty
    };
    if (dualSide) entryParams.positionSide = 'LONG';
    
    const entryOrder = await binanceClient.makeRequestWithRetry('/fapi/v1/order', 'POST', entryParams, true);
    if (!entryOrder?.orderId) {
      console.error('Failed to open position');
      process.exit(1);
    }
    console.log(`✅ Position opened! Order ID: ${entryOrder.orderId}`);
    
    await delay(1000);
    
    // Base params for SL orders
    const baseParams = { symbol };
    if (dualSide) baseParams.positionSide = 'LONG';
    
    // ═══════════════════════════════════════════════════════════
    // TEST ALL POSSIBLE SL METHODS
    // ═══════════════════════════════════════════════════════════
    
    console.log('\n' + '═'.repeat(60));
    console.log('Testing ALL possible SL order methods...');
    console.log('═'.repeat(60));
    
    const createdOrders = [];
    
    // 1. Standard endpoint - STOP_MARKET
    let result = await testOrder(binanceClient, 
      '1. STOP_MARKET on /fapi/v1/order',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'STOP_MARKET', stopPrice: slPrice, quantity: qty }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 2. STOP_MARKET with closePosition
    result = await testOrder(binanceClient,
      '2. STOP_MARKET with closePosition',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'STOP_MARKET', stopPrice: slPrice, closePosition: 'true' }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 3. STOP (stop-limit)
    result = await testOrder(binanceClient,
      '3. STOP (stop-limit) on /fapi/v1/order',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'STOP', stopPrice: slPrice, price: slPrice, quantity: qty, timeInForce: 'GTC' }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 4. STOP with workingType MARK_PRICE
    result = await testOrder(binanceClient,
      '4. STOP with workingType=MARK_PRICE',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'STOP', stopPrice: slPrice, price: slPrice, quantity: qty, timeInForce: 'GTC', workingType: 'MARK_PRICE' }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 5. STOP_MARKET with workingType
    result = await testOrder(binanceClient,
      '5. STOP_MARKET with workingType=MARK_PRICE',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'STOP_MARKET', stopPrice: slPrice, quantity: qty, workingType: 'MARK_PRICE' }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 6. Try /fapi/v1/order with priceProtect
    result = await testOrder(binanceClient,
      '6. STOP_MARKET with priceProtect=true',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'STOP_MARKET', stopPrice: slPrice, quantity: qty, priceProtect: 'true' }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 7. Try batch orders endpoint
    result = await testOrder(binanceClient,
      '7. STOP_MARKET via /fapi/v1/batchOrders',
      '/fapi/v1/batchOrders',
      { batchOrders: JSON.stringify([{ ...baseParams, side: 'SELL', type: 'STOP_MARKET', stopPrice: slPrice, quantity: qty }]) }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 8. Try with reduceOnly (may work differently)
    result = await testOrder(binanceClient,
      '8. STOP_MARKET with reduceOnly (one-way mode param)',
      '/fapi/v1/order',
      { symbol, side: 'SELL', type: 'STOP_MARKET', stopPrice: slPrice, quantity: qty, reduceOnly: 'true' }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 9. TRAILING_STOP_MARKET
    result = await testOrder(binanceClient,
      '9. TRAILING_STOP_MARKET with callbackRate',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'TRAILING_STOP_MARKET', callbackRate: '1', quantity: qty }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 10. TRAILING_STOP_MARKET with activationPrice
    result = await testOrder(binanceClient,
      '10. TRAILING_STOP_MARKET with activationPrice',
      '/fapi/v1/order',
      { ...baseParams, side: 'SELL', type: 'TRAILING_STOP_MARKET', activationPrice: slPrice, callbackRate: '1', quantity: qty }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 11. Try conditional order endpoint (new Binance API?)
    result = await testOrder(binanceClient,
      '11. /fapi/v1/conditional/order endpoint',
      '/fapi/v1/conditional/order',
      { ...baseParams, side: 'SELL', strategyType: 'STOP_MARKET', stopPrice: slPrice, quantity: qty }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 12. Try /fapi/v2/order if exists
    result = await testOrder(binanceClient,
      '12. /fapi/v2/order endpoint',
      '/fapi/v2/order',
      { ...baseParams, side: 'SELL', type: 'STOP_MARKET', stopPrice: slPrice, quantity: qty }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // 13. Try algo endpoint
    result = await testOrder(binanceClient,
      '13. /fapi/v1/algo/futures/newOrderTwap',
      '/fapi/v1/algo/futures/newOrderTwap',
      { ...baseParams, side: 'SELL', quantity: qty, duration: 300 }
    );
    if (result?.orderId) createdOrders.push(result.orderId);
    await delay(300);
    
    // Cancel created orders
    console.log('\n' + '═'.repeat(60));
    console.log('Cleaning up orders...');
    console.log('═'.repeat(60));
    
    for (const orderId of createdOrders) {
      try {
        await binanceClient.cancelOrder(symbol, orderId);
        console.log(`Canceled order ${orderId}`);
      } catch (e) {
        console.log(`Failed to cancel ${orderId}: ${e?.message}`);
      }
      await delay(200);
    }
    
    // Close position
    console.log('\nClosing position...');
    const closeParams = { symbol, side: 'SELL', type: 'MARKET', quantity: qty };
    if (dualSide) closeParams.positionSide = 'LONG';
    
    try {
      await binanceClient.makeRequestWithRetry('/fapi/v1/order', 'POST', closeParams, true);
      console.log('✅ Position closed');
    } catch (e) {
      console.log(`⚠️ Failed to close: ${e?.message}`);
    }
    
    // Summary
    console.log('\n' + '═'.repeat(60));
    console.log('SUMMARY');
    console.log('═'.repeat(60));
    
    const successful = RESULTS.filter(r => r.success);
    const failed = RESULTS.filter(r => !r.success);
    
    console.log('\n✅ SUCCESSFUL METHODS:');
    if (successful.length === 0) {
      console.log('  None - all SL methods failed on testnet');
    } else {
      successful.forEach(r => {
        console.log(`  - ${r.name}`);
        console.log(`    Endpoint: ${r.endpoint}`);
        console.log(`    Order ID: ${r.orderId}`);
      });
    }
    
    console.log('\n❌ FAILED METHODS:');
    failed.forEach(r => {
      console.log(`  - ${r.name}: [${r.code}] ${r.error?.substring(0, 60)}...`);
    });
    
    console.log('\n' + '═'.repeat(60));
    console.log('CONCLUSION');
    console.log('═'.repeat(60));
    
    if (successful.length > 0) {
      console.log('\n🎉 Found working SL method(s)! Use these in production.');
    } else {
      console.log(`
⚠️ NO exchange-level SL orders work on Binance Testnet!

This is a TESTNET LIMITATION. On production (mainnet), STOP_MARKET 
should work normally.

For testnet, you must use SOFTWARE-BASED SL:
1. Monitor price via WebSocket
2. When price hits SL level, place MARKET order to close
3. This is what SoftwareStopLossService does

The MARKET order in software SL is intentional - it only executes
AFTER the price has already hit the SL level.
`);
    }
    
    process.exit(0);
  } catch (error) {
    console.error('Test failed:', error);
    process.exit(1);
  }
}

main();
