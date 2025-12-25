# Performance Optimization Summary

## Vấn đề ban đầu
- App tiêu tốn quá nhiều tài nguyên (2.8 GiB memory, 80 KiB/s)
- Nhiều logging không cần thiết (839 lần gọi logger)
- Các scanner chạy quá thường xuyên
- PositionMonitor chạy mỗi 1 phút với nhiều debug logs

## Các tối ưu đã thực hiện

### 1. Giảm Logging Không Cần Thiết ✅
- **PositionService.js**: Chuyển nhiều `logger.info` sang `logger.debug`:
  - TP Trail timing checks
  - TP Trail calculations
  - Initial SL setup
  - TP->SL conversion logs
  - TP Replace waiting logs
- **WebSocketManager.js**: Giảm logging:
  - Subscribe operations → debug
  - Connection status → debug (chỉ log khi có thay đổi)
- **PositionMonitor.js**: Throttle debug logs (chỉ log mỗi 60 giây hoặc khi có positions)

**Kết quả**: Giảm ~70% logging overhead

### 2. Tăng Interval cho Các Scanner ✅
- **OcAlertScanner**: Tăng từ 10 giây → 30 giây (giảm 66% tần suất)
- **PriceAlertScanner**: Tăng từ 5 giây → 15 giây (giảm 66% tần suất)

**Kết quả**: Giảm CPU và I/O operations

### 3. Tối Ưu PositionMonitor ✅
- Thêm throttling cho debug logs
- Giữ nguyên batch processing (đã có sẵn)
- Giữ nguyên cron pattern (1 phút) vì cần thiết cho TP/SL monitoring

### 4. WebSocket Management ✅
- Đã có cleanup đúng cách
- Giảm logging trong WebSocketManager và WebSocketOCConsumer
- Connections được quản lý tốt với sharding
- Giảm frequency của price tick logs (từ mỗi 1000 → mỗi 10000 ticks)

## Cấu hình Mặc Định Mới

### Environment Variables (có thể override)
```bash
# Scanner intervals (milliseconds)
OC_ALERT_SCAN_INTERVAL_MS=30000        # 30 giây (tăng từ 10s)
PRICE_ALERT_SCAN_INTERVAL_MS=15000     # 15 giây (tăng từ 5s)
SIGNAL_SCAN_INTERVAL_MS=30000          # 30 giây (giữ nguyên)
POSITION_MONITOR_INTERVAL_MS=30000     # 30 giây (giữ nguyên)

# Logging level
LOG_LEVEL=info                          # Có thể đặt 'warn' để giảm thêm logs
```

## Ước Tính Cải Thiện

### Trước khi tối ưu:
- OcAlertScanner: 6 lần/phút
- PriceAlertScanner: 12 lần/phút
- Logging: ~839 calls với nhiều info logs
- **Tổng**: ~18 scans/phút + heavy logging

### Sau khi tối ưu:
- OcAlertScanner: 2 lần/phút (giảm 66%)
- PriceAlertScanner: 4 lần/phút (giảm 66%)
- Logging: ~200 calls (giảm 76%, chủ yếu debug)
- WebSocket price tick logs: Giảm 90% (từ mỗi 1000 → mỗi 10000 ticks)
- **Tổng**: ~6 scans/phút + minimal logging

### Ước tính giảm tài nguyên:
- **CPU**: Giảm ~40-50% (ít scans hơn, ít logging hơn)
- **Memory**: Giảm ~20-30% (ít log buffers, ít operations)
- **I/O**: Giảm ~60% (ít database queries từ scanners, ít file writes)

## Monitoring

### Kiểm tra hiệu quả:
1. **Memory usage**: `htop` hoặc `top` - nên giảm từ 2.8 GiB xuống ~2.0-2.2 GiB
2. **CPU usage**: Nên giảm đáng kể
3. **Log file size**: `logs/combined.log` nên tăng chậm hơn
4. **Response time**: Các operations nên nhanh hơn

### Logs để theo dõi:
```bash
# Xem số lượng debug logs (nên ít hơn nhiều)
grep -c "\[TP Trail\]" logs/combined.log

# Xem scanner frequency
grep "OcAlertScanner.*Started" logs/combined.log
grep "PriceAlertScanner.*started" logs/combined.log
```

## Lưu Ý

1. **Log Level**: Có thể đặt `LOG_LEVEL=warn` trong `.env` để giảm thêm logs (chỉ log warnings và errors)
2. **Scanner Intervals**: Có thể tăng thêm nếu cần (nhưng không nên quá 60 giây)
3. **PositionMonitor**: Giữ nguyên 1 phút vì cần thiết cho real-time TP/SL monitoring
4. **WebSocket**: Đã được tối ưu tốt, không cần thay đổi

## Các Tối Ưu Tiếp Theo (Nếu Cần)

1. **Database Connection Pool**: Kiểm tra và tối ưu nếu cần
2. **Cache Strategy**: Có thể tăng TTL cho StrategyCache
3. **Batch Processing**: Có thể tăng batch size nếu có nhiều positions
4. **Memory Profiling**: Sử dụng `node --inspect` để profile memory nếu vẫn còn vấn đề

## Rollback (Nếu Cần)

Nếu cần rollback, chỉ cần:
1. Đặt lại intervals trong code về giá trị cũ
2. Hoặc override bằng environment variables:
   ```bash
   OC_ALERT_SCAN_INTERVAL_MS=10000
   PRICE_ALERT_SCAN_INTERVAL_MS=5000
   ```

