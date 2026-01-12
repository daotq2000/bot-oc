/**
 * Script to check PriceAlertScanner status
 * Usage: node scripts/check_price_alert_status.js
 */

import { configService } from '../src/services/ConfigService.js';
import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { priceAlertSymbolTracker } from '../src/services/PriceAlertSymbolTracker.js';
import logger from '../src/utils/logger.js';

async function checkPriceAlertStatus() {
  try {
    console.log('=== Price Alert Status Check ===\n');

    // Check ENABLE_ALERTS
    const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
    console.log(`✅ ENABLE_ALERTS: ${alertsEnabled}`);

    // Check PRICE_ALERT_CHECK_ENABLED
    const checkEnabled = configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true);
    console.log(`✅ PRICE_ALERT_CHECK_ENABLED: ${checkEnabled}`);

    // Check active configs
    const configs = await PriceAlertConfig.findAll();
    const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
    console.log(`\n📋 Active PriceAlertConfigs: ${activeConfigs.length}`);
    for (const config of activeConfigs) {
      console.log(`  - Config ${config.id}: ${config.exchange} (threshold=${config.threshold}, intervals=${JSON.stringify(config.intervals)}, telegram_chat_id=${config.telegram_chat_id})`);
    }

    // Check tracked symbols
    await priceAlertSymbolTracker.refresh();
    const trackingSymbols = priceAlertSymbolTracker.getSymbolsForExchange('binance');
    const mexcSymbols = priceAlertSymbolTracker.getSymbolsForExchange('mexc');
    console.log(`\n📊 Tracked Symbols:`);
    console.log(`  - Binance: ${trackingSymbols.size}`);
    console.log(`  - MEXC: ${mexcSymbols.size}`);

    // Check scan interval
    const scanInterval = configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 500);
    console.log(`\n⏱️  Scan Interval: ${scanInterval}ms`);

    // Check concurrency
    const concurrency = configService.getNumber('PRICE_ALERT_SCAN_CONCURRENCY', 50);
    console.log(`⚙️  Scan Concurrency: ${concurrency}`);

    console.log('\n=== Status Check Complete ===');
  } catch (error) {
    console.error('❌ Error checking status:', error);
    logger.error('Error checking price alert status:', error);
  }
}

checkPriceAlertStatus().then(() => {
  process.exit(0);
}).catch(error => {
  console.error('Fatal error:', error);
  process.exit(1);
});

