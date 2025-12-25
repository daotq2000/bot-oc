#!/usr/bin/env node

/**
 * Script để liệt kê các coin đang được monitor qua WebSocket trên Binance và MEXC
 */

import { mexcPriceWs } from '../src/services/MexcWebSocketManager.js';
import { webSocketManager } from '../src/services/WebSocketManager.js';
import { strategyCache } from '../src/services/StrategyCache.js';

async function listMonitoredCoins() {
  try {
    console.log('\n=== DANH SÁCH COIN ĐANG MONITOR WEBSOCKET ===\n');

    // Refresh strategy cache để lấy danh sách strategies
    await strategyCache.refresh();

    // Lấy symbols từ strategy cache
    const mexcSymbols = new Set();
    const binanceSymbols = new Set();

    for (const [key, strategy] of strategyCache.cache.entries()) {
      const [exchange, symbol] = key.split('|');
      if (exchange === 'mexc') {
        mexcSymbols.add(symbol);
      } else if (exchange === 'binance') {
        binanceSymbols.add(symbol);
      }
    }

    // Lấy symbols đang subscribe từ WebSocket managers
    const mexcSubscribed = mexcPriceWs?.subscribed ? Array.from(mexcPriceWs.subscribed).sort() : [];
    const binanceStatus = webSocketManager?.getStatus?.() || {};
    
    // Lấy symbols từ Binance connections (từ streams)
    const binanceSubscribed = new Set();
    if (webSocketManager.connections) {
      for (const conn of webSocketManager.connections) {
        if (conn.streams) {
          for (const stream of conn.streams) {
            // Stream format: btcusdt@markPrice, btcusdt@kline_1m, etc.
            const match = stream.match(/^([a-z0-9]+)@/);
            if (match) {
              binanceSubscribed.add(match[1].toUpperCase());
            }
          }
        }
      }
    }
    const binanceSubscribedList = Array.from(binanceSubscribed).sort();

    // Hiển thị kết quả
    console.log('📊 BINANCE FUTURES:');
    console.log(`   - Tổng số coin trong strategies: ${binanceSymbols.size}`);
    console.log(`   - Tổng số coin đang subscribe WebSocket: ${binanceSubscribedList.length}`);
    console.log(`   - Số kết nối WebSocket: ${binanceStatus.totalConnections || 0}`);
    console.log(`   - Số kết nối đang mở: ${binanceStatus.connectedCount || 0}`);
    console.log(`   - Tổng số streams: ${binanceStatus.totalStreams || 0}`);
    
    if (binanceSubscribedList.length > 0) {
      console.log(`\n   ✅ Danh sách coin Binance đang subscribe WebSocket (${binanceSubscribedList.length}):`);
      // Hiển thị theo nhóm 10 coin mỗi dòng
      for (let i = 0; i < binanceSubscribedList.length; i += 10) {
        const chunk = binanceSubscribedList.slice(i, i + 10);
        console.log(`   ${chunk.join(', ')}`);
      }
    }
    
    if (binanceSymbols.size > 0) {
      const binanceSymbolsList = Array.from(binanceSymbols).sort();
      if (binanceSubscribedList.length === 0) {
        console.log(`\n   📋 Danh sách coin Binance trong strategies (${binanceSymbolsList.length}) - WebSocket chưa kết nối:`);
      } else {
        console.log(`\n   📋 Danh sách coin Binance trong strategies (${binanceSymbolsList.length}):`);
      }
      for (let i = 0; i < binanceSymbolsList.length; i += 10) {
        const chunk = binanceSymbolsList.slice(i, i + 10);
        console.log(`   ${chunk.join(', ')}`);
      }
    }

    console.log('\n📊 MEXC FUTURES:');
    console.log(`   - Tổng số coin trong strategies: ${mexcSymbols.size}`);
    console.log(`   - Tổng số coin đang subscribe WebSocket: ${mexcSubscribed.length}`);
    console.log(`   - WebSocket connected: ${mexcPriceWs?.ws?.readyState === 1 ? '✅ Có' : '❌ Không'}`);
    
    if (mexcSubscribed.length > 0) {
      console.log(`\n   ✅ Danh sách coin MEXC đang subscribe WebSocket (${mexcSubscribed.length}):`);
      // Hiển thị theo nhóm 10 coin mỗi dòng
      for (let i = 0; i < mexcSubscribed.length; i += 10) {
        const chunk = mexcSubscribed.slice(i, i + 10);
        console.log(`   ${chunk.join(', ')}`);
      }
    }
    
    if (mexcSymbols.size > 0) {
      const mexcSymbolsList = Array.from(mexcSymbols).sort();
      if (mexcSubscribed.length === 0) {
        console.log(`\n   📋 Danh sách coin MEXC trong strategies (${mexcSymbolsList.length}) - WebSocket chưa kết nối:`);
      } else {
        console.log(`\n   📋 Danh sách coin MEXC trong strategies (${mexcSymbolsList.length}):`);
      }
      for (let i = 0; i < mexcSymbolsList.length; i += 10) {
        const chunk = mexcSymbolsList.slice(i, i + 10);
        console.log(`   ${chunk.join(', ')}`);
      }
    }

    // Tổng kết
    console.log('\n📈 TỔNG KẾT:');
    console.log(`   - Tổng số coin Binance (trong strategies): ${binanceSymbols.size}`);
    console.log(`   - Tổng số coin Binance (đang subscribe): ${binanceSubscribedList.length}`);
    console.log(`   - Tổng số coin MEXC (trong strategies): ${mexcSymbols.size}`);
    console.log(`   - Tổng số coin MEXC (đang subscribe): ${mexcSubscribed.length}`);
    console.log(`   - Tổng cộng coin trong strategies: ${binanceSymbols.size + mexcSymbols.size}`);
    console.log(`   - Tổng cộng coin đang subscribe: ${binanceSubscribedList.length + mexcSubscribed.length}\n`);

  } catch (error) {
    console.error('❌ Lỗi khi liệt kê coin:', error?.message || error);
    console.error(error?.stack);
    process.exit(1);
  }
}

// Chạy script
listMonitoredCoins()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('❌ Lỗi:', error?.message || error);
    process.exit(1);
  });

