# 🔥 HOTFIX IMPLEMENTATION - Event Loop Blocking Fixes

**Ngày implement**: 2026-01-22  
**Status**: ✅ COMPLETED

---

## 📋 TÓM TẮT

Đã implement 3 fix quan trọng để giải quyết vấn đề **Event Loop Blocking** và **Bot Congestion**:

1. ✅ **PositionMonitor**: Chunking & Yielding với `setImmediate()`
2. ✅ **SymbolsUpdater**: Fail-fast & Timeout cho MEXC
3. ✅ **RealtimeOCDetector**: Throttle refresh cache

---

## 🔧 CHI TIẾT CÁC FIX

### 1. PositionMonitor - Chunking & Yielding ✅

#### Vấn đề:
- Xử lý 456 positions cùng lúc → cycle time 6-8 phút
- Block event loop → WebSocket lag, stale messages

#### Giải pháp:
- **Limit positions per cycle**: `POSITION_MONITOR_MAX_TP_SL_PER_CYCLE` (default: 20)
- **Limit monitoring per cycle**: `POSITION_MONITOR_MAX_MONITORING_PER_CYCLE` (default: 50)
- **Yielding với `setImmediate()`**: Sau mỗi batch để cho WebSocket xử lý
- **Dynamic delay**: Tăng delay khi degrade mode active

#### Code changes:
```javascript
// File: src/jobs/PositionMonitor.js

// 1. Limit TP/SL placement per cycle
const MAX_POSITIONS_PER_CYCLE = 20; // Config: POSITION_MONITOR_MAX_TP_SL_PER_CYCLE
const positionsToProcess = botHighPriority.slice(0, MAX_POSITIONS_PER_CYCLE);

// 2. Yielding after each batch
await Promise.allSettled(batch.map(p => this.placeExitOrder(p)));
await new Promise(resolve => setImmediate(resolve)); // ✅ YIELD TO EVENT LOOP

// 3. Dynamic delay based on system state
if (watchdogService?.isDegraded?.()) {
  await new Promise(resolve => setTimeout(resolve, BATCH_DELAY_MS * 2));
}
```

#### Config mới:
- `POSITION_MONITOR_MAX_TP_SL_PER_CYCLE`: Max positions để tạo TP/SL mỗi cycle (default: 20)
- `POSITION_MONITOR_MAX_MONITORING_PER_CYCLE`: Max positions để monitor mỗi cycle (default: 50)
- `POSITION_MONITOR_TP_BATCH_DELAY_MS`: Delay giữa các batch TP/SL (default: 50ms)
- `POSITION_MONITOR_MONITORING_BATCH_DELAY_MS`: Delay giữa các batch monitoring (default: 50ms)

---

### 2. SymbolsUpdater - Fail-fast & Timeout ✅

#### Vấn đề:
- MEXC API 404 error → retry liên tục → block 10 phút
- Watchdog timeout quá lâu (10 phút)

#### Giải pháp:
- **Per-exchange timeout**: 10 giây cho mỗi exchange
- **Fail-fast**: Dùng `Promise.race()` với timeout
- **Reduce watchdog timeout**: Từ 10 phút → 5 phút
- **Better error handling**: Handle MEXC 404 specifically

#### Code changes:
```javascript
// File: src/jobs/SymbolsUpdater.js

// 1. Helper function với timeout
_withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    })
  ]);
}

// 2. Apply timeout cho mỗi exchange
const EXCHANGE_TIMEOUT_MS = 10000; // 10 seconds
const binancePromise = this._withTimeout(
  exchangeInfoService.updateFiltersFromExchange(),
  EXCHANGE_TIMEOUT_MS,
  'Binance update'
);

// 3. Reduce watchdog timeout
const reducedWatchdogTimeout = Math.min(watchdogTimeoutMs, 5 * 60 * 1000); // Max 5 minutes
```

#### Config mới:
- `SYMBOLS_UPDATE_EXCHANGE_TIMEOUT_MS`: Timeout cho mỗi exchange update (default: 10000ms = 10s)

---

### 3. RealtimeOCDetector - Throttle Refresh ✅

#### Vấn đề:
- Fetch 100+ symbols cùng lúc → block event loop 30-50 giây
- Refresh interval quá ngắn (5 phút)

