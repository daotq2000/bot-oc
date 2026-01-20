# OC Scanning Fix Summary

## ✅ Đã Hoàn Thành

### 1. Giảm maxStreamsPerConn xuống 30
- **File**: `src/services/WebSocketManager.js`
- **Thay đổi**: Giảm từ 50 xuống 30 streams/connection
- **Lý do**: Giảm message rate và event loop backlog để tối ưu OC scanning
- **Kỳ vọng**: ~30-60 messages/second per connection thay vì ~50-100

### 2. Thêm Monitoring Cho OC Scanning
- **File**: `src/consumers/WebSocketOCConsumer.js`
- **Thêm**:
  - Stats tracking: `ticksReceived`, `ticksProcessed`, `ticksDropped`, `matchesFound`, `matchesProcessed`
  - Queue monitoring: `queueSize`, `maxQueueSize`
  - Performance metrics: `avgProcessingTime`, `timeSinceLastTick`, `timeSinceLastProcessed`, `timeSinceLastMatch`
  - Periodic logging mỗi 1 phút với đầy đủ thông tin
- **Lợi ích**: Có thể theo dõi real-time xem OC scanning có hoạt động không

### 3. Health Check Endpoint Chi Tiết
- **File**: `src/app.js`
- **Endpoint**: `GET /health/detailed`
- **Thông tin trả về**:
  - Status tổng thể (ok/degraded/error)
  - Uptime, memory usage
  - WebSocket OC Consumer stats
  - WebSocket Manager status
  - Price Alert Worker status
  - Position Sync status
- **Lợi ích**: Có thể monitor từ bên ngoài qua HTTP API

### 4. Health Check Script
- **File**: `scripts/check-health.sh`
- **Usage**: `./scripts/check-health.sh [port]`
- **Tính năng**:
  - Kiểm tra health endpoint
  - Parse và hiển thị thông tin chi tiết
  - Cảnh báo nếu có vấn đề (no ticks > 60s, queue > 1000, no WS connections)
- **Lợi ích**: Dễ dàng kiểm tra từ command line

## 📊 Cách Sử Dụng

### Kiểm tra Health qua API:
```bash
curl http://localhost:3000/health/detailed | jq
```

### Kiểm tra Health qua Script:
```bash
./scripts/check-health.sh 3000
```

### Xem OC Scan Stats trong Log:
```bash
tail -f logs/combined.log | grep "OC Scan Stats"
```

## 🔍 Monitoring OC Scanning

### Các chỉ số quan trọng:
1. **ticksReceived**: Số lượng ticks nhận được từ WebSocket
2. **ticksProcessed**: Số lượng ticks đã xử lý
3. **matchesFound**: Số lượng matches tìm thấy
4. **queueSize**: Kích thước queue đang chờ xử lý
5. **timeSinceLastTick**: Thời gian từ lần nhận tick cuối cùng (nếu > 60s = có vấn đề)
6. **timeSinceLastProcessed**: Thời gian từ lần xử lý cuối cùng
7. **avgProcessingTime**: Thời gian xử lý trung bình

### Dấu hiệu có vấn đề:
- `timeSinceLastTick > 60000` (1 phút): Không nhận được ticks từ WebSocket
- `queueSize > 1000`: Queue quá lớn, xử lý không kịp
- `ticksReceived > 0` nhưng `ticksProcessed = 0`: Có ticks nhưng không xử lý được
- `matchesFound > 0` nhưng `matchesProcessed = 0`: Tìm thấy matches nhưng không process được

## 🚀 Next Steps

1. **Restart bot** để áp dụng các thay đổi
2. **Monitor logs** để xem OC Scan Stats mỗi phút
3. **Kiểm tra health endpoint** định kỳ để đảm bảo bot hoạt động tốt
4. **Điều chỉnh** `maxStreamsPerConn` nếu cần (có thể giảm xuống 20 nếu vẫn còn latency cao)

## 📝 Notes

- Monitoring sẽ log mỗi 1 phút với đầy đủ thông tin
- Health endpoint có thể được gọi từ monitoring tools (Prometheus, Grafana, etc.)
- Script `check-health.sh` yêu cầu `jq` để parse JSON (có thể cài: `sudo apt install jq`)

