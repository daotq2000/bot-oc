# Rate Limit & IP Ban Fix

## Vấn đề
- Update position bị rate limit rất nhiều
- Bị banned IP nên không thể tracking được vị thế
- Quá nhiều REST API calls khi có nhiều positions

## Giải pháp đã implement

### 1. Exponential Backoff cho 429 Errors ✅
- **File**: `src/services/BinanceDirectClient.js`
- **Thay đổi**: 
  - Detect 429 (Too Many Requests) errors
  - Exponential backoff: 1s, 2s, 4s (với jitter)
  - Update `lastRequestTime` để tránh request ngay sau backoff
- **Kết quả**: Tự động retry với delays tăng dần khi gặp rate limit

### 2. Tăng Rate Limiting Intervals ✅
- **File**: `src/services/BinanceDirectClient.js`
- **Thay đổi**:
  - Market data min interval: 100ms → 200ms (configurable)
  - REST price fallback cooldown: 5s → 10s (configurable)
- **Kết quả**: Giảm số lượng requests/second

### 3. Tối Ưu PositionMonitor Processing ✅
- **File**: `src/jobs/PositionMonitor.js`
- **Thay đổi**:
  - Batch size: 5 → 3 (giảm parallel processing)
  - Batch delay: 500ms → 2000ms (tăng delay giữa batches)
  - **Quan trọng**: Xử lý positions **tuần tự** thay vì parallel
  - Thêm delay 500ms giữa mỗi position (configurable)
- **Kết quả**: Giảm burst requests, tránh rate limit

### 4. Đảm Bảo WebSocket Subscriptions ✅
- **File**: `src/jobs/PositionMonitor.js`
- **Thay đổi**:
  - Tự động subscribe WebSocket cho tất cả position symbols (Binance)
  - Đảm bảo giá được lấy từ WebSocket cache thay vì REST API
- **Kết quả**: Giảm REST API calls, sử dụng WebSocket real-time data

### 5. WebSocket-First Strategy ✅
- **File**: `src/services/BinanceDirectClient.js`
- **Logic hiện tại**:
  1. Ưu tiên WebSocket cache (không có rate limit)
  2. Chỉ fallback REST nếu WebSocket không có giá
  3. REST fallback có cooldown 10 giây
- **Kết quả**: Hầu hết requests sử dụng WebSocket, ít REST calls

## Cấu Hình Mới

### Environment Variables
```bash
# Rate limiting
BINANCE_MARKET_DATA_MIN_INTERVAL_MS=200        # Min interval giữa market data requests (200ms)
BINANCE_REST_PRICE_COOLDOWN_MS=10000           # Cooldown cho REST fallback (10s)
BINANCE_MIN_REQUEST_INTERVAL_MS=100             # Min interval cho trading requests (100ms)

# Position Monitor
POSITION_MONITOR_BATCH_SIZE=3                   # Số positions xử lý mỗi batch (giảm từ 5)
POSITION_MONITOR_BATCH_DELAY_MS=2000           # Delay giữa batches (tăng từ 500ms)
POSITION_MONITOR_POSITION_DELAY_MS=500         # Delay giữa mỗi position (mới)

# WebSocket fallback
BINANCE_TICKER_REST_FALLBACK=false             # Tắt REST fallback (chỉ dùng WebSocket)
```

## Ước Tính Cải Thiện

### Trước khi fix:
- **10 positions**: 10 REST calls/phút × 60 = 600 calls/giờ
- **Batch processing**: 5 positions parallel = burst requests
- **No backoff**: Retry ngay khi gặp 429 → bị ban IP
- **REST fallback**: 5s cooldown → vẫn có thể bị rate limit

### Sau khi fix:
- **10 positions**: 
  - WebSocket cache: ~0 REST calls (nếu subscriptions đúng)
  - REST fallback: Chỉ khi WebSocket miss, cooldown 10s
  - Sequential processing: 1 position/500ms = 2 positions/giây
  - Batch delay: 2s giữa batches
- **Estimated**: Giảm 80-90% REST API calls

## Monitoring

### Kiểm tra WebSocket subscriptions:
```bash
# Xem logs để đảm bảo WebSocket được subscribe
grep "WebSocket subscriptions" logs/combined.log
grep "Binance-WS.*subscribe" logs/combined.log
```

### Kiểm tra rate limit errors:
```bash
# Xem có 429 errors không
grep "429\|Rate limit\|Too Many Requests" logs/error.log

# Xem backoff retries
grep "Rate limit.*Waiting" logs/combined.log
```

### Kiểm tra REST fallback usage:
```bash
# Xem có dùng REST fallback không (nên ít)
grep "REST fallback price" logs/combined.log
```

## Lưu Ý Quan Trọng

1. **WebSocket Subscriptions**: 
   - Đảm bảo `WebSocketOCConsumer` subscribe đúng symbols
   - PositionMonitor tự động subscribe thêm position symbols
   - Nếu WebSocket không có giá → skip update (tránh REST call)

2. **Sequential Processing**:
   - Positions được xử lý tuần tự (không parallel)
   - Delay 500ms giữa mỗi position
   - Delay 2s giữa batches
   - **Kết quả**: Chậm hơn nhưng an toàn hơn

3. **Exponential Backoff**:
   - Khi gặp 429: đợi 1s, 2s, 4s trước khi retry
   - Tự động update `lastRequestTime` để tránh request ngay sau backoff
   - **Kết quả**: Tự động recover khi rate limit được giải phóng

4. **REST Fallback**:
   - Chỉ dùng khi WebSocket không có giá
   - Cooldown 10 giây cho mỗi symbol
   - Có thể tắt hoàn toàn bằng `BINANCE_TICKER_REST_FALLBACK=false`

## Troubleshooting

### Vẫn bị rate limit?
1. Kiểm tra WebSocket subscriptions có đúng không
2. Tăng `POSITION_MONITOR_POSITION_DELAY_MS` lên 1000ms
3. Tăng `POSITION_MONITOR_BATCH_DELAY_MS` lên 5000ms
4. Giảm `POSITION_MONITOR_BATCH_SIZE` xuống 2
5. Tắt REST fallback: `BINANCE_TICKER_REST_FALLBACK=false`

### WebSocket không có giá?
1. Kiểm tra WebSocket connections: `grep "Binance-WS.*Connected" logs/combined.log`
2. Đảm bảo symbols được subscribe: `grep "subscribe.*symbols" logs/combined.log`
3. Kiểm tra WebSocketOCConsumer có chạy không

### Positions update chậm?
- Đây là trade-off để tránh rate limit
- Có thể giảm delays nếu không bị rate limit
- Nhưng nên giữ sequential processing

## Rollback (Nếu Cần)

Nếu cần rollback về behavior cũ:
```bash
POSITION_MONITOR_BATCH_SIZE=5
POSITION_MONITOR_BATCH_DELAY_MS=500
POSITION_MONITOR_POSITION_DELAY_MS=0
BINANCE_MARKET_DATA_MIN_INTERVAL_MS=100
BINANCE_REST_PRICE_COOLDOWN_MS=5000
```

Và revert code về parallel processing trong PositionMonitor.

