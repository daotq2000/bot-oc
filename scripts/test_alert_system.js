import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { exchangeInfoService } from '../src/services/ExchangeInfoService.js';
import { TelegramService } from '../src/services/TelegramService.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function main() {
  try {
    await configService.loadAll();
    await exchangeInfoService.loadFiltersFromDB();

    console.log('\n=== Alert System Test ===\n');

    // 1. Check Telegram Service
    console.log('1. Telegram Service:');
    const telegramService = new TelegramService();
    const telegramInit = await telegramService.initialize();
    console.log(`   Initialized: ${telegramInit}`);
    console.log(`   Bot exists: ${telegramService.bot !== null}`);
    console.log(`   Alert Channel ID: ${telegramService.alertChannelId || 'NOT SET'}`);
    console.log('');

    // 2. Check Alert Configs
    console.log('2. Alert Configs:');
    const configs = await PriceAlertConfig.findAll();
    console.log(`   Total active configs: ${configs.length}`);
    
    for (const cfg of configs) {
      console.log(`   Config ${cfg.id}:`);
      console.log(`     Exchange: ${cfg.exchange}`);
      console.log(`     Threshold: ${cfg.threshold}%`);
      console.log(`     Chat ID: ${cfg.telegram_chat_id || 'NOT SET'}`);
      console.log(`     Symbols (raw): ${JSON.stringify(cfg.symbols)}`);
      
      // Test symbol loading
      let symbols = Array.isArray(cfg.symbols) ? cfg.symbols : [];
      if (symbols.length === 0) {
        const useFilters = configService.getBoolean('PRICE_ALERT_USE_SYMBOL_FILTERS', true);
        if (useFilters) {
          try {
            const maxSymbols = Number(configService.getNumber('PRICE_ALERT_MAX_SYMBOLS', 5000));
            symbols = await exchangeInfoService.getSymbolsFromDB(cfg.exchange, true, maxSymbols);
            console.log(`     Symbols (loaded from DB): ${symbols.length} symbols`);
            if (symbols.length > 0) {
              console.log(`     Sample: ${symbols.slice(0, 5).join(', ')}${symbols.length > 5 ? '...' : ''}`);
            }
          } catch (e) {
            console.log(`     ERROR loading symbols: ${e?.message || e}`);
          }
        }
      } else {
        console.log(`     Symbols (from config): ${symbols.length} symbols`);
      }
      console.log('');
    }

    // 3. Test sending a message
    console.log('3. Test Telegram Message:');
    if (telegramInit && configs.length > 0) {
      const testChatId = configs[0].telegram_chat_id || telegramService.alertChannelId;
      if (testChatId) {
        try {
          await telegramService.sendVolatilityAlert(testChatId, {
            symbol: 'TESTUSDT',
            interval: '1m',
            oc: 5.5,
            open: 100.0,
            currentPrice: 105.5,
            direction: 'bullish'
          });
          console.log(`   ✅ Test alert sent to ${testChatId}`);
        } catch (e) {
          console.log(`   ❌ Failed to send test alert: ${e?.message || e}`);
        }
      } else {
        console.log('   ⚠️  No chat ID available for test');
      }
    } else {
      console.log('   ⚠️  Telegram not initialized or no configs');
    }

    // 4. Config flags
    console.log('\n4. Config Flags:');
    console.log(`   PRICE_ALERT_CHECK_ENABLED: ${configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true)}`);
    console.log(`   PRICE_ALERTS_STRATEGY_FIRST: ${configService.getBoolean('PRICE_ALERTS_STRATEGY_FIRST', false)}`);
    console.log(`   PRICE_ALERT_USE_SYMBOL_FILTERS: ${configService.getBoolean('PRICE_ALERT_USE_SYMBOL_FILTERS', true)}`);
    console.log(`   PRICE_ALERT_MAX_SYMBOLS: ${configService.getNumber('PRICE_ALERT_MAX_SYMBOLS', 5000)}`);
    console.log(`   OC_ALERT_SCAN_INTERVAL_MS: ${configService.getNumber('OC_ALERT_SCAN_INTERVAL_MS', 3000)}`);

    process.exit(0);
  } catch (e) {
    logger.error('Test failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

main();

