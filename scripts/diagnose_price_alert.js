#!/usr/bin/env node

/**
 * Script để chẩn đoán vấn đề Price Alert cho MEXC và Binance
 */

import { configService } from '../src/services/ConfigService.js';
import { priceAlertSymbolTracker } from '../src/services/PriceAlertSymbolTracker.js';
import { mexcPriceWs } from '../src/services/MexcWebSocketManager.js';
import { webSocketManager } from '../src/services/WebSocketManager.js';
import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import logger from '../src/utils/logger.js';

async function diagnose() {
  console.log('\n🔍 Price Alert Diagnostic Tool\n');
  console.log('='.repeat(60));

  // 1. Check Config Flags
  console.log('\n1️⃣  Checking Configuration Flags:');
  const moduleEnabled = configService.getBoolean('PRICE_ALERT_MODULE_ENABLED', true);
  const checkEnabled = configService.getBoolean('PRICE_ALERT_CHECK_ENABLED', true);
  const alertsEnabled = configService.getBoolean('ENABLE_ALERTS', true);
  const scannerEnabled = configService.getBoolean('PRICE_ALERT_USE_SCANNER', true);
  const wsEnabled = configService.getBoolean('PRICE_ALERT_USE_WEBSOCKET', false);

  console.log(`   PRICE_ALERT_MODULE_ENABLED: ${moduleEnabled ? '✅' : '❌'} ${moduleEnabled}`);
  console.log(`   PRICE_ALERT_CHECK_ENABLED: ${checkEnabled ? '✅' : '❌'} ${checkEnabled}`);
  console.log(`   ENABLE_ALERTS: ${alertsEnabled ? '✅' : '❌'} ${alertsEnabled}`);
  console.log(`   PRICE_ALERT_USE_SCANNER: ${scannerEnabled ? '✅' : '❌'} ${scannerEnabled}`);
  console.log(`   PRICE_ALERT_USE_WEBSOCKET: ${wsEnabled ? '✅' : '❌'} ${wsEnabled}`);

  if (!moduleEnabled || !checkEnabled || !alertsEnabled) {
    console.log('   ⚠️  WARNING: Some critical flags are disabled!');
  }

  // 2. Check Telegram Bot Tokens
  console.log('\n2️⃣  Checking Telegram Bot Tokens:');
  const mexcToken = configService.getString('TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC');
  const binanceToken = configService.getString('TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE');
  
  console.log(`   TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC: ${mexcToken ? '✅ Configured' : '❌ NOT CONFIGURED'}`);
  console.log(`   TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE: ${binanceToken ? '✅ Configured' : '❌ NOT CONFIGURED'}`);

  if (!mexcToken || !binanceToken) {
    console.log('   ⚠️  WARNING: Telegram bot tokens are missing! Alerts cannot be sent.');
  }

  // 3. Check Price Alert Configs
  console.log('\n3️⃣  Checking Price Alert Configs:');
  try {
    const configs = await PriceAlertConfig.findAll();
    const activeConfigs = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1');
    
    console.log(`   Total configs: ${configs.length}`);
    console.log(`   Active configs: ${activeConfigs.length}`);

    if (activeConfigs.length === 0) {
      console.log('   ⚠️  WARNING: No active price alert configs found!');
    } else {
      for (const config of activeConfigs) {
        const exchange = (config.exchange || 'mexc').toLowerCase();
        const threshold = config.threshold || 0;
        const chatId = config.telegram_chat_id || 'N/A';
        const intervals = Array.isArray(config.intervals) ? config.intervals.join(', ') : (config.intervals || '1m');
        const symbols = config.symbols ? (Array.isArray(config.symbols) ? config.symbols.length : 'N/A') : 'from symbol_filters';
        
        console.log(`   Config ${config.id} (${exchange}): threshold=${threshold}% chat_id=${chatId} intervals=[${intervals}] symbols=${symbols}`);
      }
    }
  } catch (error) {
    console.log(`   ❌ ERROR: Failed to load configs: ${error?.message || error}`);
  }

  // 4. Check Symbol Tracking
  console.log('\n4️⃣  Checking Symbol Tracking:');
  try {
    await priceAlertSymbolTracker.refresh(true); // Force refresh
    const trackingSymbols = priceAlertSymbolTracker.getAllSymbols(false);
    
    for (const [exchange, symbols] of trackingSymbols.entries()) {
      console.log(`   ${exchange.toUpperCase()}: ${symbols.size} symbols tracked`);
      if (symbols.size === 0) {
        console.log(`   ⚠️  WARNING: No symbols tracked for ${exchange}!`);
      } else {
        // Show first 5 symbols as sample
        const sampleSymbols = Array.from(symbols).slice(0, 5);
        console.log(`   Sample symbols: ${sampleSymbols.join(', ')}${symbols.size > 5 ? '...' : ''}`);
      }
    }
  } catch (error) {
    console.log(`   ❌ ERROR: Failed to refresh symbols: ${error?.message || error}`);
  }

  // 5. Check WebSocket Status
  console.log('\n5️⃣  Checking WebSocket Status:');
  
  // MEXC
  try {
    const mexcStatus = mexcPriceWs.getStatus();
    console.log(`   MEXC WebSocket: ${mexcStatus?.connected ? '✅ Connected' : '❌ Not Connected'}`);
    if (mexcStatus) {
      console.log(`     - ReadyState: ${mexcStatus.readyState || 'N/A'}`);
      console.log(`     - Subscribed symbols: ${mexcStatus.subscribedCount || 0}`);
    }
  } catch (error) {
    console.log(`   ❌ ERROR checking MEXC WebSocket: ${error?.message || error}`);
  }

  // Binance
  try {
    const binanceStatus = webSocketManager.getStatus();
    console.log(`   Binance WebSocket: ${binanceStatus?.connectedCount > 0 ? `✅ Connected (${binanceStatus.connectedCount} streams)` : '❌ Not Connected'}`);
    if (binanceStatus) {
      console.log(`     - Connected streams: ${binanceStatus.connectedCount || 0}`);
      console.log(`     - Subscribed symbols: ${binanceStatus.subscribedSymbols?.size || 0}`);
    }
  } catch (error) {
    console.log(`   ❌ ERROR checking Binance WebSocket: ${error?.message || error}`);
  }

  // 6. Test Price Retrieval
  console.log('\n6️⃣  Testing Price Retrieval:');
  const testSymbols = {
    mexc: ['BTCUSDT', 'ETHUSDT'],
    binance: ['BTCUSDT', 'ETHUSDT']
  };

  for (const [exchange, symbols] of Object.entries(testSymbols)) {
    console.log(`   ${exchange.toUpperCase()}:`);
    for (const symbol of symbols) {
      try {
        let price = null;
        if (exchange === 'mexc') {
          price = mexcPriceWs.getPrice(symbol);
        } else if (exchange === 'binance') {
          price = webSocketManager.getPrice(symbol);
        }
        
        if (price && Number.isFinite(price) && price > 0) {
          console.log(`     ✅ ${symbol}: ${price}`);
        } else {
          console.log(`     ❌ ${symbol}: No price available (WebSocket may not be receiving updates)`);
        }
      } catch (error) {
        console.log(`     ❌ ${symbol}: Error - ${error?.message || error}`);
      }
    }
  }

  // 7. Summary
  console.log('\n' + '='.repeat(60));
  console.log('\n📊 Summary:');
  console.log(`   Module Enabled: ${moduleEnabled ? '✅' : '❌'}`);
  console.log(`   Check Enabled: ${checkEnabled ? '✅' : '❌'}`);
  console.log(`   Alerts Enabled: ${alertsEnabled ? '✅' : '❌'}`);
  console.log(`   MEXC Bot Token: ${mexcToken ? '✅' : '❌'}`);
  console.log(`   Binance Bot Token: ${binanceToken ? '✅' : '❌'}`);
  
  let activeConfigsCount = 0;
  try {
    const configs = await PriceAlertConfig.findAll();
    activeConfigsCount = configs.filter(cfg => cfg.is_active === true || cfg.is_active === 1 || cfg.is_active === '1').length;
  } catch (e) {
    // Ignore
  }
  
  const trackingSymbols = await priceAlertSymbolTracker.refresh(true);
  console.log(`   Active Configs: ${activeConfigsCount}`);
  console.log(`   MEXC Symbols: ${trackingSymbols?.get('mexc')?.size || 0}`);
  console.log(`   Binance Symbols: ${trackingSymbols?.get('binance')?.size || 0}`);
  
  console.log('\n💡 Next Steps:');
  if (!moduleEnabled || !checkEnabled || !alertsEnabled) {
    console.log('   1. Enable PRICE_ALERT_MODULE_ENABLED, PRICE_ALERT_CHECK_ENABLED, and ENABLE_ALERTS');
  }
  if (!mexcToken || !binanceToken) {
    console.log('   2. Configure TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC and TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE');
  }
  if (!activeConfigs || activeConfigs.length === 0) {
    console.log('   3. Create active price alert configs in database');
  }
  if (trackingSymbols?.get('mexc')?.size === 0 || trackingSymbols?.get('binance')?.size === 0) {
    console.log('   4. Check symbol_filters table or add symbols to price_alert_config');
  }
  
  console.log('\n');
}

diagnose().catch(error => {
  console.error('❌ Diagnostic failed:', error);
  process.exit(1);
});

