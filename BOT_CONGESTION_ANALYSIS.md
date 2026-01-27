# 🔍 PHÂN TÍCH NGHẼN BOT - ROOT CAUSE ANALYSIS

**Ngày phân tích**: 2026-01-22  
**Trạng thái**: Bot bị nghẽn, event loop delay cao, nhiều position không có TP/SL

---

## 📊 TÓM TẮT VẤN ĐỀ

### 1. **Event Loop Delay Cao** ⚠️
- **Mean delay**: 77.6ms → 181.1ms → 137.3ms (streak 3/3)
- **Max delay**: 677.4ms → 540.0ms → 539.5ms
- **Kết quả**: Watchdog kích hoạt degrade mode (tắt ADV_TPSL)

### 2. **WebSocket Processing Lag** ⚠️
- **Lag phát hiện**: 316ms, 380ms, 2127ms (nghiêm trọng!)
- **Nguyên nhân**: Event loop bị block → WebSocket messages bị delay xử lý
- **Hậu quả**: Stale messages, missed signals

### 3. **Position TP/SL Delay Nghiêm Trọng** 🚨
- **Nhiều position không có TP/SL**: 869s, 870s, 874s, 1576s, 1992s...
- **Pattern**: `exit_order_id` có nhưng `sl_order_id=NULL` (TP được tạo nhưng SL thất bại)
- **Nguyên nhân**: 
  - PositionMonitor cycle quá dài
  - API rate limit khi tạo SL
  - Binance API Error -2022 (ReduceOnly rejected)

### 4. **SymbolsUpdater Timeout** ⚠️
- **Watchdog timeout**: 600s (10 phút) - quá lâu!
- **Nguyên nhân**: MEXC API 404 error → retry liên tục → block event loop
- **Tác động**: Lock `isRunning` → block job khác

---

## 🔬 PHÂN TÍCH CHI TIẾT CÁC SERVICE

### 1. **PositionMonitor** (10s interval) - 🔴 CRITICAL

#### Vấn đề:
- **Xử lý quá nhiều position cùng lúc** (456+ positions active)
- **Cycle time quá dài**: Mỗi cycle phải:
  - Fetch tất cả open positions từ DB
  - Group by bot
  - Fetch exchange positions (API call per bot)
  - Process TP/SL placement (API calls)
  - Process ADV_TPSL features (OHLCV fetches, calculations)
  - Update positions (DB writes)

#### Bottleneck:
```javascript
// PositionMonitor.monitorAllPositions()
- Fetch all open positions: ~50-100ms (DB query)
- For each bot:
  - getOpenPositions(): ~200-500ms (API call)
  - For each position:
    - placeExitOrder(): ~300-1000ms (2 API calls: TP + SL)
    - ADV_TPSL features: ~500-2000ms (OHLCV + calculations)
- Total cycle time: 456 positions × (300ms + 500ms) = ~6-8 phút!
```

#### Throttling hiện tại:
- `ADV_TPSL_MAX_POSITIONS_PER_CYCLE`: Giới hạn số position xử lý ADV_TPSL
- `ADV_TPSL_MAX_CONCURRENT`: Giới hạn concurrent operations
- `ADV_TPSL_POSITION_COOLDOWN_MS`: Cooldown giữa các lần apply

**Vấn đề**: Throttling chỉ áp dụng cho ADV_TPSL, không áp dụng cho basic TP/SL placement!

---

### 2. **RealtimeOCDetector** - 🟡 MODERATE

#### Vấn đề:
- **Nhiều REST API calls** để fetch open prices
- **Cache cleanup timers**: 5 phút/lần
- **Open price refresh**: 5 phút/lần (có thể fetch nhiều symbols)

#### Bottleneck:
```javascript
// RealtimeOCDetector.refreshOpenPriceCache()
- Get all active symbols: ~50ms
- For each symbol:
  - IndicatorWarmup.fetchCandles(): ~200-500ms (API call)
- Total: 100+ symbols × 300ms = ~30-50 giây mỗi 5 phút
```

**Tác động**: Block event loop trong 30-50 giây mỗi 5 phút

---

### 3. **SymbolsUpdater** (15 phút interval) - 🟡 MODERATE

#### Vấn đề:
- **MEXC API 404 error** → retry liên tục
- **Watchdog timeout**: 600s (10 phút) - quá lâu!
- **Block `isRunning` flag** → prevent concurrent runs

