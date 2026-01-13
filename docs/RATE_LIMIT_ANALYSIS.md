# Phân Tích Nguyên Nhân Gây Rate Limit

## 📊 Kết Quả Phân Tích

### Top Nguyên Nhân (theo thứ tự)

1. **PositionMonitor - 90.6% tổng requests** ⚠️ **NGUYÊN NHÂN CHÍNH**
2. PositionSync - 9.4% tổng requests
3. PriceAlertScanner - 0% (chủ yếu dùng WebSocket)
4. EntryOrderMonitor - 0% (ít pending orders)

---

## 🔍 PHÂN TÍCH CHI TIẾT POSITIONMONITOR

### API Calls Mỗi Position Mỗi Cycle (25 giây)

#### 1. `placeExitOrder()` - Đặt/cập nhật TP/SL orders
- **`getOrderStatus()`**: 2 calls
  - Kiểm tra TP order status (Line 155)
  - Kiểm tra SL order status (Line 180)
  - **Vấn đề**: Gọi cho MỌI position, kể cả khi đã có TP/SL
  
- **`getOrderAverageFillPrice()`**: ~0.8 calls/position
  - Lấy fill price thực tế (Line 240)
  - Chỉ gọi nếu có `order_id` (synced positions không có)
  
- **`getClosableQuantity()`**: 1 call
  - Lấy quantity chính xác từ exchange (Line 319)
  - Cần để tính SL theo USDT amount
  
- **`createOrder()`**: ~2 calls/position (khi cần TP/SL)
  - Tạo TP order (Line 347)
  - Tạo SL order (Line 549)
  
- **`getTickerPrice()`**: ~0.1 calls/position
  - Chỉ khi invalid SL cần force close (Line 540 - rare case)

#### 2. `monitorPosition()` → `PositionService.updatePosition()`
- **`getTickerPrice()`**: 1 call/position
  - Lấy current price để tính PnL (Line 97 in PositionService)
  - **Vấn đề**: Gọi cho MỌI position mỗi cycle, kể cả khi không cần update

### Tổng API Calls Mỗi Position Mỗi Cycle

| Function | API Calls | Ghi chú |
|----------|-----------|---------|
| `placeExitOrder()` | ~6 calls | Khi cần TP/SL hoặc verify orders |
| `updatePosition()` | ~1 call | Luôn gọi để update PnL |
| **TOTAL** | **~7 calls/position/cycle** | |

### Tính Toán Rate Limit

**Với 4 positions (hiện tại):**
- Calls per cycle: 4 × 7 = ~28 calls
- Cycles per minute: 60 / 25 = 2.4 cycles
- **Requests per minute: ~67 requests/min** (5.6% limit) ✅

**Với 50 positions (tăng):**
- Calls per cycle: 50 × 7 = ~350 calls
- Cycles per minute: 60 / 25 = 2.4 cycles
- **Requests per minute: ~840 requests/min** (70% limit) ⚠️

**Với 100 positions (nhiều):**
- Calls per cycle: 100 × 7 = ~700 calls
- Cycles per minute: 60 / 25 = 2.4 cycles
- **Requests per minute: ~1,680 requests/min** (140% limit) ❌ **VƯỢT LIMIT!**

---

## 🎯 NGUYÊN NHÂN CỐT YẾU

### 1. **`getOrderStatus()` được gọi cho MỌI position** ❌

**Vấn đề:**
- Mỗi position gọi `getOrderStatus()` 2 lần (TP + SL) mỗi cycle
- Kể cả khi orders đã tồn tại và active
- Không có cache, luôn gọi API

**Location:** `PositionMonitor.placeExitOrder()` - Lines 155, 180

**Impact:**
- 4 positions × 2 calls = 8 calls/cycle
- 100 positions × 2 calls = 200 calls/cycle = **480 calls/min**

### 2. **`getTickerPrice()` được gọi cho MỌI position** ❌

**Vấn đề:**
- Mỗi position gọi `getTickerPrice()` để update PnL mỗi cycle
- Kể cả khi giá không thay đổi đáng kể
- Có WebSocket cache nhưng vẫn fallback REST

**Location:** `PositionService.updatePosition()` - Line 97

**Impact:**
- 4 positions × 1 call = 4 calls/cycle
- 100 positions × 1 call = 100 calls/cycle = **240 calls/min**

### 3. **`getClosableQuantity()` được gọi mỗi khi place TP/SL** ⚠️

**Vấn đề:**
- Gọi mỗi khi cần place TP/SL
- Có thể gọi nhiều lần nếu TP/SL fail và retry

**Location:** `PositionMonitor.placeExitOrder()` - Line 319

**Impact:**
- Moderate, nhưng tăng khi có nhiều positions cần TP/SL

---

## 💡 GIẢI PHÁP TỐI ƯU

### 1. **Tối Ưu `getOrderStatus()` - QUAN TRỌNG NHẤT** 🎯

**Hiện tại:**
```javascript
// Lines 151-173, 175-198
// Gọi getOrderStatus() cho MỌI position mỗi cycle
if (position.exit_order_id) {
  const orderStatus = await exchangeService.getOrderStatus(...); // ❌
}
if (position.sl_order_id) {
  const orderStatus = await exchangeService.getOrderStatus(...); // ❌
}
```

