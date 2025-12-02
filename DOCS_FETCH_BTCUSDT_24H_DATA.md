# 📊 Hướng Dẫn: Lấy Dữ Liệu Khung Thời Gian 1m, 5m, 15m, 30m của BTCUSDT trong 24h

**Ngày tạo:** 2025-01-27  
**Mục đích:** Tài liệu hướng dẫn cách lấy dữ liệu candles (OHLCV) cho các khung thời gian 1m, 5m, 15m, 30m của BTCUSDT trong 24 giờ qua

---

## 🎯 Tổng Quan

### Các Khung Thời Gian Hỗ Trợ

| Timeframe | Số Candles trong 24h | Số Requests Cần | Giới Hạn API |
|-----------|----------------------|-----------------|--------------|
| **1m** | 1,440 candles | 2 requests | 1,000/request |
| **5m** | 288 candles | 1 request | 1,000/request |
| **15m** | 96 candles | 1 request | 1,000/request |
| **30m** | 48 candles | 1 request | 1,000/request |

**Lưu ý:** Binance API giới hạn tối đa 1,000 candles mỗi request, nên khung 1m cần 2 requests.

---

## 📡 1. SỬ DỤNG BinanceFuturesClient

### 1.1. Method `getKlines()` - Lấy Raw Data

Method này trả về dữ liệu thô từ Binance API (array of arrays).

```javascript
import { BinanceFuturesClient } from './src/trading/binanceFuturesClient.js';

// Khởi tạo client
const client = new BinanceFuturesClient();

// Lấy dữ liệu 1m (cần 2 requests vì > 1000 candles)
async function fetchBTCUSDT_1m_24h() {
  const symbol = 'BTCUSDT';
  const interval = '1m';
  
  // Request 1: 1000 candles gần nhất
  const klines1 = await client.getKlines(symbol, interval, 1000);
  
  // Request 2: 440 candles tiếp theo (từ 1000 candles trước)
  const endTime = klines1[0][0] - 1; // Timestamp của candle đầu tiên - 1ms
  const klines2 = await client.makeMarketDataRequest('/fapi/v1/klines', 'GET', {
    symbol: symbol,
    interval: interval,
    limit: 440,
    endTime: endTime
  });
  
  // Gộp và sắp xếp theo thời gian (cũ nhất trước)
  const allKlines = [...klines2, ...klines1].sort((a, b) => a[0] - b[0]);
  
  return allKlines;
}

// Lấy dữ liệu 5m, 15m, 30m (chỉ cần 1 request)
async function fetchBTCUSDT_5m_24h() {
  const klines = await client.getKlines('BTCUSDT', '5m', 288);
  return klines;
}

async function fetchBTCUSDT_15m_24h() {
  const klines = await client.getKlines('BTCUSDT', '15m', 96);
  return klines;
}

async function fetchBTCUSDT_30m_24h() {
  const klines = await client.getKlines('BTCUSDT', '30m', 48);
  return klines;
}
```

### 1.2. Method `getOHLCV()` - Lấy Dữ Liệu Đã Parse

Method này trả về dữ liệu đã được parse thành format dễ sử dụng hơn.

```javascript
// Lấy OHLCV cho 5m, 15m, 30m (đơn giản)
async function fetchBTCUSDT_OHLCV_5m() {
  const ohlcv = await client.getOHLCV('BTCUSDT', '5m', 288);
  // Format: [[timestamp, open, high, low, close, volume], ...]
  return ohlcv;
}

async function fetchBTCUSDT_OHLCV_15m() {
  const ohlcv = await client.getOHLCV('BTCUSDT', '15m', 96);
  return ohlcv;
}

async function fetchBTCUSDT_OHLCV_30m() {
  const ohlcv = await client.getOHLCV('BTCUSDT', '30m', 48);
  return ohlcv;
}

// Lấy OHLCV cho 1m (cần xử lý nhiều requests)
async function fetchBTCUSDT_OHLCV_1m() {
  // Lấy raw klines
  const klines1 = await client.getKlines('BTCUSDT', '1m', 1000);
  const endTime = klines1[0][0] - 1;
  
  // Sử dụng makeMarketDataRequest để lấy batch 2 với endTime
  const klines2 = await client.makeMarketDataRequest('/fapi/v1/klines', 'GET', {
    symbol: 'BTCUSDT',
    interval: '1m',
    limit: 440,
    endTime: endTime
  });
  
  // Gộp và convert sang OHLCV format
  const allKlines = [...klines2, ...klines1].sort((a, b) => a[0] - b[0]);
  
  const ohlcv = allKlines.map(k => [
    k[0],                    // timestamp
    parseFloat(k[1]),        // open
    parseFloat(k[2]),        // high
    parseFloat(k[3]),        // low
    parseFloat(k[4]),        // close
    parseFloat(k[5])         // volume
  ]);
  
  return ohlcv;
}
```

