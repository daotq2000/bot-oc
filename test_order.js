import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import { StrategyService } from './src/services/StrategyService.js';
import { CandleService } from './src/services/CandleService.js';
import { OrderService } from './src/services/OrderService.js';
import { TelegramService } from './src/services/TelegramService.js';
import { calculateTakeProfit, calculateInitialStopLoss } from './src/utils/calculator.js';
import logger from './src/utils/logger.js';

// Load environment variables
dotenv.config();

/**
 * Test script to simulate placing an order on Binance testnet
 * Usage: node test_order.js [strategy_id]
 */
async function testOrder() {
  try {
    // Get strategy ID from command line or use first active strategy
    const strategyId = process.argv[2] ? parseInt(process.argv[2]) : null;
    
    logger.info('=== Test Order Placement on Binance Testnet ===');
    
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
      
      // Try to find BTCUSDT or ETHUSDT first
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
    
    // Initialize Telegram service (optional, won't fail if not configured)
    let telegramService = null;
    try {
      telegramService = new TelegramService();
      await telegramService.initialize();
    } catch (error) {
      logger.warn('Telegram service not available, continuing without it');
    }
    
    const orderService = new OrderService(exchangeService, telegramService);
    
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
    
    // Calculate OC using current price (simulating open candle)
    const oc = candleService.calculateOC(latestCandle.open, currentPrice);
    const direction = candleService.getCandleDirection(latestCandle.open, currentPrice);
    
    logger.info(`Candle: Open=${latestCandle.open}, Current=${currentPrice}`);
    logger.info(`OC: ${oc.toFixed(2)}%, Direction: ${direction}`);
    
    // 6. Determine side based on direction and trade_type
    let side;
    if (strategy.trade_type === 'both') {
      side = direction === 'bullish' ? 'long' : 'short';
    } else if (strategy.trade_type === 'long') {
      side = 'long';
    } else {
      side = 'short';
    }
    
    logger.info(`Selected side: ${side}`);
    
    // 7. Calculate entry price (use current price for market order)
    const entryPrice = currentPrice;
    
    // 8. Calculate TP and SL
    const tpPrice = calculateTakeProfit(entryPrice, Math.abs(oc), strategy.take_profit, side);
    const slPrice = calculateInitialStopLoss(tpPrice, Math.abs(oc), strategy.reduce, side);
    
    logger.info(`Entry Price: ${entryPrice}`);
    logger.info(`Take Profit: ${tpPrice} (${((tpPrice - entryPrice) / entryPrice * 100).toFixed(2)}%)`);
    logger.info(`Stop Loss: ${slPrice} (${((slPrice - entryPrice) / entryPrice * 100).toFixed(2)}%)`);
    
    // 9. Create signal object
    const signal = {
      strategy,
      side,
      entryPrice,
      currentPrice,
      tpPrice,
      slPrice,
      amount: strategy.amount,
      oc: Math.abs(oc)
    };
    
    logger.info('\n=== Placing Order on Binance Testnet ===');
    logger.info(`Symbol: ${strategy.symbol}`);
    logger.info(`Side: ${side === 'long' ? 'BUY' : 'SELL'}`);
    logger.info(`Type: MARKET`);
    logger.info(`Amount: ${strategy.amount} USDT`);
    
    // 10. Execute signal (place order)
    const position = await orderService.executeSignal(signal);
    
    logger.info('\n=== Order Placed Successfully ===');
    logger.info(`Position ID: ${position.id}`);
    logger.info(`Order ID: ${position.order_id}`);
    logger.info(`Entry Price: ${position.entry_price}`);
    logger.info(`Take Profit: ${position.take_profit_price}`);
    logger.info(`Stop Loss: ${position.stop_loss_price}`);
    
    // 11. Note about TP
    logger.info('\n=== Note ===');
    logger.info('Take Profit is stored in database and will be monitored by PositionMonitor job.');
    logger.info('Binance Futures does not support automatic TP orders, so the bot will monitor');
    logger.info('the price and close the position when TP is hit.');
    
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
testOrder();

