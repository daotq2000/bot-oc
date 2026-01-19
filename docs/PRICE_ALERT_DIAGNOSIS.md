# Phân tích vấn đề Price Alert MEXC và Binance

## 🔍 Phân tích từ Logs

### Tình trạng hiện tại:
1. ✅ **PriceAlertWorker đang chạy**: Subscribed MEXC=749 symbols, Binance=541 symbols
2. ✅ **PriceAlertScanner đang scan**: Detect OC cho nhiều symbols
3. ❌ **Không có alerts được gửi**: Không thấy logs "Threshold met" hoặc "Sending alert"

### Logs quan sát được:
```
[PriceAlertScanner] 🔍 detectOC | BINANCE 0GUSDT 1m OC=0.10% (open=0.878, current=0.8789)
[PriceAlertScanner] 🔍 detectOC | BINANCE 1000CHEEMSUSDT 1m OC=0.01% (open=0.0009659, current=0.000966)
...
```

**Vấn đề**: OC được detect nhưng rất nhỏ (< 3%), không đạt threshold để gửi alert.

## 🔎 Nguyên nhân có thể

### 1. **OC không đạt threshold (3%)**
- **Hiện tượng**: OC được detect nhưng < 3% (threshold)
- **Nguyên nhân**: Market không có biến động lớn
- **Giải pháp**: Giảm threshold hoặc chờ market volatility tăng

### 2. **Alert bị throttle**
- **Hiện tượng**: Alert đã đạt threshold nhưng bị throttle bởi `minAlertInterval` (60s)
- **Nguyên nhân**: Code có rate limiting
- **Giải pháp**: Kiểm tra logs "Alert throttled"

### 3. **Telegram bot token không được config**
- **Hiện tượng**: Bot không được initialize
- **Nguyên nhân**: Thiếu `TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC` hoặc `TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE`
- **Giải pháp**: Kiểm tra env variables

### 4. **WebSocket không nhận được price updates**
- **Hiện tượng**: Price cache không được update
- **Nguyên nhân**: WebSocket connection issues
- **Giải pháp**: Kiểm tra WebSocket status

### 5. **Config không active hoặc không có symbols**
- **Hiện tượng**: Không có configs active hoặc symbols rỗng
- **Nguyên nhân**: DB config issues
- **Giải pháp**: Kiểm tra `price_alert_config` table

## 🔧 Các bước kiểm tra

### Step 1: Kiểm tra Config
```sql
SELECT * FROM price_alert_config WHERE is_active = 1;
```

### Step 2: Kiểm tra Environment Variables
```bash
echo $TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC
echo $TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE
echo $ENABLE_ALERTS
echo $PRICE_ALERT_CHECK_ENABLED
```

### Step 3: Kiểm tra Logs chi tiết
```bash
# Tìm logs về threshold check
grep -E "(Threshold met|Alert throttled|OC below threshold)" logs/combined.log

# Tìm logs về WebSocket subscription
grep -E "(MEXC WS|Binance WS|WebSocket subscribed)" logs/combined.log

# Tìm logs về Telegram initialization
grep -E "(Telegram client initialized|TELEGRAM_BOT_TOKEN)" logs/combined.log
```

### Step 4: Kiểm tra WebSocket Status
- MEXC: `mexcPriceWs.getStatus()`
- Binance: `webSocketManager.getStatus()`

### Step 5: Test với symbol có volatility cao
- Tìm symbol có OC > 3% trong logs
- Kiểm tra xem alert có được gửi không

## 🚀 Giải pháp đề xuất

### Fix 1: Thêm debug logging
Thêm logs chi tiết hơn trong `checkSymbolPrice()` để track:
- Threshold check result
- Alert queuing status
- Telegram send status

### Fix 2: Kiểm tra Telegram bot initialization
Đảm bảo bot tokens được config đúng:
- `TELEGRAM_BOT_TOKEN_SEND_ALERT_MEXC`
- `TELEGRAM_BOT_TOKEN_SEND_ALERT_BINANCE`

### Fix 3: Kiểm tra WebSocket connection
Đảm bảo WebSocket đang connected và nhận price updates:
- MEXC: `mexcPriceWs.ensureConnected()`
- Binance: `webSocketManager.connect()`

### Fix 4: Test với lower threshold
Tạm thời giảm threshold xuống 1% để test xem alert có hoạt động không.

## 📊 Metrics để monitor

1. **OC Detection Rate**: Số lượng OC được detect mỗi phút
2. **Threshold Hit Rate**: Số lượng OC >= threshold
3. **Alert Send Rate**: Số lượng alerts được gửi thành công
4. **WebSocket Connection Status**: MEXC và Binance WS status
5. **Telegram Bot Status**: Bot initialization status

## 🔍 Code Issues cần kiểm tra

### 1. PriceAlertScanner.checkSymbolPrice()
- Line 649: Threshold check logic
- Line 651: Rate limiting logic
- Line 657: Alert sending logic

### 2. TelegramService.sendVolatilityAlert()
- Line 798: Alert queuing logic
- Line 858: AlertType determination
- Line 866: Queue processing

### 3. PriceAlertWorker.subscribeWebSockets()
- Line 270: MEXC WebSocket connection check
- Line 294: Binance WebSocket connection check