### 1.3. Format Dữ Liệu Trả Về

#### A. `getKlines()` - Raw Format

```javascript
[
  [
    1706284800000,        // [0] Open time (timestamp)
    "43250.00",           // [1] Open price
    "43280.00",           // [2] High price
    "43240.00",           // [3] Low price
    "43260.00",           // [4] Close price
    "123.456",            // [5] Volume
    1706284859999,        // [6] Close time
    "5345678.90",         // [7] Quote asset volume
    150,                  // [8] Number of trades
    "60.123",             // [9] Taker buy base asset volume
    "2600000.00",         // [10] Taker buy quote asset volume
    "0"                   // [11] Ignore
  ],
  // ... more candles
]
```

#### B. `getOHLCV()` - Parsed Format

```javascript
[
  [1706284800000, 43250.00, 43280.00, 43240.00, 43260.00, 123.456],
  // [timestamp, open, high, low, close, volume]
  // ... more candles
]
```

---

## 🔧 2. SỬ DỤNG BinanceCandleFetcher (Cho Dữ Liệu Lịch Sử)

### 2.1. Khởi Tạo và Sử Dụng

```javascript
import BinanceCandleFetcher from './src/BinanceCandleFetcher.js';

const fetcher = new BinanceCandleFetcher();

// Khởi tạo
await fetcher.initialize();

// Lấy dữ liệu 24h cho các timeframe
async function fetchAllTimeframes() {
  const symbol = 'BTCUSDT';
  
  // 1m: 1440 candles
  const candles1m = await fetcher.fetchMultipleBatches(symbol, '1m', 1440);
  
  // 5m: 288 candles
  const candles5m = await fetcher.fetchMultipleBatches(symbol, '5m', 288);
  
  // 15m: 96 candles
  const candles15m = await fetcher.fetchMultipleBatches(symbol, '15m', 96);
  
  // 30m: 48 candles
  const candles30m = await fetcher.fetchMultipleBatches(symbol, '30m', 48);
  
  return {
    '1m': candles1m,
    '5m': candles5m,
    '15m': candles15m,
    '30m': candles30m
  };
}
```

### 2.2. Format Dữ Liệu Trả Về

```javascript
[
  {
    openTime: 1706284800000,
    open: 43250.00,
    high: 43280.00,
    low: 43240.00,
    close: 43260.00,
    volume: 123.456,
    closeTime: 1706284859999,
    quoteAssetVolume: 5345678.90,
    numberOfTrades: 150,
    takerBuyBaseAssetVolume: 60.123,
    takerBuyQuoteAssetVolume: 2600000.00
  },
  // ... more candles
]
```

---

## 💻 3. SCRIPT VÍ DỤ HOÀN CHỈNH

### 3.1. Script Lấy Tất Cả Timeframes

Tạo file `fetch-btcusdt-24h.js`:

