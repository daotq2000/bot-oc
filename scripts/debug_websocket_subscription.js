import { Strategy } from '../src/models/Strategy.js';
import { PriceAlertConfig } from '../src/models/PriceAlertConfig.js';
import { webSocketManager } from '../src/services/WebSocketManager.js';
import logger from '../src/utils/logger.js';

function normalizeSymbol(symbol) {
  if (!symbol) return symbol;
  return symbol.toUpperCase().replace(/\//g, '').replace(/:/g, '');
}

async function main() {
  try {
    const strategies = await Strategy.findAll(null, true);
    const alertConfigs = await PriceAlertConfig.findAll();

    const allSymbols = new Set();
    const mexcSymbols = new Set();
    const binanceSymbols = new Set();

    // Collect from strategies
    for (const strategy of strategies) {
      const norm = normalizeSymbol(strategy.symbol);
      allSymbols.add(norm);
      if ((strategy.exchange || '').toLowerCase() === 'mexc') {
        mexcSymbols.add(norm);
      } else if ((strategy.exchange || '').toLowerCase() === 'binance') {
        binanceSymbols.add(norm);
      }
    }

    // Collect from alert configs
    for (const config of alertConfigs) {
      const symbols = typeof config.symbols === 'string' ? JSON.parse(config.symbols) : config.symbols;
      if (Array.isArray(symbols)) {
        for (const symbol of symbols) {
          const normalizedSymbol = normalizeSymbol(symbol);
          allSymbols.add(normalizedSymbol);
          if ((config.exchange || '').toLowerCase() === 'mexc') {
            mexcSymbols.add(normalizedSymbol);
          } else if ((config.exchange || '').toLowerCase() === 'binance') {
            binanceSymbols.add(normalizedSymbol);
          }
        }
      }
    }

    console.log('\n=== WebSocket Subscription Debug ===\n');
    console.log(`Total strategies: ${strategies.length}`);
    console.log(`Total unique symbols: ${allSymbols.size}`);
    console.log(`Binance strategies: ${strategies.filter(s => (s.exchange || '').toLowerCase() === 'binance').length}`);
    console.log(`Binance unique symbols: ${binanceSymbols.size}`);
    console.log(`MEXC strategies: ${strategies.filter(s => (s.exchange || '').toLowerCase() === 'mexc').length}`);
    console.log(`MEXC unique symbols: ${mexcSymbols.size}`);

    // Check WebSocket status
    const wsStatus = webSocketManager.getStatus();
    console.log(`\nWebSocket Status:`);
    console.log(`  Total connections: ${wsStatus.totalConnections}`);
    console.log(`  Connected: ${wsStatus.connectedCount}`);
    console.log(`  Total streams: ${wsStatus.totalStreams}`);

    // Check if THETAUSDT is subscribed
    const thetaPrice = webSocketManager.getPrice('THETAUSDT');
    console.log(`\nTHETAUSDT price from WS: ${thetaPrice || 'NOT AVAILABLE'}`);

    // Sample Binance symbols
    const binanceArray = Array.from(binanceSymbols).sort();
    console.log(`\nSample Binance symbols (first 50):`);
    console.log(binanceArray.slice(0, 50).join(', '));
    if (binanceArray.length > 50) {
      console.log(`... and ${binanceArray.length - 50} more`);
    }

    // Check if THETAUSDT is in the list
    if (binanceSymbols.has('THETAUSDT')) {
      console.log(`\n✅ THETAUSDT is in Binance symbols list`);
    } else {
      console.log(`\n❌ THETAUSDT is NOT in Binance symbols list`);
      // Find strategies with THETA
      const thetaStrategies = strategies.filter(s => 
        normalizeSymbol(s.symbol) === 'THETAUSDT' && (s.exchange || '').toLowerCase() === 'binance'
      );
      console.log(`   Found ${thetaStrategies.length} Binance strategies with THETAUSDT`);
      if (thetaStrategies.length > 0) {
        console.log(`   Sample strategy: ID=${thetaStrategies[0].id}, symbol=${thetaStrategies[0].symbol}, exchange=${thetaStrategies[0].exchange}`);
      }
    }

    process.exit(0);
  } catch (e) {
    logger.error('Debug failed:', e?.message || e);
    console.error(e);
    process.exit(1);
  }
}

main();

