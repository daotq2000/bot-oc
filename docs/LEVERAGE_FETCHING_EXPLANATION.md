# Cách Lấy Leverage của Coin - Binance và MEXC

**Date:** 2025-01-27

---

## 📋 Tổng Quan

Hệ thống lấy leverage của coin theo thứ tự ưu tiên:
1. **Cache** (từ `symbol_filters` table) - nhanh nhất, không tốn API call
2. **REST API** (fallback) - chậm hơn, tốn API call

---

## 🔵 BINANCE

### 1. Cache (Ưu tiên cao nhất)

**Method:** `ExchangeInfoService.getMaxLeverage(symbol)`

**Nguồn dữ liệu:**
- Lấy từ `symbol_filters` table (field `max_leverage`)
- Cache được update định kỳ bởi `ExchangeInfoService.updateFiltersFromExchange()`

**Cách update cache:**
```javascript
// File: src/services/ExchangeInfoService.js
// API: GET /fapi/v1/exchangeInfo
// Response: { symbols: [{ symbol, leverageBrackets: [...] }] }

// Extract max leverage từ leverageBrackets
if (symbolInfo.leverageBrackets && symbolInfo.leverageBrackets.length > 0) {
  const maxBracket = symbolInfo.leverageBrackets.reduce((max, bracket) => {
    const leverage = parseInt(bracket.initialLeverage || 0);
    return leverage > parseInt(max.initialLeverage || 0) ? bracket : max;
  });
  maxLeverage = parseInt(maxBracket.initialLeverage || 125);
}
```

**Lưu vào DB:**
- Table: `symbol_filters`
- Field: `max_leverage`
- Exchange: `'binance'`

---

### 2. REST API (Fallback)

**Method:** `BinanceDirectClient.getMaxLeverage(symbol)`

**API Endpoint:**
```
GET /fapi/v1/leverageBracket?symbol={symbol}
```

**Request:**
```javascript
// File: src/services/BinanceDirectClient.js
async getLeverageBrackets(symbol) {
  const normalizedSymbol = this.normalizeSymbol(symbol);
  const params = { symbol: normalizedSymbol };
  const data = await this.makeRequest('/fapi/v1/leverageBracket', 'GET', params, true);
  // ...
}
```

**Response Format:**
```json
[
  {
    "symbol": "BTCUSDT",
    "brackets": [
      {
        "bracket": 1,
        "initialLeverage": 125,
        "notionalCap": 10000,
        "notionalFloor": 0,
        "maintMarginRatio": 0.004
      },
      {
        "bracket": 2,
        "initialLeverage": 100,
        "notionalCap": 50000,
        "notionalFloor": 10000,
        "maintMarginRatio": 0.005
      }
      // ... more brackets
    ]
  }
]
```

**Logic lấy max leverage:**
```javascript
// Tìm bracket có initialLeverage cao nhất
const maxBracket = brackets.reduce((max, bracket) => {
  const leverage = parseInt(bracket.initialLeverage || 0);
  return leverage > parseInt(max.initialLeverage || 0) ? bracket : max;
});
return parseInt(maxBracket.initialLeverage || 125);
```

**Default:** 125 (nếu không tìm thấy)

---

### 3. Luồng Sử Dụng

```javascript
// File: src/services/ExchangeService.js
// Khi tạo order, cần set leverage:

// 1. Check cache trước
const maxLeverageFromCache = exchangeInfoService.getMaxLeverage(normalizedSymbol);

// 2. Nếu có bot.default_leverage, dùng nó
if (this.bot.default_leverage != null) {
  desiredLev = parseInt(this.bot.default_leverage);
} else {
  // 3. Dùng max leverage từ cache hoặc default config
  const defaultLeverage = parseInt(configService.getNumber('BINANCE_DEFAULT_LEVERAGE', 5));
  desiredLev = maxLeverageFromCache || defaultLeverage;
}

// 4. Set leverage cho symbol
await this.binanceDirectClient.setLeverage(normalizedSymbol, desiredLev);
```

---

## 🟢 MEXC

### 1. Cache (Ưu tiên cao nhất)

**Method:** `ExchangeInfoService.getMaxLeverage(symbol)`

**Nguồn dữ liệu:**
- Lấy từ `symbol_filters` table (field `max_leverage`)
- Cache được update định kỳ bởi `ExchangeInfoService.updateMexcFiltersFromExchange()`

**Cách update cache:**
```javascript
// File: src/services/ExchangeInfoService.js
// Sử dụng CCXT để fetch markets
await mexc.fetchMarkets({ 'type': 'swap' });

// Extract max leverage từ market info
let maxLeverage = null;
if (m.limits?.leverage?.max !== undefined) {
  maxLeverage = Number(m.limits.leverage.max);
} else if (m.info?.maxLeverage !== undefined) {
  maxLeverage = Number(m.info.maxLeverage);
} else if (m.info?.leverage_max !== undefined) {
  maxLeverage = Number(m.info.leverage_max);
}

// Fallback default
if (!maxLeverage || !Number.isFinite(maxLeverage)) {
  maxLeverage = 50; // typical on MEXC
}
```

**Lưu vào DB:**
- Table: `symbol_filters`
- Field: `max_leverage`
- Exchange: `'mexc'`

---

### 2. REST API (Không có method riêng)

**Lưu ý:** MEXC không có method `getMaxLeverage()` riêng như Binance. Chỉ có `setLeverage()`.

