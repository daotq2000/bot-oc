# Performance Optimization Plan

**Ngày:** 2025-12-23  
**Mục tiêu:** Tối thiểu CPU và RAM khi chạy bot

---

## Các Vấn Đề Hiệu Năng Đã Phát Hiện

### 1. Memory Leaks - Caches Không Có Cleanup
- **OrderService.positionCountCache**: Không có cleanup, có thể tăng vô hạn
- **OcAlertScanner**: Nhiều Maps (state, openCache, lastSent) không có cleanup
- **RealtimeOCDetector**: Đã có cleanup nhưng có thể tối ưu thêm

### 2. Excessive Logging
- **1072 logging calls** trong codebase
- **410 template string logs** - tốn CPU cho string interpolation
- Nhiều debug/info logs không cần thiết trong production

### 3. Large Data Structures
- Caches không có size limits
- Maps/Sets có thể tăng vô hạn

### 4. Timers/Intervals
- Nhiều setInterval không được clear khi stop
- Có thể gây memory leaks

---

## Các Fix Đã Lên Kế Hoạch

### Priority 1: Memory Leaks (Critical)
1. ✅ Thêm cleanup cho OrderService.positionCountCache
2. ✅ Thêm cleanup cho OcAlertScanner caches
3. ✅ Thêm size limits cho tất cả caches

### Priority 2: Logging Optimization
1. ✅ Giảm debug/info logs trong production
2. ✅ Sử dụng conditional logging
3. ✅ Tối ưu template string logs

### Priority 3: Cache Optimization
1. ✅ Thêm LRU eviction cho caches
2. ✅ Giảm cache sizes nếu có thể
3. ✅ Thêm TTL cho caches

### Priority 4: Timer Cleanup
1. ✅ Đảm bảo tất cả timers được clear khi stop
2. ✅ Track timers để cleanup dễ dàng

---

## Metrics

### Trước Optimization:
- Logging calls: ~1072
- Caches không có cleanup: 3+
- Template string logs: ~410

### Sau Optimization (Target):
- Logging calls: Giảm 30-50%
- Tất cả caches có cleanup
- Template string logs: Giảm 20-30%

---

## Implementation

Xem các file đã được fix trong commits tiếp theo.