#### Giải pháp:
- **Skip khi degrade mode**: Không refresh khi system degraded
- **Limit symbols per refresh**: `OC_OPEN_PRICE_MAX_SYMBOLS_PER_REFRESH` (default: 20)
- **Batch processing**: Process 5 symbols parallel, delay 200ms giữa batches
- **Yielding với `setImmediate()`**: Sau mỗi batch
- **Increase refresh interval**: Từ 5 phút → 15 phút

#### Code changes:
```javascript
// File: src/services/RealtimeOCDetector.js

// 1. Skip khi degrade mode
if (watchdogService?.isDegraded?.()) {
  logger.warn('[RealtimeOCDetector] System degraded, skipping refresh');
  return;
}

// 2. Limit symbols per refresh
const MAX_SYMBOLS_PER_REFRESH = 20; // Config: OC_OPEN_PRICE_MAX_SYMBOLS_PER_REFRESH
const symbolsToRefresh = shuffled.slice(0, MAX_SYMBOLS_PER_REFRESH);

// 3. Process in batches với yielding
for (let i = 0; i < symbolsToRefresh.length; i += REFRESH_BATCH_SIZE) {
  // Process batch
  await Promise.allSettled(batch.map(...));
  
  // ✅ YIELD TO EVENT LOOP
  await new Promise(resolve => setImmediate(resolve));
  
  // Delay between batches
  await new Promise(resolve => setTimeout(resolve, REFRESH_BATCH_DELAY_MS));
}

// 4. Increase refresh interval
const refreshInterval = 15 * 60 * 1000; // 15 minutes (was 5 minutes)
```

#### Config mới:
- `OC_OPEN_PRICE_MAX_SYMBOLS_PER_REFRESH`: Max symbols refresh mỗi lần (default: 20)
- `OC_OPEN_PRICE_REFRESH_BATCH_SIZE`: Batch size cho refresh (default: 5)
- `OC_OPEN_PRICE_REFRESH_BATCH_DELAY_MS`: Delay giữa các batch (default: 200ms)
- `OC_OPEN_PRICE_REFRESH_INTERVAL_MS`: Refresh interval (default: 900000ms = 15 phút)

---

## 📊 KẾT QUẢ MONG ĐỢI

### Trước khi fix:
- **PositionMonitor cycle time**: 6-8 phút (456 positions)
- **Event loop delay**: Mean 77-181ms, Max 540-677ms
- **WebSocket lag**: 316ms, 380ms, 2127ms
- **Position TP/SL delay**: 869s, 1576s, 1992s

### Sau khi fix:
- **PositionMonitor cycle time**: < 5 giây (20 positions/cycle)
- **Event loop delay**: Mean < 20ms, Max < 100ms (target)
- **WebSocket lag**: < 100ms (target)
- **Position TP/SL delay**: < 10 giây (target)

---

## 🎯 MONITORING & ALERTS

### Metrics cần monitor:
1. **PositionMonitor cycle time**: < 5 giây
2. **Event loop delay**: Mean < 20ms, Max < 100ms
3. **WebSocket processing lag**: < 100ms
4. **Position TP/SL delay**: < 10 giây từ khi position mở

### Alerts:
- Event loop delay > 50ms (mean) hoặc > 200ms (max)
- PositionMonitor cycle time > 10 giây
- Position không có TP/SL > 30 giây
- WebSocket processing lag > 500ms

---

## 🔄 ROLLBACK PLAN

Nếu có vấn đề, có thể rollback bằng cách:

1. **Disable throttling**:
   ```env
   POSITION_MONITOR_MAX_TP_SL_PER_CYCLE=999999
   POSITION_MONITOR_MAX_MONITORING_PER_CYCLE=999999
   ```

2. **Increase refresh interval**:
   ```env
   OC_OPEN_PRICE_REFRESH_INTERVAL_MS=3600000  # 1 hour
   ```

3. **Disable SymbolsUpdater timeout**:
   ```env
   SYMBOLS_UPDATE_EXCHANGE_TIMEOUT_MS=600000  # 10 minutes
   ```

---

## 📝 NOTES

- **Hardware**: 32GB RAM, 32 cores - đủ mạnh, vấn đề là ở code
- **Node.js single-threaded**: Event loop blocking là vấn đề chính
- **Yielding với `setImmediate()`**: Cho phép WebSocket và I/O khác chen vào xử lý
- **Staggering approach**: Chia nhỏ work load thành nhiều cycles thay vì xử lý tất cả cùng lúc

---

**Status**: ✅ COMPLETED - Ready for testing  
**Next Steps**: Monitor metrics và adjust config nếu cần

