import WebSocket from 'ws';
import logger from '../src/utils/logger.js';

/**
 * Test script to find the correct MEXC WebSocket subscription format
 * Tests multiple endpoints and subscription formats
 */

const testSymbols = ['BTC_USDT', 'ETH_USDT', 'BNB_USDT'];
const endpoints = [
  // MEXC Futures WebSocket endpoint (from official documentation)
  'wss://contract.mexc.com/edge',  // Official futures endpoint
  'wss://contract.mexc.co/edge',   // Alternative domain
  // Other endpoints to test
  'wss://wbs-api.mexc.com/ws',     // New API endpoint (found in previous test)
  'wss://wbs-api.mexc.co/ws',
  'wss://contract.mexc.com/ws',    // Old endpoint
  'wss://wbs.mexc.co/ws'
];

const subscriptionFormats = [
  // Format 1: Official MEXC Futures format (from documentation)
  {
    name: 'sub.ticker_futures',
    format: (symbol) => JSON.stringify({ method: 'sub.ticker', param: { symbol } })
  },
  // Format 2: Original format (tested before)
  {
    name: 'method+param',
    format: (symbol) => JSON.stringify({ method: 'sub.ticker', param: { symbol } })
  },
  // Format 2: With id
  {
    name: 'method+param+id',
    format: (symbol) => JSON.stringify({ method: 'sub.ticker', param: { symbol }, id: Date.now().toString() })
  },
  // Format 3: op+args (like Binance)
  {
    name: 'op+args',
    format: (symbol) => JSON.stringify({ op: 'sub.ticker', args: [symbol] })
  },
  // Format 4: action+channel
  {
    name: 'action+channel',
    format: (symbol) => JSON.stringify({ action: 'sub', channel: 'ticker', symbol })
  },
  // Format 5: subscribe method
  {
    name: 'subscribe',
    format: (symbol) => JSON.stringify({ method: 'subscribe', params: [`ticker.${symbol}`] })
  },
  // Format 6: sub method with topic
  {
    name: 'sub+topic',
    format: (symbol) => JSON.stringify({ method: 'sub', topic: `ticker.${symbol}` })
  },
  // Format 7: Different channel format
  {
    name: 'channel+ticker',
    format: (symbol) => JSON.stringify({ channel: 'ticker', symbol })
  },
  // Format 8: push.ticker (reverse of sub)
  {
    name: 'push.ticker',
    format: (symbol) => JSON.stringify({ method: 'push.ticker', param: { symbol } })
  },
  // Format 9: sub with symbol in param array
  {
    name: 'sub+param_array',
    format: (symbol) => JSON.stringify({ method: 'sub', param: [symbol] })
  },
  // Format 10: sub with symbol string
  {
    name: 'sub+symbol_string',
    format: (symbol) => JSON.stringify({ method: 'sub', symbol })
  },
  // Format 11: Different topic format
  {
    name: 'topic+symbol',
    format: (symbol) => JSON.stringify({ topic: symbol, op: 'sub' })
  },
  // Format 12: spot ticker format (maybe futures uses different)
  {
    name: 'spot_ticker',
    format: (symbol) => JSON.stringify({ method: 'sub.ticker', param: { symbol: symbol.replace('_USDT', 'USDT') } })
  },
  // Format 13: futures specific format
  {
    name: 'futures_ticker',
    format: (symbol) => JSON.stringify({ method: 'sub.futures.ticker', param: { symbol } })
  },
  // Format 14: contract ticker
  {
    name: 'contract_ticker',
    format: (symbol) => JSON.stringify({ method: 'sub.contract.ticker', param: { symbol } })
  },
  // Format 15: Try without underscore
  {
    name: 'symbol_no_underscore',
    format: (symbol) => JSON.stringify({ method: 'sub.ticker', param: { symbol: symbol.replace('_', '') } })
  },
  // Format 16: Try lowercase symbol
  {
    name: 'symbol_lowercase',
    format: (symbol) => JSON.stringify({ method: 'sub.ticker', param: { symbol: symbol.toLowerCase() } })
  },
  // Format 17: Try different method names
  {
    name: 'sub_price',
    format: (symbol) => JSON.stringify({ method: 'sub.price', param: { symbol } })
  },
  // Format 18: Try sub.24hrTicker
  {
    name: 'sub_24hrTicker',
    format: (symbol) => JSON.stringify({ method: 'sub.24hrTicker', param: { symbol } })
  },
  // Format 19: Try sub.miniTicker
  {
    name: 'sub_miniTicker',
    format: (symbol) => JSON.stringify({ method: 'sub.miniTicker', param: { symbol } })
  },
  // Format 20: Try sub.bookTicker
  {
    name: 'sub_bookTicker',
    format: (symbol) => JSON.stringify({ method: 'sub.bookTicker', param: { symbol } })
  },
  // Format 21: Try with stream name format
  {
    name: 'stream_format',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase()}@ticker`] })
  },
  // Format 22: Try with stream name format (futures)
  {
    name: 'stream_format_futures',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIBE', params: [`${symbol.toLowerCase().replace('_', '')}@ticker`] })
  },
  // Format 23: New MEXC API format (SUBSCRIPTION method)
  {
    name: 'SUBSCRIPTION_spot_ticker',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIPTION', params: [`spot@public.deals.v3.api@${symbol.replace('_', '').toUpperCase()}`], id: 1 })
  },
  // Format 24: New MEXC API format for ticker
  {
    name: 'SUBSCRIPTION_spot_ticker_v2',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIPTION', params: [`spot@public.increase.depth.v3.api@${symbol.replace('_', '').toUpperCase()}`], id: 1 })
  },
  // Format 25: Futures ticker format
  {
    name: 'SUBSCRIPTION_futures_ticker',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIPTION', params: [`futures@public.deals.v3.api@${symbol.replace('_', '').toUpperCase()}`], id: 1 })
  },
  // Format 26: Contract ticker format
  {
    name: 'SUBSCRIPTION_contract_ticker',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIPTION', params: [`contract@public.deals.v3.api@${symbol.replace('_', '').toUpperCase()}`], id: 1 })
  },
  // Format 27: Try with ticker channel
  {
    name: 'SUBSCRIPTION_ticker_channel',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIPTION', params: [`spot@public.ticker.v3.api@${symbol.replace('_', '').toUpperCase()}`], id: 1 })
  },
  // Format 28: Try with miniTicker channel
  {
    name: 'SUBSCRIPTION_miniTicker',
    format: (symbol) => JSON.stringify({ method: 'SUBSCRIPTION', params: [`spot@public.miniTicker.v3.api@${symbol.replace('_', '').toUpperCase()}`], id: 1 })
  }
];

async function testEndpoint(endpoint, format, symbol) {
  return new Promise((resolve) => {
    const ws = new WebSocket(endpoint, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Origin': 'https://www.mexc.com'
      }
    });

    let connected = false;
    let subscribed = false;
    let receivedTicker = false;
    let errorReceived = false;
    const messages = [];
    let timeout;

    const cleanup = () => {
      if (timeout) clearTimeout(timeout);
      try { ws.close(); } catch (_) {}
    };

    timeout = setTimeout(() => {
      cleanup();
      resolve({
        success: false,
        reason: 'timeout',
        messages: messages.slice(0, 5) // First 5 messages
      });
    }, 15000); // 15 second timeout (longer for futures endpoint)

    ws.on('open', () => {
      connected = true;
      console.log(`  ✅ Connected to ${endpoint}`);
      
      // Wait a bit then subscribe
      setTimeout(() => {
        const subMsg = format.format(symbol);
        console.log(`  📤 Sending subscription: ${subMsg}`);
        ws.send(subMsg);
        subscribed = true;
      }, 500);
    });

    ws.on('message', (raw) => {
      // Check if it's binary (Protobuf)
      if (raw instanceof Buffer) {
        messages.push({ _binary: true, length: raw.length, preview: raw.slice(0, 50).toString('hex') });
        // Check if it looks like ticker data (has reasonable size)
        if (raw.length > 10 && raw.length < 10000) {
          receivedTicker = true;
          console.log(`  ✅ Received binary ticker data: ${raw.length} bytes`);
          console.log(`  📝 Preview (hex): ${raw.slice(0, 100).toString('hex')}`);
          cleanup();
          resolve({
            success: true,
            isBinary: true,
            length: raw.length,
            preview: raw.slice(0, 100).toString('hex'),
            messages: messages.slice(0, 5)
          });
          return;
        }
        return;
      }
      
      try {
        const msg = JSON.parse(raw.toString());
        messages.push(msg);

        // Check for error
        if (msg.code !== undefined && msg.code !== 0) {
          errorReceived = true;
          console.log(`  ❌ Error received: code=${msg.code}, msg=${msg.msg || msg.message}`);
          cleanup();
          resolve({
            success: false,
            reason: 'error',
            error: msg,
            messages: messages.slice(0, 5)
          });
          return;
        }

        // Check for ticker data - multiple formats
        const channel = msg?.channel || msg?.method || msg?.topic || msg?.stream || '';
        const hasTicker = typeof channel === 'string' && (
          channel.includes('ticker') || 
          channel.includes('price') ||
          channel.includes('@ticker') ||
          channel.includes('24hrTicker')
        );
        
        // Check for price in various locations
        const hasPrice = 
          msg?.data?.lastPrice || 
          msg?.param?.lastPrice || 
          msg?.data?.last || 
          msg?.param?.last || 
          msg?.price ||
          msg?.c || // close price
          msg?.p || // price
          (msg?.data && typeof msg.data === 'object' && (msg.data.c || msg.data.p));
        
        // Check for stream format (like Binance)
        const isStream = msg?.stream && msg?.data;
        
        if (hasTicker || hasPrice || isStream) {
          receivedTicker = true;
          console.log(`  ✅ Received ticker data:`, JSON.stringify(msg).substring(0, 300));
          cleanup();
          resolve({
            success: true,
            message: msg,
            messages: messages.slice(0, 5)
          });
          return;
        }

        // Log other messages
        if (messages.length <= 5) {
          console.log(`  📥 Message #${messages.length}:`, JSON.stringify(msg).substring(0, 150));
        }
      } catch (e) {
        console.log(`  ⚠️ Parse error:`, e?.message);
      }
    });

    ws.on('error', (error) => {
      console.log(`  ❌ WebSocket error:`, error?.message);
      cleanup();
      resolve({
        success: false,
        reason: 'ws_error',
        error: error?.message,
        messages: messages.slice(0, 5)
      });
    });

    ws.on('close', () => {
      if (!receivedTicker && !errorReceived) {
        cleanup();
        resolve({
          success: false,
          reason: 'closed',
          messages: messages.slice(0, 5)
        });
      }
    });
  });
}

