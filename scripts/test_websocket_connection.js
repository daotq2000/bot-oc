import { mexcPriceWs } from '../src/services/MexcWebSocketManager.js';
import { webSocketManager } from '../src/services/WebSocketManager.js';
import { priceAlertSymbolTracker } from '../src/services/PriceAlertSymbolTracker.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function testWebSocketConnection() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('TEST WEBSOCKET CONNECTION - BINANCE & MEXC');
    console.log('='.repeat(80) + '\n');

    await configService.loadAll();

    // Refresh symbols
    await priceAlertSymbolTracker.refresh();
    const trackingSymbols = priceAlertSymbolTracker.getAllSymbols();

    // Test MEXC WebSocket
    console.log('📋 TEST MEXC WEBSOCKET:');
    console.log('-'.repeat(80));
    
    const mexcSymbols = Array.from(trackingSymbols.get('mexc') || []).slice(0, 5);
    console.log(`   Testing with ${mexcSymbols.length} symbols: ${mexcSymbols.join(', ')}`);
    
    if (mexcSymbols.length > 0) {
      console.log('   Subscribing symbols...');
      mexcPriceWs.subscribe(mexcSymbols);
      
      // Wait for connection
      console.log('   Waiting for connection...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const mexcConnected = mexcPriceWs?.ws?.readyState === 1;
      const mexcSubscribed = mexcPriceWs?.subscribed?.size || 0;
      console.log(`   Status: ${mexcConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
      console.log(`   Subscribed symbols: ${mexcSubscribed}`);
      
      if (mexcConnected) {
        console.log('   Testing price fetching...');
        for (const symbol of mexcSymbols) {
          const price = mexcPriceWs.getPrice(symbol);
          if (price && Number.isFinite(price) && price > 0) {
            console.log(`     ✅ ${symbol}: ${price}`);
          } else {
            console.log(`     ⚠️  ${symbol}: No price yet (may need more time)`);
          }
        }
      } else {
        console.log('   ⚠️  WebSocket not connected. Trying to ensure connection...');
        mexcPriceWs.ensureConnected();
        await new Promise(resolve => setTimeout(resolve, 3000));
        const retryConnected = mexcPriceWs?.ws?.readyState === 1;
        console.log(`   Retry status: ${retryConnected ? '✅ CONNECTED' : '❌ STILL DISCONNECTED'}`);
      }
    } else {
      console.log('   ⚠️  No MEXC symbols to test');
    }
    console.log('');

    // Test Binance WebSocket
    console.log('📋 TEST BINANCE WEBSOCKET:');
    console.log('-'.repeat(80));
    
    const binanceSymbols = Array.from(trackingSymbols.get('binance') || []).slice(0, 5);
    console.log(`   Testing with ${binanceSymbols.length} symbols: ${binanceSymbols.join(', ')}`);
    
    if (binanceSymbols.length > 0) {
      console.log('   Subscribing symbols...');
      webSocketManager.subscribe(binanceSymbols);
      
      // Ensure connection
      console.log('   Ensuring connection...');
      webSocketManager.connect();
      
      // Wait for connection
      console.log('   Waiting for connection...');
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const binanceStatus = webSocketManager.getStatus();
      const binanceConnected = binanceStatus.connectedCount > 0;
      console.log(`   Status: ${binanceConnected ? '✅ CONNECTED' : '❌ DISCONNECTED'}`);
      console.log(`   Connections: ${binanceStatus.connectedCount}/${binanceStatus.totalConnections}`);
      console.log(`   Total streams: ${binanceStatus.totalStreams}`);
      
      if (binanceConnected) {
        console.log('   Testing price fetching...');
        for (const symbol of binanceSymbols) {
          const price = webSocketManager.getPrice(symbol);
          if (price && Number.isFinite(price) && price > 0) {
            console.log(`     ✅ ${symbol}: ${price}`);
          } else {
            console.log(`     ⚠️  ${symbol}: No price yet (may need more time)`);
          }
        }
      } else {
        console.log('   ⚠️  WebSocket not connected');
      }
    } else {
      console.log('   ⚠️  No Binance symbols to test');
    }
    console.log('');

    // Summary
    console.log('📋 SUMMARY:');
    console.log('='.repeat(80));
    const finalMexcConnected = mexcPriceWs?.ws?.readyState === 1;
    const finalBinanceStatus = webSocketManager.getStatus();
    const finalBinanceConnected = finalBinanceStatus.connectedCount > 0;
    
    if (finalMexcConnected && finalBinanceConnected) {
      console.log('✅ Both WebSockets are connected!');
    } else {
      if (!finalMexcConnected) {
        console.log('❌ MEXC WebSocket is not connected');
      }
      if (!finalBinanceConnected) {
        console.log('❌ Binance WebSocket is not connected');
      }
    }
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Error:', error);
    logger.error('Error testing WebSocket connection:', error);
  }
}

// Run test
testWebSocketConnection()
  .then(() => {
    // Keep process alive for a bit to see WebSocket messages
    setTimeout(() => {
      process.exit(0);
    }, 5000);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

