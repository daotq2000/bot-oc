# Mô Tả Luồng Hệ Thống Sau Khi Tính Được OC

## Tổng Quan

Hệ thống có **2 luồng song song** để detect OC (Order Count/Open-Close percentage) và tự động trigger orders:

1. **WebSocketOCConsumer** (Event-driven): Nhận price ticks từ WebSocket realtime
2. **PriceAlertScanner** (Polling-based): Scan định kỳ các symbols từ PriceAlertSymbolTracker

Cả hai luồng đều không phụ thuộc vào database candles và sử dụng WebSocket price data.

---

## 1. Hai Luồng Phát Hiện OC

### 1.1. Luồng 1: WebSocketOCConsumer (Event-Driven)
- **Trigger**: WebSocket price tick events
- **Tần suất**: Realtime (mỗi khi có price update)
- **Component**: `src/consumers/WebSocketOCConsumer.js`
- **Ưu điểm**: Nhanh nhất, realtime, không có delay

### 1.2. Luồng 2: PriceAlertScanner (Polling-Based)
- **Trigger**: Interval timer (default: 100ms)
- **Tần suất**: Scan định kỳ
- **Component**: `src/jobs/PriceAlertScanner.js`
- **Ưu điểm**: Safety net khi WebSocket miss, có thể scan nhiều intervals cùng lúc

---

## 2. Tính Toán OC

### 1.1. Nguồn Dữ Liệu
- **WebSocket Price Ticks**: Nhận giá realtime từ `MexcWebSocketManager` hoặc `WebSocketManager` (Binance)
- **Open Price**: Lấy từ WebSocket kline data hoặc cache

### 1.2. Công Thức Tính OC
```javascript
OC = ((currentPrice - openPrice) / openPrice) * 100
```
- `openPrice`: Giá mở của candle hiện tại (theo interval)
- `currentPrice`: Giá hiện tại từ WebSocket tick
- Kết quả: Phần trăm biến động giá (có thể âm hoặc dương)

### 2.1. Component Chính: `RealtimeOCDetector`
- File: `src/services/RealtimeOCDetector.js`
- Method: `detectOC(exchange, symbol, price, timestamp, source)`
- Chức năng:
  - Lấy open price từ cache hoặc WebSocket
  - Tính OC percentage
  - Match với strategies trong `StrategyCache`
  - Trả về danh sách matches nếu OC đạt ngưỡng

---

## 3. Luồng 1: WebSocketOCConsumer (Event-Driven)

### 3.1. WebSocketOCConsumer Nhận Price Tick

**File**: `src/consumers/WebSocketOCConsumer.js`

**Flow**:
```
WebSocket Price Tick 
  → handlePriceTick()
  → Throttling check (min 100ms per symbol)
  → Add to batch queue
  → Process batch (deduplicate, parallel processing)
```

**Tối Ưu Hóa**:
- **Batch Processing**: Gộp nhiều ticks thành batch (default: 20 ticks)
- **Throttling**: Chỉ process mỗi symbol mỗi 100ms
- **Deduplication**: Chỉ lấy tick mới nhất cho mỗi symbol

### 3.2. Detect OC và Match Strategies

**Method**: `_detectAndProcess(tick)`

```javascript
// 1. Gọi RealtimeOCDetector để detect OC
const matches = await realtimeOCDetector.detectOC(
  exchange, 
  symbol, 
  price, 
  timestamp, 
  'WebSocketOCConsumer'
);

// 2. Nếu có matches, process từng match
if (matches.length > 0) {
  await Promise.allSettled(
    matches.map(match => this.processMatch(match))
  );
}
```

**Match Criteria**:
- OC đạt ngưỡng `strategy.oc` (ví dụ: 1.5%)
- Strategy đang active
- Symbol và exchange khớp
- Interval khớp

### 3.3. Process Match và Tạo Signal

**Method**: `processMatch(match)`

**Các Bước**:

