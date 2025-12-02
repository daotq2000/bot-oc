import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { Candle } from './src/models/Candle.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import { CandleService } from './src/services/CandleService.js';
import { StrategyService } from './src/services/StrategyService.js';
import { calculateOC } from './src/utils/calculator.js';
import logger from './src/utils/logger.js';

dotenv.config();

/**
 * Script to check why MYXUSDT 5m signals are not triggering
 */
async function checkMYXUSDT() {
  try {
    logger.info('=== Checking MYXUSDT 5m Signals ===\n');
    
    // 1. Get strategies for MYXUSDT 5m
    const strategies = await Strategy.findAll(null, true);
    const myxStrategies = strategies.filter(s => 
      (s.symbol === 'MYXUSDT' || s.symbol === 'MYX/USDT') && s.interval === '5m'
    );
    
    if (myxStrategies.length === 0) {
      logger.error('No active strategies found for MYXUSDT 5m');
      process.exit(1);
    }
    
    logger.info(`Found ${myxStrategies.length} strategy(ies) for MYXUSDT 5m:\n`);
    for (const strategy of myxStrategies) {
      logger.info(`Strategy ID: ${strategy.id}`);
      logger.info(`  Symbol: ${strategy.symbol}`);
      logger.info(`  Interval: ${strategy.interval}`);
      logger.info(`  OC Threshold: ${strategy.oc}%`);
      logger.info(`  Extend: ${strategy.extend}%`);
      logger.info(`  Trade Type: ${strategy.trade_type}`);
      logger.info(`  Amount: ${strategy.amount} USDT`);
      logger.info(`  Is Active: ${strategy.is_active}`);
      logger.info('');
    }
    
    // 2. Get bot
    const botId = myxStrategies[0].bot_id;
    const bot = await Bot.findById(botId);
    if (!bot) {
      logger.error(`Bot ${botId} not found`);
      process.exit(1);
    }
    
    // 3. Initialize services
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    const candleService = new CandleService(exchangeService);
    const strategyService = new StrategyService(exchangeService, candleService);
    
    // 4. Get recent candles from database
    const symbol = 'MYXUSDT';
    const interval = '5m';
    const exchange = bot.exchange;
    
    logger.info(`\n=== Recent Candles (last 20) ===\n`);
    
    const recentCandles = await Candle.getCandles(exchange, symbol, interval, parseInt(20));
    
    if (recentCandles.length === 0) {
      logger.error('No candles found in database');
      process.exit(1);
    }
    
    // 5. Analyze each candle
    const candlesAboveThreshold = [];
    
    for (const candle of recentCandles) {
      const oc = calculateOC(candle.open, candle.close);
      const absOC = Math.abs(oc);
      const direction = candle.close >= candle.open ? 'bullish' : 'bearish';
      
      // Check if above threshold for any strategy
      const aboveThreshold = myxStrategies.some(s => absOC >= s.oc);
      
      if (aboveThreshold) {
        candlesAboveThreshold.push({
          candle,
          oc,
          absOC,
          direction,
          timestamp: new Date(candle.open_time).toISOString()
        });
      }
      
      logger.info(`Candle ${new Date(candle.open_time).toISOString()}:`);
      logger.info(`  Open: ${candle.open}, Close: ${candle.close}`);
      logger.info(`  OC: ${oc.toFixed(4)}% (abs: ${absOC.toFixed(4)}%)`);
      logger.info(`  Direction: ${direction}`);
      logger.info(`  Above threshold: ${aboveThreshold ? 'YES ✅' : 'NO ❌'}`);
      logger.info('');
    }
    
    // 6. Summary
    logger.info(`\n=== Summary ===\n`);
    logger.info(`Total candles analyzed: ${recentCandles.length}`);
    logger.info(`Candles above threshold: ${candlesAboveThreshold.length}`);
    
    if (candlesAboveThreshold.length > 0) {
      logger.info(`\n⚠️  Found ${candlesAboveThreshold.length} candle(s) above threshold but no signals triggered!\n`);
      
      // 7. Check why signals didn't trigger for these candles
      logger.info(`\n=== Checking why signals didn't trigger ===\n`);
      
      for (const item of candlesAboveThreshold.slice(0, 5)) { // Check first 5
        const candle = item.candle;
        logger.info(`\nChecking candle at ${item.timestamp}:`);
        logger.info(`  OC: ${item.oc.toFixed(4)}%`);
        logger.info(`  Direction: ${item.direction}`);
        
        // Simulate signal check for each strategy
        for (const strategy of myxStrategies) {
          logger.info(`\n  Strategy ${strategy.id}:`);
          
          // Check if OC meets threshold
          if (item.absOC < strategy.oc) {
            logger.info(`    ❌ OC ${item.absOC.toFixed(4)}% < threshold ${strategy.oc}%`);
            continue;
          }
          
          logger.info(`    ✅ OC ${item.absOC.toFixed(4)}% >= threshold ${strategy.oc}%`);
          
          // Check trade_type
          const sidesToCheck = strategyService.getSidesToCheck(strategy, item.direction);
          logger.info(`    Sides to check: ${sidesToCheck.length > 0 ? sidesToCheck.join(', ') : 'NONE'}`);
          
          if (sidesToCheck.length === 0) {
            logger.info(`    ❌ No sides to check (trade_type=${strategy.trade_type}, direction=${item.direction})`);
            continue;
          }
          
          // Get current price (use close price for closed candles)
          const currentPrice = candle.close;
          
          // Check extend condition for each side
          for (const side of sidesToCheck) {
            const entryPrice = strategyService.calculateEntryPrice(candle, strategy, side);
            const extendMet = strategyService.checkExtendCondition(side, currentPrice, entryPrice, candle.open);
            
            logger.info(`    Side: ${side}`);
            logger.info(`      Entry Price: ${entryPrice}`);
            logger.info(`      Current Price: ${currentPrice}`);
            logger.info(`      Extend Met: ${extendMet ? 'YES ✅' : 'NO ❌'}`);
            
            if (!extendMet) {
              logger.info(`      ❌ Extend condition not met!`);
            }
          }
        }
      }
    } else {
      logger.info(`\n✅ No candles found above threshold in recent data.`);
    }
    
    // 8. Check latest candle and current signal
    logger.info(`\n=== Checking Latest Candle and Current Signal ===\n`);
    const latestCandle = await candleService.getLatestCandle(symbol, interval);
    if (latestCandle) {
      const currentPrice = await exchangeService.getTickerPrice(symbol);
      const isClosed = candleService.isCandleClosed(latestCandle);
      const oc = candleService.calculateOC(latestCandle.open, isClosed ? latestCandle.close : currentPrice);
      
      logger.info(`Latest candle:`);
      logger.info(`  Open: ${latestCandle.open}`);
      logger.info(`  Close: ${isClosed ? latestCandle.close : currentPrice} (${isClosed ? 'CLOSED' : 'OPEN'})`);
      logger.info(`  OC: ${oc.toFixed(4)}%`);
      logger.info(`  Timestamp: ${new Date(latestCandle.open_time).toISOString()}`);
      
      // Try to check signal
      for (const strategy of myxStrategies) {
        logger.info(`\nChecking signal for Strategy ${strategy.id}:`);
        const signal = await strategyService.checkSignal(strategy);
        if (signal) {
          logger.info(`  ✅ Signal detected!`);
          logger.info(`    Side: ${signal.side}`);
          logger.info(`    Entry: ${signal.entryPrice}`);
          logger.info(`    TP: ${signal.tpPrice}`);
          logger.info(`    SL: ${signal.slPrice}`);
        } else {
          logger.info(`  ❌ No signal`);
        }
      }
    }
    
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    if (error.stack) {
      logger.error('Stack:', error.stack);
    }
    process.exit(1);
  }
}

checkMYXUSDT();

