import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { priceAlertSymbolTracker } from '../src/services/PriceAlertSymbolTracker.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function debugConfigs() {
  try {
    await configService.loadAll();

    console.log('\n=== Price Alert Configs Debug ===\n');

    // Get all configs (including inactive)
    const allConfigs = await PriceAlertConfig.findAllAny();
    console.log(`Total configs (all): ${allConfigs.length}`);

    // Get active configs
    const activeConfigs = await PriceAlertConfig.findAll();
    console.log(`Active configs (from findAll): ${activeConfigs.length}`);

    // Check is_active values
    console.log('\n--- Config Details ---');
    for (const cfg of allConfigs) {
      console.log(`Config ID: ${cfg.id}`);
      console.log(`  Exchange: ${cfg.exchange}`);
      console.log(`  is_active (type): ${typeof cfg.is_active}, value: ${cfg.is_active}`);
      console.log(`  is_active === true: ${cfg.is_active === true}`);
      console.log(`  is_active === 1: ${cfg.is_active === 1}`);
      console.log(`  is_active == true: ${cfg.is_active == true}`);
      console.log(`  Symbols (raw): ${JSON.stringify(cfg.symbols)}`);
      console.log(`  Symbols (type): ${typeof cfg.symbols}`);
      console.log(`  Symbols (length): ${Array.isArray(cfg.symbols) ? cfg.symbols.length : 'N/A'}`);
      console.log('');
    }

    // Test PriceAlertSymbolTracker
    console.log('\n--- PriceAlertSymbolTracker Test ---');
    await priceAlertSymbolTracker.refresh();
    const trackingSymbols = priceAlertSymbolTracker.getAllSymbols();
    console.log(`Tracking symbols:`);
    for (const [exchange, symbols] of trackingSymbols.entries()) {
      console.log(`  ${exchange}: ${symbols.size} symbols`);
      if (symbols.size > 0) {
        console.log(`    Sample: ${Array.from(symbols).slice(0, 5).join(', ')}${symbols.size > 5 ? '...' : ''}`);
      }
    }

    process.exit(0);
  } catch (e) {
    logger.error('Debug failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

debugConfigs();

