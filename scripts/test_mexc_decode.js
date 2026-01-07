import WebSocket from 'ws';

/**
 * Test script to decode MEXC Futures WebSocket Protobuf data
 * Endpoint: wss://contract.mexc.com/edge
 */

const symbol = 'BTC_USDT';
const endpoint = 'wss://contract.mexc.com/edge';

console.log(`\n=== MEXC Futures WebSocket Protobuf Decoder Test ===\n`);
console.log(`Endpoint: ${endpoint}`);
console.log(`Symbol: ${symbol}\n`);

const ws = new WebSocket(endpoint, {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
    'Origin': 'https://www.mexc.com'
  }
});

let messageCount = 0;
let pingInterval;

ws.on('open', () => {
  console.log('✅ Connected to MEXC Futures WebSocket');
  
  // Send ping first (required for futures endpoint)
  const pingMsg = JSON.stringify({ method: 'ping' });
  console.log(`📤 Sending ping: ${pingMsg}`);
  ws.send(pingMsg);
  
  // Subscribe after a short delay
  setTimeout(() => {
    const subMsg = JSON.stringify({
      method: 'sub.ticker',
      param: { symbol }
    });
    console.log(`📤 Sending subscription: ${subMsg}`);
    ws.send(subMsg);
    
    // Start ping interval (every 15 seconds as per documentation)
    pingInterval = setInterval(() => {
      const ping = JSON.stringify({ method: 'ping' });
      ws.send(ping);
      console.log('📤 Sent ping');
    }, 15000);
  }, 1000);
});

