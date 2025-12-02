import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import { StrategyService } from './src/services/StrategyService.js';
import { CandleService } from './src/services/CandleService.js';
import { TelegramService } from './src/services/TelegramService.js';
import { calculateTakeProfit, calculateInitialStopLoss } from './src/utils/calculator.js';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Test script to place trigger orders on Binance testnet
 * Usage: node test_trigger_order.js [strategy_id]
 */
async function testTriggerOrder() {
  try {
    // Get strategy ID from command line or use first active strategy
    const strategyId = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    logger.info('=== Test Trigger Order Placement on Binance Testnet ===');
    
    // 1. Get strategy
    let strategy;
    if (strategyId) {
      strategy = await Strategy.findById(strategyId);
      if (!strategy) {
        logger.error(`Strategy ${strategyId} not found`);
        process.exit(1);
      }
    } else {
      // Get first active USDT strategy, prefer BTCUSDT or ETHUSDT
      const strategies = await Strategy.findAll(null, true);
      if (strategies.length === 0) {
        logger.error('No active strategies found');
        process.exit(1);
      }
      
      strategy = strategies.find(s => s.symbol === 'BTCUSDT' || s.symbol === 'BTC/USDT') ||
                 strategies.find(s => s.symbol === 'ETHUSDT' || s.symbol === 'ETH/USDT') ||
                 strategies[0];
      
      logger.info(`Using strategy: ID ${strategy.id} (${strategy.symbol})`);
    }
    
    logger.info(`Strategy: ${strategy.id} - ${strategy.symbol}`);
    logger.info(`  Bot ID: ${strategy.bot_id}`);
    logger.info(`  Interval: ${strategy.interval}`);
    logger.info(`  OC Threshold: ${strategy.oc}%`);
    logger.info(`  Extend: ${strategy.extend}%`);
    logger.info(`  Amount: ${strategy.amount} USDT`);
    logger.info(`  Take Profit: ${strategy.take_profit}`);
    logger.info(`  Trade Type: ${strategy.trade_type}`);
    
    // 2. Get bot
    const bot = await Bot.findById(strategy.bot_id);
    if (!bot) {
      logger.error(`Bot ${strategy.bot_id} not found`);
      process.exit(1);
    }
    
    if (bot.exchange !== 'binance') {
      logger.error(`This test only works with Binance exchange. Bot ${bot.id} uses ${bot.exchange}`);
      process.exit(1);
    }
    
    logger.info(`Bot: ${bot.bot_name} (${bot.exchange})`);
    
    // 3. Initialize services
    logger.info('Initializing services...');
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    
    const candleService = new CandleService(exchangeService);
    const strategyService = new StrategyService(exchangeService, candleService);
    
    // Initialize Telegram service (optional)
    let telegramService = null;
    try {
      telegramService = new TelegramService();
      await telegramService.initialize();
    } catch (error) {
      logger.warn('Telegram service not available, continuing without it');
    }
    
    // 4. Get current price
    logger.info(`Getting current price for ${strategy.symbol}...`);
    const currentPrice = await exchangeService.getTickerPrice(strategy.symbol);
    logger.info(`Current price: ${currentPrice}`);
    
    // 5. Get latest candle to calculate OC
    const latestCandle = await candleService.getLatestCandle(strategy.symbol, strategy.interval);
    if (!latestCandle) {
      logger.error(`No candle data for ${strategy.symbol} ${strategy.interval}`);
      process.exit(1);
    }
    
    // Calculate OC using current price
    const oc = candleService.calculateOC(latestCandle.open, currentPrice);
    const direction = candleService.getCandleDirection(latestCandle.open, currentPrice);
    
    logger.info(`Candle: Open=${latestCandle.open}, Current=${currentPrice}`);
    logger.info(`OC: ${oc.toFixed(2)}%, Direction: ${direction}`);
    
    // 6. Determine side
    let side;
    if (strategy.trade_type === 'both') {
      side = direction === 'bullish' ? 'long' : 'short';
    } else if (strategy.trade_type === 'long') {
      side = 'long';
    } else {
      side = 'short';
    }
    
    logger.info(`Selected side: ${side}`);
    
    // 7. Calculate entry price (use current price for trigger)
    // For LONG: entry price should be above current (buy stop)
    // For SHORT: entry price should be below current (sell stop)
    let entryPrice;
    if (side === 'long') {
      // For long: entry trigger above current price (e.g., +0.1%)
      entryPrice = currentPrice * 1.001;
    } else {
      // For short: entry trigger below current price (e.g., -0.1%)
      entryPrice = currentPrice * 0.999;
    }
    
    // 8. Calculate quantity from amount
    const quantity = strategy.amount / currentPrice;
    
    // 9. Calculate TP and SL
    const tpPrice = calculateTakeProfit(entryPrice, Math.abs(oc) || 2.0, strategy.take_profit || 50, side);
    const slPrice = calculateInitialStopLoss(tpPrice, Math.abs(oc) || 2.0, strategy.reduce || 10, side);
    
    logger.info(`Entry Price (trigger): ${entryPrice}`);
    logger.info(`Quantity: ${quantity}`);
    logger.info(`Take Profit: ${tpPrice} (${((tpPrice - entryPrice) / entryPrice * 100).toFixed(2)}%)`);
    logger.info(`Stop Loss: ${slPrice} (${((slPrice - entryPrice) / entryPrice * 100).toFixed(2)}%)`);
    
    // 10. Place entry trigger order
    logger.info('\n=== Placing Entry Trigger Order ===');
    logger.info(`Symbol: ${strategy.symbol}`);
    logger.info(`Side: ${side.toUpperCase()}`);
    logger.info(`Type: STOP_MARKET`);
    logger.info(`Trigger Price: ${entryPrice}`);
    logger.info(`Quantity: ${quantity}`);
    
    const binanceClient = exchangeService.binanceDirectClient;
    if (!binanceClient) {
      throw new Error('BinanceDirectClient not initialized');
    }
    
    const entryOrder = await binanceClient.createEntryTriggerOrder(
      strategy.symbol,
      side,
      entryPrice,
      quantity
    );
    
    logger.info(`✅ Entry trigger order placed: Order ID: ${entryOrder.orderId}`);
    
    // 11. Note about TP/SL
    logger.info('\n=== Note ===');
    logger.info('TP and SL orders should be placed AFTER entry order is filled.');
    logger.info('In production, use webhook or polling to detect when entry order is filled,');
    logger.info('then call createTpLimitOrder() and createSlLimitOrder().');
    logger.info('\nExample code after entry fill:');
    logger.info(`  await binanceClient.createTpLimitOrder('${strategy.symbol}', '${side}', ${tpPrice}, ${quantity});`);
    logger.info(`  await binanceClient.createSlLimitOrder('${strategy.symbol}', '${side}', ${slPrice}, ${quantity});`);
    
    logger.info('\n✅ Test completed successfully!');
    
    process.exit(0);
  } catch (error) {
    logger.error('Test failed:', error);
    if (error.stack) {
      logger.error('Stack trace:', error.stack);
    }
    process.exit(1);
  }
}

// Run test
testTriggerOrder();

