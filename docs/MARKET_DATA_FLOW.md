# Cách Bot Lấy Dữ Liệu Market và Tính Toán Biến Động

## Tổng Quan Flow

```
SignalScanner → StrategyService → CandleService + ExchangeService → Tính OC → Kiểm tra Signal
```

## 1. Lấy Dữ Liệu Market

### 1.1. Candle Data (Dữ liệu nến)

**Nguồn dữ liệu:**
- **Binance**: Sử dụng `BinanceDirectClient` gọi trực tiếp API Binance Futures (`/fapi/v1/klines`)
  - Market data từ production API: `https://fapi.binance.com`
  - Trading từ testnet: `https://testnet.binancefuture.com`
- **MEXC/Gate.io**: Sử dụng CCXT library

**Quy trình:**
1. **CandleUpdater Job** (chạy mỗi phút) cập nhật candles cho tất cả strategies:
   ```javascript
   // CandleUpdater.js - line 75
   const strategies = await Strategy.findAll(null, true);
   // Lấy candles từ exchange và lưu vào database
   await candleService.updateCandles(strategy.symbol, strategy.interval);
   ```

2. **CandleService.fetchOHLCV()** lấy dữ liệu từ exchange:
   - Thử `swap` (futures) trước, nếu lỗi thì fallback sang `spot`
   - Format: `[timestamp, open, high, low, close, volume]`
   - Lưu vào database bảng `candles`

3. **Lưu trữ trong database:**
   - Bảng `candles` lưu: `exchange`, `symbol`, `interval`, `open_time`, `open`, `high`, `low`, `close`, `volume`, `close_time`

### 1.2. Current Price (Giá hiện tại)

**Khi scan signal:**
```javascript
// StrategyService.js - line 39
const currentPrice = await this.exchangeService.getTickerPrice(strategy.symbol);
```

**Nguồn:**
- **Binance**: `BinanceDirectClient.getPrice()` → `/fapi/v1/ticker/price`
- **MEXC/Gate**: `exchange.fetchTicker()` từ CCXT

**Mục đích:** Tính OC real-time khi nến chưa đóng

## 2. Tính Toán Biến Động (OC - Open-Close)

### 2.1. Công Thức Tính OC

```javascript
// calculator.js - line 11-14
export function calculateOC(open, close) {
  if (!open || open === 0) return 0;
  return ((close - open) / open) * 100;
}
```

**Công thức:** `OC% = ((close - open) / open) * 100`

**Ví dụ:**
- Open = 100, Close = 102 → OC = +2.00% (bullish)
- Open = 100, Close = 98 → OC = -2.00% (bearish)

### 2.2. Xác Định Direction (Hướng)

```javascript
// calculator.js - line 22-24
export function getCandleDirection(open, close) {
  return close >= open ? 'bullish' : 'bearish';
}
```

- **Bullish**: `close >= open` (giá tăng)
- **Bearish**: `close < open` (giá giảm)

### 2.3. Xử Lý Nến Đóng vs Nến Mở

**Khi nến đã đóng:**
```javascript
// StrategyService.js - line 52-56
const metrics = this.candleService.calculateCandleMetrics(latestCandle);
oc = metrics.oc;  // Sử dụng close price từ database
direction = metrics.direction;
```

**Khi nến chưa đóng (đang mở):**
```javascript
// StrategyService.js - line 46-50
oc = this.candleService.calculateOC(latestCandle.open, currentPrice);
direction = this.candleService.getCandleDirection(latestCandle.open, currentPrice);
// Log: "Candle OPEN - OC=0.00% (using current price)"
```

**Lý do:** Khi nến chưa đóng, bot sử dụng giá hiện tại (`currentPrice`) thay vì `close` để tính OC real-time.

### 2.4. Kiểm Tra Candle Đã Đóng

```javascript
// CandleService.js - line 194-197
isCandleClosed(candle) {
  if (!candle || !candle.close_time) return false;
  return Date.now() > candle.close_time;
}
```

**Logic:** So sánh thời gian hiện tại với `close_time` của nến.

## 3. Flow Chi Tiết Khi Scan Signal

### 3.1. SignalScanner.scanStrategy()

