# Fix OC Detection - REST API Fallback

## 🔴 Vấn Đề

Hệ thống không detect được coins có biến động > 3% vì:
- **Open price không chính xác**: Đang dùng `binance_ws_prev_close` làm fallback
- **OC tính sai**: Khi bucket mới bắt đầu, WebSocket chưa có kline data → dùng prev_close → OC = 0%

## ✅ Giải Pháp Đã Implement

### 1. Thêm REST API Fallback

**File:** `src/services/RealtimeOCDetector.js` - `getAccurateOpen()`

**Thay đổi:**
- Thêm step 3: Fetch từ REST API khi WebSocket không có data
- Chỉ dùng `prev_close` như LAST RESORT (step 4)
- Log warning khi dùng prev_close

**Logic mới:**
```javascript
// 1) Best: exact bucket open from WS
// 2) Latest candle open (if matches bucketStart)
// 3) NEW: Fetch from REST API (more accurate than prev_close)
// 4) LAST RESORT: prev_close (with warning)
```

### 2. REST API Implementation

**Method:** Fetch klines từ Binance public endpoint
- Endpoint: `/fapi/v1/klines`
- No auth required (public data)
- Fetch 2 candles để ensure có data cần thiết
- Match exact bucketStart hoặc use latest nếu close enough

### 3. Logging Improvements

- Log khi fetch từ REST API thành công
- Warning khi phải dùng prev_close
- Debug logs để track source của open price

## 📊 Expected Results

### Before:
- Source: mostly `binance_ws_prev_close`
- OC detection: ~0-1% (sai)
- Missed alerts: nhiều coins > 3% không detect được

### After:
- Source: `binance_rest_api` hoặc `binance_ws_bucket_open`
- OC detection: chính xác hơn
- Better alerts: detect được coins > 3% chính xác hơn

## 🔍 Monitoring

Check logs để verify fix:
```bash
# Check REST API usage
grep "Fetched open from REST API" logs/combined.log | tail -20

# Check source distribution
grep "source=" logs/combined.log | awk -F'source=' '{print $2}' | sort | uniq -c

# Check OC values
grep "oc=" logs/combined.log | grep -E "oc=[3-9]\." | head -20
```

## ⚠️ Notes

- REST API có rate limit (1200 req/min)
- Cache được sử dụng để giảm API calls
- Fallback về prev_close vẫn có nhưng với warning

