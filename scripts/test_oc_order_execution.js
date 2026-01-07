import { realtimeOCDetector } from '../src/services/RealtimeOCDetector.js';
import { strategyCache } from '../src/services/StrategyCache.js';
import { webSocketOCConsumer } from '../src/consumers/WebSocketOCConsumer.js';
import { OrderService } from '../src/services/OrderService.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import logger from '../src/utils/logger.js';
import { configService } from '../src/services/ConfigService.js';

/**
 * Test script to simulate OC=5% and test order execution
 * 
 * Flow:
 * 1. Find or create a test strategy with OC=3% for Binance
 * 2. Initialize OrderService with test bot
 * 3. Simulate price tick with OC=5% (vượt threshold 3%)
 * 4. Verify order is created
 */

const TEST_SYMBOL = 'BTCUSDT';
const TEST_EXCHANGE = 'binance';
const TEST_OC_THRESHOLD = 3; // Strategy OC threshold
const TEST_SIMULATED_OC = 5; // Simulated OC percentage

async function findOrCreateTestStrategy() {
  try {
    logger.info(`[Test] Looking for test strategy: ${TEST_EXCHANGE} ${TEST_SYMBOL} OC=${TEST_OC_THRESHOLD}%`);
    
    // First refresh cache to see what's available
    await strategyCache.refresh();
    
    // Try to find strategy in cache first (more reliable)
    const cachedStrategies = strategyCache.getStrategies(TEST_EXCHANGE, TEST_SYMBOL);
    const testStrategyFromCache = cachedStrategies.find(s => 
      Number(s.oc) === TEST_OC_THRESHOLD &&
      (s.interval || '1m') === '1m' &&
      (s.is_active === true || s.is_active === 1)
    );
    
    if (testStrategyFromCache) {
      logger.info(`[Test] ✅ Found test strategy in cache: ID=${testStrategyFromCache.id}, bot_id=${testStrategyFromCache.bot_id}, symbol=${testStrategyFromCache.symbol}, oc=${testStrategyFromCache.oc}%`);
      return testStrategyFromCache;
    }
    
    // Fallback: Find from database
    const strategies = await Strategy.findAll(null, true);
    const testStrategy = strategies.find(s => {
      const symbolMatch = s.symbol?.toUpperCase().replace(/[\/:_]/g, '') === TEST_SYMBOL.toUpperCase();
      const ocMatch = Number(s.oc) === TEST_OC_THRESHOLD;
      const intervalMatch = (s.interval || '1m') === '1m';
      const activeMatch = s.is_active === true || s.is_active === 1;
      return symbolMatch && ocMatch && intervalMatch && activeMatch;
    });

    if (testStrategy) {
      logger.info(`[Test] ✅ Found existing test strategy from DB: ID=${testStrategy.id}, bot_id=${testStrategy.bot_id}, symbol=${testStrategy.symbol}, oc=${testStrategy.oc}%`);
      // Make sure it has exchange field
      if (!testStrategy.exchange) {
        const bot = await Bot.findById(testStrategy.bot_id);
        if (bot) {
          testStrategy.exchange = bot.exchange || TEST_EXCHANGE;
        }
      }
      return testStrategy;
    }

    // Create new test strategy
    logger.info(`[Test] Creating new test strategy...`);
    
    // Find an active bot for Binance (or any bot if none active)
    const bots = await Bot.findAll();
    let binanceBot = bots.find(b => 
      b.exchange?.toLowerCase() === TEST_EXCHANGE && 
      (b.is_active === true || b.is_active === 1)
    );
    
    // If no active bot, find any Binance bot
    if (!binanceBot) {
      binanceBot = bots.find(b => b.exchange?.toLowerCase() === TEST_EXCHANGE);
    }

    let binanceBotToUse = binanceBot;
    if (!binanceBotToUse) {
      logger.warn(`[Test] No active Binance bot found. Creating test bot...`);
      
      // Create test bot for Binance testnet
      // Note: Bot.create requires all fields, use empty strings for optional fields
      binanceBotToUse = await Bot.create({
        bot_name: 'Test Bot (Binance Testnet)',
        exchange: TEST_EXCHANGE,
        uid: '',
        access_key: process.env.BINANCE_TESTNET_API_KEY || '',
        secret_key: process.env.BINANCE_TESTNET_API_SECRET || '',
        proxy: '',
        telegram_chat_id: '',
        future_balance_target: 20.00,
        spot_transfer_threshold: 10.00,
        transfer_frequency: 15,
        withdraw_enabled: false,
        withdraw_address: '',
        withdraw_network: 'BEP20',
        spot_balance_threshold: 10.00,
        max_concurrent_trades: 5,
        telegram_alert_channel_id: '',
        binance_testnet: 1, // Use testnet
        concurrency_lock_timeout: null,
        is_active: true
      });
      
      logger.info(`[Test] ✅ Created test bot: ID=${binanceBotToUse.id}, name=${binanceBotToUse.name}`);
      logger.warn(`[Test] ⚠️ Please set BINANCE_TESTNET_API_KEY and BINANCE_TESTNET_API_SECRET environment variables for real trading`);
    } else {
      logger.info(`[Test] Using existing bot: ID=${binanceBotToUse.id}, name=${binanceBotToUse.name}`);
    }

    const newStrategy = await Strategy.create({
      bot_id: binanceBotToUse.id,
      symbol: TEST_SYMBOL,
      trade_type: 'both', // Allow both long and short
      interval: '1m',
      oc: TEST_OC_THRESHOLD,
      amount: 10, // Small amount for testing
      take_profit: 55,
      reduce: 10,
      up_reduce: 0, // Default value
      extend: 0,
      ignore: 0, // Default value
      is_active: true
    });
    
    // Update exchange field separately (if exists in DB)
    try {
      await Strategy.update(newStrategy.id, { exchange: TEST_EXCHANGE });
    } catch (e) {
      logger.warn(`[Test] Could not set exchange field: ${e?.message}`);
    }

    logger.info(`[Test] ✅ Created test strategy: ID=${newStrategy.id}`);
    return newStrategy;
  } catch (error) {
    logger.error(`[Test] Error finding/creating test strategy:`, error?.message || error);
    throw error;
  }
}

