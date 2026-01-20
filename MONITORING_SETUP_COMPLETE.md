# ✅ Monitoring Setup Complete

## Đã Hoàn Thành Tất Cả Các Bước

### 1. ✅ Giảm maxStreamsPerConn xuống 20
- **File**: `src/services/WebSocketManager.js`
- **Giá trị mới**: `maxStreamsPerConn = 20`
- **Lý do**: Tối ưu tối đa cho OC scanning và giảm latency
- **Kỳ vọng**: ~20-40 messages/second per connection

### 2. ✅ Monitor Logs để xem OC Scan Stats mỗi phút
- **Log location**: `logs/combined.log`
- **Pattern**: `OC Scan Stats`
- **Frequency**: Mỗi 1 phút
- **Script**: `scripts/monitor-oc-scan.sh` (real-time interactive)

### 3. ✅ Kiểm tra Health Endpoint Định Kỳ
- **Endpoint**: `GET /health/detailed`
- **Scripts**:
  - `scripts/check-health.sh` - One-time check
  - `scripts/monitor-health-periodic.sh` - Periodic logging
  - `scripts/monitor-oc-scan.sh` - Real-time interactive

## 🚀 Quick Start

### Monitor Real-time (Interactive)
```bash
./scripts/monitor-oc-scan.sh
```

### Monitor Định Kỳ (Background)
```bash
# Chạy background, log mỗi 5 phút
nohup ./scripts/monitor-health-periodic.sh > /dev/null 2>&1 &

# Xem log
tail -f logs/health-monitor.log
```

### Kiểm tra Health Một Lần
```bash
curl http://localhost:3000/health/detailed | jq
# Hoặc
./scripts/check-health.sh
```

### Xem OC Scan Stats trong Logs
```bash
tail -f logs/combined.log | grep "OC Scan Stats"
```

## 📊 Các Chỉ Số Cần Monitor

### OC Scan Stats (mỗi phút)
- `ticksReceived` - Số ticks nhận được
- `ticksProcessed` - Số ticks đã xử lý
- `matchesFound` - Số matches tìm thấy
- `queueSize` - Kích thước queue
- `timeSinceLastTick` - Thời gian từ tick cuối (nếu > 60s = có vấn đề)

### Health Endpoint
- `status` - ok/degraded/error
- `modules.webSocketOC` - OC Consumer stats
- `modules.webSocketManager` - WS Manager stats
- `modules.priceAlertWorker` - Price Alert status
- `modules.positionSync` - Position Sync status

## ⚠️ Dấu Hiệu Có Vấn Đề

1. **OC Scanning không hoạt động**:
   - `timeSinceLastTick > 60000` (1 phút)
   - `ticksReceived = 0`
   - `queueSize` tăng liên tục

2. **WebSocket Issues**:
   - `connections = 0`
   - `reconnectQueue.size > 10`
   - `tickQueue.size > 1000`

3. **Performance Issues**:
   - `avgProcessingTime > 100ms`
   - `memory.used > 2000MB`
   - `status = degraded`

## 📝 Next Steps

1. **Restart bot** để áp dụng `maxStreamsPerConn = 20`
2. **Chạy monitor script** để theo dõi real-time
3. **Kiểm tra logs** sau khi restart để xem OC Scan Stats
4. **Monitor health endpoint** định kỳ để đảm bảo bot hoạt động tốt

## 📚 Documentation

- Chi tiết: `MONITORING_GUIDE.md`
- OC Scanning Fix: `OC_SCANNING_FIX_SUMMARY.md`