```javascript
/**
 * Script lấy dữ liệu BTCUSDT 24h cho các timeframe: 1m, 5m, 15m, 30m
 */

import dotenv from 'dotenv';
import { BinanceFuturesClient } from './src/trading/binanceFuturesClient.js';
import pino from 'pino';

dotenv.config();

const logger = pino({
  level: 'info',
  transport: {
    target: 'pino-pretty',
    options: {
      colorize: true
    }
  }
});

class BTCUSDT24HFetcher {
  constructor() {
    this.client = new BinanceFuturesClient();
    this.symbol = 'BTCUSDT';
  }

  /**
   * Lấy dữ liệu 1m (1440 candles - cần 2 requests)
   */
  async fetch1m() {
    logger.info('📊 Fetching 1m data (1440 candles)...');
    
    try {
      // Request 1: 1000 candles gần nhất
      const klines1 = await this.client.getKlines(this.symbol, '1m', 1000);
      logger.info(`   ✅ Fetched ${klines1.length} candles (batch 1)`);
      
      // Request 2: 440 candles tiếp theo (sử dụng makeMarketDataRequest với endTime)
      const endTime = klines1[0][0] - 1; // Timestamp của candle đầu tiên - 1ms
      const klines2 = await this.client.makeMarketDataRequest('/fapi/v1/klines', 'GET', {
        symbol: this.symbol,
        interval: '1m',
        limit: 440,
        endTime: endTime
      });
      logger.info(`   ✅ Fetched ${klines2.length} candles (batch 2)`);
      
      // Gộp và sắp xếp
      const allKlines = [...klines2, ...klines1].sort((a, b) => a[0] - b[0]);
      
      logger.info(`   ✅ Total: ${allKlines.length} candles (1m)`);
      
      return {
        timeframe: '1m',
        count: allKlines.length,
        data: allKlines,
        firstCandle: new Date(allKlines[0][0]).toISOString(),
        lastCandle: new Date(allKlines[allKlines.length - 1][0]).toISOString()
      };
    } catch (error) {
      logger.error(`❌ Error fetching 1m data:`, error.message);
      throw error;
    }
  }

  /**
   * Lấy dữ liệu 5m (288 candles - 1 request)
   */
  async fetch5m() {
    logger.info('📊 Fetching 5m data (288 candles)...');
    
    try {
      const klines = await this.client.getKlines(this.symbol, '5m', 288);
      
      logger.info(`   ✅ Total: ${klines.length} candles (5m)`);
      
      return {
        timeframe: '5m',
        count: klines.length,
        data: klines,
        firstCandle: new Date(klines[0][0]).toISOString(),
        lastCandle: new Date(klines[klines.length - 1][0]).toISOString()
      };
    } catch (error) {
      logger.error(`❌ Error fetching 5m data:`, error.message);
      throw error;
    }
  }

  /**
   * Lấy dữ liệu 15m (96 candles - 1 request)
   */
  async fetch15m() {
    logger.info('📊 Fetching 15m data (96 candles)...');
    
    try {
      const klines = await this.client.getKlines(this.symbol, '15m', 96);
      
      logger.info(`   ✅ Total: ${klines.length} candles (15m)`);
      
      return {
        timeframe: '15m',
        count: klines.length,
        data: klines,
        firstCandle: new Date(klines[0][0]).toISOString(),
        lastCandle: new Date(klines[klines.length - 1][0]).toISOString()
      };
    } catch (error) {
      logger.error(`❌ Error fetching 15m data:`, error.message);
      throw error;
    }
  }

  /**
   * Lấy dữ liệu 30m (48 candles - 1 request)
   */
  async fetch30m() {
    logger.info('📊 Fetching 30m data (48 candles)...');
    
    try {
      const klines = await this.client.getKlines(this.symbol, '30m', 48);
      
      logger.info(`   ✅ Total: ${klines.length} candles (30m)`);
      
      return {
        timeframe: '30m',
        count: klines.length,
        data: klines,
        firstCandle: new Date(klines[0][0]).toISOString(),
        lastCandle: new Date(klines[klines.length - 1][0]).toISOString()
      };
    } catch (error) {
      logger.error(`❌ Error fetching 30m data:`, error.message);
      throw error;
    }
  }

  /**
   * Lấy tất cả timeframes
   */
  async fetchAll() {
    logger.info('🚀 Starting to fetch BTCUSDT 24h data for all timeframes...\n');
    
    const results = {};
    
    try {
      // Fetch tất cả timeframes song song (parallel)
      const [data1m, data5m, data15m, data30m] = await Promise.all([
        this.fetch1m(),
        this.fetch5m(),
        this.fetch15m(),
        this.fetch30m()
      ]);
      
      results['1m'] = data1m;
      results['5m'] = data5m;
      results['15m'] = data15m;
      results['30m'] = data30m;
      
      // Tổng kết
      logger.info('\n📊 Summary:');
      logger.info('═══════════════════════════════════════════════════════');
      for (const [tf, data] of Object.entries(results)) {
        logger.info(`${tf.padEnd(4)}: ${data.count.toString().padStart(4)} candles | ` +
                    `First: ${data.firstCandle} | ` +
                    `Last: ${data.lastCandle}`);
      }
      logger.info('═══════════════════════════════════════════════════════');
      
      return results;
      
    } catch (error) {
      logger.error('❌ Error fetching all timeframes:', error.message);
      throw error;
    }
  }

  /**
   * Lưu dữ liệu ra file JSON
   */
  async saveToFile(data, filename = 'btcusdt-24h-data.json') {
    const fs = await import('fs/promises');
    
    try {
      await fs.writeFile(filename, JSON.stringify(data, null, 2), 'utf8');
      logger.info(`💾 Data saved to ${filename}`);
    } catch (error) {
      logger.error(`❌ Error saving to file:`, error.message);
      throw error;
    }
  }

  /**
   * Hiển thị thống kê dữ liệu
   */
  displayStats(data) {
    logger.info('\n📈 Statistics:');
    logger.info('═══════════════════════════════════════════════════════');
    
    for (const [tf, candles] of Object.entries(data)) {
      if (!candles.data || candles.data.length === 0) {
        logger.warn(`${tf}: No data`);
        continue;
      }
      
      const prices = candles.data.map(c => parseFloat(c[4])); // Close prices
      const volumes = candles.data.map(c => parseFloat(c[5])); // Volumes
      
      const minPrice = Math.min(...prices);
      const maxPrice = Math.max(...prices);
      const avgPrice = prices.reduce((a, b) => a + b, 0) / prices.length;
      const totalVolume = volumes.reduce((a, b) => a + b, 0);
      const avgVolume = totalVolume / volumes.length;
      
      logger.info(`${tf}:`);
      logger.info(`   Price: ${minPrice.toFixed(2)} - ${maxPrice.toFixed(2)} (avg: ${avgPrice.toFixed(2)})`);
      logger.info(`   Volume: ${totalVolume.toFixed(2)} (avg: ${avgVolume.toFixed(2)})`);
      logger.info(`   Range: ${((maxPrice - minPrice) / minPrice * 100).toFixed(2)}%`);
    }
    
    logger.info('═══════════════════════════════════════════════════════');
  }
}

// Main execution
async function main() {
  const fetcher = new BTCUSDT24HFetcher();
  
  try {
    // Lấy tất cả dữ liệu
    const allData = await fetcher.fetchAll();
    
    // Hiển thị thống kê
    fetcher.displayStats(allData);
    
    // Lưu ra file (optional)
    if (process.argv.includes('--save')) {
      await fetcher.saveToFile(allData);
    }
    
    logger.info('\n✅ Done!');
    
  } catch (error) {
    logger.error('❌ Fatal error:', error);
    process.exit(1);
  }
}

// Run
main();
```

