import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { priceAlertSymbolTracker } from '../src/services/PriceAlertSymbolTracker.js';
import { configService } from '../src/services/ConfigService.js';
import { mexcPriceWs } from '../src/services/MexcWebSocketManager.js';
import { webSocketManager } from '../src/services/WebSocketManager.js';
import logger from '../src/utils/logger.js';

async function checkAlertModules() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('KIỂM TRA MODULE ALERT - BINANCE & MEXC');
    console.log('='.repeat(80) + '\n');

    // 1. Load configs
    await configService.loadAll();

    // 2. Check master switches
    console.log('📋 1. KIỂM TRA CẤU HÌNH MASTER SWITCHES:');
    console.log('-'.repeat(80));
    const enableAlerts = configService.getBoolean('ENABLE_ALERTS', true);
    const moduleEnabled = configService.getBoolean('PRICE_ALERT_MODULE_ENABLED', true);
    console.log(`   ENABLE_ALERTS: ${enableAlerts ? '✅ ENABLED' : '❌ DISABLED'}`);
    console.log(`   PRICE_ALERT_MODULE_ENABLED: ${moduleEnabled ? '✅ ENABLED' : '❌ DISABLED'}`);
    
    if (!enableAlerts || !moduleEnabled) {
      console.log('\n⚠️  CẢNH BÁO: Một hoặc cả hai master switches đang bị tắt!');
      console.log('   Module alert sẽ không hoạt động.\n');
    }
    console.log('');

    // 3. Check price alert configs
    console.log('📋 2. KIỂM TRA PRICE ALERT CONFIGS:');
    console.log('-'.repeat(80));
    const allConfigs = await PriceAlertConfig.findAllAny();
    const activeConfigs = await PriceAlertConfig.findAll();
    
    console.log(`   Tổng số configs: ${allConfigs.length}`);
    console.log(`   Active configs: ${activeConfigs.length}\n`);

    if (activeConfigs.length === 0) {
      console.log('⚠️  CẢNH BÁO: Không có active config nào!');
      console.log('   Module alert sẽ không hoạt động.\n');
    } else {
      for (const cfg of activeConfigs) {
        console.log(`   Config ID: ${cfg.id}`);
        console.log(`     Exchange: ${cfg.exchange}`);
        console.log(`     is_active: ${cfg.is_active}`);
        console.log(`     Threshold: ${cfg.threshold}%`);
        console.log(`     Intervals: ${JSON.stringify(cfg.intervals)}`);
        console.log(`     Telegram Chat ID: ${cfg.telegram_chat_id || '❌ MISSING'}`);
        
        let symbols = [];
        if (cfg.symbols) {
          if (typeof cfg.symbols === 'string') {
            try {
              symbols = JSON.parse(cfg.symbols);
            } catch (e) {
              symbols = [];
            }
          } else if (Array.isArray(cfg.symbols)) {
            symbols = cfg.symbols;
          }
        }
        console.log(`     Symbols (from config): ${symbols.length > 0 ? symbols.length : 'EMPTY (will use symbol_filters)'}`);
        console.log('');
      }
    }

    // 4. Check symbol tracking
    console.log('📋 3. KIỂM TRA SYMBOL TRACKING:');
    console.log('-'.repeat(80));
    await priceAlertSymbolTracker.refresh();
    const trackingSymbols = priceAlertSymbolTracker.getAllSymbols();
    
    for (const [exchange, symbols] of trackingSymbols.entries()) {
      console.log(`   ${exchange.toUpperCase()}: ${symbols.size} symbols`);
      if (symbols.size > 0) {
        const sampleSymbols = Array.from(symbols).slice(0, 5);
        console.log(`     Sample: ${sampleSymbols.join(', ')}${symbols.size > 5 ? '...' : ''}`);
      } else {
        console.log(`     ⚠️  Không có symbols nào được track!`);
      }
    }
    console.log('');

    // 5. Check WebSocket connections
    console.log('📋 4. KIỂM TRA WEBSOCKET CONNECTIONS:');
    console.log('-'.repeat(80));
    
    // MEXC WebSocket
    const mexcWsConnected = mexcPriceWs?.ws?.readyState === 1; // WebSocket.OPEN = 1
    const mexcSubscribed = mexcPriceWs?.subscribed?.size || 0;
    const mexcPriceCache = mexcPriceWs?.priceCache?.size || 0;
    console.log(`   MEXC WebSocket:`);
    console.log(`     Status: ${mexcWsConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
    console.log(`     Subscribed symbols: ${mexcSubscribed}`);
    console.log(`     Price cache size: ${mexcPriceCache}`);
    console.log(`     Price handlers: ${mexcPriceWs?._priceHandlers?.size || 0}`);
    
    if (!mexcWsConnected) {
      console.log(`     ⚠️  MEXC WebSocket không kết nối!`);
    }
    if (mexcSubscribed === 0) {
      console.log(`     ⚠️  Không có symbols nào được subscribe!`);
    }
    console.log('');

    // Binance WebSocket
    const binanceStatus = webSocketManager?.getStatus?.() || {};
    const binanceConnected = binanceStatus.connectedCount > 0;
    const binanceStreams = binanceStatus.totalStreams || 0;
    const binancePriceCache = webSocketManager?.priceCache?.size || 0;
    console.log(`   Binance WebSocket:`);
    console.log(`     Status: ${binanceConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
    console.log(`     Connections: ${binanceStatus.connectedCount || 0}/${binanceStatus.totalConnections || 0}`);
    console.log(`     Total streams: ${binanceStreams}`);
    console.log(`     Price cache size: ${binancePriceCache}`);
    console.log(`     Price handlers: ${webSocketManager?._priceHandlers?.size || 0}`);
    
    if (!binanceConnected) {
      console.log(`     ⚠️  Binance WebSocket không kết nối!`);
    }
    if (binanceStreams === 0) {
      console.log(`     ⚠️  Không có streams nào được subscribe!`);
    }
    console.log('');

    // 6. Test price fetching
    console.log('📋 5. KIỂM TRA LẤY GIÁ:');
    console.log('-'.repeat(80));
    
    // Test MEXC
    const mexcSymbols = Array.from(trackingSymbols.get('mexc') || []).slice(0, 3);
    if (mexcSymbols.length > 0) {
      console.log(`   MEXC (testing ${mexcSymbols.length} symbols):`);
      for (const symbol of mexcSymbols) {
        const price = mexcPriceWs?.getPrice?.(symbol);
        if (price && Number.isFinite(price) && price > 0) {
          console.log(`     ✅ ${symbol}: ${price}`);
        } else {
          console.log(`     ❌ ${symbol}: Không có giá (price=${price})`);
        }
      }
    } else {
      console.log(`   MEXC: Không có symbols để test`);
    }
    console.log('');

    // Test Binance
    const binanceSymbols = Array.from(trackingSymbols.get('binance') || []).slice(0, 3);
    if (binanceSymbols.length > 0) {
      console.log(`   Binance (testing ${binanceSymbols.length} symbols):`);
      for (const symbol of binanceSymbols) {
        const price = webSocketManager?.getPrice?.(symbol);
        if (price && Number.isFinite(price) && price > 0) {
          console.log(`     ✅ ${symbol}: ${price}`);
        } else {
          console.log(`     ❌ ${symbol}: Không có giá (price=${price})`);
        }
      }
    } else {
      console.log(`   Binance: Không có symbols để test`);
    }
    console.log('');

    // 7. Summary
    console.log('📋 6. TÓM TẮT:');
    console.log('='.repeat(80));
    
    const issues = [];
    
    if (!enableAlerts || !moduleEnabled) {
      issues.push('Master switches bị tắt');
    }
    
    if (activeConfigs.length === 0) {
      issues.push('Không có active configs');
    }
    
    const mexcSymbolCount = trackingSymbols.get('mexc')?.size || 0;
    const binanceSymbolCount = trackingSymbols.get('binance')?.size || 0;
    
    if (mexcSymbolCount === 0 && activeConfigs.some(c => c.exchange?.toLowerCase() === 'mexc')) {
      issues.push('MEXC: Không có symbols được track');
    }
    
    if (binanceSymbolCount === 0 && activeConfigs.some(c => c.exchange?.toLowerCase() === 'binance')) {
      issues.push('Binance: Không có symbols được track');
    }
    
    if (!mexcWsConnected && mexcSymbolCount > 0) {
      issues.push('MEXC WebSocket không kết nối');
    }
    
    if (!binanceConnected && binanceSymbolCount > 0) {
      issues.push('Binance WebSocket không kết nối');
    }
    
    if (issues.length === 0) {
      console.log('✅ Tất cả các module alert đang hoạt động bình thường!');
    } else {
      console.log('❌ CÁC VẤN ĐỀ PHÁT HIỆN:');
      issues.forEach((issue, idx) => {
        console.log(`   ${idx + 1}. ${issue}`);
      });
    }
    
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Lỗi khi kiểm tra:', error);
    logger.error('Error checking alert modules:', error);
  }
}

// Run check
checkAlertModules()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

