# Startup CPU Optimization

**Ngày:** 2025-12-23  
**Vấn đề:** Bot sử dụng 22-23 CPU cores khi khởi động  
**Giải pháp:** Delay và sequential processing để giảm CPU spike

---

## Vấn Đề

Khi khởi động, bot thực hiện nhiều tác vụ đồng thời:
- Initialize nhiều bots cùng lúc
- Load markets cho mỗi exchange
- Initialize WebSocket connections
- Load configs và symbols
- Initialize multiple workers

→ Gây CPU spike (22-23 cores)

---

## Giải Pháp Đã Áp Dụng

### 1. ✅ Sequential Bot Initialization với Delay

**Trước:** Tất cả bots được initialize song song  
**Sau:** Initialize tuần tự với delay giữa mỗi bot

**Files đã fix:**
- `src/jobs/PositionSync.js` - Delay 500ms giữa các bots
- `src/workers/StrategiesWorker.js` - Delay 800ms giữa các bots
- `src/jobs/BalanceManager.js` - Delay 600ms giữa các bots
- `src/jobs/PositionMonitor.js` - Delay 600ms giữa các bots
- `src/jobs/EntryOrderMonitor.js` - Delay 600ms giữa các bots

### 2. ✅ Defer Non-Critical Operations

**Trước:** Tất cả operations chạy ngay khi startup  
**Sau:** Delay các operations không critical

**Changes:**
- **Symbol filters update**: Delay 10s (Binance), 15s (MEXC)
- **Telegram bot**: Delay 2s
- **Price Alert Worker**: Delay 3s
- **Strategies Worker**: Delay 5s
- **Symbols Updater**: Delay 7s
- **Position Sync**: Delay 8s

### 3. ✅ Sequential Worker Initialization

**PriceAlertWorker:**
- Delay 300ms giữa symbol tracker refresh và scanner init
- Delay 300ms giữa PriceAlertScanner và OcAlertScanner
- Delay 500ms trước WebSocket subscriptions

**StrategiesWorker:**
- Delay 500ms giữa mỗi component initialization
- Sequential bot initialization với delay 800ms

**PriceAlertScanner:**
- Sequential exchange initialization với delay 500ms

---

## Startup Sequence (Mới)

```
0s:    Database connection
0s:    Load configs
0s:    Exchange info service (load from DB)
1s:    Telegram service
2s:    Telegram bot (deferred)
3s:    WebSocket managers
3s:    Price Alert Worker (deferred)
5s:    Strategies Worker (deferred)
7s:    Symbols Updater (deferred)
8s:    Position Sync (deferred)
10s:   Binance filters update (deferred)
15s:   MEXC filters update (deferred)
```

---

## Kết Quả Mong Đợi

### CPU Usage
- **Trước:** 22-23 CPU cores (100% spike)
- **Sau:** < 5 CPU cores (distributed over time)

### Startup Time
- **Trước:** ~5-10 giây (intensive)
- **Sau:** ~15-20 giây (smooth, distributed)

### Memory
- **Trước:** High memory spike
- **Sau:** Gradual memory increase

---

## Files Đã Được Fix

1. **src/app.js**
   - Defer non-critical operations
   - Add delays between worker initializations

2. **src/jobs/PositionSync.js**
   - Sequential bot initialization với delay

3. **src/workers/StrategiesWorker.js**
   - Sequential bot initialization với delay
   - Delay giữa các component initializations

4. **src/workers/PriceAlertWorker.js**
   - Delay giữa các initialization steps

5. **src/jobs/PriceAlertScanner.js**
   - Sequential exchange initialization với delay

6. **src/jobs/BalanceManager.js**
   - Sequential bot initialization với delay

7. **src/jobs/PositionMonitor.js**
   - Sequential bot initialization với delay

8. **src/jobs/EntryOrderMonitor.js**
   - Sequential bot initialization với delay

---

## Configuration

Có thể điều chỉnh delays thông qua config nếu cần:

```javascript
// Có thể thêm vào app_configs nếu cần
STARTUP_BOT_INIT_DELAY_MS = 500-800  // Delay giữa bot initializations
STARTUP_WORKER_DELAY_MS = 2000-5000  // Delay giữa worker initializations
```

---

## Monitoring

### Kiểm Tra CPU Usage:
```bash
# Monitor CPU during startup
top -p $(pgrep -f "node.*app.js")
# hoặc
htop -p $(pgrep -f "node.*app.js")
```

### Kiểm Tra Startup Time:
```bash
# Check logs for initialization times
grep "Initializing\|started successfully" logs/combined.log | head -20
```

---

## Notes

- Tất cả delays được tính toán để đảm bảo:
  - Critical services start first
  - Non-critical services start after
  - CPU load được distribute over time
  - Không ảnh hưởng đến functionality

- Có thể điều chỉnh delays nếu cần:
  - Tăng delay nếu CPU vẫn cao
  - Giảm delay nếu startup quá chậm