async function initializeOrderService(botId, telegramService) {
  try {
    logger.info(`[Test] Initializing OrderService for bot ${botId}...`);
    
    // Get bot
    const bot = await Bot.findById(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }

    // Initialize ExchangeService
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    logger.info(`[Test] ✅ ExchangeService initialized for ${bot.exchange}`);

    // Create OrderService (constructor takes exchangeService and telegramService)
    const orderService = new OrderService(exchangeService, telegramService || null);
    
    logger.info(`[Test] ✅ OrderService created`);

    return orderService;
  } catch (error) {
    logger.error(`[Test] Error initializing OrderService:`, error?.message || error);
    throw error;
  }
}

async function simulatePriceTick(strategy, simulatedOC) {
  try {
    logger.info(`[Test] Simulating price tick with OC=${simulatedOC}%...`);
    
    // Try to get current price from exchange (real price), but use fallback if fails
    let currentPrice = null;
    try {
      const bot = await Bot.findById(strategy.bot_id);
      const exchangeService = new ExchangeService(bot);
      await exchangeService.initialize();
      currentPrice = await exchangeService.getTickerPrice(TEST_SYMBOL);
    } catch (e) {
      logger.warn(`[Test] Failed to get price from exchange: ${e?.message}, using simulated price`);
    }
    
    // Fallback: Use a reasonable test price for BTCUSDT
    if (!currentPrice || !Number.isFinite(currentPrice) || currentPrice <= 0) {
      currentPrice = 86000; // Simulated BTC price for testing
      logger.info(`[Test] Using simulated current price: ${currentPrice}`);
    } else {
      logger.info(`[Test] Current price from exchange: ${currentPrice}`);
    }

    // Calculate open price to achieve desired OC
    // OC = ((currentPrice - openPrice) / openPrice) * 100
    // simulatedOC = ((currentPrice - openPrice) / openPrice) * 100
    // simulatedOC / 100 = (currentPrice - openPrice) / openPrice
    // simulatedOC / 100 = currentPrice/openPrice - 1
    // simulatedOC / 100 + 1 = currentPrice/openPrice
    // openPrice = currentPrice / (simulatedOC / 100 + 1)
    
    const openPrice = currentPrice / (simulatedOC / 100 + 1);
    
    logger.info(`[Test] Calculated open price: ${openPrice} (to achieve OC=${simulatedOC}%)`);
    logger.info(`[Test] Verification: OC = ((${currentPrice} - ${openPrice}) / ${openPrice}) * 100 = ${((currentPrice - openPrice) / openPrice * 100).toFixed(2)}%`);

    // Set open price in cache manually for the interval bucket
    const interval = strategy.interval || '1m';
    const timestamp = Date.now();
    const bucketStart = realtimeOCDetector.getBucketStart(interval, timestamp);
    const normalizedExchange = TEST_EXCHANGE.toLowerCase();
    const normalizedSymbol = TEST_SYMBOL.toUpperCase().replace(/[\/:_]/g, '');
    const cacheKey = `${normalizedExchange}|${normalizedSymbol}|${interval}|${bucketStart}`;
    
    // Manually set open price in cache
    realtimeOCDetector.openPriceCache.set(cacheKey, {
      open: openPrice,
      bucketStart: bucketStart,
      lastUpdate: timestamp
    });

    logger.info(`[Test] ✅ Set open price in cache: ${cacheKey} = ${openPrice}`);

    // Now simulate price tick with current price
    logger.info(`[Test] Simulating price tick: ${normalizedExchange} ${normalizedSymbol} @ ${currentPrice}`);
    
    return {
      exchange: normalizedExchange,
      symbol: normalizedSymbol,
      price: currentPrice,
      timestamp: timestamp,
      openPrice: openPrice,
      expectedOC: simulatedOC
    };
  } catch (error) {
    logger.error(`[Test] Error simulating price tick:`, error?.message || error);
    throw error;
  }
}