#### a) Kiểm Tra Điều Kiện
- ✅ Kiểm tra `OrderService` có tồn tại cho bot
- ✅ Kiểm tra strategy đã có open position chưa (với cache)
- ✅ Xác định side (LONG/SHORT) dựa trên:
  - `direction` (bullish/bearish từ OC)
  - `trade_type` (long_only/short_only/both)
  - `is_reverse_strategy` (counter-trend hay trend-following)

#### b) Tính Entry Price
- **Counter-trend** (`is_reverse_strategy = true`):
  - Sử dụng extend logic
  - LONG: `entry = current - extendRatio * delta`
  - SHORT: `entry = current + extendRatio * delta`
  - Order type: **LIMIT**
  
- **Trend-following** (`is_reverse_strategy = false`):
  - Entry = current price
  - Order type: **MARKET** (forceMarket = true)

#### c) Tính TP/SL
```javascript
tpPrice = calculateTakeProfit(entryPrice, strategy.take_profit, side);
slPrice = calculateInitialStopLoss(entryPrice, strategy.stoploss, side);
```

#### d) Kiểm Tra Extend (chỉ cho counter-trend)
- Nếu extend không đạt 100%:
  - Nếu `ENABLE_LIMIT_ON_EXTEND_MISS = true`:
    - Kiểm tra `priceDiffRatio <= EXTEND_LIMIT_MAX_DIFF_RATIO` (default: 50%)
    - Nếu OK → Đặt LIMIT order thụ động
    - Nếu không → Skip order
  - Nếu `ENABLE_LIMIT_ON_EXTEND_MISS = false` → Skip order

#### e) Tạo Signal Object
```javascript
const signal = {
  strategy: strategy,
  side: 'long' | 'short',
  entryPrice: entryPrice,
  currentPrice: currentPrice,
  oc: Math.abs(oc),
  interval: interval,
  timestamp: timestamp,
  tpPrice: tpPrice,
  slPrice: slPrice,
  amount: strategy.amount,
  forceMarket: forceMarket, // true cho trend-following
  forcePassiveLimit: forcePassiveLimit // true nếu extend không đạt
};
```

### 3.4. OrderService.executeSignal()

**File**: `src/services/OrderService.js`

**Các Bước**:

#### a) Kiểm Tra Giới Hạn
- ✅ Max concurrent positions per bot
- ✅ Max amount per coin (per symbol)
- ✅ Position limit service check

#### b) Xác Định Order Type
```javascript
if (signal.forceMarket) {
  orderType = 'market'; // Trend-following
} else if (signal.forcePassiveLimit) {
  orderType = 'limit'; // Counter-trend với extend không đạt
} else {
  orderType = shouldUseMarketOrder() ? 'market' : 'limit';
}
```

#### c) Tạo Order Trên Exchange
```javascript
order = await exchangeService.createOrder({
  symbol: strategy.symbol,
  side: side === 'long' ? 'buy' : 'sell',
  positionSide: side === 'long' ? 'LONG' : 'SHORT',
  amount: amount, // USDT amount
  type: orderType,
  price: orderType === 'limit' ? entryPrice : undefined
});
```

**Fallback Logic**:
- Nếu LIMIT order bị reject với lỗi "would immediately trigger":
  - Nếu `ENABLE_FALLBACK_TO_MARKET = true` → Fallback sang MARKET
  - Nếu `ENABLE_FALLBACK_TO_MARKET = false` → Skip order

#### d) Xác Định Entry Price Thực Tế
- **MARKET order**: Dùng `avgFillPrice` hoặc `price` từ order response
- **LIMIT order**: 
  - Kiểm tra order status ngay lập tức
  - Nếu đã filled → Dùng `avgFillPrice`
  - Nếu chưa filled nhưng price đã crossed → Treat as filled
  - Nếu chưa filled → Dùng `entryPrice` (sẽ được update sau)

### 3.5. Tạo Position Trong Database

