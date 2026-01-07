# CÁCH HỆ THỐNG PHÁT HIỆN NẾN CÓ OC >= THRESHOLD

## 📊 NGUỒN DỮ LIỆU

### 1. **Exchange API (MEXC/Gate.io)**
- **Công cụ**: CCXT library
- **Endpoint**: `fetchOHLCV()` - Fetch candlestick data
- **Dữ liệu trả về**: 
  ```
  [
    [timestamp, open, high, low, close, volume],
    [timestamp, open, high, low, close, volume],
    ...
  ]
  ```

### 2. **Luồng Lấy Dữ Liệu**

```
Exchange (MEXC/Gate.io)
    ↓
ExchangeService.fetchOHLCV()
    ↓
CandleService.updateCandles()
    ↓
Lưu vào Database (bảng candles)
```

---

## 🔄 QUY TRÌNH TỰ ĐỘNG

### **Bước 1: CandleUpdater Job (Mỗi phút)**

```javascript
// File: src/jobs/CandleUpdater.js

// Chạy mỗi phút (*/1 * * * *)
cron.schedule('*/1 * * * *', async () => {
  // 1. Lấy tất cả strategies đang active
  const strategies = await Strategy.findAll(null, true);
  
  // 2. Group theo bot_id + symbol + interval (tránh duplicate)
  // 3. Fetch candles từ exchange cho mỗi strategy
  await candleService.updateCandles(symbol, interval);
});
```

**Chi tiết:**
- Job chạy **mỗi phút** (cron: `*/1 * * * *`)
- Lấy tất cả strategies đang active
- Group để tránh fetch duplicate (cùng symbol+interval)
- Fetch **100 candles** mới nhất từ exchange
- Lưu vào database

### **Bước 2: Fetch từ Exchange**

```javascript
// File: src/services/ExchangeService.js

async fetchOHLCV(symbol, timeframe, limit = 100) {
  // Sử dụng CCXT để fetch OHLCV data
  const candles = await this.exchange.fetchOHLCV(
    symbol,      // VD: "BTC/USDT"
    timeframe,   // VD: "1m", "5m", "1h"
    undefined,   // since (undefined = latest)
    limit        // 100 candles
  );
  
  // Convert format:
  return candles.map(candle => ({
    symbol,
    interval: timeframe,
    open_time: candle[0],      // timestamp
    open: candle[1],            // giá mở
    high: candle[2],            // giá cao nhất
    low: candle[3],             // giá thấp nhất
    close: candle[4],           // giá đóng
    volume: candle[5],          // volume
    close_time: candle[0] + timeframe_ms - 1
  }));
}
```

**Nguồn dữ liệu:**
- **MEXC**: `https://api.mexc.com/api/v3/klines`
- **Gate.io**: `https://api.gateio.ws/api/v4/futures/usdt/candlesticks`
- Tất cả requests đi qua **proxy** (nếu cấu hình)

### **Bước 3: Lưu vào Database**

```javascript
// File: src/services/CandleService.js

async updateCandles(symbol, interval) {
  // 1. Fetch từ exchange
  const candles = await this.exchangeService.fetchOHLCV(symbol, interval, 100);
  
  // 2. Bulk insert/update vào database
  await Candle.bulkInsert(candles);
}
```

**Database:**
- Bảng `candles` lưu trữ:
  - `symbol`: BTC/USDT
  - `interval`: 1m, 5m, 1h...
  - `open_time`, `open`, `high`, `low`, `close`, `volume`, `close_time`

---

## 🔍 PHÁT HIỆN OC >= THRESHOLD

### **Bước 1: SignalScanner Job (Mỗi phút)**

```javascript
// File: src/jobs/SignalScanner.js

// Chạy mỗi phút
cron.schedule('*/1 * * * *', async () => {
  // 1. Lấy tất cả strategies đang active
  const strategies = await Strategy.findAll(null, true);
  
  // 2. Check signal cho mỗi strategy
  for (const strategy of strategies) {
    const signal = await strategyService.checkSignal(strategy);
    if (signal) {
      await orderService.executeSignal(signal);
    }
  }
});
```

### **Bước 2: Check Signal Logic**

```javascript
// File: src/services/StrategyService.js

async checkSignal(strategy) {
  // 1. Lấy nến mới nhất từ DATABASE
  const latestCandle = await this.candleService.getLatestCandle(
    strategy.symbol,
    strategy.interval
  );
  
  // 2. Kiểm tra nến đã đóng chưa
  const isClosed = this.candleService.isCandleClosed(latestCandle);
  if (!isClosed) return null; // Chờ nến đóng
  
  // 3. TÍNH OC
  const { oc, direction } = this.candleService.calculateCandleMetrics(latestCandle);
  
  // 4. SO SÁNH VỚI THRESHOLD
  if (Math.abs(oc) < strategy.oc) {
    return null; // OC không đủ lớn
  }
  
  // 5. OC >= threshold → Tiếp tục xử lý signal
  // ...
}
```

