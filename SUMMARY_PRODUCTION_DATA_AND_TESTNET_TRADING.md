# 📊 Tóm Tắt: Lấy Dữ Liệu Giá Từ Production và Đặt Lệnh Bằng Binance Testnet

**Ngày tạo:** 2025-01-27  
**Mục đích:** Tài liệu giải thích cách hệ thống lấy dữ liệu giá từ Binance Production và đặt lệnh giao dịch qua Binance Testnet

---

## 🎯 Tổng Quan Kiến Trúc

Hệ thống sử dụng **Hybrid Mode** để tách biệt:
- **Dữ liệu giá (Market Data)**: Luôn lấy từ **Binance Production API** (dữ liệu thật)
- **Giao dịch (Trading)**: Có thể dùng **Binance Testnet** (tiền ảo) hoặc **Production** (tiền thật)

```
┌─────────────────────────────────────────────────────────┐
│                    HYBRID MODE                           │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  📊 MARKET DATA (Production)                             │
│  ├── Giá thực tế (Real prices)                          │
│  ├── Volume thực tế (Real volume)                       │
│  ├── Dữ liệu lịch sử chính xác                          │
│  └── API: https://fapi.binance.com                      │
│                                                          │
│  💰 TRADING (Testnet hoặc Production)                    │
│  ├── Testnet: https://testnet.binancefuture.com        │
│  └── Production: https://fapi.binance.com              │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

---

## 📡 1. LẤY DỮ LIỆU GIÁ TỪ PRODUCTION

### 1.1. Cấu Hình Hybrid Mode

Trong file `.env_production`:

```env
# Hybrid Mode Configuration
HYBRID_MODE=true
HYBRID_DATA_SOURCE=production
HYBRID_TRADING_TARGET=testnet  # hoặc 'production'

# Binance API Configuration (Production Data Source)
BINANCE_API_KEY=your_production_api_key
BINANCE_SECRET=your_production_secret

# Binance Futures Testnet API Configuration (For Trading)
BINANCE_FUTURES_TESTNET_API_KEY=your_testnet_api_key
BINANCE_FUTURES_TESTNET_SECRET_KEY=your_testnet_secret_key
```

### 1.2. Implementation trong `binanceFuturesClient.js`

#### A. Khởi tạo Production Data URL

```javascript
// File: src/trading/binanceFuturesClient.js

configureEnvironment(apiKey, secretKey, options) {
  // 🔥 IMPORTANT: Market data ALWAYS from production for accurate analysis
  this.productionDataURL = 'https://fapi.binance.com';
  
  // Check for hybrid mode configuration
  this.isHybridMode = process.env.HYBRID_MODE === 'true' || 
                      process.env.HYBRID_MODE_ENABLED === 'true';
  this.hybridTradingTarget = process.env.HYBRID_TRADING_TARGET || 'production';
  
  if (this.isHybridMode && this.hybridTradingTarget === 'testnet') {
    // Hybrid mode: Use testnet for trading, production for data
    this.apiKey = apiKey || process.env.BINANCE_FUTURES_TESTNET_API_KEY || '';
    this.secretKey = secretKey || process.env.BINANCE_FUTURES_TESTNET_SECRET_KEY || '';
    this.isTestnet = true;
    this.baseURL = 'https://testnet.binancefuture.com'; // For trading only
    this.mode = 'Hybrid (Testnet Trading)';
  }
  // ...
}
```

**Điểm quan trọng:**
- `productionDataURL` luôn được set thành `'https://fapi.binance.com'` (Production API)
- `baseURL` có thể là testnet hoặc production tùy vào `HYBRID_TRADING_TARGET`

#### B. Method `makeMarketDataRequest()` - Luôn dùng Production

```javascript
/**
 * Make request for MARKET DATA only (always uses production API)
 * This ensures all analysis uses real market data regardless of trading mode
 */