ws.on('message', (raw) => {
  messageCount++;
  
  // Try to parse as JSON first
  try {
    const jsonStr = raw.toString();
    if (jsonStr.trim().startsWith('{')) {
      const msg = JSON.parse(jsonStr);
      console.log(`\n📥 Message #${messageCount} (JSON):`);
      console.log(JSON.stringify(msg, null, 2));
      
      // Check if it's a ticker message
      if (msg.channel === 'push.ticker' || msg.method === 'push.ticker' || msg.data?.lastPrice || msg.data?.last) {
        const price = msg.data?.lastPrice || msg.data?.last || msg.param?.lastPrice || msg.param?.last;
        const symbol = msg.data?.symbol || msg.param?.symbol || msg.symbol;
        console.log(`\n✅ TICKER DATA FOUND!`);
        console.log(`   Symbol: ${symbol}`);
        console.log(`   Price: ${price}`);
        return;
      }
      
      // Check if it's a pong
      if (msg.channel === 'pong' || msg.method === 'pong') {
        console.log(`   (Pong response)`);
        return;
      }
      
      return;
    }
  } catch (e) {
    // Not JSON, continue to binary parsing
  }
  
  // Handle binary (Protobuf) data
  if (raw instanceof Buffer) {
    console.log(`\n📥 Message #${messageCount} (Binary/Protobuf):`);
    console.log(`   Length: ${raw.length} bytes`);
    console.log(`   Hex: ${raw.toString('hex')}`);
    console.log(`   First 20 bytes (hex): ${raw.slice(0, 20).toString('hex')}`);
    
    // Try to find price patterns in the binary data
    // Protobuf often contains numeric values that might be prices
    // Look for patterns that could be float/double values
    
    // Try reading as different data types
    console.log(`\n   Attempting to parse as different types:`);
    
    // Try reading as little-endian doubles (common for prices)
    if (raw.length >= 8) {
      for (let i = 0; i <= raw.length - 8; i += 1) {
        try {
          const value = raw.readDoubleLE(i);
          if (value > 0 && value < 1000000 && Number.isFinite(value)) {
            console.log(`   [Offset ${i}] Possible price (double LE): ${value}`);
          }
        } catch (_) {}
      }
    }
    
    // Try reading as big-endian doubles
    if (raw.length >= 8) {
      for (let i = 0; i <= raw.length - 8; i += 1) {
        try {
          const value = raw.readDoubleBE(i);
          if (value > 0 && value < 1000000 && Number.isFinite(value)) {
            console.log(`   [Offset ${i}] Possible price (double BE): ${value}`);
          }
        } catch (_) {}
      }
    }
    
    // Try reading as little-endian floats
    if (raw.length >= 4) {
      for (let i = 0; i <= raw.length - 4; i += 1) {
        try {
          const value = raw.readFloatLE(i);
          if (value > 0 && value < 1000000 && Number.isFinite(value)) {
            console.log(`   [Offset ${i}] Possible price (float LE): ${value}`);
          }
        } catch (_) {}
      }
    }
    
    // Try reading as big-endian floats
    if (raw.length >= 4) {
      for (let i = 0; i <= raw.length - 4; i += 1) {
        try {
          const value = raw.readFloatBE(i);
          if (value > 0 && value < 1000000 && Number.isFinite(value)) {
            console.log(`   [Offset ${i}] Possible price (float BE): ${value}`);
          }
        } catch (_) {}
      }
    }
    
    // Try reading as varint (common in Protobuf)
    console.log(`\n   Reading as varints (Protobuf wire format):`);
    let offset = 0;
    while (offset < raw.length) {
      try {
        // Read varint
        let value = 0;
        let shift = 0;
        let bytesRead = 0;
        
        for (let i = offset; i < raw.length && i < offset + 10; i++) {
          const byte = raw[i];
          value |= (byte & 0x7F) << shift;
          bytesRead++;
          
          if ((byte & 0x80) === 0) {
            break;
          }
          shift += 7;
        }
        
        if (bytesRead > 0 && value > 0 && value < 1000000000) {
          console.log(`   [Offset ${offset}] Varint: ${value} (${bytesRead} bytes)`);
          offset += bytesRead;
        } else {
          offset++;
        }
      } catch (_) {
        offset++;
      }
    }
    
    // Try to find ASCII strings (symbol names, etc.)
    const asciiStrings = [];
    let currentString = '';
    for (let i = 0; i < raw.length; i++) {
      const byte = raw[i];
      if (byte >= 32 && byte <= 126) { // Printable ASCII
        currentString += String.fromCharCode(byte);
      } else {
        if (currentString.length >= 3) {
          asciiStrings.push(currentString);
        }
        currentString = '';
      }
    }
    if (currentString.length >= 3) {
      asciiStrings.push(currentString);
    }
    
    if (asciiStrings.length > 0) {
      console.log(`\n   ASCII strings found: ${asciiStrings.join(', ')}`);
    }
    
    // Show first 10 messages in detail
    if (messageCount <= 10) {
      console.log(`\n   Full hex dump (first 100 bytes):`);
      const hex = raw.toString('hex');
      for (let i = 0; i < Math.min(100, hex.length); i += 32) {
        console.log(`   ${i.toString(16).padStart(4, '0')}: ${hex.slice(i, i + 32).match(/.{1,2}/g)?.join(' ') || ''}`);
      }
    }
    
    return;
  }
  
  // Handle JSON messages
  try {
    const msg = JSON.parse(raw.toString());
    console.log(`\n📥 Message #${messageCount} (JSON):`);
    console.log(JSON.stringify(msg, null, 2));
  } catch (e) {
    console.log(`\n📥 Message #${messageCount} (Text):`);
    console.log(raw.toString());
  }
});

ws.on('error', (error) => {
  console.error('❌ WebSocket error:', error.message);
});

ws.on('close', () => {
  console.log('\n⚠️ WebSocket closed');
  if (pingInterval) clearInterval(pingInterval);
  process.exit(0);
});

// Run for 30 seconds then exit
setTimeout(() => {
  console.log('\n\n✅ Test completed. Closing connection...');
  if (pingInterval) clearInterval(pingInterval);
  ws.close();
}, 30000);