#### Bottleneck:
```javascript
// SymbolsUpdater.update()
- Fetch Binance markets: ~2-5 giây
- Fetch MEXC markets: ~2-5 giây (nhưng fail với 404)
- Retry logic: Có thể retry nhiều lần
- Total: Có thể mất 10+ phút nếu MEXC fail
```

**Tác động**: Lock job trong 10 phút → block event loop

---

### 4. **WebSocketManager** - 🟢 LOW

#### Vấn đề:
- **Processing lag**: 316ms, 380ms, 2127ms
- **Nguyên nhân**: Event loop bị block bởi các job khác
- **Hậu quả**: WebSocket messages bị delay → stale data

---

### 5. **PositionSync** (30s interval) - 🟢 LOW

#### Vấn đề:
- **Sync tất cả positions** từ exchange → DB
- **API calls**: 1 call per bot để fetch positions
- **Cycle time**: ~5-10 giây cho nhiều bots

**Tác động**: Nhẹ, nhưng cộng dồn với các job khác

---

## 🎯 ROOT CAUSE SUMMARY

### **Nguyên nhân chính**:

1. **PositionMonitor cycle quá dài** (6-8 phút cho 456 positions)
   - Xử lý quá nhiều position cùng lúc
   - Không có throttling cho basic TP/SL placement
   - ADV_TPSL features tốn nhiều thời gian (OHLCV fetches)

2. **RealtimeOCDetector refresh cache** (30-50 giây mỗi 5 phút)
   - Fetch candles cho 100+ symbols
   - Block event loop trong thời gian dài

3. **SymbolsUpdater timeout** (10 phút)
   - MEXC API 404 → retry liên tục
   - Lock job quá lâu

4. **Event loop blocking** → WebSocket lag → Stale messages → Missed signals

---

## 💡 ĐỀ XUẤT GIẢI PHÁP

### **PRIORITY 1: Fix PositionMonitor** 🔴

#### 1.1. **Throttle Basic TP/SL Placement**
```javascript
// Thêm throttling cho basic TP/SL placement
const MAX_TP_SL_PER_CYCLE = 20; // Process 20 positions per cycle
const TP_SL_BATCH_SIZE = 5; // Process 5 positions in parallel
const TP_SL_BATCH_DELAY_MS = 100; // Delay between batches
```

#### 1.2. **Priority Queue cho TP/SL**
```javascript
// Ưu tiên positions không có TP/SL (high priority)
// Positions có TP/SL nhưng cần update (low priority)
const highPriority = positions.filter(p => !p.exit_order_id || !p.sl_order_id);
const lowPriority = positions.filter(p => p.exit_order_id && p.sl_order_id);
```

#### 1.3. **Reduce Cycle Time**
```javascript
// Giảm số position xử lý mỗi cycle
// Chia nhỏ thành nhiều cycles
const MAX_POSITIONS_PER_CYCLE = 50; // Thay vì xử lý tất cả 456 positions
```

#### 1.4. **Skip ADV_TPSL khi degrade mode**
```javascript
// Đã có, nhưng cần đảm bảo basic TP/SL vẫn chạy
if (watchdogLimits && watchdogLimits.maxPerCycle === 0) {
  // Skip ADV_TPSL, nhưng vẫn process basic TP/SL
}
```

---

### **PRIORITY 2: Fix RealtimeOCDetector** 🟡

#### 2.1. **Throttle Open Price Refresh**
```javascript
// Giảm số symbols refresh mỗi lần
const MAX_SYMBOLS_PER_REFRESH = 20; // Thay vì tất cả 100+ symbols
const REFRESH_BATCH_SIZE = 5; // Process 5 symbols in parallel
const REFRESH_BATCH_DELAY_MS = 200; // Delay between batches
```

#### 2.2. **Increase Refresh Interval**
```javascript
// Tăng interval từ 5 phút → 15 phút
const refreshInterval = 15 * 60 * 1000; // 15 minutes
```

#### 2.3. **Skip Refresh khi degrade mode**
```javascript
// Skip refresh khi event loop delay cao
if (watchdogService.isDegraded()) {
  logger.debug('[RealtimeOCDetector] Skipping refresh (degrade mode)');
  return;
}
```

---