async makeMarketDataRequest(endpoint, method = 'GET', params = {}) {
  const url = new URL(endpoint, this.productionDataURL);
  
  // Add query parameters
  if (params && Object.keys(params).length > 0) {
    Object.entries(params).forEach(([key, value]) => {
      if (value !== undefined && value !== null) {
        url.searchParams.append(key, value);
      }
    });
  }
  
  try {
    const response = await fetch(url.toString(), {
      method,
      headers: {
        'Content-Type': 'application/json'
      }
    });
    
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`HTTP ${response.status}: ${errorText}`);
    }
    
    return await response.json();
  } catch (error) {
    logger.error(`❌ Market data request failed: ${endpoint}`, error.message);
    throw error;
  }
}
```

**Đặc điểm:**
- Luôn sử dụng `this.productionDataURL = 'https://fapi.binance.com'`
- Không cần authentication (public API)
- Trả về dữ liệu thực tế từ thị trường

#### C. Các Method Lấy Dữ Liệu Giá

Tất cả các method sau đều sử dụng `makeMarketDataRequest()` để lấy dữ liệu từ Production:

```javascript
// 1. Lấy giá hiện tại
async getPrice(symbol) {
  const response = await this.makeMarketDataRequest('/fapi/v1/ticker/price', 'GET', { symbol });
  return parseFloat(response.price);
}

// 2. Lấy 24h ticker
async getTicker(symbol) {
  const data = await this.makeMarketDataRequest('/fapi/v1/ticker/24hr', 'GET', { symbol });
  return data;
}

// 3. Lấy klines (candles)
async getKlines(symbol, interval = '1h', limit = 100) {
  const data = await this.makeMarketDataRequest('/fapi/v1/klines', 'GET', {
    symbol,
    interval,
    limit
  });
  return data;
}

// 4. Lấy exchange info
async getExchangeInfo() {
  const response = await this.makeMarketDataRequest('/fapi/v1/exchangeInfo', 'GET');
  return response;
}
```

### 1.3. BinanceCandleFetcher - Lấy Dữ Liệu Lịch Sử

File `src/BinanceCandleFetcher.js` cũng lấy dữ liệu từ Production:

```javascript
class BinanceCandleFetcher {
  constructor() {
    this.dataStore = new MySQLDataStore();
    this.baseURL = 'https://api.binance.com/api/v3'; // Production API
    this.batchSize = 1000;
  }

  async fetchCandlesFromBinance(symbol, interval, limit = 1000, endTime = null) {
    const params = {
      symbol: symbol,
      interval: interval,
      limit: Math.min(limit, this.batchSize)
    };

    if (endTime) {
      params.endTime = endTime;
    }

    // Fetch từ Production API
    const response = await axios.get(`${this.baseURL}/klines`, { params });
    
    // Parse và trả về candles
    const candles = response.data.map(candle => ({
      openTime: parseInt(candle[0]),
      open: parseFloat(candle[1]),
      high: parseFloat(candle[2]),
      low: parseFloat(candle[3]),
      close: parseFloat(candle[4]),
      volume: parseFloat(candle[5]),
      // ...
    }));

    return candles;
  }
}
```

---

## 💰 2. ĐẶT LỆNH BẰNG BINANCE TESTNET

### 2.1. Cấu Hình Testnet

Trong file `.env_production`:

```env
# Demo Mode Configuration (for unified client)
DEMO_MODE=false
BINANCE_FUTURES_ENDPOINT=https://testnet.binancefuture.com

# Hybrid Mode Configuration
HYBRID_MODE=true
HYBRID_DATA_SOURCE=production
HYBRID_TRADING_TARGET=testnet  # ← Quan trọng: set 'testnet' để dùng testnet

