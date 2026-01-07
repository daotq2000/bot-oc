import dotenv from 'dotenv';
import { CandleService } from './src/services/CandleService.js';
import { ExchangeService } from './src/services/ExchangeService.js';
import { Bot } from './src/models/Bot.js';
import logger from './src/utils/logger.js';

dotenv.config();

/**
 * Script to compare OC (Open-Close) percentage across different time intervals
 * This helps verify if OC calculation is correct
 */
async function compareOCAcrossIntervals() {
  try {
    logger.info('=== OC Comparison Across Time Intervals ===\n');
    
    // Get a bot (assuming bot ID 2 for Binance)
    const bot = await Bot.findById(2);
    if (!bot) {
      logger.error('Bot not found');
      process.exit(1);
    }
    
    // Initialize services
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();
    const candleService = new CandleService(exchangeService);
    
    // Test symbol
    const symbol = 'BTCUSDT';
    const intervals = ['1m', '3m', '5m', '15m', '30m', '1h'];
    
    logger.info(`Symbol: ${symbol}`);
    logger.info(`Comparing OC across intervals: ${intervals.join(', ')}\n`);
    
    // Get current price
    const currentPrice = await exchangeService.getTickerPrice(symbol);
    logger.info(`Current Price: ${currentPrice}\n`);
    
    // Get latest candles for each interval
    const results = [];
    
    for (const interval of intervals) {
      try {
        // Normalize interval format (ensure it matches database format)
        const normalizedInterval = interval;
        
        const candle = await candleService.getLatestCandle(symbol, normalizedInterval);
        if (!candle) {
          logger.warn(`No candle data for ${interval}`);
          continue;
        }
        
        const isClosed = candleService.isCandleClosed(candle);
        const oc = candleService.calculateOC(candle.open, isClosed ? candle.close : currentPrice);
        const direction = candleService.getCandleDirection(candle.open, isClosed ? candle.close : currentPrice);
        
        // Calculate range (high - low) as percentage
        const range = ((candle.high - candle.low) / candle.open) * 100;
        
        results.push({
          interval,
          open: candle.open,
          close: isClosed ? candle.close : currentPrice,
          high: candle.high,
          low: candle.low,
          oc: parseFloat(oc.toFixed(4)),
          range: parseFloat(range.toFixed(4)),
          direction,
          isClosed,
          timestamp: new Date(candle.open_time || candle.openTime).toISOString()
        });
      } catch (error) {
        logger.error(`Error getting candle for ${interval}:`, error.message || error);
      }
    }
    
    if (results.length === 0) {
      logger.error('No candle data found for any interval. Please ensure candles are being updated.');
      process.exit(1);
    }
    
    // Display results in table format
    logger.info('Results:');
    logger.info('='.repeat(120));
    logger.info(
      `${'Interval'.padEnd(10)} | ${'Open'.padEnd(12)} | ${'Close'.padEnd(12)} | ${'OC %'.padEnd(10)} | ${'Range %'.padEnd(10)} | ${'Direction'.padEnd(10)} | Status`
    );
    logger.info('-'.repeat(120));
    
    for (const result of results) {
      logger.info(
        `${result.interval.padEnd(10)} | ${result.open.toFixed(2).padEnd(12)} | ${result.close.toFixed(2).padEnd(12)} | ${result.oc.padEnd(10)} | ${result.range.padEnd(10)} | ${result.direction.padEnd(10)} | ${result.isClosed ? 'CLOSED' : 'OPEN'}`
      );
    }
    
    logger.info('='.repeat(120));
    logger.info('\n');
    
    // Analysis
    logger.info('Analysis:');
    logger.info('-'.repeat(120));
    
    if (results.length > 0) {
      // Sort by OC absolute value
      const sortedByOC = [...results].sort((a, b) => Math.abs(b.oc) - Math.abs(a.oc));
      logger.info(`Highest OC (absolute): ${sortedByOC[0].interval} with ${sortedByOC[0].oc}%`);
      logger.info(`Lowest OC (absolute): ${sortedByOC[sortedByOC.length - 1].interval} with ${sortedByOC[sortedByOC.length - 1].oc}%`);
      
      // Sort by range
      const sortedByRange = [...results].sort((a, b) => b.range - a.range);
      logger.info(`Highest Range: ${sortedByRange[0].interval} with ${sortedByRange[0].range}%`);
      logger.info(`Lowest Range: ${sortedByRange[sortedByRange.length - 1].interval} with ${sortedByRange[sortedByRange.length - 1].range}%`);
      
      // Check if longer intervals have higher OC (they shouldn't necessarily)
      logger.info('\nOC Comparison:');
      for (let i = 0; i < results.length - 1; i++) {
        const current = results[i];
        const next = results[i + 1];
        const ocDiff = Math.abs(next.oc) - Math.abs(current.oc);
        const comparison = ocDiff > 0 ? 'HIGHER' : 'LOWER';
        logger.info(`  ${current.interval} → ${next.interval}: OC is ${comparison} (${ocDiff > 0 ? '+' : ''}${ocDiff.toFixed(4)}%)`);
      }
    }
    
    logger.info('\n');
    
    // Explanation
    logger.info('Explanation:');
    logger.info('-'.repeat(120));
    logger.info('OC (Open-Close) is calculated independently for each candle:');
    logger.info('  OC = (close - open) / open * 100');
    logger.info('');
    logger.info('Important points:');
    logger.info('1. OC is NOT cumulative - each interval calculates its own OC');
    logger.info('2. A 5-minute candle does NOT necessarily have higher OC than a 1-minute candle');
    logger.info('3. OC only measures the difference between open and close prices');
    logger.info('4. Range (high - low) is different from OC and usually increases with longer intervals');
    logger.info('');
    logger.info('Example:');
    logger.info('  - 1m candle: open=100, close=102 → OC = +2%');
    logger.info('  - 5m candle: open=100, close=99 → OC = -1% (even though it contains the 1m candle)');
    logger.info('  - This is because the 5m candle might have started at 100, gone up to 102, then down to 99');
    
    process.exit(0);
  } catch (error) {
    logger.error('Error:', error);
    process.exit(1);
  }
}

compareOCAcrossIntervals();

