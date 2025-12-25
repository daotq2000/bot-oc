# Fix: Leverage Logic khi default_leverage = null

**Date:** 2025-01-27

---

## 🐛 Vấn Đề

Khi `bots.default_leverage = null`, hệ thống nên:
1. ✅ Ưu tiên lấy `max_leverage` từ `symbol_filters` cache
2. ❌ Nếu cache miss, **phải thử gọi API** (cho Binance) trước khi fallback
3. ❌ Chỉ fallback sang default config (5) nếu cả cache và API đều fail

**Nhưng logic cũ đang:**
- Nếu cache trả về `null`, nó **fallback ngay** sang default (5) mà không thử gọi API
- Điều này dẫn đến việc set leverage = 5x thay vì max leverage thực tế của coin (ví dụ: 125x cho BTCUSDT)

---

## ✅ Giải Pháp

### 1. Binance (ExchangeService.js:393-420)

**Trước:**
```javascript
const maxLeverageFromCache = exchangeInfoService.getMaxLeverage(normalizedSymbol);
const defaultLeverage = parseInt(configService.getNumber('BINANCE_DEFAULT_LEVERAGE', 5));
desiredLev = maxLeverageFromCache || defaultLeverage; // ❌ Fallback ngay nếu cache null
```

**Sau:**
```javascript
// Try cache first
let maxLeverageFromCache = exchangeInfoService.getMaxLeverage(normalizedSymbol);

// If cache miss, try API call (for Binance)
if (maxLeverageFromCache == null && this.binanceDirectClient) {
  try {
    maxLeverageFromCache = await this.binanceDirectClient.getMaxLeverage(normalizedSymbol);
    logger.debug(`[Binance] Fetched max leverage from API for ${normalizedSymbol}: ${maxLeverageFromCache}`);
  } catch (apiErr) {
    logger.warn(`[Binance] Failed to fetch max leverage from API for ${normalizedSymbol}: ${apiErr?.message || apiErr}`);
  }
}

// Only fallback to default config if both cache and API failed
if (maxLeverageFromCache != null && Number.isFinite(Number(maxLeverageFromCache))) {
  desiredLev = parseInt(maxLeverageFromCache);
} else {
  const defaultLeverage = parseInt(configService.getNumber('BINANCE_DEFAULT_LEVERAGE', 5));
  desiredLev = defaultLeverage;
  logger.warn(`[Binance] Using default leverage ${defaultLeverage} for ${normalizedSymbol} (cache and API both failed)`);
}
```

### 2. MEXC (ExchangeService.js:528-560 và 615-625)

**Trước:**
```javascript
maxLev = Number(exchangeInfoService.getMaxLeverage(symbol)) || Number(configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5));
```

**Sau:**
```javascript
// Try cache first
const maxLeverageFromCache = exchangeInfoService.getMaxLeverage(symbol);

// Only fallback to default config if cache is null/undefined
if (maxLeverageFromCache != null && Number.isFinite(Number(maxLeverageFromCache))) {
  maxLev = Number(maxLeverageFromCache);
} else {
  maxLev = Number(configService.getNumber('MEXC_DEFAULT_LEVERAGE', 5));
  logger.warn(`[MEXC] Using default leverage ${maxLev} for ${symbol} (cache miss)`);
}
```

**Lưu ý:** MEXC không có API riêng để lấy leverage, nên chỉ có thể dùng cache hoặc default.

---

## 📊 Thứ Tự Ưu Tiên (Sau Fix)

1. **`bot.default_leverage`** (nếu được set) → Dùng giá trị này
2. **Cache từ `symbol_filters.max_leverage`** → Ưu tiên cao nhất khi `default_leverage = null`
3. **API call** (chỉ Binance) → Nếu cache miss, thử gọi API
4. **Default config** (`BINANCE_DEFAULT_LEVERAGE` hoặc `MEXC_DEFAULT_LEVERAGE`) → Chỉ khi cả cache và API đều fail

---

## 🧪 Test Results

**Test Script:** `scripts/test_leverage_logic.js`

**Kết quả:**
```
=== Testing leverage logic for bot_id=2, exchange=binance, default_leverage=null ===

Step 1: Checking cache...
  Cache result: null (NOT FOUND)
Step 2: Cache miss, trying API call...
  API result: 125 (FOUND)

✅ Final leverage: 125 (from API)

=== Comparison ===
Old logic would use: 5
New logic uses: 125

✅ FIX VERIFIED: New logic correctly uses API result (125) instead of default (5)
```

**Kết luận:**
- ✅ Old logic: Cache miss → dùng default (5) ngay
- ✅ New logic: Cache miss → gọi API → lấy được 125 → dùng 125
- ✅ Fix đã hoạt động đúng như mong đợi

---

## 📝 Files Changed

1. **`src/services/ExchangeService.js`**
   - Dòng 393-420: Binance leverage logic
   - Dòng 528-560: MEXC leverage logic (createOrder)
   - Dòng 615-625: MEXC leverage logic (margin calculation)

---

## 🔍 Code Locations

### Binance:
- **File:** `src/services/ExchangeService.js`
- **Method:** `createOrder()` (dòng ~393-420)
- **Logic:** Cache → API → Default

### MEXC:
- **File:** `src/services/ExchangeService.js`
- **Method:** `createOrder()` (dòng ~528-560) và margin calculation (dòng ~615-625)
- **Logic:** Cache → Default (không có API)

---

## 💡 Lưu Ý

1. **Binance API Call:**
   - Method: `BinanceDirectClient.getMaxLeverage(symbol)`
   - Endpoint: `/fapi/v1/leverageBracket?symbol={symbol}`
   - Có thể gây rate limit nếu gọi quá nhiều, nên ưu tiên cache trước

2. **MEXC:**
   - Không có API riêng để lấy leverage
   - Chỉ có thể dùng cache từ `symbol_filters` hoặc default
   - Cache được update từ CCXT `fetchMarkets()`

3. **Cache Refresh:**
   - Cache được update định kỳ bởi `SymbolsUpdater` job
   - Nếu cache miss, có thể do:
     - Symbol chưa được sync vào `symbol_filters` table
     - Cache chưa được load từ DB
     - Symbol không tồn tại trên exchange

---

## ✅ Verification

Để verify fix hoạt động đúng:

1. **Set `bots.default_leverage = NULL`** cho một bot
2. **Đảm bảo symbol không có trong cache** (hoặc xóa khỏi `symbol_filters`)
3. **Tạo order** cho symbol đó
4. **Kiểm tra log:**
   - Phải thấy: `[Binance] Fetched max leverage from API for {symbol}: {leverage}`
   - Leverage được set phải là giá trị từ API, không phải default (5)

---

**Report Generated:** 2025-01-27