# Binance Futures Testnet API Configuration (For Trading)
BINANCE_FUTURES_TESTNET_API_KEY=your_testnet_api_key
BINANCE_FUTURES_TESTNET_SECRET_KEY=your_testnet_secret_key
```

### 2.2. Khởi Tạo Client với Testnet

Trong `enhancedAutoTradeService.js`:

```javascript
async initialize(apiKey = '', secretKey = '', isTestnet = true) {
  // Determine API keys based on DEMO_MODE environment variable
  const demoMode = process.env.DEMO_MODE === 'true';
  let finalApiKey = apiKey;
  let finalSecretKey = secretKey;
  let finalIsTestnet = isTestnet;
  
  if (demoMode) {
    // Demo mode: use Binance Futures Testnet API keys
    finalApiKey = apiKey || process.env.BINANCE_FUTURES_TESTNET_API_KEY;
    finalSecretKey = secretKey || process.env.BINANCE_FUTURES_TESTNET_SECRET_KEY;
    finalIsTestnet = true; // Force testnet mode
    logger.info('🧪 Demo Mode: Using Binance Futures Testnet API');
  } else {
    // Production mode: use Binance Futures Production API keys
    finalApiKey = apiKey || process.env.BINANCE_FUTURES_API_KEY || process.env.BINANCE_API_KEY;
    finalSecretKey = secretKey || process.env.BINANCE_FUTURES_SECRET_KEY || process.env.BINANCE_SECRET;
    finalIsTestnet = false; // Force production mode
    logger.info('🏭 Production Mode: Using Binance Futures Production API');
  }
  
  // Initialize client
  this.futuresClient = new BinanceFuturesClient(finalApiKey, finalSecretKey, finalIsTestnet);
  // ...
}
```

### 2.3. Đặt Lệnh Giao Dịch

#### A. Method `makeRequest()` - Dùng cho Trading

Khác với `makeMarketDataRequest()`, method `makeRequest()` sử dụng `baseURL` (có thể là testnet):

```javascript
async makeRequest(endpoint, method = 'GET', params = {}, requiresAuth = false, retries = 3) {
  // Rate limiting
  const now = Date.now();
  const timeSinceLastRequest = now - this.lastRequestTime;
  if (timeSinceLastRequest < this.minRequestInterval) {
    await new Promise(resolve => setTimeout(resolve, this.minRequestInterval - timeSinceLastRequest));
  }
  this.lastRequestTime = Date.now();

  // 🔥 Sử dụng baseURL (có thể là testnet hoặc production)
  const url = `${this.baseURL}${endpoint}`;
  const timestamp = Date.now();
  
  // Authentication với API key và secret
  if (requiresAuth) {
    const authParams = { ...params, timestamp };
    
    if (method === 'GET') {
      const sortedParams = Object.keys(authParams)
        .sort()
        .map(key => `${key}=${authParams[key]}`)
        .join('&');
      
      const signature = crypto
        .createHmac('sha256', this.secretKey)
        .update(sortedParams)
        .digest('hex');
      
      queryString = '?' + sortedParams + '&signature=' + signature;
    } else {
      // POST requests
      requestBody = new URLSearchParams(authParams).toString();
      const signature = crypto
        .createHmac('sha256', this.secretKey)
        .update(requestBody)
        .digest('hex');
      requestBody += '&signature=' + signature;
    }
  }
  
  const headers = {
    'X-MBX-APIKEY': this.apiKey
  };
  
  // Make request
  const response = await fetch(url + queryString, {
    method,
    headers,
    body: requestBody
  });
  
  return await response.json();
}
```

#### B. Các Method Đặt Lệnh

Tất cả các method đặt lệnh đều sử dụng `makeRequest()` với `requiresAuth = true`:

```javascript
// 1. Đặt lệnh Market
async placeMarketOrder(symbol, side, quantity, positionSide = 'BOTH') {
  // Format quantity theo precision
  const symbolInfo = await this.precisionUtils.getSymbolInfo(this, symbol);
  const formattedQuantity = this.precisionUtils.formatQuantity(symbolInfo, quantity);
  
  const params = {
    symbol,
    side,
    type: 'MARKET',
    quantity: formattedQuantity
  };
  
  // 🔥 Gọi makeRequest() với baseURL (testnet hoặc production)
  const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
  logger.info(`✅ Market order placed: ${side} ${formattedQuantity} ${symbol}`);
  return data;
}

// 2. Đặt lệnh Limit
async placeLimitOrder(symbol, side, quantity, price, positionSide = 'BOTH', timeInForce = 'GTC') {
  const symbolInfo = await this.precisionUtils.getSymbolInfo(this, symbol);
  const validation = this.precisionUtils.validateOrderParams(symbolInfo, quantity, price);
  
  const params = {
    symbol,
    side,
    type: 'LIMIT',
    quantity: validation.quantity,
    price: validation.price,
    timeInForce
  };
  
  // 🔥 Gọi makeRequest() với baseURL
  const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
  logger.info(`✅ Limit order placed: ${side} ${validation.quantity} ${symbol} @ ${validation.price}`);
  return data;
}

