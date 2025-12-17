import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function verifyAlertConfigs() {
  try {
    await configService.loadAll();

    console.log('\n=== Price Alert Configs Verification ===\n');

    const configs = await PriceAlertConfig.findAll();
    console.log(`Total configs: ${configs.length}\n`);

    for (const cfg of configs) {
      const isActive = cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1';
      const exchange = (cfg.exchange || 'mexc').toLowerCase();
      const chatId = cfg.telegram_chat_id;
      
      console.log(`Config ID: ${cfg.id}`);
      console.log(`  Exchange: ${exchange.toUpperCase()}`);
      console.log(`  Active: ${isActive}`);
      console.log(`  Telegram Chat ID: ${chatId}`);
      console.log(`  Threshold: ${cfg.threshold}%`);
      console.log(`  Intervals: ${typeof cfg.intervals === 'string' ? cfg.intervals : JSON.stringify(cfg.intervals)}`);
      console.log(`  Symbols: ${typeof cfg.symbols === 'string' ? cfg.symbols : JSON.stringify(cfg.symbols)}`);
      
      // Expected chat IDs based on user's config
      const expectedChatIds = {
        'binance': '-1003009070677',
        'mexc': '-1003052914854'
      };
      
      if (expectedChatIds[exchange] && chatId !== expectedChatIds[exchange]) {
        console.log(`  ⚠️  WARNING: Expected chat_id ${expectedChatIds[exchange]} for ${exchange}, but got ${chatId}`);
      } else if (expectedChatIds[exchange]) {
        console.log(`  ✅ Chat ID matches expected value for ${exchange}`);
      }
      
      console.log('');
    }

    // Summary
    console.log('=== Summary ===');
    const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
    console.log(`Active configs: ${activeConfigs.length}`);
    
    const byExchange = {};
    for (const cfg of activeConfigs) {
      const exchange = (cfg.exchange || 'mexc').toLowerCase();
      if (!byExchange[exchange]) {
        byExchange[exchange] = [];
      }
      byExchange[exchange].push({
        id: cfg.id,
        chatId: cfg.telegram_chat_id,
        threshold: cfg.threshold
      });
    }
    
    for (const [exchange, configs] of Object.entries(byExchange)) {
      console.log(`\n${exchange.toUpperCase()}: ${configs.length} config(s)`);
      for (const cfg of configs) {
        console.log(`  Config ${cfg.id}: chat_id=${cfg.chatId}, threshold=${cfg.threshold}%`);
      }
    }

    process.exit(0);
  } catch (e) {
    logger.error('Verification failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

verifyAlertConfigs();

