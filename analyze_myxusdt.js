import dotenv from 'dotenv';
import { Bot } from './src/models/Bot.js';
import { Strategy } from './src/models/Strategy.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import { CandleService } from './src/services/CandleService.js';
import { StrategyService } from './src/services/StrategyService.js';
import logger from './src/utils/logger.js';

dotenv.config();

/**
 * Analyze why MYXUSDT 5m signals are not triggering
 */
async function analyzeMYXUSDT() {
  try {
    logger.info('=== Analyzing MYXUSDT 5m Signal Issues ===\n');
    
    // 1. Get strategy
    const strategies = await Strategy.findAll(null, true);
    const myxStrategy = strategies.find(s => 
      (s.symbol === 'MYXUSDT' || s.symbol === 'MYX/USDT') && s.interval === '5m'
    );
    
    if (!myxStrategy) {
      logger.error('No active strategy found for MYXUSDT 5m');
      process.exit(1);
    }
    
    logger.info(`Strategy ID: ${myxStrategy.id}`);
    logger.info(`  Symbol: ${myxStrategy.symbol}`);
    logger.info(`  Interval: ${myxStrategy.interval}`);
    logger.info(`  OC Threshold: ${myxStrategy.oc}%`);
    logger.info(`  Extend: ${myxStrategy.extend}%`);
    logger.info(`  Trade Type: ${myxStrategy.trade_type}`);
    logger.info(`  Amount: ${myxStrategy.amount} USDT\n`);
    
    // 2. Get bot
    const bot = await Bot.findById(myxStrategy.bot_id);
    if (!bot) {
      logger.error(`Bot ${myxStrategy.bot_id} not found`);
      process.exit(1);
    }
    
    // 3. Initialize services
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    const candleService = new CandleService(exchangeService);
    const strategyService = new StrategyService(exchangeService, candleService);
    
    // 4. Get latest candle
    const symbol = 'MYXUSDT';
    const interval = '5m';
    
    logger.info('=== Latest Candle Analysis ===\n');
    
    const latestCandle = await candleService.getLatestCandle(symbol, interval);
    if (!latestCandle) {
      logger.error('No candle data found. Please ensure candles are being updated.');
      process.exit(1);
    }
    
    const currentPrice = await exchangeService.getTickerPrice(symbol);
    const isClosed = candleService.isCandleClosed(latestCandle);
    const oc = candleService.calculateOC(latestCandle.open, isClosed ? latestCandle.close : currentPrice);
    const direction = candleService.getCandleDirection(latestCandle.open, isClosed ? latestCandle.close : currentPrice);
    
    logger.info(`Latest Candle:`);
    logger.info(`  Open Time: ${new Date(latestCandle.open_time).toISOString()}`);
    logger.info(`  Open: ${latestCandle.open}`);
    logger.info(`  Close: ${isClosed ? latestCandle.close : currentPrice} (${isClosed ? 'CLOSED' : 'OPEN'})`);
    logger.info(`  High: ${latestCandle.high}`);
    logger.info(`  Low: ${latestCandle.low}`);
    logger.info(`  OC: ${oc.toFixed(4)}%`);
    logger.info(`  Direction: ${direction}`);
    logger.info(`  Above Threshold: ${Math.abs(oc) >= myxStrategy.oc ? 'YES ✅' : 'NO ❌'}\n`);
    
    // 5. Check signal
    logger.info('=== Signal Check ===\n');
    
    if (Math.abs(oc) < myxStrategy.oc) {
      logger.info(`❌ OC ${Math.abs(oc).toFixed(4)}% < threshold ${myxStrategy.oc}%`);
      logger.info(`   This is why no signal is triggered.\n`);
    } else {
      logger.info(`✅ OC ${Math.abs(oc).toFixed(4)}% >= threshold ${myxStrategy.oc}%`);
      
      // Check sides
      const sidesToCheck = strategyService.getSidesToCheck(myxStrategy, direction);
      logger.info(`   Sides to check: ${sidesToCheck.length > 0 ? sidesToCheck.join(', ') : 'NONE'}\n`);
      
      if (sidesToCheck.length === 0) {
        logger.info(`❌ No sides to check (trade_type=${myxStrategy.trade_type}, direction=${direction})`);
        logger.info(`   This is why no signal is triggered.\n`);
      } else {
        // Check each side
        for (const side of sidesToCheck) {
          console.log(`\n=== Checking ${side.toUpperCase()} side ===`);
          
          const entryPrice = strategyService.calculateEntryPrice(latestCandle, myxStrategy, side);
          const extendMet = strategyService.checkExtendCondition(side, currentPrice, entryPrice, latestCandle.open);
          
          console.log(`Entry Price: ${entryPrice}`);
          console.log(`Current Price: ${currentPrice}`);
          console.log(`Open Price: ${latestCandle.open}`);
          console.log(`Extend Met: ${extendMet ? 'YES ✅' : 'NO ❌'}`);
          
          if (!extendMet) {
            console.log(`\n❌ Extend condition NOT met!`);
            console.log(`   For ${side}: price must ${side === 'long' ? 'drop below' : 'rise above'} entry price`);
            console.log(`   Entry: ${entryPrice}, Current: ${currentPrice}`);
            
            if (side === 'long') {
              console.log(`   Condition 1: currentPrice (${currentPrice}) <= entryPrice (${entryPrice}) = ${currentPrice <= entryPrice}`);
              console.log(`   Condition 2: entryPrice (${entryPrice}) < openPrice (${latestCandle.open}) = ${entryPrice < latestCandle.open}`);
            } else {
              console.log(`   Condition 1: currentPrice (${currentPrice}) >= entryPrice (${entryPrice}) = ${currentPrice >= entryPrice}`);
              console.log(`   Condition 2: entryPrice (${entryPrice}) > openPrice (${latestCandle.open}) = ${entryPrice > latestCandle.open}`);
            }
          } else {
            console.log(`\n✅ Extend condition met!`);
            
            // Check ignore logic
            const shouldIgnore = await strategyService.shouldIgnoreSignal(
              latestCandle,
              myxStrategy,
              side,
              currentPrice
            );
            
            if (shouldIgnore) {
              console.log(`❌ Signal ignored (previous candle logic)`);
            } else {
              console.log(`✅ Signal should trigger!`);
            }
          }
        }
      }
    }
    
    // 6. Try to get signal
    logger.info('\n=== Full Signal Check ===\n');
    const signal = await strategyService.checkSignal(myxStrategy);
    
    if (signal) {
      logger.info('✅ Signal detected!');
      logger.info(`  Side: ${signal.side}`);
      logger.info(`  Entry: ${signal.entryPrice}`);
      logger.info(`  TP: ${signal.tpPrice}`);
      logger.info(`  SL: ${signal.slPrice}`);
    } else {
      logger.info('❌ No signal detected');
      logger.info('   Check the analysis above to see why.\n');
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

analyzeMYXUSDT();

