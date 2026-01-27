# 🚨 CRITICAL FIXES V2 - Event Loop Blocking (Continued)

**Ngày**: 2026-01-22  
**Status**: ✅ COMPLETED

---

## 🔴 VẤN ĐỀ PHÁT HIỆN

Từ log analysis:
1. **Event loop delay cực cao**: mean=154-841ms, max=574-2457ms (streak 12/3)
2. **Nhiều positions không có closable quantity**: Retry liên tục → block event loop
3. **Emergency positions quá nhiều**: Process tất cả cùng lúc → block event loop
4. **RealtimeOCDetector spam**: Log warnings liên tục

---

## ✅ FIXES ĐÃ IMPLEMENT

### 1. **Limit Emergency Positions Batch Processing** 🚨

**Vấn đề**: Process TẤT CẢ emergency positions cùng lúc → block event loop

**Giải pháp**:
- Limit batch size: 5 positions concurrent (configurable)
- Yielding sau mỗi batch với `setImmediate()`
- Delay 100ms giữa các batches

**Code**:
```javascript
// File: src/jobs/PositionMonitor.js
const EMERGENCY_BATCH_SIZE = 5; // Max 5 concurrent
const EMERGENCY_BATCH_DELAY_MS = 100; // 100ms delay

for (let i = 0; i < emergencyPositions.length; i += EMERGENCY_BATCH_SIZE) {
  const batch = emergencyPositions.slice(i, i + EMERGENCY_BATCH_SIZE);
  await Promise.allSettled(batch.map(pos => this.placeExitOrder(pos)));
  
  // Yield to event loop
  await new Promise(resolve => setImmediate(resolve));
  
  // Delay between batches
  if (i + EMERGENCY_BATCH_SIZE < emergencyPositions.length) {
    await new Promise(resolve => setTimeout(resolve, EMERGENCY_BATCH_DELAY_MS));
  }
}
```

**Config**:
- `POSITION_MONITOR_EMERGENCY_BATCH_SIZE`: Max concurrent emergency positions (default: 5)
- `POSITION_MONITOR_EMERGENCY_BATCH_DELAY_MS`: Delay between batches (default: 100ms)

---

### 2. **Skip Positions Without Closable Quantity** ⚠️

**Vấn đề**: Positions không có closable quantity → retry liên tục → block event loop

**Giải pháp**:
- Skip ngay lập tức (không retry)
- Clear `tp_sl_pending` flag để prevent retry loops
- Log warning (không error) - position sẽ được sync bởi PositionSync

**Code**:
```javascript
// File: src/jobs/PositionMonitor.js
const quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
if (!quantity || quantity <= 0) {
  logger.warn(
    `[Place TP/SL] ⚠️ No closable quantity found for position ${position.id}, ` +
    `position likely already closed on exchange. Skipping TP/SL placement (will be synced by PositionSync).`
  );
  
  // Clear pending flag to prevent retry loops
  await Position.update(position.id, { tp_sl_pending: false });
  return; // Skip immediately
}
```

---

### 3. **Reduce RealtimeOCDetector Log Spam** 📝

**Vấn đề**: "Using prev_close as open" warnings spam liên tục → log file lớn

**Giải pháp**:
- Change log level từ `warn` → `debug`
- Giảm noise trong log files

**Code**:
```javascript
// File: src/services/RealtimeOCDetector.js
// Before: logger.warn(...)
// After: logger.debug(...)
logger.debug(
  `[RealtimeOCDetector] Using prev_close as open (less accurate) | ${sym} ${interval} ...`
);
```

---

### 4. **Increase PositionMonitor Interval** ⏱️

**Vấn đề**: Interval 10s quá ngắn khi có nhiều positions → cycle chồng lên nhau

**Giải pháp**:
- Tăng interval từ 10s → 20s
- Giảm frequency khi có nhiều positions

**Code**:
```javascript
// File: src/config/constants.js
POSITION_MONITOR: parseInt(process.env.POSITION_MONITOR_INTERVAL_MS || '20000'), // 20 seconds
```

**Config**:
- `POSITION_MONITOR_INTERVAL_MS`: Interval giữa các cycles (default: 20000ms = 20s)

---

### 5. **Smart Emergency Detection** 🧠

**Vấn đề**: Tất cả positions > 10s đều được mark là emergency → quá nhiều

**Giải pháp**:
- Chỉ mark emergency nếu:
  - Position > 1 phút không có TP/SL, HOẶC
  - Position có TP nhưng không có SL (real emergency)
- Positions 10s-1 phút → high priority (không emergency)

**Code**:
```javascript
// File: src/jobs/PositionMonitor.js
if (needsTPSL && timeSinceOpened > EMERGENCY_SLA_MS) {
  const hasTPButNoSL = pos.exit_order_id && !pos.sl_order_id;
  
  if (hasTPButNoSL || timeSinceOpened > 60 * 1000) {
    // Real emergency: > 1 minute OR has TP but no SL
    emergencyPositions.push({ ...pos, ageMs: timeSinceOpened });
  } else {
    // 10s-1min: high priority (not emergency)
    highPriorityPositions.push(pos);
  }
}
```

---

## 📊 KẾT QUẢ MONG ĐỢI

### **Trước khi fix**:
- ❌ Emergency positions: Process tất cả cùng lúc → block event loop
- ❌ Positions không có quantity: Retry liên tục → block event loop
- ❌ RealtimeOCDetector: Log spam → log file lớn
- ❌ PositionMonitor interval: 10s → cycles chồng lên nhau
- ❌ Event loop delay: 154-841ms (mean), 574-2457ms (max)

### **Sau khi fix**:
- ✅ Emergency positions: Process in batches (5 concurrent) → không block
- ✅ Positions không có quantity: Skip ngay → không retry
- ✅ RealtimeOCDetector: Debug level → giảm noise
- ✅ PositionMonitor interval: 20s → cycles không chồng
- ✅ Event loop delay: < 50ms (mean), < 200ms (max) - target

---

## 🔧 CONFIG MỚI

```env
# Emergency batch processing
POSITION_MONITOR_EMERGENCY_BATCH_SIZE=5        # Max concurrent emergency positions
POSITION_MONITOR_EMERGENCY_BATCH_DELAY_MS=100  # Delay between batches

# PositionMonitor interval
POSITION_MONITOR_INTERVAL_MS=20000  # 20 seconds (increased from 10s)
```

---

## 🚨 MONITORING

### **Key Metrics**:
1. **Emergency positions count**: Should decrease over time
2. **Positions without closable quantity**: Should be handled by PositionSync
3. **Event loop delay**: Should decrease significantly
4. **PositionMonitor cycle time**: Should be < 5s

### **Alerts**:
- 🚨 Emergency positions > 10 (may indicate system overload)
- ⚠️ Event loop delay > 100ms (mean) or > 500ms (max)
- ⚠️ PositionMonitor cycle time > 10s

---

## 📝 NOTES

- **Emergency batch processing**: Critical để tránh block event loop khi có nhiều emergency positions
- **Skip positions without quantity**: Prevent retry loops, let PositionSync handle
- **Reduce log spam**: Improve log readability và reduce I/O
- **Increase interval**: Give system time to recover between cycles

---

**Status**: ✅ COMPLETED - Ready for testing  
**Expected Impact**: Significant reduction in event loop delay