**Giải pháp:**
- ✅ **Cache order status** với TTL (ví dụ: 5 phút)
- ✅ **Chỉ verify orders** khi:
  - Position mới được tạo
  - TP/SL order bị reject/cancel
  - Định kỳ (ví dụ: mỗi 5 phút thay vì mỗi cycle)
- ✅ **Skip verify** nếu order_id không thay đổi và đã verify gần đây

**Impact:**
- Giảm ~400 calls/min với 100 positions (từ 480 → 80)

### 2. **Tối Ưu `getTickerPrice()`** 🎯

**Hiện tại:**
```javascript
// PositionService.updatePosition() - Line 97
const currentPrice = await this.exchangeService.getTickerPrice(position.symbol);
```

**Giải pháp:**
- ✅ **Ưu tiên WebSocket cache** (đã có)
- ✅ **Tăng WebSocket subscription** coverage để giảm REST fallback
- ✅ **Cache prices** với short TTL (ví dụ: 1 giây) để tránh multiple calls cho cùng symbol
- ✅ **Skip update** nếu giá thay đổi < threshold (ví dụ: < 0.1%)

**Impact:**
- Giảm ~200 calls/min với 100 positions (từ 240 → 40)

### 3. **Tối Ưu `getClosableQuantity()`** 

**Hiện tại:**
```javascript
// Line 319
const quantity = await exchangeService.getClosableQuantity(position.symbol, position.side);
```

**Giải pháp:**
- ✅ **Cache quantity** với TTL (ví dụ: 30 giây)
- ✅ **Reuse quantity** trong cùng cycle
- ✅ **Chỉ gọi khi cần** (khi place TP/SL, không gọi khi verify)

**Impact:**
- Giảm moderate calls

### 4. **Tăng Interval** ⚠️

**Hiện tại:** 25 giây
**Đề xuất:** 40-60 giây

**Impact:**
- Giảm frequency: 60/25 = 2.4 cycles/min → 60/40 = 1.5 cycles/min
- Giảm ~40% requests/min

### 5. **Batch Processing Tối Ưu**

**Hiện tại:**
- Batch size: 3 positions
- Process sequentially với delay 500ms

**Đề xuất:**
- Batch size: 2 positions (giảm parallel)
- Delay: 500ms → 1000ms (tăng delay)

**Impact:**
- Giảm burst requests
- Spread requests over time

---

## 📈 DỰ ĐOÁN VỚI CÁC TỐI ƯU

### Với 100 Positions

**Trước tối ưu:**
- Requests/min: ~1,680 (140% limit) ❌

**Sau tối ưu:**
1. Cache `getOrderStatus()`: -400 calls/min
2. Cache `getTickerPrice()`: -200 calls/min  
3. Tăng interval 25s → 40s: -40%
4. Các tối ưu khác: -50 calls/min

**Kết quả:**
- Requests/min: ~550 (46% limit) ✅

---

## 🎯 KHUYẾN NGHỊ ƯU TIÊN

### Priority 1: Tối ưu `getOrderStatus()` (Cao nhất)
- **Impact:** Giảm ~30-40% requests/min
- **Effort:** Medium
- **Implementation:** Cache với TTL + chỉ verify khi cần

### Priority 2: Cache `getTickerPrice()`
- **Impact:** Giảm ~15-20% requests/min  
- **Effort:** Low
- **Implementation:** Symbol-level cache với short TTL

### Priority 3: Tăng Interval
- **Impact:** Giảm ~40% requests/min
- **Effort:** Low (chỉ config change)
- **Trade-off:** Position updates chậm hơn

### Priority 4: Batch Processing
- **Impact:** Giảm burst requests
- **Effort:** Low
- **Implementation:** Tăng delay giữa positions

---

## 📝 CONFIG ĐỀ XUẤT

```sql
-- Tăng intervals
UPDATE app_configs SET value = '40000' WHERE key = 'POSITION_MONITOR_INTERVAL_MS';
UPDATE app_configs SET value = '60000' WHERE key = 'POSITION_SYNC_INTERVAL_MS';

-- Batch processing
UPDATE app_configs SET value = '2' WHERE key = 'POSITION_MONITOR_BATCH_SIZE';
UPDATE app_configs SET value = '1000' WHERE key = 'POSITION_MONITOR_POSITION_DELAY_MS';
UPDATE app_configs SET value = '3000' WHERE key = 'POSITION_MONITOR_BATCH_DELAY_MS';
```

---

## ✅ KẾT LUẬN

**Nguyên nhân cốt yếu:**
1. **`getOrderStatus()` được gọi quá thường xuyên** (MỌI position mỗi cycle)
2. **`getTickerPrice()` được gọi quá thường xuyên** (MỌI position mỗi cycle)
3. **Interval quá ngắn** (25 giây → nhiều cycles)

**Giải pháp ưu tiên:**
1. Cache `getOrderStatus()` với TTL
2. Cache `getTickerPrice()` hoặc ưu tiên WebSocket
3. Tăng interval lên 40-60 giây
4. Tối ưu batch processing

Với các tối ưu này, bot có thể handle 100+ positions mà không bị rate limit.

