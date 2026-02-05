# Fix Timeout (-1007) và Rate Limit khi đặt TP/SL

## 📋 Tóm tắt vấn đề

Từ log error, có 2 vấn đề chính:
1. **Error -1007**: "Timeout waiting for response from backend server" - Binance backend bị quá tải
2. **Error -4120**: "Order type not supported for this endpoint" - Một số symbol không hỗ trợ TAKE_PROFIT_MARKET/STOP_MARKET

Nguyên nhân gốc:
- Quá nhiều API calls đồng thời khi cập nhật TP/SL cho nhiều positions
- Request interval quá ngắn (125ms unsigned, 150ms signed)
- Không có cơ chế throttling khi Binance backend bị quá tải

## 🔧 Các thay đổi chính

### 1. BinanceRequestScheduler - Adaptive Throttling

**File**: `src/services/BinanceRequestScheduler.js`

**Thay đổi**:
- Tăng interval mặc định: 125ms → 200ms (unsigned), 150ms → 250ms (signed)
- Thêm **Adaptive Throttling**: Tự động tăng interval khi gặp timeout
  - Đếm số lỗi timeout trong 1 phút
  - Nếu >= 3 lỗi → tăng throttle multiplier (1.5x, 2x, ... max 4x)
  - Sau 30s không có lỗi → giảm dần throttle
- Thêm **Timeout Circuit Breaker**: Block tất cả requests 15s khi quá nhiều timeout
  - Kích hoạt khi throttle đạt max (4x)
  - Tự động mở lại sau cooldown

**Config mới**:
```
BINANCE_TIMEOUT_WINDOW_MS=60000       # Window đếm timeout errors (1 phút)
BINANCE_TIMEOUT_THRESHOLD=3           # Số lỗi để trigger throttle
BINANCE_MAX_THROTTLE_MULTIPLIER=4     # Max throttle (4x = 800ms intervals)
BINANCE_THROTTLE_DECAY_MS=30000       # Decay sau 30s không có lỗi
BINANCE_TIMEOUT_CIRCUIT_COOLDOWN_MS=15000  # Block 15s khi circuit mở
```

### 2. BinanceDirectClient - Error Classification

**File**: `src/services/BinanceDirectClient.js`

**Thay đổi**:
- Cập nhật interval defaults: 125ms → 200ms, 150ms → 250ms
- Thông báo scheduler khi gặp timeout (-1007, network timeout)
- Thêm -4120 (Order type not supported) vào non-retryable errors để tránh retry vô ích

### 3. PositionService - TP/SL Update Throttling

**File**: `src/services/PositionService.js`

**Thay đổi**:
- Skip position update nếu timeout circuit breaker đang mở
- Track các positions bị lỗi TP/SL nhiều lần
- Backoff 30s sau 3 lần thất bại liên tiếp

**Config mới**:
```
TP_SL_UPDATE_DELAY_MS=500      # Delay giữa các TP/SL updates
TP_SL_UPDATE_BATCH_SIZE=3      # Xử lý 3 positions cùng lúc
TP_SL_MAX_RETRIES=3            # Max retries cho TP/SL update
TP_SL_RETRY_BACKOFF_MS=30000   # Backoff 30s sau max retries
```

### 4. ExitOrderManager - Circuit Breaker Integration

**File**: `src/services/ExitOrderManager.js`

**Thay đổi**:
- Kiểm tra timeout circuit breaker trước khi đặt/hủy order
- Skip operations khi Binance backend đang quá tải
- Report timeout errors cho scheduler

## 📊 Stats mới trong log

```
[BinanceScheduler] qMain=5 qTest=0 processed=100 (main=95, test=5) signed=80 unsigned=20 timeouts=2 throttle=1.5x circuit=closed
```

- `timeouts`: Số lỗi timeout
- `throttle`: Multiplier hiện tại (1x = bình thường, 4x = max)
- `circuit`: Trạng thái timeout circuit breaker (closed/OPEN)

## 🚀 Deployment

1. Restart bot để áp dụng thay đổi
2. Theo dõi log để xem throttle stats
3. Nếu vẫn gặp timeout, có thể tăng:
   - `BINANCE_REQUEST_INTERVAL_MS=300` (300ms = ~3 req/sec)
   - `BINANCE_SIGNED_REQUEST_INTERVAL_MS=400` (400ms = ~2.5 req/sec)

## 📈 Expected Results

- Giảm đáng kể lỗi -1007 timeout
- Tự động điều chỉnh tốc độ request khi Binance bị quá tải
- Position updates vẫn hoạt động ngay cả khi Binance chậm (sẽ retry sau khi circuit đóng)
- Không còn spam API khi có lỗi liên tục
