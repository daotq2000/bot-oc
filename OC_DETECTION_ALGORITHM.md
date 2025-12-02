# Thuật Toán Phát Hiện Dao Động Nến (OC Detection Algorithm)

## Tổng Quan

Hệ thống sử dụng thuật toán **OC (Open-Close)** để phát hiện dao động của nến và tạo tín hiệu giao dịch. Thuật toán này dựa trên sự chênh lệch giữa giá mở (open) và giá đóng (close) của nến.

## 1. Công Thức Tính OC

### Công thức cơ bản:
```
OC = ((close - open) / open) × 100
```

### Ví dụ:
- **Nến Bullish**: 
  - Open = 100, Close = 101
  - OC = ((101 - 100) / 100) × 100 = **+1%**
  
- **Nến Bearish**:
  - Open = 100, Close = 99
  - OC = ((99 - 100) / 100) × 100 = **-1%**

### Xác định hướng nến:
```javascript
direction = close >= open ? 'bullish' : 'bearish'
```

## 2. Quy Trình Phát Hiện Signal

### Bước 1: Lấy nến mới nhất
```javascript
latestCandle = await candleService.getLatestCandle(symbol, interval)
```

### Bước 2: Kiểm tra nến đã đóng chưa
```javascript
isClosed = Date.now() > candle.close_time
```
- **Xử lý cả nến đang mở và nến đã đóng** để bắt kịp sóng thị trường
- Nếu nến chưa đóng: sử dụng **current price** để tính OC real-time
- Nếu nến đã đóng: sử dụng **close price** từ database

### Bước 3: Tính toán OC và direction

**Nếu nến chưa đóng (đang mở):**
```javascript
currentPrice = await exchangeService.getTickerPrice(symbol)
oc = calculateOC(candle.open, currentPrice)  // Sử dụng current price
direction = getCandleDirection(candle.open, currentPrice)
```

**Nếu nến đã đóng:**
```javascript
oc = calculateOC(candle.open, candle.close)  // Sử dụng close price
direction = getCandleDirection(candle.open, candle.close)
```

**Lợi ích:**
- ✅ Bắt kịp sóng thị trường ngay khi dao động xảy ra
- ✅ Không cần chờ nến đóng mới phát hiện signal
- ✅ Phản ứng nhanh hơn với biến động giá

### Bước 4: So sánh với threshold
```javascript
if (Math.abs(oc) < strategy.oc) {
  return null; // Không đạt threshold
}
```
- Sử dụng **giá trị tuyệt đối** `Math.abs(oc)` để bỏ qua dấu
- Ví dụ: OC = -1.5% và threshold = 1% → **Đạt điều kiện** (|-1.5| >= 1)

### Bước 5: Xác định side cần kiểm tra
Dựa trên `trade_type` và `direction`:

| trade_type | direction | Sides to check |
|------------|-----------|----------------|
| `both`     | bullish   | `['long']`     |
| `both`     | bearish   | `['short']`    |
| `long`     | bullish   | `['long']`     |
| `long`     | bearish   | `[]` (skip)    |
| `short`    | bullish   | `[]` (skip)    |
| `short`    | bearish   | `['short']`    |

### Bước 6: Tính Entry Price

#### Cho LONG position:
```javascript
entryPrice = open - (open × oc × extend / 10000)
```

**Ví dụ:**
- Open = 100
- OC = 1% (absolute value)
- Extend = 10%
- Entry = 100 - (100 × 1 × 10 / 10000) = 100 - 0.1 = **99.9**

#### Cho SHORT position:
```javascript
entryPrice = open + (open × oc × extend / 10000)
```

**Ví dụ:**
- Open = 100
- OC = 1% (absolute value)
- Extend = 10%
- Entry = 100 + (100 × 1 × 10 / 10000) = 100 + 0.1 = **100.1**

### Bước 7: Kiểm tra Extend Condition

Đây là điều kiện **quan trọng nhất** để trigger signal:

#### Cho LONG:
```javascript
extendMet = currentPrice <= entryPrice && entryPrice < openPrice
```

**Điều kiện:**
1. `currentPrice <= entryPrice`: Giá hiện tại phải **giảm xuống dưới entry price**
2. `entryPrice < openPrice`: Entry price phải **thấp hơn open price**

