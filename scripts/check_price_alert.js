import dotenv from 'dotenv';
import { configService } from '../src/services/ConfigService.js';
import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { TelegramService } from '../src/services/TelegramService.js';
import logger from '../src/utils/logger.js';

dotenv.config();

async function checkPriceAlert() {
  console.log('\n=== Price Alert 诊断 ===\n');

  // 1. 检查配置
  console.log('1. 检查配置:');
  const enableAlerts = configService.getBoolean('ENABLE_ALERTS', true);
  const moduleEnabled = configService.getBoolean('PRICE_ALERT_MODULE_ENABLED', true);
  const checkEnabled = configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true);
  console.log(`   ENABLE_ALERTS: ${enableAlerts}`);
  console.log(`   PRICE_ALERT_MODULE_ENABLED: ${moduleEnabled}`);
  console.log(`   PRICE_ALERT_CHECK_ENABLED: ${checkEnabled}\n`);

  // 2. 检查 Telegram Service
  console.log('2. 检查 Telegram Service:');
  const telegramService = new TelegramService();
  await telegramService.initialize();
  console.log(`   Telegram 初始化: ${telegramService.initialized ? '✅' : '❌'}`);
  console.log(`   Alert Channel ID: ${telegramService.alertChannelId || '(未设置)'}\n`);

  // 3. 检查 Price Alert 配置
  console.log('3. 检查 Price Alert 配置:');
  try {
    const configs = await PriceAlertConfig.findAll();
    const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
    console.log(`   总配置数: ${configs.length}`);
    console.log(`   活跃配置数: ${activeConfigs.length}`);
    
    if (activeConfigs.length > 0) {
      console.log('\n   活跃配置详情:');
      for (const cfg of activeConfigs) {
        console.log(`   - ID: ${cfg.id}, Exchange: ${cfg.exchange}, Threshold: ${cfg.threshold}%, Chat ID: ${cfg.telegram_chat_id || '(未设置)'}`);
        const symbols = typeof cfg.symbols === 'string' ? JSON.parse(cfg.symbols) : (cfg.symbols || []);
        console.log(`      Symbols: ${Array.isArray(symbols) ? symbols.length : 0} symbols`);
        const intervals = typeof cfg.intervals === 'string' ? JSON.parse(cfg.intervals) : (cfg.intervals || []);
        console.log(`      Intervals: ${Array.isArray(intervals) ? intervals.join(', ') : 'N/A'}`);
      }
    } else {
      console.log('   ⚠️  没有活跃的配置！');
    }
  } catch (error) {
    console.log(`   ❌ 错误: ${error.message}`);
  }

  // 4. 测试发送消息
  console.log('\n4. 测试发送消息:');
  if (telegramService.initialized && telegramService.alertChannelId) {
    try {
      await telegramService.sendMessage(telegramService.alertChannelId, '🧪 Price Alert 测试消息');
      console.log('   ✅ 测试消息发送成功');
    } catch (error) {
      console.log(`   ❌ 测试消息发送失败: ${error.message}`);
    }
  } else {
    console.log('   ⚠️  Telegram 未初始化或没有 Alert Channel ID');
  }

  // 5. 测试 sendVolatilityAlert
  console.log('\n5. 测试 sendVolatilityAlert:');
  if (telegramService.initialized && telegramService.alertChannelId) {
    try {
      await telegramService.sendVolatilityAlert(telegramService.alertChannelId, {
        symbol: 'BTCUSDT',
        interval: '1m',
        oc: 5.5,
        open: 50000,
        currentPrice: 52750,
        direction: 'bullish'
      });
      console.log('   ✅ Volatility Alert 测试发送成功');
    } catch (error) {
      console.log(`   ❌ Volatility Alert 测试发送失败: ${error.message}`);
      console.log(`   错误堆栈: ${error.stack}`);
    }
  } else {
    console.log('   ⚠️  Telegram 未初始化或没有 Alert Channel ID');
  }

  console.log('\n=== 诊断完成 ===\n');
  process.exit(0);
}

checkPriceAlert().catch(error => {
  console.error('诊断失败:', error);
  process.exit(1);
});

