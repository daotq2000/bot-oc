# WebSocket Order Tracking - Fix Summary

**Date:** 2025-01-27  
**Issue:** Position đã hit TP nhưng không được track và tính PNL đúng do WebSocket order tracking

---

## ✅ Các Fix Đã Thực Hiện

### 1. Normalize Exchange Name trong PositionService
**File:** `src/services/PositionService.js`

**Vấn đề:** Exchange name có thể không được normalize đúng khi check OrderStatusCache, dẫn đến cache miss

**Fix:**
- Normalize exchange name thành lowercase trước khi check cache
- Áp dụng cho cả TP và SL order checks
- Áp dụng cho cả PRIORITY CHECK 1 và PRIORITY CHECK 2

**Code:**
```javascript
// CRITICAL FIX: Normalize exchange name to lowercase to match cache key format
const exchange = (this.exchangeService?.exchange || this.exchangeService?.bot?.exchange || 'binance').toLowerCase();
```

---

### 2. Thêm Debug Logging
**File:** `src/services/PositionService.js`

**Thay đổi:**
- Log khi cache miss để dễ debug
- Log exchange name được sử dụng

**Code:**
```javascript
// Debug logging for cache miss
if (!cachedTpStatus) {
  logger.debug(`[TP/SL Check] TP order ${position.tp_order_id} for position ${position.id} not found in cache (exchange: ${exchange})`);
}
```

---

### 3. Cải thiện Logging trong EntryOrderMonitor
**File:** `src/jobs/EntryOrderMonitor.js`

**Thay đổi:**
- Log rõ ràng khi TP/SL order filled qua WebSocket
- Log để biết cache đã được update

**Code:**
```javascript
if (isFilled) {
  logger.info(`[EntryOrderMonitor] TP/SL order ${orderId} (${symbol}) FILLED via WebSocket. Cache updated. PositionService will detect on next cycle.`);
}
```

---

### 4. Cải thiện Logging trong OrderStatusCache
**File:** `src/services/OrderStatusCache.js`

**Thay đổi:**
- Log FILLED orders ở info level (thay vì debug)
- Log đầy đủ thông tin: filled quantity, avgPrice, symbol

**Code:**
```javascript
// Log important status changes (FILLED orders) at info level for debugging
if (normalizedStatus === 'closed') {
  logger.info(`[OrderStatusCache] ✅ Order ${orderId} (${exchange}) FILLED: filled=${filled}, avgPrice=${avgPrice || 'N/A'}, symbol=${symbol || 'N/A'}`);
}
```

---

## 🔍 Kiến Trúc WebSocket Order Tracking

### Luồng Hoạt Động:

```
1. Binance WebSocket
   ↓
2. ORDER_TRADE_UPDATE event
   ↓
3. EntryOrderMonitor._handleBinanceOrderTradeUpdate()
   ↓
4. OrderStatusCache.updateOrderStatus()
   - Key: "binance:orderId"
   - Status: "closed" (nếu FILLED)
   - avgPrice: actual fill price
   ↓
5. PositionMonitor.monitorPosition() (chạy định kỳ)
   ↓
6. PositionService.updatePosition()
   ↓
7. Check OrderStatusCache.getOrderStatus(tp_order_id, "binance")
   - Key: "binance:tp_order_id"
   ↓
8. Nếu status === "closed" → closePosition()
```

### Vấn Đề Exchange Name Mismatch:

**Trước khi fix:**
- EntryOrderMonitor update cache: `"binance:orderId"` (lowercase)
- PositionService check cache: `"Binance:orderId"` (có thể uppercase)
- → Cache miss!

**Sau khi fix:**
- EntryOrderMonitor update cache: `"binance:orderId"` (lowercase)
- PositionService check cache: `"binance:orderId"` (normalized to lowercase)
- → Cache hit! ✅

---

## 📋 Checklist Debug

Khi position hit TP nhưng không được track, kiểm tra:

1. **WebSocket Connection:**
   ```bash
   grep "User-data WebSocket connected" logs/combined.log
   ```

2. **ORDER_TRADE_UPDATE Events:**
   ```bash
   grep "ORDER_TRADE_UPDATE" logs/combined.log | grep "FILLED"
   ```

3. **OrderStatusCache Update:**
   ```bash
   grep "OrderStatusCache.*FILLED" logs/combined.log
   ```

4. **PositionService Check Cache:**
   ```bash
   grep "TP/SL Check.*filled.*from WebSocket cache" logs/combined.log
   grep "TP/SL Check.*not found in cache" logs/combined.log
   ```

5. **Position Close:**
   ```bash
   grep "Position closed.*tp_hit" logs/combined.log
   ```

---

## 💡 Nguyên Nhân Có Thể

### 1. Exchange Name Mismatch ✅ FIXED
- **Trước:** Exchange name không được normalize đúng
- **Sau:** Exchange name luôn được normalize thành lowercase

### 2. WebSocket Disconnect
- Nếu WebSocket disconnect, OrderStatusCache không được update
- **Giải pháp:** PositionService có fallback sang REST API

### 3. Cache TTL Expired
- Cache TTL = 3 minutes
- Nếu PositionMonitor chạy chậm, cache có thể expire
- **Giải pháp:** Fallback sang REST API

### 4. Order ID Format Mismatch
- Order ID có thể là string hoặc number
- **Giải pháp:** Đã normalize thành string trong cache key

---

## 🔧 Scripts

### `scripts/check_websocket_order_tracking.js`
- Kiểm tra bot configuration
- Kiểm tra OrderStatusCache
- Phân tích vấn đề

---

## 📊 Kết Quả Mong Đợi

### Trước khi fix:
- ❌ Exchange name mismatch → cache miss
- ❌ Position hit TP nhưng không được track
- ❌ PNL không được tính

### Sau khi fix:
- ✅ Exchange name được normalize đúng
- ✅ Cache hit rate cao hơn
- ✅ Position hit TP được track đúng
- ✅ PNL được tính đúng
- ✅ Logging rõ ràng để debug

---

**Report Generated:** 2025-01-27  
**Status:** ✅ Fixed

