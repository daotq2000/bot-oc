# Monitoring Guide - OC Scanning & Health Check

## ✅ Đã Hoàn Thành

### 1. Giảm maxStreamsPerConn xuống 20
- **File**: `src/services/WebSocketManager.js`
- **Thay đổi**: Giảm từ 30 xuống 20 streams/connection
- **Lý do**: Tối ưu tối đa cho OC scanning và giảm latency
- **Kỳ vọng**: ~20-40 messages/second per connection

### 2. Script Monitor OC Scan Real-time
- **File**: `scripts/monitor-oc-scan.sh`
- **Usage**: `./scripts/monitor-oc-scan.sh [port] [interval_seconds]`
- **Tính năng**:
  - Hiển thị health status real-time
  - Hiển thị OC Scan Stats từ logs
  - Hiển thị warnings/errors gần đây
  - Auto-refresh mỗi 60 giây (có thể tùy chỉnh)

### 3. Script Monitor Health Định Kỳ
- **File**: `scripts/monitor-health-periodic.sh`
- **Usage**: `./scripts/monitor-health-periodic.sh [port] [interval_minutes] [output_file]`
- **Tính năng**:
  - Log health check định kỳ vào file
  - Mặc định: mỗi 5 phút, log vào `logs/health-monitor.log`
  - Có thể chạy background để monitor lâu dài

## 📊 Cách Sử Dụng

### 1. Monitor Real-time (Interactive)
```bash
# Monitor với interval mặc định 60s
./scripts/monitor-oc-scan.sh

# Monitor với interval tùy chỉnh (30s)
./scripts/monitor-oc-scan.sh 3000 30
```

### 2. Monitor Định Kỳ (Background)
```bash
# Chạy background với interval mặc định 5 phút
nohup ./scripts/monitor-health-periodic.sh > /dev/null 2>&1 &

# Hoặc với interval tùy chỉnh (10 phút)
nohup ./scripts/monitor-health-periodic.sh 3000 10 logs/health-10min.log > /dev/null 2>&1 &

# Xem log
tail -f logs/health-monitor.log
```

### 3. Kiểm tra Health Endpoint Trực Tiếp
```bash
# Kiểm tra một lần
curl http://localhost:3000/health/detailed | jq

# Hoặc dùng script check-health.sh
./scripts/check-health.sh 3000
```

### 4. Xem OC Scan Stats trong Logs
```bash
# Xem stats gần đây
tail -f logs/combined.log | grep "OC Scan Stats"

# Xem stats với context
tail -f logs/combined.log | grep -A 2 "OC Scan Stats"
```

## 🔍 Các Chỉ Số Quan Trọng

### OC Scan Stats (mỗi phút trong log)
- **ticksReceived**: Số ticks nhận được từ WebSocket
- **ticksProcessed**: Số ticks đã xử lý
- **matchesFound**: Số matches tìm thấy
- **queueSize**: Kích thước queue đang chờ xử lý
- **timeSinceLastTick**: Thời gian từ lần nhận tick cuối cùng
- **avgProcessingTime**: Thời gian xử lý trung bình

### Health Endpoint Metrics
- **status**: ok/degraded/error
- **uptime**: Thời gian bot đã chạy (giây)
- **memory**: Heap used/total/RSS (MB)
- **modules**: Trạng thái các module (PriceAlertWorker, PositionSync, WebSocketOC, WebSocketManager)

## ⚠️ Dấu Hiệu Có Vấn Đề

### 1. OC Scanning Không Hoạt Động
- `timeSinceLastTick > 60000` (1 phút): Không nhận được ticks từ WebSocket
- `ticksReceived = 0`: Không có ticks nào được nhận
- `queueSize` tăng liên tục: Xử lý không kịp

### 2. WebSocket Issues
- `connections = 0`: Không có WebSocket connections active
- `reconnectQueue.size > 10`: Nhiều connections đang reconnect
- `tickQueue.size > 1000`: Tick queue quá lớn

### 3. Performance Issues
- `avgProcessingTime > 100ms`: Xử lý chậm
- `memory.used > 2000MB`: Memory usage cao
- `status = degraded`: Bot đang gặp vấn đề

## 🚀 Best Practices

### 1. Monitor Thường Xuyên
- Chạy `monitor-health-periodic.sh` trong background để log định kỳ
- Kiểm tra `logs/health-monitor.log` mỗi ngày
- Xem OC Scan Stats trong `logs/combined.log` mỗi giờ

### 2. Alert Setup (Tùy Chọn)
Có thể setup cron job để alert khi có vấn đề:
```bash
# Kiểm tra mỗi 10 phút và alert nếu có vấn đề
*/10 * * * * /path/to/check-health.sh 3000 | grep -q "WARNING" && echo "Bot issue detected" | mail -s "Bot Alert" admin@example.com
```

### 3. Log Rotation
Đảm bảo log rotation để không đầy disk:
```bash
# Thêm vào logrotate config
/path/to/bot-oc/logs/*.log {
    daily
    rotate 7
    compress
    missingok
    notifempty
}
```

## 📝 Notes

- **maxStreamsPerConn = 20**: Đã được giảm để tối ưu latency
- **OC Scan Stats**: Log mỗi 1 phút trong `combined.log`
- **Health Endpoint**: Có thể được gọi từ monitoring tools (Prometheus, Grafana, etc.)
- **Scripts**: Yêu cầu `jq` để parse JSON (cài: `sudo apt install jq`)

## 🔧 Troubleshooting

### Nếu Health Endpoint không khả dụng:
1. Kiểm tra bot có đang chạy: `ps aux | grep node`
2. Kiểm tra port: `netstat -tlnp | grep 3000`
3. Restart bot nếu cần

### Nếu không thấy OC Scan Stats:
1. Bot cần restart để áp dụng code mới
2. Kiểm tra `isRunning` trong health endpoint
3. Kiểm tra logs để xem có lỗi không

### Nếu latency vẫn cao:
1. Giảm `maxStreamsPerConn` xuống 15 hoặc 10
2. Kiểm tra network connection
3. Kiểm tra CPU/memory usage
4. Xem log để tìm bottleneck