**Ví dụ:**
- Open = 100
- Entry = 99.9 (sau khi tính extend)
- Current Price = 99.8
- → **✅ Đạt điều kiện** (99.8 <= 99.9 && 99.9 < 100)

#### Cho SHORT:
```javascript
extendMet = currentPrice >= entryPrice && entryPrice > openPrice
```

**Điều kiện:**
1. `currentPrice >= entryPrice`: Giá hiện tại phải **tăng lên trên entry price**
2. `entryPrice > openPrice`: Entry price phải **cao hơn open price**

**Ví dụ:**
- Open = 100
- Entry = 100.1 (sau khi tính extend)
- Current Price = 100.2
- → **✅ Đạt điều kiện** (100.2 >= 100.1 && 100.1 > 100)

### Bước 8: Kiểm tra Ignore Logic (Optional)

Kiểm tra xem có nên bỏ qua signal dựa trên nến trước đó:
- Nếu nến trước có hướng ngược lại
- Kiểm tra retracement có đủ không

### Bước 9: Tính Take Profit và Stop Loss

```javascript
tpPrice = calculateTakeProfit(entryPrice, oc, take_profit, side)
slPrice = calculateInitialStopLoss(tpPrice, oc, reduce, side)
```

## 3. Ví Dụ Thực Tế

### Scenario 1: Bullish Candle với OC = 1.5%

**Input:**
- Symbol: BTC/USDT
- Open = 100,000
- Close = 101,500
- OC = +1.5%
- Strategy: `oc = 1%`, `extend = 10%`, `trade_type = 'both'`

**Quy trình:**
1. ✅ Nến đã đóng
2. ✅ OC = 1.5% >= 1% (threshold)
3. ✅ Direction = 'bullish' → Check LONG
4. Entry Price = 100,000 - (100,000 × 1.5 × 10 / 10000) = **99,850**
5. **Chờ giá pullback xuống ≤ 99,850**
6. Nếu Current Price = 99,800 → ✅ **Signal LONG được tạo**

### Scenario 2: Bearish Candle với OC = -2%

**Input:**
- Symbol: ETH/USDT
- Open = 3,000
- Close = 2,940
- OC = -2%
- Strategy: `oc = 1%`, `extend = 10%`, `trade_type = 'both'`

**Quy trình:**
1. ✅ Nến đã đóng
2. ✅ OC = |-2%| = 2% >= 1% (threshold)
3. ✅ Direction = 'bearish' → Check SHORT
4. Entry Price = 3,000 + (3,000 × 2 × 10 / 10000) = **3,006**
5. **Chờ giá pullback lên ≥ 3,006**
6. Nếu Current Price = 3,010 → ✅ **Signal SHORT được tạo**

## 4. Tại Sao Không Có Position Được Mở?

### Vấn đề phổ biến:

1. **OC không đạt threshold**
   - Nến mới nhất có OC < 1%
   - Giải pháp: Giảm threshold hoặc chờ nến có dao động lớn hơn

2. **Extend condition không đạt**
   - Giá không pullback đủ để trigger entry
   - Ví dụ: Bullish candle, entry = 99.9, nhưng giá chỉ giảm đến 99.95
   - Giải pháp: Giảm `extend` hoặc điều chỉnh logic

3. ~~**Nến chưa đóng**~~ ✅ **ĐÃ FIX**
   - ~~SignalScanner chỉ xử lý nến đã đóng~~
   - ✅ **Bây giờ xử lý cả nến đang mở** - sử dụng current price để tính OC real-time

4. **Trade type không khớp**
   - `trade_type = 'long'` nhưng nến là bearish → Skip
   - `trade_type = 'short'` nhưng nến là bullish → Skip

## 5. Công Thức Tóm Tắt

```
OC = ((close - open) / open) × 100

LONG Entry = open - (open × |OC| × extend / 10000)
SHORT Entry = open + (open × |OC| × extend / 10000)

LONG Condition: currentPrice <= entryPrice && entryPrice < openPrice
SHORT Condition: currentPrice >= entryPrice && entryPrice > openPrice
```

## 6. Code Locations

- **OC Calculation**: `src/utils/calculator.js` → `calculateOC()`
- **Signal Detection**: `src/services/StrategyService.js` → `checkSignal()`
- **Extend Condition**: `src/services/StrategyService.js` → `checkExtendCondition()`
- **Entry Price**: `src/utils/calculator.js` → `calculateLongEntryPrice()`, `calculateShortEntryPrice()`