#### Trường Hợp 1: MARKET hoặc LIMIT đã filled ngay
```javascript
position = await Position.create({
  strategy_id: strategy.id,
  bot_id: strategy.bot_id,
  order_id: order.id,
  symbol: strategy.symbol,
  side: side,
  entry_price: effectiveEntryPrice, // Giá fill thực tế
  amount: amount,
  take_profit_price: tempTpPrice,
  stop_loss_price: tempSlPrice,
  current_reduce: strategy.reduce,
  tp_sl_pending: true // ⚠️ Flag: TP/SL orders sẽ được đặt bởi PositionMonitor
});
```

#### Trường Hợp 2: LIMIT order chưa filled
```javascript
// Tạo entry_order record để monitor
await EntryOrder.create({
  strategy_id: strategy.id,
  bot_id: strategy.bot_id,
  order_id: order.id,
  symbol: strategy.symbol,
  side: side,
  amount: amount,
  entry_price: effectiveEntryPrice,
  status: 'open'
});

// Position sẽ được tạo bởi EntryOrderMonitor khi order filled
```

### 3.6. Gửi Thông Báo
- ✅ Entry trade alert qua Telegram (central channel)
- ❌ Order notification (đã disable để tránh spam)

---

## 4. Luồng 2: PriceAlertScanner (Polling-Based)

**File**: `src/jobs/PriceAlertScanner.js`

### 4.1. Khởi Tạo Scanner

**Method**: `initialize(telegramService)`

**Các Bước**:
- Lấy active `PriceAlertConfig` từ database
- Extract exchanges từ configs (mexc, binance)
- Initialize `ExchangeService` cho mỗi exchange (public price mode, không cần API keys)
- Setup scan interval (default: 100ms)

### 4.2. Scan Loop (Định Kỳ)

**Method**: `scan()`

**Các Bước**:

#### a) Kiểm Tra Điều Kiện
```javascript
// Check master switch
if (!ENABLE_ALERTS) return;
if (!PRICE_ALERT_CHECK_ENABLED) return;

// Get active configs
const activeConfigs = await PriceAlertConfig.findAll();
```

#### b) Process Mỗi Config
- Lấy symbols từ `PriceAlertSymbolTracker.getSymbolsForExchange()`
- Lấy intervals từ config (default: ['1m'])
- Scan mỗi symbol với mỗi interval

### 4.3. Tính OC Cho Mỗi Symbol

**Method**: `checkSymbolPrice()`

**Các Bước**:

#### a) Lấy Current Price
```javascript
// Priority: WebSocket > Cache > null
const price = await this.getPrice(exchange, symbol);
```

**getPrice() Logic**:
1. Check cache (TTL: 500ms)
2. Try WebSocket (`webSocketManager` hoặc `mexcPriceWs`)
3. Return null nếu không có (REST API fallback đã disable)

#### b) Quản Lý Bucket State
```javascript
const now = Date.now();
const intervalMs = getIntervalMs(interval); // e.g., 60000 for '1m'
const bucket = Math.floor(now / intervalMs);

const stateKey = `${exchange}_${symbol}_${interval}`;
let state = this.alertStates.get(stateKey);

// New bucket -> reset openPrice
if (state.bucket !== bucket) {
  state.openPrice = price; // Reset open = current price
  state.bucket = bucket;
  state.alerted = false;
}
```

**Bucket Logic**:
- Mỗi interval có buckets riêng (1m = 60s buckets)
- Khi bucket thay đổi → reset `openPrice` = current price
- Đảm bảo OC được tính từ đầu mỗi candle

#### c) Tính OC
```javascript
const openPrice = state.openPrice;
const oc = ((price - openPrice) / openPrice) * 100; // signed
const ocAbs = Math.abs(oc);
```

### 4.4. Kiểm Tra Threshold và Gửi Alert

**Logic**:
```javascript
if (ocAbs >= threshold) {
  const timeSinceLastAlert = now - state.lastAlertTime;
  const minAlertInterval = 60000; // 1 minute
  
  if (!state.alerted || timeSinceLastAlert >= minAlertInterval) {
    await this.sendPriceAlert(...);
    state.lastAlertTime = now;
    state.alerted = true;
  }
} else {
  // Reset khi OC drop xuống dưới threshold
  state.alerted = false;
}
```