async function runTests() {
  console.log('\n=== MEXC WebSocket Subscription Format Test ===\n');
  console.log(`Testing ${testSymbols.length} symbols: ${testSymbols.join(', ')}\n`);
  console.log(`Testing ${endpoints.length} endpoints\n`);
  console.log(`Testing ${subscriptionFormats.length} subscription formats\n`);

  const results = [];

  for (const endpoint of endpoints) {
    console.log(`\n${'='.repeat(60)}`);
    console.log(`Testing endpoint: ${endpoint}`);
    console.log(`${'='.repeat(60)}\n`);

    for (const format of subscriptionFormats) {
      console.log(`\nFormat: ${format.name}`);
      console.log(`Symbol: ${testSymbols[0]}`);

      const result = await testEndpoint(endpoint, format, testSymbols[0]);
      
      results.push({
        endpoint,
        format: format.name,
        symbol: testSymbols[0],
        ...result
      });

      if (result.success) {
        console.log(`\n🎉 SUCCESS! Format "${format.name}" works on ${endpoint}`);
        console.log(`\nWorking subscription message: ${format.format(testSymbols[0])}`);
        console.log(`\nSample response:`, JSON.stringify(result.message, null, 2));
        
        // Test with other symbols to confirm
        console.log(`\nTesting other symbols...`);
        for (let i = 1; i < testSymbols.length; i++) {
          const otherResult = await testEndpoint(endpoint, format, testSymbols[i]);
          if (otherResult.success) {
            console.log(`  ✅ ${testSymbols[i]}: OK`);
          } else {
            console.log(`  ❌ ${testSymbols[i]}: ${otherResult.reason}`);
          }
        }
        
        console.log(`\n✅ Found working format! Stopping tests.`);
        console.log(`\nSummary:`);
        console.log(`  Endpoint: ${endpoint}`);
        console.log(`  Format: ${format.name}`);
        console.log(`  Subscription: ${format.format('BTC_USDT')}`);
        
        process.exit(0);
      }

      // Wait between tests
      await new Promise(resolve => setTimeout(resolve, 1000));
    }
  }

  // If we get here, no format worked
  console.log(`\n${'='.repeat(60)}`);
  console.log(`❌ No working format found!`);
  console.log(`${'='.repeat(60)}\n`);

  console.log(`Results summary:`);
  results.forEach((r, i) => {
    console.log(`${i + 1}. ${r.endpoint} + ${r.format}: ${r.success ? '✅' : '❌'} (${r.reason || 'unknown'})`);
    if (r.error) {
      console.log(`   Error: ${r.error.msg || r.error.message || JSON.stringify(r.error)}`);
    }
  });

  process.exit(1);
}

runTests().catch(error => {
  console.error('Test failed:', error);
  process.exit(1);
});

