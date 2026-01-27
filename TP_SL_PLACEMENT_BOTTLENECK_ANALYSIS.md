# 🐌 PHÂN TÍCH: Tốc độ tạo TP/SL quá chậm

**Ngày**: 2026-01-22  
**Vấn đề**: Tốc độ tạo TP/SL quá chậm, mở position mới còn nhiều hơn tạo TP/SL

---

## 🎯 TÓM TẮT

**Root Cause**: **Nhiều bottleneck** trong flow TP/SL placement:
1. **Interval quá lâu**: 20 giây/cycle
2. **Batch size quá nhỏ**: Chỉ 20 positions/cycle
3. **Nhiều API calls**: Mỗi position cần 5-10 API calls
4. **Sequential processing**: TP → delay 1s → SL (không parallel)
5. **Lock mechanism**: is_processing lock có thể block concurrent processing

**Giải pháp**: Tối ưu multi-pronged approach

---

## 📊 PHÂN TÍCH FLOW HIỆN TẠI

### **Flow TP/SL Placement**

```
1. PositionMonitor.monitorAllPositions() (mỗi 20s)
   ↓
2. Filter positions cần TP/SL (tp_sl_pending = true hoặc không có exit_order_id/sl_order_id)
   ↓
3. Priority split:
   - Emergency (age > 10s): Process ngay
   - High priority (cần TP/SL): Batch 20 positions/cycle
   - Low priority (đã có TP/SL): Monitoring only
   ↓
4. Process high-priority positions (MAX 20/cycle):
   For each position:
     a. Acquire lock (is_processing = 1)
     b. Verify existing orders (2 API calls: getOrderStatus cho TP + SL)
     c. Get fill price (1-2 API calls: getOrderAverageFillPrice hoặc getOpenPositions)
     d. Get closable quantity (1 API call: getClosableQuantity)
     e. Calculate TP/SL prices
     f. Place TP order (1 API call: ExitOrderManager.placeOrReplaceExitOrder)
     g. Wait 1s (TP_SL_PLACEMENT_DELAY_MS)
     h. Place SL order (1 API call: createStopLossLimit)
     i. Release lock
   ↓
5. Yield to event loop (setImmediate)
   ↓
6. Delay 50ms (BATCH_DELAY_MS)
   ↓
7. Next batch (nếu còn)
```

**Tổng thời gian cho 1 position**:
- Lock: ~10ms
- Verify orders: ~200-400ms (2 API calls)
- Get fill price: ~100-200ms (1-2 API calls)
- Get closable quantity: ~100ms (1 API call)
- Place TP: ~200-500ms (1 API call + dedupe)
- Delay: 1000ms (TP_SL_PLACEMENT_DELAY_MS)
- Place SL: ~200-500ms (1 API call)
- Release lock: ~10ms

**Total**: **~1.8-2.7 giây/position**

**Với batch 20 positions**:
- Sequential: 20 × 2.5s = **50 giây** (quá lâu!)
- Parallel (Promise.allSettled): **~2.5-5 giây** (tùy API latency)

---

## ⚠️ BOTTLENECK IDENTIFIED

### **1. Interval quá lâu (20 giây)**

**Vấn đề**:
- PositionMonitor chạy mỗi 20 giây
- Nếu có 50 positions cần TP/SL → cần **3 cycles** (60 giây) để xử lý hết
- Trong 60 giây đó, có thể mở thêm 10-20 positions mới

**Code**:
```javascript
// src/config/constants.js
POSITION_MONITOR: parseInt(process.env.POSITION_MONITOR_INTERVAL_MS || '20000'), // 20 seconds
```

**Impact**: **Chậm 20 giây** mỗi cycle

---

### **2. Batch size quá nhỏ (20 positions/cycle)**

**Vấn đề**:
- Chỉ xử lý 20 positions/cycle
- Nếu có 100 positions cần TP/SL → cần **5 cycles** (100 giây)
- Trong 100 giây đó, có thể mở thêm 20-30 positions mới

**Code**:
```javascript
// src/jobs/PositionMonitor.js
const MAX_POSITIONS_PER_CYCLE = Number(configService.getNumber('POSITION_MONITOR_MAX_TP_SL_PER_CYCLE', 20));
```

**Impact**: **Chậm 5x** nếu có nhiều positions

---

### **3. Nhiều API calls per position (5-10 calls)**

**Vấn đề**:
- Mỗi position cần 5-10 API calls:
  1. `getOrderStatus` (TP) - verify existing TP order
  2. `getOrderStatus` (SL) - verify existing SL order
  3. `getOrderAverageFillPrice` - get fill price
  4. `getOpenPositions` - fallback for fill price
  5. `getClosableQuantity` - get quantity
  6. `getTickerPrice` - get current price (trong ExitOrderManager)
  7. `getOpenOrders` - check duplicates (trong ExitOrderManager)
  8. `placeOrder` (TP) - create TP order
  9. `placeOrder` (SL) - create SL order
  10. `cancelOrder` - dedupe old orders

**Impact**: **Chậm 2-5 giây/position** (tùy API latency)