**Throttling**:
- Chỉ gửi alert mỗi 1 phút (minAlertInterval)
- Flag `alerted` để tránh spam
- Reset `alerted` khi OC < threshold

### 4.5. Gửi Alert và Trigger Orders

**Method**: `sendPriceAlert()`

**Các Bước**:

#### a) Gửi Telegram Alert
```javascript
await this.telegramService.sendVolatilityAlert(telegramChatId, {
  symbol,
  interval,
  oc: ocPercent,
  open: openPrice,
  currentPrice,
  direction: bullish ? 'bullish' : 'bearish'
});
```

#### b) Tìm Strategies và Match
```javascript
// Lấy strategies từ StrategyCache
const strategies = strategyCache.getStrategies(exchange, symbol);

// Filter và match
const matches = [];
for (const strategy of strategies) {
  if (strategy.is_active && 
      strategy.bot?.is_active !== false && 
      strategy.interval === interval) {
    const ocThreshold = Number(strategy.oc || 0);
    if (ocAbs >= ocThreshold) {
      matches.push({
        strategy,
        oc: ocPercent,
        absOC: ocAbs,
        direction,
        openPrice,
        currentPrice,
        interval,
        timestamp: Date.now()
      });
    }
  }
}
```

#### c) Trigger Order Execution
```javascript
if (matches.length > 0) {
  for (const match of matches) {
    // ⚠️ QUAN TRỌNG: Sử dụng webSocketOCConsumer.processMatch()
    // để đảm bảo logic xử lý giống với luồng WebSocket
    await webSocketOCConsumer.processMatch(match);
  }
}
```

**Điểm Quan Trọng**:
- PriceAlertScanner **không tự xử lý order**
- Nó gọi `webSocketOCConsumer.processMatch()` để tái sử dụng logic
- Đảm bảo consistency giữa 2 luồng

### 4.6. So Sánh 2 Luồng

| Tiêu Chí | WebSocketOCConsumer | PriceAlertScanner |
|----------|---------------------|-------------------|
| **Trigger** | WebSocket events | Interval timer (100ms) |
| **Tần Suất** | Realtime | Polling |
| **Nguồn Price** | WebSocket ticks | WebSocket cache |
| **OC Detection** | RealtimeOCDetector | Self-calculated |
| **Bucket Logic** | RealtimeOCDetector | Self-managed |
| **Order Execution** | processMatch() | webSocketOCConsumer.processMatch() |
| **Ưu Điểm** | Nhanh nhất, realtime | Safety net, multi-interval |
| **Nhược Điểm** | Phụ thuộc WebSocket | Có delay (polling) |

---

## 5. PositionMonitor - Đặt TP/SL Orders

**File**: `src/jobs/PositionMonitor.js`

### 5.1. Kiểm Tra `tp_sl_pending` Flag

**Method**: `placeExitOrder(position)`

```javascript
const isTPSLPending = position.tp_sl_pending === true || position.tp_sl_pending === 1;
let needsTp = !position.exit_order_id || isTPSLPending;
let needsSl = !position.sl_order_id || isTPSLPending;
```

### 5.2. Verify Existing Orders
- Kiểm tra TP/SL orders có còn active trên exchange không
- Nếu order đã filled/canceled → Cần recreate

### 5.3. Lấy Entry Price Thực Tế
```javascript
// Ưu tiên: Lấy từ exchange order fill price
fillPrice = await exchangeService.getOrderAverageFillPrice(
  position.symbol, 
  position.order_id
);

// Fallback: Dùng entry_price từ DB
if (!fillPrice) {
  fillPrice = position.entry_price;
}

// Update position với fill price thực tế
await Position.update(position.id, { entry_price: fillPrice });
```

### 5.4. Tính Lại TP/SL
```javascript
// Ưu tiên: Dùng trailing TP từ DB (nếu đã được tính)
if (position.take_profit_price) {
  tpPrice = position.take_profit_price; // Trailing TP
} else {
  tpPrice = calculateTakeProfit(fillPrice, strategy.take_profit, side);
}

// SL chỉ tính nếu strategy.stoploss > 0
if (strategy.stoploss > 0) {
  slPrice = calculateInitialStopLoss(fillPrice, strategy.stoploss, side);
}
```