// 3. Đặt Stop Loss
async placeStopMarketOrder(symbol, side, quantity, stopPrice, positionSide = 'BOTH') {
  const symbolInfo = await this.precisionUtils.getSymbolInfo(this, symbol);
  const validation = this.precisionUtils.validateOrderParams(symbolInfo, quantity, stopPrice);
  
  const params = {
    symbol,
    side,
    type: 'STOP_MARKET',
    quantity: validation.quantity,
    stopPrice: validation.price
  };
  
  // 🔥 Gọi makeRequest() với baseURL
  const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
  logger.info(`✅ Stop Loss order placed: ${side} ${validation.quantity} ${symbol} @ ${validation.price}`);
  return data;
}

// 4. Đặt Take Profit
async placeTakeProfitMarketOrder(symbol, side, quantity, stopPrice, positionSide = 'BOTH') {
  // Tương tự như Stop Loss
  const data = await this.makeRequest('/fapi/v1/order', 'POST', params, true);
  return data;
}
```

### 2.4. Flow Đặt Lệnh Hoàn Chỉnh

```
┌─────────────────────────────────────────────────────────┐
│  enhancedAutoTradeService.executeEnhancedTrade()       │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  futuresClient.placeMarketOrder()                        │
│  - Format quantity theo precision                        │
│  - Validate order params                                 │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  futuresClient.makeRequest()                             │
│  - baseURL = 'https://testnet.binancefuture.com'        │
│  - Endpoint: '/fapi/v1/order'                            │
│  - Method: 'POST'                                        │
│  - Authentication: API Key + Signature                   │
└──────────────────────┬──────────────────────────────────┘
                       │
                       ▼
┌─────────────────────────────────────────────────────────┐
│  Binance Testnet API                                     │
│  https://testnet.binancefuture.com/fapi/v1/order         │
│  - Xử lý lệnh                                           │
│  - Trả về orderId                                       │
└─────────────────────────────────────────────────────────┘
```

---

## 🔄 3. SO SÁNH: PRODUCTION DATA vs TESTNET TRADING

| Tiêu Chí | Production Data (Market Data) | Testnet Trading |
|----------|------------------------------|-----------------|
| **API Endpoint** | `https://fapi.binance.com` | `https://testnet.binancefuture.com` |
| **Dữ liệu** | Giá thực tế, volume thực tế | Giá mô phỏng, volume mô phỏng |
| **Authentication** | Không cần (public API) | Cần API Key + Secret Key |
| **Mục đích** | Phân tích kỹ thuật, tính toán indicators | Thực hành giao dịch, test strategy |
| **Số lượng symbols** | 500+ symbols | ~50 symbols |
| **Độ chính xác** | 100% chính xác | Có thể có sai lệch |
| **Method sử dụng** | `makeMarketDataRequest()` | `makeRequest()` |

---

## 📝 4. VÍ DỤ SỬ DỤNG

### 4.1. Lấy Giá Từ Production

```javascript
const client = new BinanceFuturesClient(
  process.env.BINANCE_FUTURES_TESTNET_API_KEY,
  process.env.BINANCE_FUTURES_TESTNET_SECRET_KEY,
  true // isTestnet = true
);

// Lấy giá từ Production (không phụ thuộc vào isTestnet)
const btcPrice = await client.getPrice('BTCUSDT');
console.log(`BTC Price: $${btcPrice}`); // Giá thực tế từ production

// Lấy klines từ Production
const klines = await client.getKlines('BTCUSDT', '1h', 100);
console.log(`Fetched ${klines.length} candles from production`);
```

### 4.2. Đặt Lệnh Trên Testnet

