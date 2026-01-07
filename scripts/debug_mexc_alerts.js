import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { priceAlertSymbolTracker } from '../src/services/PriceAlertSymbolTracker.js';
import { mexcPriceWs } from '../src/services/MexcWebSocketManager.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function debugMexcAlerts() {
  try {
    await configService.loadAll();

    console.log('\n=== MEXC Alerts Debug ===\n');

    // 1. Check configs
    const configs = await PriceAlertConfig.findAll();
    const mexcConfigs = configs.filter(cfg => (cfg.exchange || '').toLowerCase() === 'mexc');
    console.log(`Total configs: ${configs.length}`);
    console.log(`MEXC configs: ${mexcConfigs.length}`);
    
    if (mexcConfigs.length > 0) {
      mexcConfigs.forEach(cfg => {
        console.log(`\nConfig ${cfg.id}:`);
        console.log(`  Exchange: ${cfg.exchange}`);
        console.log(`  Active: ${cfg.is_active}`);
        console.log(`  Threshold: ${cfg.threshold}%`);
        console.log(`  Intervals: ${JSON.stringify(cfg.intervals)}`);
        console.log(`  Telegram Chat ID: ${cfg.telegram_chat_id}`);
        console.log(`  Symbols (from config): ${JSON.stringify(cfg.symbols)}`);
      });
    }

    // 2. Check symbol tracker
    await priceAlertSymbolTracker.refresh();
    const mexcSymbols = priceAlertSymbolTracker.getSymbolsForExchange('mexc');
    console.log(`\nMEXC symbols from tracker: ${mexcSymbols.size}`);
    if (mexcSymbols.size > 0) {
      const sampleSymbols = Array.from(mexcSymbols).slice(0, 10);
      console.log(`  Sample symbols: ${sampleSymbols.join(', ')}`);
    }

    // 3. Check MEXC WebSocket
    console.log(`\nMEXC WebSocket status:`);
    console.log(`  Connected: ${mexcPriceWs.ws?.readyState === 1 ? 'Yes' : 'No'}`);
    console.log(`  Subscribed symbols: ${mexcPriceWs.subscribed.size}`);
    console.log(`  Price cache size: ${mexcPriceWs.priceCache.size}`);
    
    if (mexcPriceWs.priceCache.size > 0) {
      const samplePrices = Array.from(mexcPriceWs.priceCache.entries()).slice(0, 5);
      console.log(`  Sample prices:`);
      samplePrices.forEach(([symbol, price]) => {
        console.log(`    ${symbol}: ${price}`);
      });
    }

    // 4. Check price handlers
    console.log(`\nPrice handlers:`);
    console.log(`  Handlers registered: ${mexcPriceWs._priceHandlers ? mexcPriceWs._priceHandlers.size : 0}`);

    // 5. Test threshold
    const threshold = mexcConfigs[0]?.threshold || 3.0;
    console.log(`\nThreshold check:`);
    console.log(`  Config threshold: ${threshold}%`);
    console.log(`  Min interval: ${configService.getNumber('PRICE_ALERT_MIN_INTERVAL_MS', 60000)}ms`);

    process.exit(0);
  } catch (e) {
    logger.error('Debug failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

debugMexcAlerts();