### 5.5. Đặt TP/SL Orders
```javascript
// Đặt TP order
if (needsTp && tpPrice) {
  const { ExitOrderManager } = await import('./ExitOrderManager.js');
  const mgr = new ExitOrderManager(exchangeService);
  const tpOrder = await mgr.placeOrReplaceExitOrder(position, tpPrice);
  
  await Position.update(position.id, {
    exit_order_id: tpOrder.orderId,
    take_profit_price: tpPrice,
    tp_sl_pending: false // Clear flag
  });
}

// Đặt SL order
if (needsSl && slPrice) {
  const slOrder = await exchangeService.createStopLossOrder({
    symbol: position.symbol,
    side: position.side,
    quantity: quantity,
    stopPrice: slPrice
  });
  
  await Position.update(position.id, {
    sl_order_id: slOrder.id,
    stop_loss_price: slPrice,
    tp_sl_pending: false // Clear flag
  });
}
```

---

## 6. PositionService - Monitoring và Trailing TP

**File**: `src/services/PositionService.js`

### 6.1. Update Position (Mỗi Chu Kỳ)

**Method**: `updatePosition(position)`

**Các Bước**:

#### a) Kiểm Tra TP/SL Orders Filled
- ✅ Check WebSocket cache (`orderStatusCache`) trước (O(1))
- ✅ Nếu order filled → Close position ngay lập tức
- ✅ Fallback: Check REST API nếu cache miss

#### b) Tính Trailing Take Profit
```javascript
// Tính minutes elapsed từ opened_at
const totalMinutesElapsed = Math.floor((now - openedAt) / (60 * 1000));

// SAFETY CHECK: Reset nếu gap > 30 phút
if (totalMinutesElapsed - prevMinutes > 30) {
  prevMinutes = totalMinutesElapsed - 1; // Reset về 1 phút
  await Position.update(position.id, { minutes_elapsed: prevMinutes });
}

// Chỉ process 1 phút mỗi lần
const minutesToProcess = Math.min(totalMinutesElapsed - prevMinutes, 1);

// Tính trailing TP
const newTP = calculateNextTrailingTakeProfit(
  prevTP, 
  entryPrice, 
  initialTP, 
  trailingPercent, 
  side, 
  minutesToProcess
);
```

#### c) Kiểm Tra TP Cross Entry
- Nếu TP đã vượt qua entry price:
  - **Force Close** ngay lập tức
  - Reason: `tp_cross_entry_force_close`
  - Bypass CloseGuard

#### d) Replace TP Order (Nếu Cần)
- Kiểm tra threshold (tick size + price change %)
- Nếu đạt threshold → Replace TP order
- Update `take_profit_price` trong DB

#### e) Update Position
```javascript
await Position.update(position.id, {
  pnl: pnl,
  current_reduce: clampedReduce,
  minutes_elapsed: actualMinutesElapsed,
  take_profit_price: newTP // Trailing TP
});
```

---

## 7. Luồng Hoàn Chỉnh (Flowchart)

### 7.1. Luồng WebSocketOCConsumer

