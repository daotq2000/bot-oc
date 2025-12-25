#!/usr/bin/env node

/**
 * Script test để so sánh price tracking giữa MEXC và Binance
 * Kiểm tra xem WebSocket có được subscribe và price có update không
 */

import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { priceAlertSymbolTracker } from '../src/services/PriceAlertSymbolTracker.js';
import { webSocketManager } from '../src/services/WebSocketManager.js';
import { mexcPriceWs } from '../src/services/MexcWebSocketManager.js';
import { configService } from '../src/services/ConfigService.js';

dotenv.config();

async function testPriceTracking() {
  console.log('\n=== TEST PRICE TRACKING MEXC vs BINANCE ===\n');

  try {
    // 1. Kiểm tra symbols được track
    console.log('📊 1. KIỂM TRA SYMBOLS ĐƯỢC TRACK:');
    await priceAlertSymbolTracker.refresh();
    const mexcSymbols = priceAlertSymbolTracker.getSymbolsForExchange('mexc');
    const binanceSymbols = priceAlertSymbolTracker.getSymbolsForExchange('binance');
    console.log(`   - MEXC symbols: ${mexcSymbols.size}`);
    console.log(`   - Binance symbols: ${binanceSymbols.size}`);
    
    // Lấy một số symbols để test
    const testSymbols = {
      mexc: Array.from(mexcSymbols).slice(0, 5),
      binance: Array.from(binanceSymbols).slice(0, 5)
    };
    console.log(`   - Test MEXC symbols: ${testSymbols.mexc.join(', ')}`);
    console.log(`   - Test Binance symbols: ${testSymbols.binance.join(', ')}`);

    // 2. Kiểm tra WebSocket subscriptions
    console.log('\n📡 2. KIỂM TRA WEBSOCKET SUBSCRIPTIONS:');
    
    // MEXC
    const mexcSubscribed = mexcPriceWs?.subscribed ? Array.from(mexcPriceWs.subscribed) : [];
    console.log(`   - MEXC WebSocket subscribed: ${mexcSubscribed.length} symbols`);
    console.log(`   - MEXC WebSocket connected: ${mexcPriceWs?.ws?.readyState === 1 ? '✅' : '❌'}`);
    if (mexcSubscribed.length > 0) {
      console.log(`   - Sample MEXC subscribed: ${mexcSubscribed.slice(0, 10).join(', ')}`);
    }

    // Binance
    const binanceStatus = webSocketManager?.getStatus?.() || {};
    console.log(`   - Binance WebSocket connections: ${binanceStatus.totalConnections || 0}`);
    console.log(`   - Binance WebSocket connected: ${binanceStatus.connectedCount || 0}`);
    console.log(`   - Binance WebSocket streams: ${binanceStatus.totalStreams || 0}`);
    
    // Lấy symbols từ Binance connections
    const binanceSubscribed = new Set();
    if (webSocketManager.connections) {
      for (const conn of webSocketManager.connections) {
        if (conn.streams) {
          for (const stream of conn.streams) {
            const match = stream.match(/^([a-z0-9]+)@markPrice/);
            if (match) {
              binanceSubscribed.add(match[1].toUpperCase());
            }
          }
        }
      }
    }
    console.log(`   - Binance WebSocket subscribed: ${binanceSubscribed.size} symbols`);
    if (binanceSubscribed.size > 0) {
      const binanceList = Array.from(binanceSubscribed).slice(0, 10);
      console.log(`   - Sample Binance subscribed: ${binanceList.join(', ')}`);
    }

    // 3. Test lấy price từ WebSocket
    console.log('\n💰 3. TEST LẤY PRICE TỪ WEBSOCKET:');
    
    // Test MEXC
    if (testSymbols.mexc.length > 0) {
      const testSymbol = testSymbols.mexc[0];
      console.log(`\n   MEXC - Symbol: ${testSymbol}`);
      const mexcWsPrice = mexcPriceWs.getPrice(testSymbol);
      console.log(`   - WebSocket price: ${mexcWsPrice || 'NULL'}`);
      
      // Test lấy từ ExchangeService
      try {
        const bot = await Bot.findById(3); // Test với bot 3
        if (bot && bot.exchange === 'mexc') {
          const exSvc = new ExchangeService(bot);
          await exSvc.initialize();
          const exPrice = await exSvc.getTickerPrice(testSymbol);
          console.log(`   - ExchangeService price: ${exPrice || 'NULL'}`);
        }
      } catch (e) {
        console.log(`   - ExchangeService error: ${e?.message || e}`);
      }
    }

    // Test Binance
    if (testSymbols.binance.length > 0) {
      const testSymbol = testSymbols.binance[0];
      console.log(`\n   Binance - Symbol: ${testSymbol}`);
      const binanceWsPrice = webSocketManager.getPrice(testSymbol);
      console.log(`   - WebSocket price: ${binanceWsPrice || 'NULL'}`);
      
      // Test lấy từ ExchangeService
      try {
        const bot = await Bot.findById(3); // Test với bot 3
        if (bot && bot.exchange === 'binance') {
          const exSvc = new ExchangeService(bot);
          await exSvc.initialize();
          const exPrice = await exSvc.getTickerPrice(testSymbol);
          console.log(`   - ExchangeService price: ${exPrice || 'NULL'}`);
        }
      } catch (e) {
        console.log(`   - ExchangeService error: ${e?.message || e}`);
      }
    }

    // 4. Test PriceAlertScanner getPrice
    console.log('\n🔍 4. TEST PRICEALERTSCANNER GETPRICE:');
    
    const { PriceAlertScanner } = await import('../src/jobs/PriceAlertScanner.js');
    const scanner = new PriceAlertScanner();
    const mockTelegram = { sendVolatilityAlert: () => Promise.resolve() };
    await scanner.initialize(mockTelegram);
    
    // Test MEXC
    if (testSymbols.mexc.length > 0) {
      const testSymbol = testSymbols.mexc[0];
      console.log(`\n   MEXC - Symbol: ${testSymbol}`);
      const price = await scanner.getPrice('mexc', testSymbol);
      console.log(`   - Scanner price: ${price || 'NULL'}`);
    }

    // Test Binance
    if (testSymbols.binance.length > 0) {
      const testSymbol = testSymbols.binance[0];
      console.log(`\n   Binance - Symbol: ${testSymbol}`);
      const price = await scanner.getPrice('binance', testSymbol);
      console.log(`   - Scanner price: ${price || 'NULL'}`);
    }

    // 5. Kiểm tra config
    console.log('\n⚙️  5. KIỂM TRA CONFIG:');
    console.log(`   - BINANCE_TICKER_REST_FALLBACK: ${configService.getBoolean('BINANCE_TICKER_REST_FALLBACK', false)}`);
    console.log(`   - MEXC_TICKER_REST_FALLBACK: ${configService.getBoolean('MEXC_TICKER_REST_FALLBACK', false)}`);
    console.log(`   - PRICE_ALERT_SCAN_INTERVAL_MS: ${configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 500)}`);

    // 6. So sánh realtime tracking
    console.log('\n📈 6. TEST REALTIME TRACKING (10 giây):');
    
    const testSymbol = 'HIPPOUSDT'; // Symbol từ ví dụ của user
    console.log(`   Testing symbol: ${testSymbol}`);
    
    // MEXC
    console.log(`\n   MEXC:`);
    const mexcPrices = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const price = mexcPriceWs.getPrice(testSymbol);
      mexcPrices.push(price);
      console.log(`     ${i + 1}. Price: ${price || 'NULL'} (${new Date().toLocaleTimeString()})`);
    }
    const mexcChanges = mexcPrices.filter((p, i) => i > 0 && p !== mexcPrices[i - 1]).length;
    console.log(`   - MEXC price changes detected: ${mexcChanges}/4`);

    // Binance
    console.log(`\n   Binance:`);
    const binancePrices = [];
    for (let i = 0; i < 5; i++) {
      await new Promise(resolve => setTimeout(resolve, 2000));
      const price = webSocketManager.getPrice(testSymbol);
      binancePrices.push(price);
      console.log(`     ${i + 1}. Price: ${price || 'NULL'} (${new Date().toLocaleTimeString()})`);
    }
    const binanceChanges = binancePrices.filter((p, i) => i > 0 && p !== binancePrices[i - 1]).length;
    console.log(`   - Binance price changes detected: ${binanceChanges}/4`);

    // 7. Tổng kết
    console.log('\n📊 7. TỔNG KẾT:');
    console.log(`   - MEXC WebSocket: ${mexcPriceWs?.ws?.readyState === 1 ? '✅ Connected' : '❌ Not connected'}`);
    console.log(`   - MEXC Subscribed: ${mexcSubscribed.length} symbols`);
    console.log(`   - MEXC Price tracking: ${mexcChanges > 0 ? '✅ Working' : '❌ Not updating'}`);
    console.log(`   - Binance WebSocket: ${binanceStatus.connectedCount > 0 ? '✅ Connected' : '❌ Not connected'}`);
    console.log(`   - Binance Subscribed: ${binanceSubscribed.size} symbols`);
    console.log(`   - Binance Price tracking: ${binanceChanges > 0 ? '✅ Working' : '❌ Not updating'}`);
    
    if (binanceChanges === 0 && binanceSubscribed.size === 0) {
      console.log(`\n   ⚠️  VẤN ĐỀ: Binance không có symbols được subscribe!`);
      console.log(`   → Cần kiểm tra PriceAlertWorker có subscribe Binance symbols không`);
    }

  } catch (error) {
    console.error('\n❌ LỖI:', error?.message || error);
    console.error('Stack:', error?.stack);
    process.exit(1);
  }
}

testPriceTracking()
  .then(() => {
    console.log('\n✅ Test hoàn thành!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Test thất bại:', error?.message || error);
    process.exit(1);
  });