async function runTest() {
  try {
    logger.info('\n' + '='.repeat(60));
    logger.info('OC Order Execution Test');
    logger.info('='.repeat(60) + '\n');

    // Step 1: Find or create test strategy
    logger.info('Step 1: Finding/Creating test strategy...');
    const strategy = await findOrCreateTestStrategy();
    logger.info(`✅ Strategy: ID=${strategy.id}, symbol=${strategy.symbol}, oc=${strategy.oc}%, bot_id=${strategy.bot_id}\n`);

    // Step 2: Refresh strategy cache
    logger.info('Step 2: Refreshing strategy cache...');
    await strategyCache.refresh();
    logger.info(`✅ Strategy cache refreshed: ${strategyCache.size()} strategies\n`);

    // Verify strategy is in cache
    // StrategyCache uses exchange|symbol|oc|bot_id as key
    // Need to check if strategy has exchange field, if not, get from bot
    if (!strategy.exchange) {
      const bot = await Bot.findById(strategy.bot_id);
      if (bot) {
        strategy.exchange = bot.exchange || TEST_EXCHANGE;
        logger.info(`[Test] Strategy ${strategy.id} missing exchange field, using bot exchange: ${strategy.exchange}`);
      }
    }
    
    const cachedStrategies = strategyCache.getStrategies(strategy.exchange || TEST_EXCHANGE, TEST_SYMBOL);
    const testStrategyInCache = cachedStrategies.find(s => s.id === strategy.id);
    if (!testStrategyInCache) {
      logger.warn(`[Test] ⚠️ Strategy ${strategy.id} not found in cache by exchange=${strategy.exchange || TEST_EXCHANGE}, symbol=${TEST_SYMBOL}`);
      logger.warn(`[Test] Available strategies in cache for ${TEST_EXCHANGE} ${TEST_SYMBOL}: ${cachedStrategies.length}`);
      cachedStrategies.slice(0, 5).forEach(s => {
        logger.warn(`[Test]   - Strategy ${s.id}: oc=${s.oc}%, bot_id=${s.bot_id}, exchange=${s.exchange}`);
      });
      
      // Use matching strategy from cache instead (same bot_id and oc)
      const matchingStrategy = cachedStrategies.find(s => 
        Number(s.oc) === TEST_OC_THRESHOLD &&
        s.bot_id === strategy.bot_id
      );
      
      if (matchingStrategy) {
        logger.info(`[Test] ✅ Using matching strategy from cache: ID=${matchingStrategy.id} (instead of ${strategy.id})`);
        // Update strategy object to use cached version
        Object.assign(strategy, matchingStrategy);
      } else {
        logger.warn(`[Test] ⚠️ No matching strategy in cache, will use DB strategy ${strategy.id}`);
        logger.warn(`[Test] This may cause issues if strategy is not properly cached.`);
        // Continue anyway - strategy might work if exchange is set correctly
      }
    } else {
      logger.info(`✅ Test strategy found in cache: ${testStrategyInCache.id}\n`);
    }

    // Step 3: Initialize OrderService
    logger.info('Step 3: Initializing OrderService...');
    // Note: TelegramService not needed for test, pass null
    const orderService = await initializeOrderService(strategy.bot_id, null);
    logger.info(`✅ OrderService initialized\n`);

    // Step 4: Initialize WebSocketOCConsumer with OrderService
    logger.info('Step 4: Initializing WebSocketOCConsumer...');
    const orderServicesMap = new Map();
    orderServicesMap.set(strategy.bot_id, orderService);
    await webSocketOCConsumer.initialize(orderServicesMap);
    webSocketOCConsumer.start();
    logger.info(`✅ WebSocketOCConsumer initialized and started\n`);

    // Step 5: Simulate price tick
    logger.info('Step 5: Simulating price tick...');
    const tickData = await simulatePriceTick(strategy, TEST_SIMULATED_OC);
    logger.info(`✅ Price tick simulated\n`);

    // Step 6: Test RealtimeOCDetector directly
    logger.info('Step 6: Testing RealtimeOCDetector.detectOC()...');
    const matches = await realtimeOCDetector.detectOC(
      tickData.exchange,
      tickData.symbol,
      tickData.price,
      tickData.timestamp,
      'TestScript'
    );

    if (matches.length === 0) {
      logger.error(`❌ No matches found! Expected to find strategy ${strategy.id}`);
      logger.error(`   Exchange: ${tickData.exchange}, Symbol: ${tickData.symbol}, Price: ${tickData.price}`);
      logger.error(`   Open price in cache: ${tickData.openPrice}`);
      logger.error(`   Expected OC: ${tickData.expectedOC}%`);
      
      // Debug: Check what strategies are in cache
      const allStrategies = strategyCache.getStrategies(tickData.exchange, tickData.symbol);
      logger.error(`   Strategies in cache for ${tickData.exchange} ${tickData.symbol}: ${allStrategies.length}`);
      allStrategies.forEach(s => {
        logger.error(`     - Strategy ${s.id}: oc=${s.oc}%, interval=${s.interval}, bot_id=${s.bot_id}`);
      });
      
      process.exit(1);
    }

    logger.info(`✅ Found ${matches.length} match(es):`);
    matches.forEach(m => {
      logger.info(`   - Strategy ${m.strategy.id}: OC=${m.oc.toFixed(2)}% (threshold=${m.strategy.oc}%)`);
    });
    logger.info('');

    // Step 7: Test WebSocketOCConsumer.handlePriceTick()
    logger.info('Step 7: Testing WebSocketOCConsumer.handlePriceTick()...');
    
    // Check for existing positions first
    const { Position } = await import('../src/models/Position.js');
    const existingPositions = await Position.findOpen(strategy.id);
    if (existingPositions.length > 0) {
      logger.warn(`⚠️ Strategy ${strategy.id} already has ${existingPositions.length} open position(s)`);
      logger.warn(`   Position IDs: ${existingPositions.map(p => p.id).join(', ')}`);
      logger.warn(`   This test will skip order creation.`);
    } else {
      logger.info(`✅ No existing positions for strategy ${strategy.id}`);
    }

    // Call handlePriceTick
    await webSocketOCConsumer.handlePriceTick(
      tickData.exchange,
      tickData.symbol,
      tickData.price,
      tickData.timestamp
    );

    logger.info(`✅ handlePriceTick() completed\n`);

    // Step 8: Verify order was created
    logger.info('Step 8: Verifying order creation...');
    
    // Wait a bit for order to be processed
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    const positions = await Position.findOpen(strategy.id);
    if (positions.length > 0) {
      logger.info(`✅ Order created successfully!`);
      logger.info(`   Position ID: ${positions[positions.length - 1].id}`);
      logger.info(`   Symbol: ${positions[positions.length - 1].symbol}`);
      logger.info(`   Side: ${positions[positions.length - 1].side}`);
      logger.info(`   Entry Price: ${positions[positions.length - 1].entry_price}`);
      logger.info(`   Amount: ${positions[positions.length - 1].amount}`);
    } else {
      logger.warn(`⚠️ No position created. This might be expected if:`);
      logger.warn(`   - Strategy already has open position`);
      logger.warn(`   - Order execution failed`);
      logger.warn(`   - Concurrency limit reached`);
    }

    logger.info('\n' + '='.repeat(60));
    logger.info('Test completed!');
    logger.info('='.repeat(60) + '\n');

    process.exit(0);
  } catch (error) {
    logger.error('\n' + '='.repeat(60));
    logger.error('Test failed!');
    logger.error('='.repeat(60));
    logger.error('Error:', error?.message || error);
    logger.error('Stack:', error?.stack);
    process.exit(1);
  }
}

// Run test
runTest();