**Method:** `MexcFuturesClient.setLeverage(symbol, leverage)`

**API Endpoint:**
```
POST /api/v1/private/position/leverage
Body: { symbol: "BTCUSDT", leverage: 5 }
```

**Cách sử dụng:**
```javascript
// File: src/services/ExchangeService.js
// Khi tạo order, cần set leverage:

// 1. Check cache trước
const maxLeverageFromCache = exchangeInfoService.getMaxLeverage(symbol);

// 2. Nếu có bot.default_leverage, dùng nó
if (this.bot.default_leverage != null) {
  maxLev = Number(this.bot.default_leverage);
} else {
  // 3. Dùng max leverage từ cache hoặc default config
  maxLev = Number(maxLeverageFromCache) || Number(configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5));
}

// 4. Set leverage cho symbol
await this.mexcFuturesClient.setLeverage(symbol, maxLev);
```

**Default:** 50 (nếu không tìm thấy trong cache)

---

## 📊 So Sánh

| Exchange | Cache Source | API Endpoint | Default | Method Get |
|----------|--------------|--------------|---------|------------|
| **Binance** | `/fapi/v1/exchangeInfo` → `leverageBrackets` | `/fapi/v1/leverageBracket` | 125 | ✅ `getMaxLeverage()` |
| **MEXC** | CCXT `fetchMarkets()` → `limits.leverage.max` | ❌ Không có | 50 | ❌ Chỉ có `setLeverage()` |

---

## 🔄 Quy Trình Hoạt Động

### Binance:

```
1. ExchangeInfoService.updateFiltersFromExchange()
   → GET /fapi/v1/exchangeInfo
   → Extract leverageBrackets
   → Tìm max initialLeverage
   → Lưu vào symbol_filters.max_leverage
   
2. ExchangeService.createOrder()
   → ExchangeInfoService.getMaxLeverage(symbol) [Cache]
   → Nếu cache miss → BinanceDirectClient.getMaxLeverage(symbol) [REST API]
   → BinanceDirectClient.setLeverage(symbol, leverage)
```

### MEXC:

```
1. ExchangeInfoService.updateMexcFiltersFromExchange()
   → CCXT mexc.fetchMarkets({ type: 'swap' })
   → Extract m.limits.leverage.max hoặc m.info.maxLeverage
   → Lưu vào symbol_filters.max_leverage
   
2. ExchangeService.createOrder()
   → ExchangeInfoService.getMaxLeverage(symbol) [Cache]
   → Nếu cache miss → Default 50
   → MexcFuturesClient.setLeverage(symbol, leverage)
```

---

## 💡 Lưu Ý

### 1. Cache Priority
- **Luôn check cache trước** để tránh rate limit
- Cache được update định kỳ bởi `SymbolsUpdater` job

### 2. Bot Default Leverage
- Nếu bot có `default_leverage` được set, sẽ dùng giá trị này thay vì max leverage
- Priority: `bot.default_leverage` > `cache max_leverage` > `config default` > `hardcoded default`

### 3. Binance Leverage Brackets
- Binance có nhiều leverage brackets tùy theo notional (số tiền)
- Hệ thống lấy **max leverage** (bracket có `initialLeverage` cao nhất)
- Thực tế leverage có thể thấp hơn tùy theo notional

### 4. MEXC Leverage
- MEXC không có leverage brackets như Binance
- Leverage thường cố định cho mỗi symbol (thường là 50x hoặc 100x)
- Lấy từ CCXT market info

---

## 🔍 Code Locations

### Binance:
- **Cache:** `src/services/ExchangeInfoService.js:162-180`
- **REST API:** `src/services/BinanceDirectClient.js:736-750` (`getLeverageBrackets`)
- **Get Max:** `src/services/BinanceDirectClient.js:1030-1056` (`getMaxLeverage`)
- **Set Leverage:** `src/services/BinanceDirectClient.js:721-728`
- **Usage:** `src/services/ExchangeService.js:393-415`

### MEXC:
- **Cache:** `src/services/ExchangeInfoService.js:277-290`
- **Set Leverage:** `src/services/MexcFuturesClient.js:219-241`
- **Usage:** `src/services/ExchangeService.js:528-552`

---

## 📋 Database Schema

**Table:** `symbol_filters`

```sql
CREATE TABLE symbol_filters (
  id INT PRIMARY KEY AUTO_INCREMENT,
  exchange VARCHAR(50),
  symbol VARCHAR(50),
  tick_size VARCHAR(50),
  step_size VARCHAR(50),
  min_notional DECIMAL(20, 8),
  max_leverage INT,  -- ← Leverage được lưu ở đây
  created_at TIMESTAMP,
  updated_at TIMESTAMP,
  UNIQUE KEY (exchange, symbol)
);
```

---

## 🎯 Kết Luận

1. **Binance:**
   - Có API riêng để lấy leverage brackets: `/fapi/v1/leverageBracket`
   - Lấy max leverage từ brackets
   - Cache trong `symbol_filters` table

2. **MEXC:**
   - Không có API riêng để lấy leverage
   - Lấy từ CCXT market info (`limits.leverage.max`)
   - Cache trong `symbol_filters` table

3. **Cả hai:**
   - Ưu tiên cache trước (từ `symbol_filters`)
   - Fallback sang API/config nếu cache miss
   - Sử dụng `bot.default_leverage` nếu được set

---

**Report Generated:** 2025-01-27