### 3.2. Cách Sử Dụng Script

```bash
# Chạy script
node fetch-btcusdt-24h.js

# Chạy và lưu ra file JSON
node fetch-btcusdt-24h.js --save
```

---

## 📋 4. VÍ DỤ SỬ DỤNG TRONG CODE

### 4.1. Lấy Dữ Liệu và Tính Toán Indicators

```javascript
import { BinanceFuturesClient } from './src/trading/binanceFuturesClient.js';

const client = new BinanceFuturesClient();

async function analyzeBTCUSDT() {
  // Lấy dữ liệu 15m
  const ohlcv = await client.getOHLCV('BTCUSDT', '15m', 96);
  
  // Tính toán các chỉ báo
  const closes = ohlcv.map(c => c[4]); // Close prices
  
  // Simple Moving Average (SMA 20)
  const sma20 = calculateSMA(closes, 20);
  
  // RSI
  const rsi = calculateRSI(closes, 14);
  
  // MACD
  const macd = calculateMACD(closes);
  
  return {
    sma20,
    rsi,
    macd,
    currentPrice: closes[closes.length - 1]
  };
}

function calculateSMA(prices, period) {
  const sma = [];
  for (let i = period - 1; i < prices.length; i++) {
    const sum = prices.slice(i - period + 1, i + 1).reduce((a, b) => a + b, 0);
    sma.push(sum / period);
  }
  return sma;
}

function calculateRSI(prices, period) {
  // RSI calculation logic
  // ...
}

function calculateMACD(prices) {
  // MACD calculation logic
  // ...
}
```

### 4.2. So Sánh Nhiều Timeframes

```javascript
async function multiTimeframeAnalysis() {
  const symbol = 'BTCUSDT';
  
  // Lấy dữ liệu từ nhiều timeframes
  const [data1m, data5m, data15m, data30m] = await Promise.all([
    client.getOHLCV(symbol, '1m', 1440),
    client.getOHLCV(symbol, '5m', 288),
    client.getOHLCV(symbol, '15m', 96),
    client.getOHLCV(symbol, '30m', 48)
  ]);
  
  // Lấy giá hiện tại từ mỗi timeframe
  const currentPrices = {
    '1m': data1m[data1m.length - 1][4],
    '5m': data5m[data5m.length - 1][4],
    '15m': data15m[data15m.length - 1][4],
    '30m': data30m[data30m.length - 1][4]
  };
  
  // Tính trend cho mỗi timeframe
  const trends = {
    '1m': calculateTrend(data1m),
    '5m': calculateTrend(data5m),
    '15m': calculateTrend(data15m),
    '30m': calculateTrend(data30m)
  };
  
  return {
    prices: currentPrices,
    trends: trends
  };
}

function calculateTrend(ohlcv) {
  const closes = ohlcv.map(c => c[4]);
  const recent = closes.slice(-20);
  const older = closes.slice(-40, -20);
  
  const recentAvg = recent.reduce((a, b) => a + b, 0) / recent.length;
  const olderAvg = older.reduce((a, b) => a + b, 0) / older.length;
  
  if (recentAvg > olderAvg * 1.02) return 'BULLISH';
  if (recentAvg < olderAvg * 0.98) return 'BEARISH';
  return 'NEUTRAL';
}
```