```javascript
// Đặt lệnh Market trên Testnet
const order = await client.placeMarketOrder(
  'BTCUSDT',
  'BUY',
  0.001, // quantity
  'LONG'
);

console.log(`Order placed on testnet: ${order.orderId}`);

// Đặt Stop Loss trên Testnet
const stopLoss = await client.placeStopMarketOrder(
  'BTCUSDT',
  'SELL',
  0.001,
  40000, // stopPrice
  'LONG'
);

console.log(`Stop Loss placed: ${stopLoss.orderId}`);
```

---

## ⚙️ 5. CẤU HÌNH QUAN TRỌNG

### 5.1. Environment Variables

```env
# ============================================
# HYBRID MODE CONFIGURATION
# ============================================
HYBRID_MODE=true
HYBRID_DATA_SOURCE=production
HYBRID_TRADING_TARGET=testnet  # hoặc 'production'

# ============================================
# PRODUCTION API KEYS (cho Market Data)
# ============================================
BINANCE_API_KEY=your_production_api_key
BINANCE_SECRET=your_production_secret

# ============================================
# TESTNET API KEYS (cho Trading)
# ============================================
BINANCE_FUTURES_TESTNET_API_KEY=your_testnet_api_key
BINANCE_FUTURES_TESTNET_SECRET_KEY=your_testnet_secret_key

# ============================================
# DEMO MODE (optional)
# ============================================
DEMO_MODE=false  # false = production trading, true = testnet trading
BINANCE_FUTURES_ENDPOINT=https://testnet.binancefuture.com
```

### 5.2. Kiểm Tra Cấu Hình

```bash
# Kiểm tra Hybrid Mode
grep "HYBRID_MODE" .env_production

# Kiểm tra API endpoints
grep "BINANCE.*ENDPOINT\|BINANCE.*URL" .env_production

# Kiểm tra API keys
grep "BINANCE.*API_KEY" .env_production
```

---

## ✅ 6. TÓM TẮT

### 6.1. Lấy Dữ Liệu Giá Từ Production

1. **Luôn sử dụng Production API**: `https://fapi.binance.com`
2. **Method**: `makeMarketDataRequest()` - không cần authentication
3. **Các method liên quan**:
   - `getPrice()` - Lấy giá hiện tại
   - `getTicker()` - Lấy 24h ticker
   - `getKlines()` - Lấy candles
   - `getExchangeInfo()` - Lấy thông tin exchange
4. **Đảm bảo**: Dữ liệu luôn chính xác và cập nhật từ thị trường thực

### 6.2. Đặt Lệnh Bằng Binance Testnet

1. **Sử dụng Testnet API**: `https://testnet.binancefuture.com`
2. **Method**: `makeRequest()` - cần authentication (API Key + Signature)
3. **Các method liên quan**:
   - `placeMarketOrder()` - Đặt lệnh Market
   - `placeLimitOrder()` - Đặt lệnh Limit
   - `placeStopMarketOrder()` - Đặt Stop Loss
   - `placeTakeProfitMarketOrder()` - Đặt Take Profit
4. **Cấu hình**: Set `HYBRID_TRADING_TARGET=testnet` trong `.env_production`

### 6.3. Lợi Ích Hybrid Mode

✅ **Phân tích chính xác**: Dùng dữ liệu thực từ Production  
✅ **An toàn khi test**: Giao dịch trên Testnet không mất tiền thật  
✅ **Linh hoạt**: Dễ dàng chuyển đổi giữa Testnet và Production  
✅ **Tối ưu**: Tách biệt rõ ràng giữa Data và Trading  

---

## 📚 7. TÀI LIỆU THAM KHẢO

- **Binance Futures API Docs**: https://binance-docs.github.io/apidocs/futures/en/
- **Binance Testnet**: https://testnet.binancefuture.com/
- **File liên quan**:
  - `src/trading/binanceFuturesClient.js` - Client chính
  - `src/trading/enhancedAutoTradeService.js` - Service đặt lệnh
  - `src/BinanceCandleFetcher.js` - Fetcher dữ liệu lịch sử
  - `hybrid-bot.js` - Bot chính
  - `.env_production` - File cấu hình

---

**Cập nhật lần cuối:** 2025-01-27  
**Trạng thái:** ✅ Đã kiểm tra và xác nhận hoạt động đúng