---

### **4. Sequential TP → SL (delay 1s)**

**Vấn đề**:
- Place TP → wait 1s → place SL
- Không thể parallel vì cần delay giữa TP và SL

**Code**:
```javascript
// src/jobs/PositionMonitor.js
const delayMs = configService.getNumber('TP_SL_PLACEMENT_DELAY_MS', 1000); // 1 second
if (delayMs > 0 && needsSl) {
  await new Promise(resolve => setTimeout(resolve, delayMs));
}
```

**Impact**: **Chậm 1 giây/position** (không thể tối ưu)

---

### **5. Lock mechanism (is_processing)**

**Vấn đề**:
- Mỗi position cần acquire lock trước khi process
- Nếu lock fail → skip position → phải chờ cycle sau

**Code**:
```javascript
// src/jobs/PositionMonitor.js
const [result] = await pool.execute(
  `UPDATE positions 
   SET is_processing = 1 
   WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
   LIMIT 1`,
  [position.id]
);
if (result.affectedRows === 0) {
  // Skip - already being processed
  return;
}
```

**Impact**: **Có thể skip positions** nếu lock conflict

---

## 💡 GIẢI PHÁP ĐỀ XUẤT

### **Solution 1: Giảm Interval (Quick Win)**

**Thay đổi**:
```javascript
// .env hoặc config
POSITION_MONITOR_INTERVAL_MS=10000  // Giảm từ 20s → 10s
```

**Lợi ích**:
- ✅ **2x faster**: Cycle chạy 2x nhanh hơn
- ✅ **Đơn giản**: Chỉ cần thay đổi config

**Trade-off**:
- ⚠️ **Tăng DB load**: Query positions 2x thường xuyên hơn
- ⚠️ **Tăng CPU**: Monitor chạy 2x thường xuyên hơn

**Recommendation**: **✅ NÊN LÀM** (quick win, ít risk)

---

### **Solution 2: Tăng Batch Size (Quick Win)**

**Thay đổi**:
```javascript
// .env hoặc config
POSITION_MONITOR_MAX_TP_SL_PER_CYCLE=50  // Tăng từ 20 → 50
```

**Lợi ích**:
- ✅ **2.5x throughput**: Xử lý 2.5x positions/cycle
- ✅ **Đơn giản**: Chỉ cần thay đổi config

**Trade-off**:
- ⚠️ **Tăng API calls**: Nhiều positions → nhiều API calls
- ⚠️ **Tăng event loop delay**: Nếu process quá nhiều cùng lúc

**Recommendation**: **✅ NÊN LÀM** (quick win, monitor event loop delay)

---

### **Solution 3: Parallel TP/SL Placement (Critical)**

**Vấn đề hiện tại**:
- TP và SL được place sequential (TP → delay 1s → SL)
- Không thể parallel vì cần delay

**Giải pháp**:
- **Place TP và SL parallel** (không delay)
- **Binance hỗ trợ** place nhiều orders cùng lúc
- **Delay chỉ cần** nếu có rate limit issues

**Code change**:
```javascript
// src/jobs/PositionMonitor.js
// OLD: Sequential
if (needsTp && tpPrice) {
  await placeTP();
  await delay(1000);
  if (needsSl && slPrice) {
    await placeSL();
  }
}

// NEW: Parallel
const promises = [];
if (needsTp && tpPrice) {
  promises.push(placeTP());
}
if (needsSl && slPrice) {
  // No delay - place parallel
  promises.push(placeSL());
}
await Promise.allSettled(promises);
```

**Lợi ích**:
- ✅ **Giảm 1 giây/position**: Không cần delay
- ✅ **2x faster**: TP và SL place cùng lúc

**Trade-off**:
- ⚠️ **Risk rate limit**: Nếu Binance có rate limit cho concurrent orders
- ⚠️ **Cần test**: Đảm bảo Binance chấp nhận parallel TP/SL

**Recommendation**: **✅ NÊN LÀM** (critical optimization)

---

### **Solution 4: Reduce API Calls (Optimization)**

**Vấn đề hiện tại**:
- Mỗi position cần 5-10 API calls
- Nhiều calls có thể cache hoặc skip

**Giải pháp**:

#### **4.1. Skip order verification nếu mới mở (< 5s)**

```javascript
// src/jobs/PositionMonitor.js
const timeSinceOpened = Date.now() - new Date(position.opened_at).getTime();
if (timeSinceOpened < 5000) {
  // Position mới mở → skip verify existing orders (chưa có orders)
  needsTp = !position.exit_order_id;
  needsSl = !position.sl_order_id;
} else {
  // Verify existing orders (chỉ khi position đã mở > 5s)
  // ... existing verification code ...
}
```

**Lợi ích**:
- ✅ **Giảm 2 API calls/position** (skip getOrderStatus cho TP + SL)
- ✅ **Giảm ~400ms/position**

#### **4.2. Cache fill price**