```javascript
// SignalScanner.js - line 87-122
async scanStrategy(strategy) {
  // 1. Kiểm tra đã có position mở chưa
  const openPositions = await Position.findOpen(strategy.id);
  
  // 2. Gọi StrategyService.checkSignal()
  const signal = await strategyService.checkSignal(strategy);
  
  // 3. Nếu có signal, execute order
  if (signal) {
    await orderService.executeSignal(signal);
  }
}
```

### 3.2. StrategyService.checkSignal()

**Bước 1: Lấy latest candle từ database**
```javascript
const latestCandle = await this.candleService.getLatestCandle(
  strategy.symbol,
  strategy.interval
);
```

**Bước 2: Lấy current price từ exchange**
```javascript
const currentPrice = await this.exchangeService.getTickerPrice(strategy.symbol);
```

**Bước 3: Kiểm tra nến đã đóng chưa**
```javascript
const isClosed = this.candleService.isCandleClosed(latestCandle);
```

**Bước 4: Tính OC**
- Nếu nến chưa đóng: `OC = (currentPrice - open) / open * 100`
- Nếu nến đã đóng: `OC = (close - open) / open * 100`

**Bước 5: Kiểm tra threshold**
```javascript
if (Math.abs(oc) < strategy.oc) {
  return null; // OC chưa đạt ngưỡng
}
```

**Bước 6: Xác định side cần check**
- `trade_type = 'both'`: Check LONG nếu bullish, SHORT nếu bearish
- `trade_type = 'long'`: Chỉ check LONG khi bullish
- `trade_type = 'short'`: Chỉ check SHORT khi bearish

**Bước 7: Kiểm tra extend condition**
- LONG: Giá phải giảm xuống dưới entry price
- SHORT: Giá phải tăng lên trên entry price

**Bước 8: Kiểm tra ignore logic**
- So sánh với nến trước đó
- Nếu nến trước ngược hướng, kiểm tra retracement

## 4. Ví Dụ Thực Tế

### Log từ bot:
```
[Signal] Strategy 543 (RADUSDT): Candle OPEN - OC=0.00% (using current price), direction=bullish, threshold=2.00%
```

**Giải thích:**
1. Strategy ID: 543
2. Symbol: RADUSDT
3. Trạng thái nến: **OPEN** (chưa đóng)
4. OC tính bằng: `currentPrice` (giá hiện tại từ exchange)
5. OC = 0.00% → Chưa đạt threshold 2.00%
6. Direction: bullish (giá đang tăng so với open)
7. Kết quả: Không có signal (OC < 2.00%)

### Khi OC đạt threshold:
```
[Signal] Strategy 543 (RADUSDT): Candle OPEN - OC=2.50% (using current price), direction=bullish, threshold=2.00%
[Signal] Strategy 543 (RADUSDT): Checking sides: long (trade_type=both)
[Signal] Strategy 543 (RADUSDT) long: Entry=99.50, Current=100.00, Open=100.00, Extend=50%
[Signal] ✅ Strategy 543 (RADUSDT): Signal detected! Side=long, Entry=99.50, Current=100.00
```

## 5. Tính Toán Entry Price

### LONG Entry:
```javascript
// calculator.js - line 34-37
calculateLongEntryPrice(open, oc, extend) {
  const entryOffset = (open * oc * extend) / 10000;
  return open - entryOffset;
}
```

**Ví dụ:**
- Open = 100, OC = 2%, Extend = 50%
- Entry = 100 - (100 * 2 * 50 / 10000) = 100 - 1 = 99

### SHORT Entry:
```javascript
// calculator.js - line 47-50
calculateShortEntryPrice(open, oc, extend) {
  const entryOffset = (open * oc * extend) / 10000;
  return open + entryOffset;
}
```

**Ví dụ:**
- Open = 100, OC = 2%, Extend = 50%
- Entry = 100 + (100 * 2 * 50 / 10000) = 100 + 1 = 101

## 6. Tóm Tắt

1. **Dữ liệu nến**: Lấy từ exchange API, lưu vào database, cập nhật mỗi phút
2. **Giá hiện tại**: Lấy real-time từ exchange khi scan signal
3. **Tính OC**: 
   - Nến đóng: `(close - open) / open * 100`
   - Nến mở: `(currentPrice - open) / open * 100`
4. **Kiểm tra signal**: OC phải >= threshold, kiểm tra extend condition, ignore logic
5. **Entry price**: Tính dựa trên open, OC, và extend percentage