```
┌─────────────────────────────────────────────────────────────┐
│ 1. WebSocket Price Tick                                     │
│    (MexcWebSocketManager / WebSocketManager)               │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. WebSocketOCConsumer.handlePriceTick()                    │
│    - Throttling (100ms per symbol)                          │
│    - Batch processing (20 ticks)                            │
│    - Deduplication                                          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. RealtimeOCDetector.detectOC()                           │
│    - Lấy open price từ cache/WebSocket                      │
│    - Tính OC = ((current - open) / open) * 100             │
│    - Match với strategies                                   │
│    - Trả về matches[]                                       │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. WebSocketOCConsumer.processMatch()                       │
│    - Kiểm tra open position (cache)                         │
│    - Xác định side (LONG/SHORT)                            │
│    - Tính entry price (extend logic hoặc current)           │
│    - Tính TP/SL                                             │
│    - Kiểm tra extend condition                              │
│    - Tạo signal object                                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. OrderService.executeSignal()                             │
│    - Kiểm tra limits (max positions, max per coin)          │
│    - Xác định order type (MARKET/LIMIT)                    │
│    - Tạo order trên exchange                                │
│    - Lấy fill price thực tế                                │
│    - Tạo Position trong DB (tp_sl_pending=true)            │
│    - Hoặc tạo EntryOrder nếu LIMIT chưa filled              │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. PositionMonitor.placeExitOrder()                         │
│    - Kiểm tra tp_sl_pending flag                            │
│    - Verify existing TP/SL orders                           │
│    - Lấy fill price thực tế từ exchange                    │
│    - Tính lại TP/SL                                         │
│    - Đặt TP/SL orders                                       │
│    - Clear tp_sl_pending flag                               │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. PositionService.updatePosition() (Mỗi chu kỳ)           │
│    - Kiểm tra TP/SL filled (WebSocket cache)                │
│    - Tính trailing TP (1 phút mỗi lần)                      │
│    - Reset nếu gap > 30 phút                                │
│    - Kiểm tra TP cross entry → Force close                 │
│    - Replace TP order nếu cần                               │
│    - Update position trong DB                               │
└─────────────────────────────────────────────────────────────┘

### 7.2. Luồng PriceAlertScanner

```
┌─────────────────────────────────────────────────────────────┐
│ 1. Interval Timer (100ms)                                  │
│    PriceAlertScanner.scan()                                 │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 2. Get Active PriceAlertConfigs                             │
│    - Filter is_active = true                                │
│    - Extract exchanges (mexc, binance)                      │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 3. For Each Config:                                          │
│    - Get symbols from PriceAlertSymbolTracker               │
│    - Get intervals from config (default: ['1m'])            │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 4. For Each Symbol:                                         │
│    - Get price from WebSocket cache (500ms TTL)            │
│    - For each interval:                                     │
│      → checkSymbolPrice()                                    │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 5. Calculate OC                                             │
│    - Get bucket: Math.floor(now / intervalMs)              │
│    - New bucket → reset openPrice = currentPrice            │
│    - OC = ((currentPrice - openPrice) / openPrice) * 100   │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 6. Check Threshold                                          │
│    - If |OC| >= threshold:                                 │
│      → Check minAlertInterval (60s)                         │
│      → sendPriceAlert()                                     │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 7. Send Telegram Alert                                       │
│    - telegramService.sendVolatilityAlert()                  │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 8. Find Matching Strategies                                 │
│    - strategyCache.getStrategies(exchange, symbol)         │
│    - Filter: is_active, interval match, |OC| >= oc          │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 9. Trigger Order Execution                                  │
│    - webSocketOCConsumer.processMatch(match)               │
│    - ⚠️ Reuse logic từ WebSocketOCConsumer                 │
└────────────────────┬────────────────────────────────────────┘
                     │
                     ▼
┌─────────────────────────────────────────────────────────────┐
│ 10. OrderService.executeSignal()                            │
│     (Giống luồng WebSocketOCConsumer)                       │
└─────────────────────────────────────────────────────────────┘
```
```

---

## 8. Các Điểm Quan Trọng

### 8.1. Hai Luồng Song Song
- ✅ **WebSocketOCConsumer**: Event-driven, realtime, nhanh nhất
- ✅ **PriceAlertScanner**: Polling-based, safety net, multi-interval
- ✅ Cả hai đều gọi `webSocketOCConsumer.processMatch()` để đảm bảo consistency

### 8.2. Realtime Detection
- ✅ Không phụ thuộc database candles
- ✅ Sử dụng WebSocket price ticks
- ✅ Open price từ WebSocket kline data

### 8.3. Batch Processing & Throttling
- ✅ Batch size: 20 ticks
- ✅ Throttling: 100ms per symbol
- ✅ Deduplication: Chỉ lấy tick mới nhất