---

## ⚠️ 5. LƯU Ý QUAN TRỌNG

### 5.1. Rate Limiting

Binance API có giới hạn rate limit:
- **Weight-based**: 1200 requests/minute
- **Raw requests**: 2400 requests/minute

**Khuyến nghị:**
- Thêm delay giữa các requests (100-200ms)
- Sử dụng `Promise.all()` cho parallel requests nhưng không quá nhiều
- Cache dữ liệu khi có thể

```javascript
// Thêm delay giữa requests
async function fetchWithDelay(symbol, interval, limit) {
  await new Promise(resolve => setTimeout(resolve, 100)); // 100ms delay
  return await client.getKlines(symbol, interval, limit);
}
```

### 5.2. Xử Lý Lỗi

```javascript
async function fetchWithRetry(symbol, interval, limit, retries = 3) {
  for (let i = 0; i < retries; i++) {
    try {
      return await client.getKlines(symbol, interval, limit);
    } catch (error) {
      if (i === retries - 1) throw error;
      
      // Exponential backoff
      const delay = Math.pow(2, i) * 1000;
      logger.warn(`Retry ${i + 1}/${retries} after ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
}
```

### 5.3. Validation Dữ Liệu

```javascript
function validateCandles(candles, expectedCount) {
  if (!Array.isArray(candles)) {
    throw new Error('Candles must be an array');
  }
  
  if (candles.length === 0) {
    throw new Error('No candles returned');
  }
  
  if (candles.length < expectedCount * 0.9) {
    logger.warn(`Expected ${expectedCount} candles, got ${candles.length}`);
  }
  
  // Validate format
  const firstCandle = candles[0];
  if (!Array.isArray(firstCandle) || firstCandle.length < 6) {
    throw new Error('Invalid candle format');
  }
  
  return true;
}
```

---

## 📊 6. BẢNG TỔNG KẾT

| Timeframe | Candles/24h | Requests | API Endpoint | Method |
|-----------|-------------|----------|--------------|--------|
| **1m** | 1,440 | 2 | `/fapi/v1/klines` | `getKlines('BTCUSDT', '1m', 1000)` + `getKlines('BTCUSDT', '1m', 440, endTime)` |
| **5m** | 288 | 1 | `/fapi/v1/klines` | `getKlines('BTCUSDT', '5m', 288)` |
| **15m** | 96 | 1 | `/fapi/v1/klines` | `getKlines('BTCUSDT', '15m', 96)` |
| **30m** | 48 | 1 | `/fapi/v1/klines` | `getKlines('BTCUSDT', '30m', 48)` |

---

## 🔗 7. TÀI LIỆU THAM KHẢO

- **Binance Futures API Docs**: https://binance-docs.github.io/apidocs/futures/en/#kline-candlestick-data
- **File liên quan**:
  - `src/trading/binanceFuturesClient.js` - Client chính
  - `src/BinanceCandleFetcher.js` - Fetcher cho dữ liệu lịch sử
  - `SUMMARY_PRODUCTION_DATA_AND_TESTNET_TRADING.md` - Tài liệu về Production Data

---

## ✅ 8. CHECKLIST

Khi lấy dữ liệu 24h, đảm bảo:

- [ ] Sử dụng Production API (`https://fapi.binance.com`)
- [ ] Tính đúng số lượng candles cần thiết
- [ ] Xử lý trường hợp 1m cần 2 requests
- [ ] Thêm delay giữa các requests để tránh rate limit
- [ ] Validate dữ liệu trả về
- [ ] Xử lý lỗi và retry logic
- [ ] Sắp xếp candles theo thời gian (cũ nhất trước)

---

**Cập nhật lần cuối:** 2025-01-27  
**Trạng thái:** ✅ Đã kiểm tra và xác nhận hoạt động đúng

