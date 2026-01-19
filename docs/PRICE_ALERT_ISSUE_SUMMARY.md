# Tóm tắt Vấn đề Price Alert MEXC và Binance

## 🔍 Nguyên nhân chính

### ❌ **VẤN ĐỀ 1: WebSocket không kết nối**

**Từ diagnostic script:**
```
MEXC WebSocket: ❌ Not Connected
  - ReadyState: null
  - Subscribed symbols: 0
  
Binance WebSocket: ❌ Not Connected
  - Connected streams: 0
  - Subscribed symbols: 0
```

**Nguyên nhân:**
- WebSocket không được kết nối khi PriceAlertWorker chạy
- `ensureConnected()` và `connect()` được gọi nhưng connection không thành công
- Không có price data từ WebSocket → PriceAlertScanner không thể detect OC chính xác

**Giải pháp:**
1. Kiểm tra logs WebSocket connection errors
2. Đảm bảo WebSocket được connect trước khi subscribe symbols
3. Thêm retry logic cho WebSocket connection

### ⚠️ **VẤN ĐỀ 2: OC không đạt threshold**

**Từ logs:**
```
[PriceAlertScanner] 🔍 Threshold check | BINANCE SANDUSDT 1m OC=0.25% threshold=3.00% (OC < threshold ❌)
[PriceAlertScanner] 🔍 Threshold check | BINANCE FHEUSDT 1m OC=0.33% threshold=3.00% (OC < threshold ❌)
```

**Nguyên nhân:**
- Market không có biến động lớn
- Tất cả OC đều < 3% (threshold)
- Đây là behavior đúng, không phải bug

**Giải pháp:**
- Test với threshold 1% để verify alert system hoạt động
- Hoặc chờ market có volatility cao hơn

### ⚠️ **VẤN ĐỀ 3: RealtimeOCDetector chạy song song**

**Từ logs:**
```
[RealtimeOCDetector] 🔍 OC bucket debug | BINANCE CELOUSDT 1m OC=-0.74% ...
[RealtimeOCDetector] 🔍 OC bucket debug | BINANCE FLOWUSDT 1m OC=-1.04% ...
```

**Vấn đề:**
- RealtimeOCDetector (WebSocket-based) đang chạy song song với PriceAlertScanner (polling-based)
- Có thể gây duplicate processing
- Config: `PRICE_ALERT_USE_WEBSOCKET=false` nhưng RealtimeOCDetector vẫn chạy

**Giải pháp:**
- Kiểm tra tại sao RealtimeOCDetector vẫn chạy khi `PRICE_ALERT_USE_WEBSOCKET=false`
- Hoặc disable RealtimeOCDetector nếu chỉ dùng PriceAlertScanner

## ✅ Những gì đang hoạt động

1. ✅ **Config flags**: Tất cả đều enabled
2. ✅ **Telegram bot tokens**: Đã được config
3. ✅ **Price Alert configs**: 2 active configs (MEXC và Binance)
4. ✅ **Symbol tracking**: 200 symbols mỗi exchange
5. ✅ **PriceAlertScanner**: Đang chạy và detect OC
6. ✅ **Threshold check**: Logic hoạt động đúng

## 🚀 Giải pháp đề xuất

### Priority 1: Fix WebSocket Connection

**Vấn đề:** WebSocket không connected → không có price data

**Fix:**
1. Kiểm tra logs WebSocket connection errors
2. Đảm bảo `ensureConnected()` được gọi trước khi subscribe
3. Thêm retry logic và better error handling
4. Kiểm tra WebSocket URL và connection parameters

### Priority 2: Test với Lower Threshold

**Vấn đề:** OC không đạt threshold 3%

**Fix:**
1. Tạm thời giảm threshold xuống 1% để test
2. Verify alert system hoạt động
3. Sau đó tăng lại threshold về 3%

### Priority 3: Fix RealtimeOCDetector Conflict

**Vấn đề:** RealtimeOCDetector chạy song song với PriceAlertScanner

**Fix:**
1. Kiểm tra tại sao RealtimeOCDetector vẫn chạy khi `PRICE_ALERT_USE_WEBSOCKET=false`
2. Disable RealtimeOCDetector nếu chỉ dùng PriceAlertScanner
3. Hoặc đảm bảo không có duplicate alerts

## 📝 Next Steps

1. **Kiểm tra WebSocket connection logs:**
   ```bash
   grep -E "MEXC-WS|Binance-WS|WebSocket.*connect" logs/combined.log | tail -n 50
   ```

2. **Test với lower threshold:**
   ```sql
   UPDATE price_alert_config SET threshold = 1.0 WHERE is_active = 1;
   ```

3. **Monitor logs realtime:**
   ```bash
   tail -f logs/combined.log | grep -E "(Threshold met|Sending alert|WebSocket.*connect)"
   ```

4. **Kiểm tra WebSocket status trong runtime:**
   - MEXC: `mexcPriceWs.getStatus()`
   - Binance: `webSocketManager.getStatus()`

