# MEXC Environment Setup Guide

## Step 1: Get MEXC API Keys

1. Đăng nhập vào tài khoản MEXC của bạn
2. Truy cập: https://www.mexc.com/user/setting/api
3. Nhấp "Create API Key"
4. Chọn quyền:
   - ✅ Futures Trading (giao dịch hợp đồng)
   - ✅ Read (đọc dữ liệu)
   - ❌ Withdrawal (không cần rút tiền)
5. Sao chép:
   - API Key
   - Secret Key
   - UID (tùy chọn nhưng được khuyến nghị)

## Step 2: Get Telegram Bot Token

1. Mở Telegram và tìm kiếm `@BotFather`
2. Gửi `/start`
3. Gửi `/newbot`
4. Đặt tên bot (ví dụ: "My Trading Bot")
5. Đặt username (ví dụ: "my_trading_bot")
6. Sao chép token được cấp

## Step 3: Get Telegram Chat ID

1. Mở Telegram và tìm kiếm `@userinfobot`
2. Gửi `/start`
3. Bot sẽ trả lại Chat ID của bạn
4. Sao chép Chat ID

## Step 4: Configure .env File

Thêm các biến sau vào file `.env` của bạn:

```bash
# ============================================
# MEXC Exchange Configuration
# ============================================

MEXC_API_KEY=your_mexc_api_key_here
MEXC_SECRET_KEY=your_mexc_secret_key_here
MEXC_UID=your_mexc_uid_here

# MEXC Settings
MEXC_ENABLED=true
MEXC_DEFAULT_LEVERAGE=5
MEXC_SANDBOX=false

# ============================================
# Price Alert Configuration
# ============================================

PRICE_ALERT_CHECK_ENABLED=true
PRICE_ALERT_SCAN_INTERVAL_MS=5000

# ============================================
# Telegram Configuration
# ============================================

TELEGRAM_BOT_TOKEN=your_telegram_bot_token_here
TELEGRAM_CHAT_ID=your_telegram_chat_id_here

# ============================================
# Database Configuration
# ============================================

DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=trading_bot

# ============================================
# Server Configuration
# ============================================

PORT=3000
NODE_ENV=development
LOG_LEVEL=info
```

## Step 5: Verify Configuration

Sau khi cập nhật `.env`, khởi động ứng dụng:

```bash
npm start
```

Kiểm tra logs để xác nhận:

```bash
tail -f logs/app.log | grep -i "mexc\|price.*alert"
```

Bạn sẽ thấy:

```
[INFO] PriceAlertScanner initialized for mexc exchange
[INFO] PriceAlertScanner started with interval 5000ms
```

## Step 6: Create Your First Price Alert

Sử dụng cURL hoặc API client:

```bash
curl -X POST http://localhost:3000/api/price-alerts \
  -H "Content-Type: application/json" \
  -d '{
    "exchange": "mexc",
    "symbols": ["BTC/USDT", "ETH/USDT"],
    "intervals": ["1m", "5m"],
    "threshold": 2.5,
    "telegram_chat_id": "your_telegram_chat_id",
    "is_active": true
  }'
```

## Troubleshooting

### Issue: "MEXC_API_KEY is not configured"

**Solution**: Kiểm tra file `.env` của bạn:
```bash
grep MEXC_API_KEY .env
```

Đảm bảo giá trị không rỗng.

### Issue: "Failed to initialize exchange for mexc"

**Solution**: 
1. Kiểm tra API key và secret key có đúng không
2. Kiểm tra quyền API (phải có Futures Trading)
3. Kiểm tra IP whitelist trên MEXC (nếu được bật)

### Issue: "No exchange service for mexc"

**Solution**: Đảm bảo:
1. MEXC_API_KEY và MEXC_SECRET_KEY được cấu hình
2. Ứng dụng đã khởi động lại sau khi cập nhật `.env`
3. Kiểm tra logs: `tail -f logs/app.log`

### Issue: Alerts không được gửi

**Solution**:
1. Kiểm tra TELEGRAM_BOT_TOKEN có đúng không
2. Kiểm tra TELEGRAM_CHAT_ID có đúng không
3. Kiểm tra PRICE_ALERT_CHECK_ENABLED = true
4. Kiểm tra price alert config có active không

## Security Best Practices

⚠️ **IMPORTANT**: Bảo vệ API keys của bạn!

1. **Không commit .env file**:
   ```bash
   echo ".env" >> .gitignore
   ```

2. **Sử dụng API key restrictions**:
   - Giới hạn IP (nếu có)
   - Chỉ cấp quyền cần thiết
   - Không cấp quyền Withdrawal

3. **Rotate keys định kỳ**:
   - Tạo key mới
   - Cập nhật .env
   - Xóa key cũ

4. **Monitor API usage**:
   - Kiểm tra logs thường xuyên
   - Theo dõi hoạt động API trên MEXC

## Next Steps

1. ✅ Cấu hình MEXC API keys
2. ✅ Cấu hình Telegram
3. ✅ Khởi động ứng dụng
4. ✅ Tạo price alert đầu tiên
5. ✅ Kiểm tra logs để xác nhận hoạt động

Xem `MEXC_PRICE_ALERT_SETUP.md` để biết thêm chi tiết về cách sử dụng API.