```javascript
// Cache fill price trong scan cycle
const fillPriceCache = this._scanCache.get(`fillPrice:${position.id}`);
if (fillPriceCache && Date.now() - fillPriceCache.timestamp < 5000) {
  fillPrice = fillPriceCache.price;
} else {
  fillPrice = await getFillPrice();
  this._scanCache.set(`fillPrice:${position.id}`, { price: fillPrice, timestamp: Date.now() });
}
```

**Lợi ích**:
- ✅ **Giảm 1-2 API calls/position** (skip getOrderAverageFillPrice hoặc getOpenPositions)
- ✅ **Giảm ~200ms/position**

#### **4.3. Batch get closable quantity**

```javascript
// Batch get closable quantity cho nhiều positions cùng lúc
const quantities = await Promise.all(
  positions.map(p => exchangeService.getClosableQuantity(p.symbol, p.side))
);
```

**Lợi ích**:
- ✅ **Parallel API calls**: Nhiều positions → nhiều calls cùng lúc
- ✅ **Giảm total time**: Từ sequential → parallel

**Recommendation**: **✅ NÊN LÀM** (optimization, ít risk)

---

### **Solution 5: Emergency Queue (Critical)**

**Vấn đề hiện tại**:
- Emergency positions (age > 10s) được process trong batch
- Vẫn bị giới hạn bởi MAX_POSITIONS_PER_CYCLE

**Giải pháp**:
- **Emergency queue riêng**: Process ngay lập tức, không chờ cycle
- **Bypass batch limit**: Emergency positions không bị giới hạn

**Code change**:
```javascript
// src/jobs/PositionMonitor.js
// Emergency positions: Process ngay, không chờ cycle
const emergencyPositions = openPositions.filter(pos => {
  const timeSinceOpened = Date.now() - new Date(pos.opened_at).getTime();
  const needsTPSL = !pos.exit_order_id || !pos.sl_order_id || pos.tp_sl_pending;
  return needsTPSL && timeSinceOpened > EMERGENCY_SLA_MS;
});

// Process emergency positions ngay (không chờ batch)
if (emergencyPositions.length > 0) {
  await Promise.allSettled(
    emergencyPositions.map(pos => this.placeExitOrder(pos))
  );
}
```

**Lợi ích**:
- ✅ **Immediate processing**: Emergency positions được xử lý ngay
- ✅ **Bypass batch limit**: Không bị giới hạn bởi MAX_POSITIONS_PER_CYCLE

**Recommendation**: **✅ NÊN LÀM** (critical for safety)

---

### **Solution 6: Optimize Lock Mechanism**

**Vấn đề hiện tại**:
- Lock có thể block concurrent processing
- Nếu lock fail → skip position → chờ cycle sau

**Giải pháp**:
- **Retry lock**: Nếu lock fail, retry sau 100ms
- **Lock timeout**: Release lock sau 30s nếu process timeout

**Code change**:
```javascript
// src/jobs/PositionMonitor.js
// Retry lock nếu fail
let lockAcquired = false;
for (let retry = 0; retry < 3; retry++) {
  const [result] = await pool.execute(
    `UPDATE positions 
     SET is_processing = 1 
     WHERE id = ? AND status = 'open' AND (is_processing = 0 OR is_processing IS NULL)
     LIMIT 1`,
    [position.id]
  );
  if (result.affectedRows > 0) {
    lockAcquired = true;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 100));
}
```

**Lợi ích**:
- ✅ **Giảm skip positions**: Retry lock thay vì skip
- ✅ **Better throughput**: Nhiều positions được process hơn

**Recommendation**: **✅ NÊN LÀM** (optimization)

---

## 📊 TỔNG HỢP GIẢI PHÁP

### **Priority 1: Quick Wins (Làm ngay)**

1. **Giảm interval**: 20s → 10s
2. **Tăng batch size**: 20 → 50
3. **Parallel TP/SL**: Place TP và SL cùng lúc (bỏ delay)

**Expected improvement**: **3-5x faster**

---

### **Priority 2: Optimizations (Làm sau)**

4. **Skip order verification** cho positions mới (< 5s)
5. **Cache fill price** trong scan cycle
6. **Batch get closable quantity**
7. **Emergency queue** riêng (bypass batch limit)
8. **Optimize lock mechanism** (retry lock)

**Expected improvement**: **2-3x faster** (additional)

---

## 🎯 KẾT LUẬN

### **Root Cause**:
1. **Interval quá lâu** (20s)
2. **Batch size quá nhỏ** (20/cycle)
3. **Sequential TP/SL** (delay 1s)
4. **Nhiều API calls** (5-10/position)

### **Giải pháp**:
1. ✅ **Giảm interval**: 20s → 10s
2. ✅ **Tăng batch size**: 20 → 50
3. ✅ **Parallel TP/SL**: Bỏ delay, place cùng lúc
4. ✅ **Optimize API calls**: Skip verification, cache, batch

### **Expected Result**:
- **Before**: 20 positions/20s = **1 position/s**
- **After**: 50 positions/10s = **5 positions/s** (5x faster)

**→ Với 100 positions cần TP/SL**:
- **Before**: 100s (5 cycles × 20s)
- **After**: 20s (2 cycles × 10s) (**5x faster**)

