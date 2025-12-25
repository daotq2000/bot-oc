# WebSocket Order Tracking Analysis

**Date:** 2025-01-27  
**Issue:** Position đã hit TP nhưng không được track và tính PNL đúng

---

## 🔍 Kiến Trúc Hiện Tại

### 1. WebSocket Listener
- **EntryOrderMonitor** listen `ORDER_TRADE_UPDATE` events từ Binance WebSocket
- Chỉ hoạt động cho **Binance bots** (không có cho MEXC, Gate.io, etc.)
- Update **OrderStatusCache** cho TẤT CẢ orders (entry, TP, SL)

### 2. Order Status Cache
- **OrderStatusCache** lưu trữ order status từ WebSocket events
- Key format: `exchange:orderId` (normalized to lowercase)
- TTL: 1 hour (3600000ms)
- Max size: 1000 entries (LRU eviction)

### 3. Position Service
- **PositionService.updatePosition()** check OrderStatusCache để detect TP/SL filled
- Nếu cache miss, fallback sang REST API
- Nếu position không có exposure trên exchange, close position trong DB

---

## ⚠️ Vấn Đề Tiềm Ẩn

### 1. Exchange Name Mismatch
**Vấn đề:** Exchange name có thể không được normalize đúng khi check cache
- EntryOrderMonitor update cache với: `(bot.exchange || 'binance').toLowerCase()`
- PositionService check cache với: `this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance'`
- Nếu `exchangeService.exchange` là `'Binance'` (uppercase), cache key sẽ không match

**Fix:** ✅ Đã normalize exchange name trong PositionService

### 2. WebSocket Disconnect
**Vấn đề:** Nếu WebSocket disconnect và không reconnect kịp, OrderStatusCache sẽ không được update
- EntryOrderMonitor có reconnect logic, nhưng có thể có delay
- Trong thời gian disconnect, TP/SL orders có thể filled nhưng không được track

**Giải pháp:** PositionService có fallback sang REST API nếu cache miss

### 3. Cache TTL Quá Ngắn
**Vấn đề:** Cache TTL = 1 hour, nhưng nếu position monitor chạy chậm, order có thể bị evict trước khi check
- Order filled → cache updated
- PositionMonitor chạy sau 1+ hour → cache expired → fallback sang REST API

**Giải pháp:** TTL 1 hour là hợp lý, nhưng cần đảm bảo PositionMonitor chạy đủ thường xuyên

### 4. Order ID Format Mismatch
**Vấn đề:** Order ID có thể có format khác nhau (string vs number)
- WebSocket trả về: `orderId` (có thể là number)
- DB lưu: `tp_order_id` (có thể là string)
- Cache key: `${exchange}:${String(orderId)}` - đã normalize

**Giải pháp:** ✅ Đã normalize orderId thành string trong cache key

### 5. PositionMonitor Không Listen WebSocket Trực Tiếp
**Vấn đề:** PositionMonitor phụ thuộc vào EntryOrderMonitor để update cache
- Nếu EntryOrderMonitor không chạy, cache không được update
- PositionMonitor không có cách nào biết được TP/SL order filled ngoài việc check cache

**Giải pháp:** 
- EntryOrderMonitor đã update cache cho TẤT CẢ orders (không chỉ entry orders)
- PositionService có fallback sang REST API nếu cache miss

---

## ✅ Các Fix Đã Thực Hiện

### 1. Normalize Exchange Name trong PositionService
**File:** `src/services/PositionService.js`

**Thay đổi:**
```javascript
// CRITICAL FIX: Normalize exchange name to lowercase to match cache key format
const exchange = (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
```

**Kết quả:** Đảm bảo exchange name luôn được normalize đúng khi check cache

### 2. Thêm Debug Logging
**File:** `src/services/PositionService.js`

**Thay đổi:**
```javascript
// Debug logging for cache miss
if (!cachedTpStatus) {
  logger.debug(`[TP/SL Check] TP order ${position.tp_order_id} for position ${position.id} not found in cache (exchange: ${exchange})`);
}
```

**Kết quả:** Dễ debug hơn khi cache miss

### 3. Cải thiện Logging trong EntryOrderMonitor
**File:** `src/jobs/EntryOrderMonitor.js`

**Thay đổi:**
```javascript
if (isFilled) {
  logger.info(`[EntryOrderMonitor] TP/SL order ${orderId} (${symbol}) FILLED via WebSocket. Cache updated. PositionService will detect on next cycle.`);
}
```

**Kết quả:** Log rõ ràng khi TP/SL order filled qua WebSocket

### 4. Cải thiện Logging trong OrderStatusCache
**File:** `src/services/OrderStatusCache.js`