### **Bước 3: Tính OC (Open-Close Percentage)**

```javascript
// File: src/utils/calculator.js

function calculateOC(open, close) {
  if (!open || open === 0) return 0;
  return ((close - open) / open) * 100;
}

// Ví dụ:
// open = 50000
// close = 51000
// OC = ((51000 - 50000) / 50000) * 100 = 2%
```

**Công thức:**
```
OC = ((close_price - open_price) / open_price) × 100
```

**Ý nghĩa:**
- **OC > 0**: Nến tăng (bullish) - close > open
- **OC < 0**: Nến giảm (bearish) - close < open
- **OC = 0**: Nến không đổi

### **Bước 4: So Sánh với Threshold**

```javascript
// strategy.oc = 2.00 (threshold = 2%)
// Math.abs(oc) = |2.5| = 2.5
// 2.5 >= 2.00 → ✅ Đạt điều kiện

if (Math.abs(oc) < strategy.oc) {
  // OC không đủ lớn, bỏ qua
  return null;
}
```

**Logic:**
- Sử dụng `Math.abs()` để lấy giá trị tuyệt đối
- So sánh với `strategy.oc` (threshold)
- Chỉ xử lý khi `|OC| >= threshold`

---

## 📈 VÍ DỤ CỤ THỂ

### **Scenario 1: Nến đạt điều kiện**

```
Strategy config:
- Symbol: BTC/USDT
- Interval: 1m
- OC threshold: 2.0%

Nến mới nhất:
- Open: $50,000
- Close: $51,000
- OC = ((51000 - 50000) / 50000) × 100 = 2.0%

Kết quả: |2.0| >= 2.0 → ✅ Đạt điều kiện → Tạo signal
```

### **Scenario 2: Nến không đạt điều kiện**

```
Nến mới nhất:
- Open: $50,000
- Close: $50,500
- OC = ((50500 - 50000) / 50000) × 100 = 1.0%

Kết quả: |1.0| < 2.0 → ❌ Không đạt → Bỏ qua
```

### **Scenario 3: Nến chưa đóng**

```
Nến hiện tại (đang hình thành):
- Open time: 10:00:00
- Close time: 10:01:00 (chưa đến)
- Current time: 10:00:30

Kết quả: Nến chưa đóng → Chờ đến 10:01:00
```

---

## 🔄 FLOW HOÀN CHỈNH

```
1. CandleUpdater (mỗi phút)
   ↓
2. Fetch OHLCV từ Exchange (MEXC/Gate.io)
   ↓
3. Lưu vào Database (bảng candles)
   ↓
4. SignalScanner (mỗi phút)
   ↓
5. Đọc nến mới nhất từ Database
   ↓
6. Kiểm tra nến đã đóng?
   ↓
7. Tính OC = ((close - open) / open) × 100
   ↓
8. So sánh: |OC| >= threshold?
   ↓
9. Nếu đạt → Tạo signal → Execute order
```

---

## 🎯 ĐIỂM QUAN TRỌNG

### **1. Nguồn dữ liệu:**
- ✅ **Real-time từ Exchange API** (MEXC/Gate.io)
- ✅ **Lưu cache trong Database** để truy vấn nhanh
- ✅ **Cập nhật mỗi phút** tự động

### **2. Tính OC:**
- ✅ Tính từ **open** và **close** price
- ✅ Sử dụng giá trị tuyệt đối `|OC|`
- ✅ So sánh với **threshold** trong strategy

### **3. Điều kiện:**
- ✅ Nến phải **đã đóng** (close_time < now)
- ✅ OC phải **>= threshold**
- ✅ Chỉ xử lý nến **mới nhất**

### **4. Proxy Support:**
- ✅ Tất cả requests đến exchange đi qua proxy
- ✅ Format: `IP:PORT:USER:PASS`
- ✅ Bảo vệ khỏi IP ban

---

## 📝 CODE LOCATIONS

1. **Fetch dữ liệu**: `src/services/ExchangeService.js` → `fetchOHLCV()`
2. **Lưu database**: `src/services/CandleService.js` → `updateCandles()`
3. **Cron job update**: `src/jobs/CandleUpdater.js` → `updateAllCandles()`
4. **Tính OC**: `src/utils/calculator.js` → `calculateOC()`
5. **Check signal**: `src/services/StrategyService.js` → `checkSignal()`
6. **Cron job scan**: `src/jobs/SignalScanner.js` → `scanAllStrategies()`

---

**Tóm lại: Hệ thống lấy dữ liệu nến real-time từ Exchange API (MEXC/Gate.io) qua CCXT, lưu vào database, và mỗi phút kiểm tra nến mới nhất để tính OC và so sánh với threshold. Nếu đạt điều kiện, tạo signal và thực thi lệnh.**