### **PRIORITY 3: Fix SymbolsUpdater** 🟡

#### 3.1. **Reduce Watchdog Timeout**
```javascript
// Giảm timeout từ 10 phút → 5 phút
const watchdogTimeoutMs = 5 * 60 * 1000; // 5 minutes
```

#### 3.2. **Skip MEXC khi fail**
```javascript
// Skip MEXC update nếu fail quá nhiều lần
if (this._shouldSkipExchange('mexc')) {
  logger.warn('[SymbolsUpdater] Skipping MEXC (backoff active)');
  continue;
}
```

#### 3.3. **Async Processing**
```javascript
// Process exchanges in parallel nhưng với timeout
const binancePromise = this.updateBinance().timeout(30000); // 30s timeout
const mexcPromise = this.updateMexc().timeout(30000).catch(() => null); // Skip on fail
await Promise.allSettled([binancePromise, mexcPromise]);
```

---

### **PRIORITY 4: Optimize Event Loop** 🟢

#### 4.1. **Use setImmediate() cho Heavy Operations**
```javascript
// Chia nhỏ heavy operations thành chunks
async function processInChunks(items, chunkSize, processFn) {
  for (let i = 0; i < items.length; i += chunkSize) {
    const chunk = items.slice(i, i + chunkSize);
    await Promise.all(chunk.map(processFn));
    // Yield to event loop
    await new Promise(resolve => setImmediate(resolve));
  }
}
```

#### 4.2. **Increase Watchdog Sensitivity**
```javascript
// Phát hiện degrade mode sớm hơn
const DEGRADE_THRESHOLD_MS = 50; // Thay vì 100ms
const DEGRADE_STREAK = 2; // Thay vì 3
```

#### 4.3. **Monitor Cycle Times**
```javascript
// Log cycle time để track performance
const startTime = Date.now();
await this.monitorAllPositions();
const cycleTime = Date.now() - startTime;
if (cycleTime > 5000) {
  logger.warn(`[PositionMonitor] Cycle time too long: ${cycleTime}ms`);
}
```

---

## 📋 IMPLEMENTATION PLAN

### **Phase 1: Quick Wins** (1-2 giờ)
1. ✅ Throttle basic TP/SL placement (MAX_TP_SL_PER_CYCLE = 20)
2. ✅ Reduce SymbolsUpdater watchdog timeout (10m → 5m)
3. ✅ Skip MEXC update khi fail
4. ✅ Increase RealtimeOCDetector refresh interval (5m → 15m)

### **Phase 2: Medium-term** (2-4 giờ)
1. ✅ Priority queue cho TP/SL placement
2. ✅ Throttle RealtimeOCDetector refresh (MAX_SYMBOLS_PER_REFRESH = 20)
3. ✅ Skip refresh khi degrade mode
4. ✅ Process in chunks với setImmediate()

### **Phase 3: Long-term** (4-8 giờ)
1. ✅ Worker threads cho heavy calculations (ATR, SR, MTF)
2. ✅ Database connection pooling optimization
3. ✅ Cache optimization (reduce cache size, increase TTL)
4. ✅ Horizontal scaling (multiple bot instances)

---

## 🎯 METRICS TO MONITOR

### **Key Metrics**:
1. **Event Loop Delay**: Mean < 20ms, Max < 100ms
2. **PositionMonitor Cycle Time**: < 5 giây
3. **TP/SL Placement Time**: < 1 giây per position
4. **WebSocket Processing Lag**: < 100ms
5. **Position TP/SL Delay**: < 10 giây (từ khi position mở)

### **Alerts**:
- Event loop delay > 50ms (mean) hoặc > 200ms (max)
- PositionMonitor cycle time > 10 giây
- Position không có TP/SL > 30 giây
- WebSocket processing lag > 500ms

---

## 📝 NOTES

- **Hardware**: 32GB RAM, 32 cores - đủ mạnh, vấn đề là ở code
- **Node.js single-threaded**: Event loop blocking là vấn đề chính
- **API Rate Limits**: Cần throttle để tránh rate limit
- **Database Load**: Nhiều queries cùng lúc → cần connection pooling

---

**Status**: 🔴 CRITICAL - Cần fix ngay lập tức  
**Estimated Fix Time**: 4-6 giờ  
**Priority**: P0 (Production Blocker)