**Thay đổi:**
```javascript
// Log important status changes (FILLED orders) at info level for debugging
if (normalizedStatus === 'closed') {
  logger.info(`[OrderStatusCache] ✅ Order ${orderId} (${exchange}) FILLED: filled=${filled}, avgPrice=${avgPrice || 'N/A'}, symbol=${symbol || 'N/A'}`);
}
```

**Kết quả:** Log rõ ràng khi order FILLED, dễ debug

---

## 📋 Checklist Để Debug

1. ✅ Kiểm tra WebSocket connection:
   - Tìm log: `[EntryOrderMonitor] User-data WebSocket connected for bot X`
   - Nếu không có, WebSocket chưa được connect

2. ✅ Kiểm tra ORDER_TRADE_UPDATE events:
   - Tìm log: `[EntryOrderMonitor] ORDER_TRADE_UPDATE raw event received`
   - Tìm log: `[EntryOrderMonitor] TP/SL order X FILLED via WebSocket`

3. ✅ Kiểm tra OrderStatusCache update:
   - Tìm log: `[OrderStatusCache] ✅ Order X FILLED`
   - Nếu không có, cache không được update

4. ✅ Kiểm tra PositionService check cache:
   - Tìm log: `[TP/SL Check] TP order X filled (from WebSocket cache)`
   - Tìm log: `[TP/SL Check] TP order X not found in cache` (nếu cache miss)

5. ✅ Kiểm tra fallback REST API:
   - Tìm log: `[TP/SL Check] Position X has no exposure on exchange`
   - Tìm log: `[TP/SL Check] Closing in DB with reason: tp_hit`

---

## 🔄 Quy Trình Hoạt Động

### Khi TP Order Filled:

```
1. Binance WebSocket → ORDER_TRADE_UPDATE event
   ↓
2. EntryOrderMonitor._handleBinanceOrderTradeUpdate()
   ↓
3. OrderStatusCache.updateOrderStatus(orderId, { status: 'FILLED', ... })
   ↓
4. PositionMonitor.monitorPosition() (chạy định kỳ)
   ↓
5. PositionService.updatePosition()
   ↓
6. Check OrderStatusCache.getOrderStatus(tp_order_id, exchange)
   ↓
7. Nếu status === 'closed' → closePosition(position, price, pnl, 'tp_hit')
   ↓
8. PositionService.closePosition()
   ↓
9. Position.close() (update DB)
   ↓
10. sendTelegramCloseNotification()
```

### Nếu Cache Miss:

```
1. PositionService.updatePosition()
   ↓
2. Check OrderStatusCache → MISS
   ↓
3. Check closableQuantity → 0 (position đã close trên exchange)
   ↓
4. Fallback: Check order status via REST API
   ↓
5. Nếu order FILLED → closePosition(position, price, pnl, 'tp_hit')
```

---

## 💡 Khuyến Nghị

### 1. Đảm bảo WebSocket Connection
- Kiểm tra logs để đảm bảo WebSocket được connect cho tất cả Binance bots
- Nếu WebSocket disconnect, cần reconnect nhanh chóng

### 2. Đảm bảo PositionMonitor Chạy Đủ Thường Xuyên
- PositionMonitor cần chạy đủ thường xuyên để detect TP/SL fills
- Nếu chạy quá chậm, cache có thể expire trước khi check

### 3. Monitor Cache Hit Rate
- Thêm metrics để track cache hit/miss rate
- Nếu miss rate cao, cần điều tra nguyên nhân

### 4. Fallback Mechanism
- Đảm bảo fallback sang REST API hoạt động đúng
- Nếu cache miss, vẫn có thể detect TP/SL fills qua REST API

### 5. Logging
- Đảm bảo có đủ logging để debug
- Log rõ ràng khi TP/SL order filled và position được close

---

## 🔧 Scripts Đã Tạo

### `scripts/check_websocket_order_tracking.js`
- Kiểm tra bot configuration
- Kiểm tra position với TP/SL orders
- Kiểm tra OrderStatusCache
- Phân tích vấn đề

**Cách sử dụng:**
```bash
node scripts/check_websocket_order_tracking.js
```

---

## 📊 Metrics Cần Monitor

1. **WebSocket Connection Status**
   - Số bot có WebSocket connected
   - Số bot không có WebSocket (non-Binance)

2. **OrderStatusCache Stats**
   - Cache size
   - Cache hit rate
   - Cache miss rate
   - Expired entries

3. **TP/SL Detection**
   - Số TP/SL orders detected via WebSocket cache
   - Số TP/SL orders detected via REST API fallback
   - Số TP/SL orders missed (không được detect)

---

**Report Generated:** 2025-01-27  
**Status:** ✅ Fixed (Exchange name normalization, improved logging)

