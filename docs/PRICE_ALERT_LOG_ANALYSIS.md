# Phân tích Logs Price Alert

## 📊 Kết quả phân tích logs

### ✅ Hệ thống đang hoạt động:
1. **PriceAlertScanner đang chạy**: Detect OC cho nhiều symbols
2. **WebSocket đã subscribe**: MEXC=749 symbols, Binance=541 symbols
3. **Threshold check đang hoạt động**: Logs cho thấy threshold check được thực hiện

### ❌ Vấn đề phát hiện:

#### 1. **OC không đạt threshold (3%)**
**Từ logs:**
```
[PriceAlertScanner] 🔍 Threshold check | BINANCE SANDUSDT 1m OC=0.25% threshold=3.00% (OC < threshold ❌)
[PriceAlertScanner] 🔍 Threshold check | BINANCE XMRUSDT 1m OC=0.05% threshold=3.00% (OC < threshold ❌)
[PriceAlertScanner] 🔍 Threshold check | BINANCE FHEUSDT 1m OC=0.33% threshold=3.00% (OC < threshold ❌)
```

**Nguyên nhân**: Market không có biến động lớn, tất cả OC đều < 3%

**Giải pháp**: 
- Giảm threshold xuống 1-2% để test
- Hoặc chờ market có volatility cao hơn

#### 2. **RealtimeOCDetector đang chạy song song**
**Từ logs:**
```
[RealtimeOCDetector] 🔍 OC bucket debug | BINANCE ETHUSDT 1m OC=0.00% ...
[RealtimeOCDetector] 🔍 OC bucket debug | BINANCE CELOUSDT 1m OC=-0.74% ...
```

**Vấn đề**: RealtimeOCDetector (WebSocket-based) đang chạy song song với PriceAlertScanner (polling-based), có thể gây duplicate processing

**Giải pháp**: Kiểm tra config `PRICE_ALERT_USE_WEBSOCKET` và `PRICE_ALERT_USE_SCANNER`

#### 3. **Không có logs "Threshold met" hoặc "Sending alert"**
**Nguyên nhân**: OC không đạt threshold nên không có alert nào được gửi

**Giải pháp**: Test với lower threshold hoặc chờ market volatility

## 🔍 Chi tiết từ logs

### PriceAlertScanner Status:
- ✅ Đang scan và detect OC
- ✅ Threshold check đang hoạt động
- ✅ WebSocket subscriptions: MEXC=749, Binance=541
- ❌ Không có OC >= 3% nên không có alerts

### RealtimeOCDetector Status:
- ✅ Đang nhận price updates từ WebSocket
- ✅ Đang detect OC (nhưng OC nhỏ)
- ⚠️ Có thể đang chạy song song với PriceAlertScanner

## 🚀 Giải pháp đề xuất

### 1. Test với lower threshold
Tạm thời giảm threshold xuống 1% để test xem alert có hoạt động không:
```sql
UPDATE price_alert_config SET threshold = 1.0 WHERE is_active = 1;
```

### 2. Kiểm tra AlertMode config
```bash
# Kiểm tra config
grep -E "PRICE_ALERT_USE_SCANNER|PRICE_ALERT_USE_WEBSOCKET" .env
```

### 3. Kiểm tra Telegram bot tokens
```bash
echo $TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC
echo $TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE
```

### 4. Monitor logs realtime
```bash
tail -f logs/combined.log | grep -E "(Threshold met|Sending alert|Queuing alert)"
```

## 📝 Kết luận

**Hệ thống Price Alert đang hoạt động bình thường**, nhưng:
- OC không đạt threshold 3% → không có alerts được gửi
- Đây là behavior đúng, không phải bug
- Cần giảm threshold hoặc chờ market volatility tăng

**Next steps:**
1. Test với threshold 1% để verify alert system hoạt động
2. Kiểm tra Telegram bot tokens có được config không
3. Monitor logs khi có OC >= threshold