### 8.4. Order Type Logic
- **Trend-following**: MARKET order (forceMarket = true)
- **Counter-trend**: LIMIT order với extend logic
- **Extend miss**: LIMIT thụ động (nếu enabled)

### 8.5. TP/SL Placement
- ✅ `tp_sl_pending` flag để đảm bảo TP/SL được đặt
- ✅ PositionMonitor đặt TP/SL sau khi position created
- ✅ Verify existing orders trước khi recreate

### 8.6. Trailing TP
- ✅ Chỉ process 1 phút mỗi lần
- ✅ Reset về 1 phút nếu gap > 30 phút (safety check)
- ✅ Force close nếu TP cross entry

### 8.7. Error Handling
- ✅ Fallback to MARKET nếu LIMIT rejected
- ✅ Retry logic cho TP/SL placement
- ✅ Graceful degradation nếu WebSocket fails

---

## 9. Configuration Keys

| Key | Default | Mô Tả |
|-----|---------|-------|
| `WS_TICK_BATCH_SIZE` | 20 | Số ticks trong một batch |
| `WS_TICK_BATCH_TIMEOUT_MS` | 50 | Timeout để process batch |
| `WS_TICK_MIN_INTERVAL_MS` | 100 | Throttling interval per symbol |
| `WS_TICK_CONCURRENCY` | 10 | Số symbols xử lý song song |
| `ENABLE_LIMIT_ON_EXTEND_MISS` | true | Cho phép LIMIT khi extend không đạt |
| `EXTEND_LIMIT_MAX_DIFF_RATIO` | 0.5 | Max diff ratio cho LIMIT (50%) |
| `ENABLE_FALLBACK_TO_MARKET` | false | Fallback sang MARKET nếu LIMIT rejected |
| `OC_OPEN_PRIME_TOLERANCE_MS` | 3000 | Tolerance cho open price fetch |
| `PRICE_ALERT_SCAN_INTERVAL_MS` | 100 | Scan interval cho PriceAlertScanner |
| `PRICE_ALERT_CHECK_ENABLED` | true | Enable/disable PriceAlertScanner |
| `PRICE_ALERT_MAX_SCAN_DURATION_MS` | 30000 | Max duration cho một scan cycle |
| `ENABLE_ALERTS` | true | Master switch cho tất cả alerts |

---

## 10. Logging và Monitoring

### 10.1. Key Log Messages
- `[WebSocketOCConsumer] 🎯 Found X match(es)` - OC detected và matched
- `[OrderService] Order Success` - Order created thành công
- `[Place TP/SL] ✅ Using trailing TP from DB` - TP/SL placed
- `[TP Trail] ⚠️ Large gap detected` - Gap > 30 phút detected
- `[TP Trail] 🚨 TP crossed entry → FORCE CLOSE` - Force close triggered

### 10.2. Stats Tracking
- `processedCount`: Số ticks đã process
- `matchCount`: Số matches found
- `skippedCount`: Số ticks bị skip do throttling

---

## Kết Luận

Hệ thống có **2 luồng song song** để detect OC và trigger orders:

1. **WebSocketOCConsumer** (Event-driven): 
   - Nhận price ticks từ WebSocket realtime
   - Sử dụng `RealtimeOCDetector` để detect OC
   - Nhanh nhất, không có delay

2. **PriceAlertScanner** (Polling-based):
   - Scan định kỳ (100ms interval)
   - Tính OC tự quản lý bucket state
   - Safety net khi WebSocket miss
   - Hỗ trợ multi-interval scanning

**Điểm Chung**:
- Cả hai đều sử dụng WebSocket price data (không phụ thuộc database candles)
- Cả hai đều gọi `webSocketOCConsumer.processMatch()` để đảm bảo consistency
- Cùng một pipeline: detection → order placement → position management → trailing TP

Tất cả được tối ưu hóa với batch processing, throttling, caching, và error handling để đảm bảo hiệu suất và độ tin cậy cao.

