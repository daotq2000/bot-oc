import { Strategy } from '../src/models/Strategy.js';
import { strategyCache } from '../src/services/StrategyCache.js';
import { realtimeOCDetector } from '../src/services/RealtimeOCDetector.js';
import { webSocketOCConsumer } from '../src/consumers/WebSocketOCConsumer.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function debugMexcDetection() {
  try {
    await configService.loadAll();

    console.log('\n=== MEXC Detection Debug ===\n');

    // 1. Check strategies
    const strategies = await Strategy.findAll(null, true);
    const mexcStrategies = strategies.filter(s => (s.exchange || '').toLowerCase() === 'mexc');
    console.log(`Total strategies: ${strategies.length}`);
    console.log(`MEXC strategies: ${mexcStrategies.length}`);
    
    if (mexcStrategies.length > 0) {
      console.log('\nSample MEXC strategies:');
      mexcStrategies.slice(0, 5).forEach(s => {
        console.log(`  Strategy ${s.id}: ${s.symbol} ${s.interval}, OC=${s.oc}%, bot_id=${s.bot_id}`);
      });
    }

    // 2. Check strategy cache
    await strategyCache.refresh();
    console.log(`\nStrategy cache size: ${strategyCache.size()}`);
    
    const sampleSymbol = mexcStrategies[0]?.symbol;
    if (sampleSymbol) {
      const normalizedSymbol = sampleSymbol.toUpperCase().replace(/[\/:_]/g, '');
      const cachedStrategies = strategyCache.getStrategies('mexc', normalizedSymbol);
      console.log(`\nStrategies for ${normalizedSymbol} in cache: ${cachedStrategies.length}`);
      cachedStrategies.forEach(s => {
        console.log(`  Strategy ${s.id}: OC=${s.oc}%, bot_id=${s.bot_id}, interval=${s.interval}`);
      });
    }

    // 3. Check WebSocketOCConsumer
    console.log(`\nWebSocketOCConsumer stats:`);
    const stats = webSocketOCConsumer.getStats();
    console.log(`  isRunning: ${stats.isRunning}`);
    console.log(`  processedCount: ${stats.processedCount}`);
    console.log(`  matchCount: ${stats.matchCount}`);
    console.log(`  orderServices size: ${webSocketOCConsumer.orderServices.size}`);
    console.log(`  Available bot IDs: ${Array.from(webSocketOCConsumer.orderServices.keys()).join(', ')}`);

    // 4. Test OC detection manually
    if (sampleSymbol && mexcStrategies.length > 0) {
      const normalizedSymbol = sampleSymbol.toUpperCase().replace(/[\/:_]/g, '');
      const testPrice = 0.1; // Dummy price for testing
      console.log(`\nTesting OC detection for ${normalizedSymbol} with price ${testPrice}:`);
      const matches = await realtimeOCDetector.detectOC('mexc', normalizedSymbol, testPrice, Date.now());
      console.log(`  Matches found: ${matches.length}`);
      matches.forEach(m => {
        console.log(`    Strategy ${m.strategy.id}: OC=${m.oc.toFixed(2)}%, direction=${m.direction}`);
      });
    }

    // 5. Check RealtimeOCDetector stats
    console.log(`\nRealtimeOCDetector stats:`);
    const ocStats = realtimeOCDetector.getStats();
    console.log(`  openPriceCacheSize: ${ocStats.openPriceCacheSize}`);
    console.log(`  lastPriceCacheSize: ${ocStats.lastPriceCacheSize}`);

    process.exit(0);
  } catch (e) {
    logger.error('Debug failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

debugMexcDetection();

