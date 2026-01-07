import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  return symbol.toUpperCase().replace(/[/:_]/g, '').replace(/USD$/, 'USDT');
}

async function main() {
  try {
    await configService.loadAll();

    const configs = await PriceAlertConfig.findAll();
    console.log(`\n=== Alert Configs Debug ===`);
    console.log(`Total active configs: ${configs.length}\n`);

    for (const cfg of configs) {
      console.log(`Config ID: ${cfg.id}`);
      console.log(`  Exchange: ${cfg.exchange}`);
      console.log(`  Active: ${cfg.is_active}`);
      console.log(`  Threshold: ${cfg.threshold}%`);
      console.log(`  Telegram Chat ID: ${cfg.telegram_chat_id || 'NOT SET'}`);
      console.log(`  Symbols (raw): ${JSON.stringify(cfg.symbols)}`);
      console.log(`  Symbols (type): ${typeof cfg.symbols}`);
      console.log(`  Intervals (raw): ${JSON.stringify(cfg.intervals)}`);
      console.log(`  Intervals (type): ${typeof cfg.intervals}`);

      const symbols = Array.isArray(cfg.symbols) ? cfg.symbols : [];
      const intervals = Array.isArray(cfg.intervals) && cfg.intervals.length ? cfg.intervals : ['1m'];
      const normalized = symbols.map(s => normalizeSymbol(s));

      console.log(`  Symbols (parsed): ${JSON.stringify(symbols)}`);
      console.log(`  Symbols (normalized): ${JSON.stringify(normalized)}`);
      console.log(`  Intervals (parsed): ${JSON.stringify(intervals)}`);
      console.log(`  Symbols count: ${symbols.length}, Normalized count: ${normalized.length}`);
      console.log('');
    }

    // Check config flags
    console.log(`\n=== Config Flags ===`);
    console.log(`PRICE_ALERT_CHECK_ENABLED: ${configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true)}`);
    console.log(`PRICE_ALERTS_STRATEGY_FIRST: ${configService.getBoolean('PRICE_ALERTS_STRATEGY_FIRST', true)}`);
    console.log(`OC_ALERT_SCAN_INTERVAL_MS: ${configService.getNumber('OC_ALERT_SCAN_INTERVAL_MS', 10000)}`);
    console.log(`PRICE_ALERT_SCAN_INTERVAL_MS: ${configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 5000)}`);

    process.exit(0);
  } catch (e) {
    logger.error('Debug failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

main();

