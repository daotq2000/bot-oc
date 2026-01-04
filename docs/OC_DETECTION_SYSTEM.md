# 📊 Hệ Thống Phát Hiện và Thực Thi OC (Open-Change) - Tài Liệu Chi Tiết

## 📋 Mục Lục

1. [Tổng Quan Kiến Trúc](#1-tổng-quan-kiến-trúc)
2. [Module RealtimeOCDetector - Phát Hiện OC](#2-module-realtimeocdetector---phát-hiện-oc)
3. [Module WebSocketOCConsumer - Xử Lý Signal](#3-module-websocketocconsumer---xử-lý-signal)
4. [Module OrderService - Thực Thi Order](#4-module-orderservice---thực-thi-order)
5. [Market Regime Service - Quản Lý Rủi Ro](#5-market-regime-service---quản-lý-rủi-ro)
6. [Flow Từ Đầu Đến Cuối](#6-flow-từ-đầu-đến-cuối)
7. [Cơ Chế Cache và Tối Ưu](#7-cơ-chế-cache-và-tối-ưu)
8. [Xử Lý Lỗi và Fail-Safe](#8-xử-lý-lỗi-và-fail-safe)

---

## 1. Tổng Quan Kiến Trúc

### 1.1 Kiến Trúc Tổng Thể

```
┌─────────────────────────────────────────────────────────────────┐
│                    WebSocket Price Streams                       │
│  (Binance Futures / MEXC Swap - Mark Price Ticks)              │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              WebSocketOCConsumer                                │
│  - Batch processing price ticks                                 │
│  - Throttling per symbol                                        │
│  - Deduplication                                                │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              RealtimeOCDetector                                 │
│  - Track open prices per interval bucket                        │
│  - Calculate OC percentage                                      │
│  - Match with strategies                                        │
│  - Market regime detection                                      │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              OrderService                                        │
│  - Execute signal                                               │
│  - Create entry order                                           │
│  - Position limit checks                                        │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│              ExchangeService                                     │
│  - Create order on exchange                                     │
│  - Handle order status                                          │
│  - Position management                                          │
└─────────────────────────────────────────────────────────────────┘
```

### 1.2 Các Module Chính

| Module | Chức Năng | File |
|--------|-----------|------|
| **RealtimeOCDetector** | Phát hiện OC realtime, tính toán và match strategies | `src/services/RealtimeOCDetector.js` |
| **WebSocketOCConsumer** | Consumer WebSocket ticks, trigger orders | `src/consumers/WebSocketOCConsumer.js` |
| **OrderService** | Thực thi signal, tạo orders | `src/services/OrderService.js` |
| **MarketRegimeService** | Phân loại market regime, quản lý risk | `src/services/MarketRegimeService.js` |
| **WebSocketManager** | Quản lý WebSocket connections (Binance) | `src/services/WebSocketManager.js` |
| **StrategyCache** | Cache strategies để tăng tốc lookup | `src/services/StrategyCache.js` |

---

## 2. Module RealtimeOCDetector - Phát Hiện OC

### 2.1 Tổng Quan

**RealtimeOCDetector** là module core của hệ thống, chịu trách nhiệm:
- Track open price cho mỗi interval bucket (1m, 5m, 15m, etc.)
- Tính toán OC (Open-Change) percentage từ current price và open price
- Match OC với strategies trong cache
- Áp dụng market regime filtering để quản lý risk

**Đặc điểm quan trọng:**
- ✅ **KHÔNG sử dụng database candles** - hoàn toàn realtime từ WebSocket
- ✅ **Cache-first strategy** - ưu tiên cache để giảm REST API calls
- ✅ **Batch processing** - xử lý nhiều intervals song song
- ✅ **Circuit breaker** - tránh REST API spam khi có lỗi

### 2.2 Cấu Trúc Dữ Liệu

#### 2.2.1 Open Price Cache

```javascript
// Key: exchange|symbol|interval|bucketStart
// Value: { open, bucketStart, lastUpdate }
this.openPriceCache = new LRUCache(1000);
```

**Ví dụ:**
- Key: `binance|BTCUSDT|1m|1704067200000`
- Value: `{ open: 43000, bucketStart: 1704067200000, lastUpdate: 1704067205000 }`

#### 2.2.2 OC Match State Cache

```javascript
// Key: strategyId|symbol|interval|bucketStart
// Value: { armed, fired, firstCrossTs, peakAbs, peakTs }
this._ocMatchStateCache = new LRUCache(5000);
```

**Dùng cho reverse strategy:**
- `armed`: Đã vượt threshold chưa
- `fired`: Đã fire order chưa
- `peakAbs`: Giá trị OC peak cao nhất
- `peakTs`: Timestamp của peak

### 2.3 Flow Phát Hiện OC

#### 2.3.1 Entry Point: `detectOC()`

```javascript
async detectOC(exchange, symbol, currentPrice, timestamp, caller, options)
```

**Input:**
- `exchange`: Tên exchange (binance, mexc)
- `symbol`: Trading symbol (BTCUSDT)
- `currentPrice`: Giá hiện tại từ WebSocket
- `timestamp`: Timestamp của price tick
- `caller`: Tên module gọi (để logging)

**Output:**
- Array of match objects: `[{ strategy, oc, absOC, direction, openPrice, currentPrice, interval, timestamp, sizeMultiplier }]`

#### 2.3.2 Các Bước Xử Lý

**Bước 1: Normalize và Validate**
```javascript
const normalizedExchange = (exchange || '').toLowerCase();
const normalizedSymbol = String(symbol || '').toUpperCase().replace(/[\/:_]/g, '');

// Check price change threshold (0.01% default)
if (!this.hasPriceChanged(normalizedExchange, normalizedSymbol, currentPrice)) {
  return []; // Skip nếu giá chưa thay đổi đáng kể
}
```

**Bước 2: Get Strategies từ Cache**
```javascript
const strategies = strategyCache.getStrategies(normalizedExchange, normalizedSymbol);

// Pre-filter: chỉ lấy strategies hợp lệ
const validStrategies = strategies.filter(s => {
  const ocThreshold = Number(s.oc || 0);
  return ocThreshold > 0 && 
         s.is_active && 
         (s.bot?.is_active !== false) &&
         s.interval;
});
```

**Bước 3: Batch Get Open Prices**
```javascript
// Lấy tất cả unique intervals
const intervals = [...new Set(validStrategies.map(s => s.interval || '1m'))];

// Batch fetch open prices cho tất cả intervals
const openPricesMap = await this._batchGetOpenPrices(
  normalizedExchange,
  normalizedSymbol,
  intervals,
  currentPrice,
  timestamp
);
```

**Bước 4: Check Strategies (Parallel)**
```javascript
// Xử lý song song với concurrency limit
const concurrency = Number(configService.getNumber('OC_DETECT_CONCURRENCY', 10));
const matches = [];

for (let i = 0; i < validStrategies.length; i += concurrency) {
  const batch = validStrategies.slice(i, i + concurrency);
  const results = await Promise.all(
    batch.map(strategy => this._checkStrategy(
      strategy,
      normalizedSymbol,
      openPricesMap.get(strategy.interval || '1m'),
      currentPrice,
      timestamp,
      normalizedExchange
    ))
  );
  
  matches.push(...results.filter(m => m !== null));
}
```

### 2.4 Lấy Open Price - Chi Tiết

#### 2.4.1 `getAccurateOpen()` - Hàm Chính

**Priority Order:**
1. **Cache hit** → Return ngay
2. **WebSocket kline OPEN** (Binance only) → Fastest, no REST
3. **Previous candle CLOSE** (Binance fallback) → Open(t) = Close(t-1)
4. **REST OHLCV** (với queue và circuit breaker)

**Code Flow:**
```javascript
async getAccurateOpen(exchange, symbol, interval, currentPrice, timestamp) {
  const bucketStart = this.getBucketStart(interval, timestamp);
  const key = `${exchange}|${symbol}|${interval}|${bucketStart}`;
  
  // 1. Check cache
  const cached = this.openPriceCache.get(key);
  if (cached && cached.bucketStart === bucketStart) {
    return { open: cached.open, error: null };
  }
  
  // 2. Try WebSocket kline OPEN (Binance only)
  if (exchange === 'binance') {
    const wsOpen = webSocketManager.getKlineOpen(symbol, interval, bucketStart);
    if (wsOpen > 0) {
      this.openPriceCache.set(key, { open: wsOpen, bucketStart, lastUpdate: timestamp });
      return { open: wsOpen, error: null };
    }
    
    // Fallback: Previous candle CLOSE
    const prevBucketStart = bucketStart - this.getIntervalMs(interval);
    const prevClose = webSocketManager.getKlineClose(symbol, interval, prevBucketStart);
    if (prevClose > 0) {
      this.openPriceCache.set(key, { open: prevClose, bucketStart, lastUpdate: timestamp });
      return { open: prevClose, error: null };
    }
  }
  
  // 3. REST OHLCV (với queue)
  const result = await this.fetchOpenFromRest(exchange, symbol, interval, bucketStart);
  if (result.error) {
    // Safe fallback trong 2s đầu bucket
    if (elapsedInBucket <= 2000) {
      return { open: currentPrice, error: result.error };
    }
    return { open: null, error: result.error };
  }
  
  return { open: result.open, error: null };
}
```

#### 2.4.2 REST Fetch Queue

**Mục đích:** Tránh rate limit và throttle queue overflow

**Cơ chế:**
- Queue-based: Enqueue requests thay vì gọi trực tiếp
- Concurrent processing: Xử lý 2 requests đồng thời (configurable)
- Circuit breaker: Skip requests nếu có quá nhiều lỗi
- Stale eviction: Xóa requests cũ (>2 phút) khỏi queue

**Code:**
```javascript
async fetchOpenFromRest(exchange, symbol, interval, bucketStart) {
  return new Promise((resolve, reject) => {
    const queueKey = `${exchange}|${symbol}|${interval}|${bucketStart}`;
    
    // Circuit breaker check
    if (this._isRestOpenCircuitOpen(queueKey)) {
      resolve({ open: null, error: new Error('Circuit open') });
      return;
    }
    
    // Enqueue request
    this._restFetchQueue.push({ 
      resolve, 
      reject, 
      exchange, 
      symbol, 
      interval, 
      bucketStart, 
      enqueuedAt: Date.now(), 
      queueKey 
    });
    
    this._processRestFetchQueue();
  });
}
```

### 2.5 Strategy Matching Logic

#### 2.5.1 `_checkStrategy()` - Core Matching Function

**Input:**
- `strategy`: Strategy object từ cache
- `symbol`: Trading symbol
- `openPrice`: Open price cho interval này
- `currentPrice`: Current price từ WebSocket
- `timestamp`: Event timestamp
- `exchange`: Exchange name (cho regime detection)

**Output:**
- Match object hoặc `null`

#### 2.5.2 Trend-Follow Strategy (is_reverse_strategy = false)

**Logic:**
```javascript
if (!isReverse) {
  // Fire ngay khi absOC >= threshold
  if (!st.fired && absOC >= ocThreshold) {
    st.fired = true;
    
    // Lock regime sau khi fire (20s)
    if (this.regimeEnabled) {
      marketRegimeService.lockRegime(exchange, symbol, interval, timestamp);
    }
    
    return { 
      strategy, 
      oc, 
      absOC, 
      direction, 
      openPrice, 
      currentPrice, 
      interval, 
      timestamp,
      sizeMultiplier: regimeParams?.sizeMultiplier ?? 1.0
    };
  }
  return null;
}
```

**Đặc điểm:**
- ✅ Fire ngay lập tức khi vượt threshold
- ✅ Không cần retrace
- ✅ Delay fire cho VOL_EXPANSION (300ms) và NEWS_SPIKE (1s)

#### 2.5.3 Reverse Strategy (is_reverse_strategy = true)

**Logic:**
```javascript
// Bước 1: Arm khi vượt threshold
if (!st.armed) {
  if (absOC >= ocThreshold) {
    st.armed = true;
    st.firstCrossTs = now;
    st.peakAbs = absOC;
    st.peakTs = now;
  }
  return null;
}

// Bước 2: Update peak khi OC tiếp tục tăng
if (absOC > st.peakAbs) {
  st.peakAbs = absOC;
  st.peakTs = now;
  return null;
}

// Bước 3: Fire khi retrace hoặc stall
const retracedEnough = absOC <= st.peakAbs * (1 - retraceRatio);
const stalled = stallMs > 0 && (now - st.peakTs >= stallMs);

if (!st.fired && (retracedEnough || stalled)) {
  st.fired = true;
  return { strategy, oc, absOC, direction, ... };
}
```

**Đặc điểm:**
- ✅ Peak-hold: Giữ peak cao nhất
- ✅ Retrace: Fire khi retrace từ peak (20-40% tùy regime)
- ✅ Stall: Fire nếu không có peak mới trong 4-8s (tùy regime)
- ✅ Disable stall fire trong VOL_EXPANSION và TRENDING

**Ví dụ:**
```
OC timeline:
T0: +0.5%  (chưa vượt threshold 1.0%)
T1: +1.2%  → ARMED, peak = 1.2%
T2: +1.8%  → Update peak = 1.8%
T3: +1.5%  → Retrace từ peak = 1.5% / 1.8% = 83.3% (retrace 16.7%)
T4: +1.2%  → Retrace = 1.2% / 1.8% = 66.7% (retrace 33.3%) → FIRE!
```

### 2.6 Market Regime Integration

#### 2.6.1 Regime Detection

```javascript
// Get regime với scaling theo strategy ocThreshold
const regime = marketRegimeService.getRegime(
  exchange, 
  symbol, 
  interval, 
  absOC, 
  timestamp, 
  ocThreshold
);
```

**Regimes:**
- **SIDEWAY**: OC ≤ 0.8% × scale
- **TRENDING**: OC ≥ 1.5% × scale + consistency
- **VOL_EXPANSION**: OC ≥ 2.5% × scale
- **NEWS_SPIKE**: OC ≥ 8.0% × scale hoặc >= hard cap (8%)

#### 2.6.2 Strategy Filtering

```javascript
// Check hard OC cap (fail-safe)
if (absOC >= marketRegimeService.hardOCCap) {
  if (isReverse) {
    return null; // Disable reverse
  }
  // Continue for trend-follow but size will be reduced
}

// Check if strategy should be skipped
if (marketRegimeService.shouldSkipStrategy(regime, isReverse)) {
  return null; // Skip based on regime
}
```

#### 2.6.3 Parameter Override

```javascript
// Get regime-specific parameters
regimeParams = marketRegimeService.getRegimeParams(regime, {
  ocThreshold,
  retraceRatio: this.ocReverseRetraceRatio,
  stallMs: this.ocReverseStallMs,
  sizeMultiplier: 1.0
}, isReverse);

// Adjust threshold
ocThreshold = regimeParams.ocThreshold;
```

**Ví dụ Override:**
- **SIDEWAY**: +40% threshold, 40% retrace, disable trend-follow
- **TRENDING**: Double stall time, disable reverse, require retrace only
- **VOL_EXPANSION**: +20% threshold, 30% retrace, disable stall, -30%/-40% size, 300ms delay
- **NEWS_SPIKE**: +50% threshold, disable reverse, -60% size, 1s delay

---

## 3. Module WebSocketOCConsumer - Xử Lý Signal

### 3.1 Tổng Quan

**WebSocketOCConsumer** là consumer layer, chịu trách nhiệm:
- Subscribe WebSocket cho tất cả symbols trong strategies
- Nhận price ticks từ WebSocket
- Batch processing và throttling
- Gọi `RealtimeOCDetector.detectOC()`
- Trigger orders khi có match

### 3.2 Cấu Trúc

#### 3.2.1 Batch Processing Queue

```javascript
// Queue để batch process ticks
this._tickQueue = [];
this._batchSize = 20; // Process 20 ticks mỗi batch
this._batchTimeout = 50; // Timeout 50ms
```

**Lợi ích:**
- Giảm số lần gọi `detectOC()`
- Deduplication: Chỉ lấy tick mới nhất cho mỗi symbol
- Parallel processing với concurrency limit

#### 3.2.2 Throttling

```javascript
// Throttle per symbol
this._lastProcessed = new Map(); // exchange|symbol -> timestamp
this._minTickInterval = 100; // Minimum 100ms between ticks
```

**Logic:**
```javascript
const key = `${exchange}|${symbol}`;
const lastProcessed = this._lastProcessed.get(key);
if (lastProcessed && (timestamp - lastProcessed) < this._minTickInterval) {
  this.skippedCount++;
  return; // Skip - too soon
}
```

### 3.3 Flow Xử Lý

#### 3.3.1 Entry Point: `handlePriceTick()`

```javascript
async handlePriceTick(exchange, symbol, price, timestamp) {
  // 1. Validate
  if (!this.isRunning || !price || price <= 0) return;
  
  // 2. Throttle check
  if (tooSoon) return;
  
  // 3. Add to batch queue
  this._tickQueue.push({ exchange, symbol, price, timestamp });
  
  // 4. Process batch nếu đủ size hoặc timeout
  if (this._tickQueue.length >= this._batchSize) {
    await this._processBatch();
  } else if (!this._batchTimer) {
    this._batchTimer = setTimeout(() => this._processBatch(), this._batchTimeout);
  }
}
```

#### 3.3.2 Batch Processing

```javascript
async _processBatch() {
  const batch = this._tickQueue.splice(0, this._batchSize);
  
  // Deduplicate: Chỉ lấy tick mới nhất cho mỗi symbol
  const latest = new Map();
  for (const tick of batch) {
    const key = `${tick.exchange}|${tick.symbol}`;
    const existing = latest.get(key);
    if (!existing || existing.timestamp < tick.timestamp) {
      latest.set(key, tick);
    }
  }
  
  // Process unique symbols in parallel
  const concurrency = 10;
  const ticks = Array.from(latest.values());
  
  for (let i = 0; i < ticks.length; i += concurrency) {
    const batch = ticks.slice(i, i + concurrency);
    await Promise.allSettled(
      batch.map(tick => this._detectAndProcess(tick))
    );
  }
}
```

#### 3.3.3 Detect và Process

```javascript
async _detectAndProcess(tick) {
  const { exchange, symbol, price, timestamp } = tick;
  
  // Detect OC và match strategies
  const matches = await realtimeOCDetector.detectOC(
    exchange, 
    symbol, 
    price, 
    timestamp, 
    'WebSocketOCConsumer'
  );
  
  if (matches.length === 0) return;
  
  // Process matches in parallel
  await Promise.allSettled(
    matches.map(match => this.processMatch(match))
  );
}
```

### 3.4 Process Match - Chi Tiết

#### 3.4.1 Entry Point: `processMatch()`

**Các bước:**

**Bước 1: Validate và Get OrderService**
```javascript
const { strategy, oc, direction, currentPrice, interval } = match;
const botId = strategy.bot_id;
const orderService = this.orderServices.get(botId);
if (!orderService) {
  logger.error(`No OrderService found for bot ${botId}`);
  return;
}
```

**Bước 2: Check Open Position**
```javascript
const hasOpenPosition = await this.checkOpenPosition(strategy.id);
if (hasOpenPosition) {
  logger.info(`Strategy ${strategy.id} already has open position, skipping`);
  return;
}
```

**Bước 3: Determine Side**
```javascript
const { determineSide } = await import('../utils/sideSelector.js');
const side = determineSide(
  direction,           // 'bullish' hoặc 'bearish'
  strategy.trade_type, // 'long', 'short', 'both'
  strategy.is_reverse_strategy
);
```

**Bước 4: Calculate Entry Price**
```javascript
const isReverseStrategy = Boolean(strategy.is_reverse_strategy);

if (isReverseStrategy) {
  // Counter-trend: Calculate với extend logic
  entryPrice = side === 'long'
    ? calculateLongEntryPrice(currentPrice, baseOpen, strategy.extend || 0)
    : calculateShortEntryPrice(currentPrice, baseOpen, strategy.extend || 0);
} else {
  // Trend-following: Use current price, force MARKET
  entryPrice = currentPrice;
  forceMarket = true;
}
```

**Bước 5: Calculate TP/SL**
```javascript
const tpPrice = calculateTakeProfit(entryPrice, strategy.take_profit || 55, side);
const rawStoploss = strategy.stoploss !== undefined ? Number(strategy.stoploss) : NaN;
const isStoplossValid = Number.isFinite(rawStoploss) && rawStoploss > 0;
const slPrice = isStoplossValid 
  ? calculateInitialStopLoss(entryPrice, rawStoploss, side) 
  : null;
```

**Bước 6: Extend Check (Counter-trend only)**
```javascript
if (isReverseStrategy) {
  const totalExtendDistance = Math.abs(baseOpen - entryPrice);
  const priceDiffRatio = Math.abs(currentPrice - entryPrice) / totalExtendDistance;
  const maxDiffRatio = 0.5; // 50%
  
  if (priceDiffRatio > maxDiffRatio) {
    // Extend not met, place passive LIMIT hoặc skip
    if (allowPassive) {
      signal.forcePassiveLimit = true;
    } else {
      return; // Skip
    }
  }
}
```

**Bước 7: Create Signal và Execute**
```javascript
const signal = {
  strategy: strategy,
  side,
  entryPrice: entryPrice,
  currentPrice: currentPrice,
  oc: Math.abs(oc),
  interval,
  timestamp: match.timestamp,
  tpPrice: tpPrice,
  slPrice: slPrice,
  amount: strategy.amount || 1000,
  forceMarket: forceMarket
};

const result = await orderService.executeSignal(signal);
```

---

## 4. Module OrderService - Thực Thi Order

### 4.1 Tổng Quan

**OrderService** chịu trách nhiệm:
- Validate signal
- Check position limits
- Determine order type (MARKET vs LIMIT)
- Create order trên exchange
- Create Position record trong database
- Handle entry orders (pending LIMIT)

### 4.2 Flow Thực Thi

#### 4.2.1 Entry Point: `executeSignal()`

**Bước 1: Position Limit Checks**
```javascript
// Check max concurrent trades
const maxPositions = strategy.bot?.max_concurrent_trades || 100;
const currentCount = await getCurrentPositionCount(botId);
if (currentCount >= maxPositions) {
  return null; // Skip
}

// Check max amount per coin
const canOpen = await positionLimitService.canOpenNewPosition({
  botId: strategy.bot_id,
  symbol: strategy.symbol,
  newOrderAmount: amount
});
if (!canOpen) {
  return null; // Skip
}
```

**Bước 2: Determine Order Type**
```javascript
let orderType;

if (signal.forceMarket) {
  // Trend-following: Always MARKET
  orderType = 'market';
} else if (signal.forcePassiveLimit) {
  // Counter-trend với extend not met: LIMIT
  orderType = 'limit';
} else {
  // Default: Check price
  orderType = this.shouldUseMarketOrder(side, currentPrice, entryPrice)
    ? 'market'
    : 'limit';
}
```

**Logic `shouldUseMarketOrder()`:**
```javascript
const priceDiff = Math.abs(currentPrice - entryPrice) / entryPrice * 100;
const hasCrossedEntry = 
  (side === 'long' && currentPrice > entryPrice) ||
  (side === 'short' && currentPrice < entryPrice);

return hasCrossedEntry || priceDiff > 0.5; // >0.5% hoặc đã vượt entry
```

**Bước 3: Create Order**
```javascript
try {
  order = await this.exchangeService.createOrder({
    symbol: strategy.symbol,
    side: side === 'long' ? 'buy' : 'sell',
    positionSide: side === 'long' ? 'LONG' : 'SHORT',
    amount: amount, // USDT amount
    type: orderType,
    price: orderType === 'limit' ? entryPrice : undefined
  });
} catch (e) {
  // Fallback to MARKET nếu LIMIT trigger immediately
  if (shouldFallbackToMarket && enableFallbackToMarket) {
    order = await this.exchangeService.createOrder({
      ...,
      type: 'market'
    });
  } else {
    throw e;
  }
}
```

**Bước 4: Determine Effective Entry Price**
```javascript
let effectiveEntryPrice = entryPrice;
let hasImmediateExposure = false;

if (orderType === 'market') {
  const filled = Number(order?.avgFillPrice || order?.price || currentPrice);
  if (filled > 0) {
    effectiveEntryPrice = filled;
    hasImmediateExposure = true;
  }
} else if (orderType === 'limit') {
  // Check order status
  const st = await this.exchangeService.getOrderStatus(strategy.symbol, order.id);
  
  if (st?.status === 'filled' || st?.filled > 0) {
    const avg = await this.exchangeService.getOrderAverageFillPrice(strategy.symbol, order.id);
    effectiveEntryPrice = avg > 0 ? avg : entryPrice;
    hasImmediateExposure = true;
  } else {
    // Check if price crossed entry
    const priceCrossed = 
      (side === 'long' && currentPrice > entryPrice) ||
      (side === 'short' && currentPrice < entryPrice);
    
    if (priceCrossed) {
      effectiveEntryPrice = currentPrice;
      hasImmediateExposure = true; // Treat as filled
    }
  }
}
```

**Bước 5: Create Position hoặc Entry Order**
```javascript
if (hasImmediateExposure || orderType === 'market') {
  // Create Position ngay
  position = await Position.create({
    strategy_id: strategy.id,
    bot_id: strategy.bot_id,
    order_id: order.id,
    symbol: strategy.symbol,
    side: side,
    entry_price: effectiveEntryPrice,
    amount: amount,
    take_profit_price: tempTpPrice,
    stop_loss_price: tempSlPrice,
    current_reduce: strategy.reduce,
    tp_sl_pending: true // TP/SL sẽ được đặt bởi PositionMonitor
  });
} else {
  // Track trong entry_orders table
  await EntryOrder.create({
    strategy_id: strategy.id,
    bot_id: strategy.bot_id,
    order_id: order.id,
    symbol: strategy.symbol,
    side,
    amount,
    entry_price: effectiveEntryPrice,
    status: 'open'
  });
}
```

---

## 5. Market Regime Service - Quản Lý Rủi Ro

### 5.1 Tổng Quan

**MarketRegimeService** phân loại market regime và điều chỉnh strategy parameters để giảm risk.

### 5.2 Regime Classification

#### 5.2.1 Volatility Score

```javascript
calculateVolatilityScore(exchange, symbol, interval, currentAbsOC, ocThreshold) {
  const history = this._ocHistory.get(key) || [];
  const maxOC = Math.max(...history.map(h => h.absOC));
  const avgOC = history.reduce((sum, h) => sum + h.absOC, 0) / history.length;
  
  // Spike factor: +1.5 nếu OC >= threshold * 2
  const spikeFactor = currentAbsOC >= ocThreshold * 2 ? 1.5 : 0;
  
  // Consistency (std deviation)
  const variance = history.reduce((sum, h) => sum + Math.pow(h.absOC - avgOC, 2), 0) / history.length;
  const stdDev = Math.sqrt(variance);
  const consistency = 1 / (1 + stdDev);
  
  // Weighted score
  const score = (maxOC * 0.5) + (avgOC * 0.3) + (consistency * 10 * 0.2) + spikeFactor;
  return score;
}
```

#### 5.2.2 Regime Detection

```javascript
getRegime(exchange, symbol, interval, currentAbsOC, timestamp, ocThreshold) {
  // Scale thresholds theo strategy ocThreshold
  const scaleFactor = ocThreshold / 2.0;
  const sidewayMaxOC = 0.8 * scaleFactor;
  const trendingMinOC = 1.5 * scaleFactor;
  const volExpansionMinOC = 2.5 * scaleFactor;
  const newsSpikeMinOC = 8.0 * scaleFactor;
  
  // Classify
  if (currentAbsOC >= 8.0 || currentAbsOC >= newsSpikeMinOC) {
    return 'NEWS_SPIKE';
  } else if (currentAbsOC >= volExpansionMinOC) {
    return 'VOL_EXPANSION';
  } else if (currentAbsOC >= trendingMinOC) {
    const score = this.calculateVolatilityScore(...);
    return score > 1.8 ? 'TRENDING' : 'VOL_EXPANSION';
  } else if (currentAbsOC <= sidewayMaxOC) {
    return 'SIDEWAY';
  } else {
    const score = this.calculateVolatilityScore(...);
    return score > 0.8 ? 'TRENDING' : 'SIDEWAY';
  }
}
```

#### 5.2.3 Hysteresis

```javascript
// Prevent rapid regime switching
if (newRegime !== state.regime) {
  const timeSinceLastSwitch = timestamp - state.lastSwitchTs;
  if (timeSinceLastSwitch < this._hysteresisMs) { // 15s
    return state.regime; // Keep previous regime
  }
  
  state.regime = newRegime;
  state.lastSwitchTs = timestamp;
}
```

#### 5.2.4 Regime Lock

```javascript
// Lock regime sau khi fire order (20s)
lockRegime(exchange, symbol, interval, timestamp) {
  state.lockedUntil = timestamp + this._regimeLockMs; // 20s
}

// Check lock
if (timestamp < state.lockedUntil) {
  return state.regime; // Return locked regime
}
```

### 5.3 Parameter Override Matrix

| Regime | Trend-Follow | Reverse | Threshold | Retrace | Stall | Size | Delay |
|--------|-------------|---------|-----------|---------|-------|------|-------|
| **SIDEWAY** | ❌ OFF | ✅ ON | +40% | 40% | 3s | 100% | - |
| **TRENDING** | ✅ ON | ❌ OFF | = | 20% | 8s | 100% | - |
| **VOL_EXPANSION** | ⚠️ LIMITED | ⚠️ LIMITED | +20% | 30% | 0 (disable) | 70%/60% | 300ms |
| **NEWS_SPIKE** | ⚠️ SMALL | ❌ OFF | +50% | 20% | 0 (disable) | 40% | 1s |

---

## 6. Flow Từ Đầu Đến Cuối

### 6.1 Complete Flow Diagram

```
┌─────────────────────────────────────────────────────────────────┐
│ 1. WebSocket Price Tick                                         │
│    Binance/MEXC → Mark Price Update                            │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 2. WebSocketOCConsumer.handlePriceTick()                        │
│    - Validate price                                             │
│    - Throttle check (100ms min interval)                       │
│    - Add to batch queue                                         │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 3. Batch Processing                                             │
│    - Deduplicate (latest tick per symbol)                      │
│    - Process in parallel (concurrency: 10)                      │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 4. RealtimeOCDetector.detectOC()                                │
│    - Get strategies từ cache                                    │
│    - Batch get open prices                                      │
│    - Check strategies in parallel                               │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 5. RealtimeOCDetector._checkStrategy()                          │
│    - Calculate OC                                               │
│    - Market regime detection                                    │
│    - Strategy filtering                                         │
│    - Trend-follow: Fire ngay                                    │
│    - Reverse: Peak-hold + retrace                               │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 6. WebSocketOCConsumer.processMatch()                           │
│    - Check open position                                        │
│    - Determine side                                             │
│    - Calculate entry price                                      │
│    - Calculate TP/SL                                            │
│    - Extend check (counter-trend)                               │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 7. OrderService.executeSignal()                                 │
│    - Position limit checks                                      │
│    - Determine order type                                       │
│    - Create order on exchange                                   │
│    - Create Position or EntryOrder                              │
└───────────────────────┬─────────────────────────────────────────┘
                        │
                        ▼
┌─────────────────────────────────────────────────────────────────┐
│ 8. ExchangeService.createOrder()                                │
│    - BinanceDirectClient / MexcFuturesClient                   │
│    - Return order object                                        │
└─────────────────────────────────────────────────────────────────┘
```

### 6.2 Ví Dụ Cụ Thể

#### Scenario: Trend-Follow Strategy

**Input:**
- Symbol: BTCUSDT
- Strategy: `{ id: 1, oc: 2.0, interval: '1m', is_reverse_strategy: false, take_profit: 55, amount: 1000 }`
- Current Price: 43000
- Open Price (1m bucket): 42140
- OC: (43000 - 42140) / 42140 * 100 = **2.04%**

**Flow:**
1. WebSocket tick → `handlePriceTick('binance', 'BTCUSDT', 43000, ts)`
2. Batch queue → `_processBatch()`
3. `detectOC('binance', 'BTCUSDT', 43000, ts)` → Get strategies
4. `_checkStrategy()`:
   - OC = 2.04%, threshold = 2.0% → ✅ Match
   - Regime = TRENDING → ✅ Allowed
   - Fire ngay → Return match
5. `processMatch(match)`:
   - No open position → ✅
   - Side = 'long' (direction='bullish', trade_type='long')
   - Entry = 43000 (current price)
   - TP = 43000 * (1 + 55/100) = 66650
   - SL = null (no stoploss)
   - Force MARKET = true
6. `executeSignal(signal)`:
   - Position limits OK → ✅
   - Order type = 'market' (forceMarket)
   - Create MARKET order → Order ID: 123456
   - Position created → Position ID: 789
7. **Result:** Position mở với entry 43000, TP order sẽ được đặt bởi PositionMonitor

#### Scenario: Reverse Strategy

**Input:**
- Symbol: ETHUSDT
- Strategy: `{ id: 2, oc: 1.5, interval: '5m', is_reverse_strategy: true, extend: 60, take_profit: 55, amount: 1000 }`
- Current Price: 2500
- Open Price (5m bucket): 2450
- OC: (2500 - 2450) / 2450 * 100 = **2.04%**

**Flow:**
1. WebSocket tick → `handlePriceTick('binance', 'ETHUSDT', 2500, ts)`
2. `detectOC()` → Get strategies
3. `_checkStrategy()`:
   - OC = 2.04%, threshold = 1.5% → ✅ ARMED
   - Peak = 2.04%
   - Wait for retrace...
4. **Next tick:** OC = 1.5% (retrace từ 2.04%)
   - Retrace = 1.5% / 2.04% = 73.5% (retrace 26.5%)
   - Retrace ratio = 20% → ✅ Retrace đủ → FIRE
5. `processMatch(match)`:
   - Side = 'short' (direction='bullish', is_reverse=true)
   - Entry = calculateShortEntryPrice(2500, 2450, 60) = 2530
   - Extend check: |2500 - 2530| / |2450 - 2530| = 30/80 = 37.5% < 50% → ✅ OK
   - TP = 2530 * (1 - 55/100) = 1138.5
6. `executeSignal(signal)`:
   - Order type = 'limit' (extend OK)
   - Create LIMIT order @ 2530 → Order ID: 123457
   - EntryOrder created (pending)
7. **Result:** EntryOrder tracked, Position sẽ được tạo khi order filled

---

## 7. Cơ Chế Cache và Tối Ưu

### 7.1 Cache Layers

#### 7.1.1 Open Price Cache (LRUCache)

```javascript
// Key: exchange|symbol|interval|bucketStart
// Value: { open, bucketStart, lastUpdate }
this.openPriceCache = new LRUCache(1000);
```

**Eviction:**
- Size limit: 1000 entries (LRU)
- Age limit: 15 minutes

#### 7.1.2 Open Fetch Cache (LRUCache)

```javascript
// Key: exchange|symbol|interval|bucketStart
// Value: open price (number)
this.openFetchCache = new LRUCache(200);
```

**Purpose:** Cache REST OHLCV results để tránh duplicate calls

#### 7.1.3 Last Price Cache (LRUCache)

```javascript
// Key: exchange|symbol
// Value: { price, timestamp }
this.lastPriceCache = new LRUCache(600);
```

**Purpose:** Track last processed price để skip ticks không đổi

#### 7.1.4 OC Match State Cache (LRUCache)

```javascript
// Key: strategyId|symbol|interval|bucketStart
// Value: { armed, fired, firstCrossTs, peakAbs, peakTs }
this._ocMatchStateCache = new LRUCache(5000);
```

**Purpose:** Track state cho reverse strategy matching

### 7.2 Tối Ưu Performance

#### 7.2.1 Batch Processing

- **Price ticks:** Batch 20 ticks, timeout 50ms
- **Open prices:** Batch fetch cho nhiều intervals
- **Strategy checks:** Parallel với concurrency 10

#### 7.2.2 Throttling

- **Per symbol:** Minimum 100ms between ticks
- **REST fetch:** Queue với concurrent limit 2
- **Circuit breaker:** Skip requests nếu có quá nhiều lỗi

#### 7.2.3 Deduplication

- **Price ticks:** Chỉ lấy tick mới nhất cho mỗi symbol trong batch
- **Open prices:** Cache-first strategy

---

## 8. Xử Lý Lỗi và Fail-Safe

### 8.1 Error Handling

#### 8.1.1 REST API Errors

**Circuit Breaker:**
```javascript
// Track failures per key
this._restOpenFailCache = new LRUCache(2000);
this._restOpenFailTtlMs = 4000; // 4s TTL

// Skip requests nếu circuit open
if (this._isRestOpenCircuitOpen(queueKey)) {
  return { open: null, error: new Error('Circuit open') };
}
```

**Stale Queue Eviction:**
```javascript
// Remove requests older than 2 minutes
const staleCutoff = now - this._restQueueEvictStaleMs;
this._restFetchQueue = this._restFetchQueue.filter(req => req.enqueuedAt > staleCutoff);
```

#### 8.1.2 Order Creation Errors

**Soft Errors (Skip):**
- Symbol not available for trading
- Below minimum notional
- Invalid price after rounding
- Precision over maximum

**Hard Errors (Throw):**
- Network errors
- Authentication errors
- Unknown errors

**Fallback:**
- LIMIT → MARKET fallback nếu "would immediately trigger"

### 8.2 Fail-Safe Rules

#### 8.2.1 Hard OC Cap

```javascript
if (absOC >= 8.0) {
  // Disable reverse strategies
  if (isReverse) return null;
  // Reduce trend-follow size
  sizeMultiplier = 0.4;
}
```

#### 8.2.2 Regime Lock

```javascript
// Lock regime 20s sau khi fire order
// Prevent immediate regime flip
lockRegime(exchange, symbol, interval, timestamp);
```

#### 8.2.3 Position Limit Checks

```javascript
// Max concurrent trades per bot
if (currentCount >= maxPositions) return null;

// Max amount per coin
if (currentTotal + newAmount > maxAmountPerCoin) return null;
```

---

## 9. Configuration

### 9.1 Key Configurations

| Config | Default | Description |
|--------|---------|-------------|
| `OC_DETECT_CONCURRENCY` | 10 | Số strategies check song song |
| `WS_TICK_BATCH_SIZE` | 20 | Số ticks mỗi batch |
| `WS_TICK_BATCH_TIMEOUT_MS` | 50 | Timeout cho batch processing |
| `WS_TICK_MIN_INTERVAL_MS` | 100 | Minimum interval giữa các ticks |
| `OC_REST_FETCH_DELAY_MS` | 30 | Delay giữa REST requests |
| `OC_REST_FETCH_CONCURRENT` | 2 | Số REST requests đồng thời |
| `OC_REST_FETCH_MAX_QUEUE` | 300 | Max queue size |
| `OC_REGIME_ENABLED` | true | Enable market regime filtering |
| `REGIME_HYSTERESIS_MS` | 15000 | Hysteresis time (15s) |
| `REGIME_LOCK_MS` | 20000 | Regime lock time (20s) |
| `REGIME_HARD_OC_CAP` | 8.0 | Hard OC cap (8%) |

---

## 10. Monitoring và Logging

### 10.1 Key Logs

**OC Detection:**
```
[RealtimeOCDetector] 🎯 Returning 2 match(es) for binance BTCUSDT
```

**Regime Detection:**
```
[RealtimeOCDetector] 📊 Regime=TRENDING for BINANCE BTCUSDT 1m | OC=2.04% | Threshold=2.00%
```

**Strategy Skip:**
```
[RealtimeOCDetector] ⏭️ Strategy 1 SKIPPED: Regime=SIDEWAY, isReverse=false
```

**Order Execution:**
```
[WebSocketOCConsumer] 🚀 Triggering order for strategy 1 (BTCUSDT): long @ 43000, OC=2.04%
[OrderService] Order Success | bot=1 strat=1 BTCUSDT LONG orderId=123456 posId=789
```

### 10.2 Stats

**RealtimeOCDetector:**
- `openPriceCacheSize`: Số entries trong open price cache
- `lastPriceCacheSize`: Số entries trong last price cache

**WebSocketOCConsumer:**
- `processedCount`: Số ticks đã xử lý
- `matchCount`: Số matches tìm được
- `skippedCount`: Số ticks bị skip do throttling

---

## 11. Kết Luận

Hệ thống OC Detection được thiết kế với các nguyên tắc:

1. **Realtime First:** Không dùng database candles, hoàn toàn realtime từ WebSocket
2. **Performance:** Batch processing, caching, throttling để xử lý hàng nghìn symbols
3. **Risk Management:** Market regime filtering, hard caps, position limits
4. **Reliability:** Circuit breaker, error handling, fail-safe rules
5. **Scalability:** LRU cache, parallel processing, queue management

Hệ thống có thể xử lý hàng trăm symbols đồng thời với độ trễ thấp (<100ms từ price tick đến order execution).

