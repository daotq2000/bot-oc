# MEXC Price Alert Configuration Guide

## Overview
Hệ thống đã được cập nhật để hỗ trợ **Price Alerts** cho MEXC exchange. Bạn có thể thiết lập các cảnh báo giá tự động cho các cặp giao dịch trên MEXC.

## Prerequisites

### 1. MEXC API Keys
Bạn cần có MEXC API keys để sử dụng tính năng này:

```bash
# Thêm vào .env file
MEXC_API_KEY=your_mexc_api_key
MEXC_SECRET_KEY=your_mexc_secret_key
MEXC_UID=your_mexc_uid  # Optional, but recommended
```

### 2. Telegram Configuration
Đảm bảo bạn đã cấu hình Telegram bot:

```bash
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

## Configuration

### Enable MEXC Exchange
MEXC đã được enable mặc định. Bạn có thể kiểm tra cấu hình:

```javascript
// Các config mặc định trong app.js
MEXC_ENABLED=true
MEXC_DEFAULT_LEVERAGE=5
MEXC_SANDBOX=false
PRICE_ALERT_SCAN_INTERVAL_MS=5000
PRICE_ALERT_CHECK_ENABLED=true
```

## API Usage

### 1. Create Price Alert Config

**Endpoint:** `POST /api/price-alerts`

**Request:**
```json
{
  "exchange": "mexc",
  "symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
  "intervals": ["1m", "5m"],
  "threshold": 2.5,
  "telegram_chat_id": "your_chat_id",
  "is_active": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "exchange": "mexc",
    "symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT"],
    "intervals": ["1m", "5m"],
    "threshold": 2.5,
    "telegram_chat_id": "your_chat_id",
    "is_active": true,
    "created_at": "2025-12-12T04:27:01.370Z",
    "last_alert_time": null
  }
}
```

**Parameters:**
- `exchange` (string, required): `"mexc"` hoặc `"gate"`
- `symbols` (array, required): Danh sách cặp giao dịch (ví dụ: `["BTC/USDT", "ETH/USDT"]`)
- `intervals` (array, required): Các khoảng thời gian (ví dụ: `["1m", "5m", "1h"]`)
- `threshold` (number, required): Ngưỡng thay đổi giá (%) để kích hoạt cảnh báo
- `telegram_chat_id` (string, required): Chat ID Telegram để nhận cảnh báo
- `is_active` (boolean, optional): Kích hoạt/vô hiệu hóa cảnh báo (mặc định: `true`)

### 2. Get All Price Alerts

**Endpoint:** `GET /api/price-alerts`

**Query Parameters:**
- `exchange` (optional): Lọc theo exchange (`"mexc"`, `"gate"`, v.v.)

**Response:**
```json
{
  "success": true,
  "data": [
    {
      "id": 1,
      "exchange": "mexc",
      "symbols": ["BTC/USDT", "ETH/USDT"],
      "threshold": 2.5,
      "is_active": true,
      "created_at": "2025-12-12T04:27:01.370Z"
    }
  ]
}
```

### 3. Get Price Alert by ID

**Endpoint:** `GET /api/price-alerts/:id`

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "exchange": "mexc",
    "symbols": ["BTC/USDT", "ETH/USDT"],
    "intervals": ["1m", "5m"],
    "threshold": 2.5,
    "telegram_chat_id": "your_chat_id",
    "is_active": true,
    "created_at": "2025-12-12T04:27:01.370Z",
    "last_alert_time": "2025-12-12T04:30:00.000Z"
  }
}
```

### 4. Update Price Alert

**Endpoint:** `PUT /api/price-alerts/:id`

**Request:**
```json
{
  "symbols": ["BTC/USDT", "ETH/USDT", "XRP/USDT"],
  "threshold": 3.0,
  "is_active": true
}
```

**Response:**
```json
{
  "success": true,
  "data": {
    "id": 1,
    "exchange": "mexc",
    "symbols": ["BTC/USDT", "ETH/USDT", "XRP/USDT"],
    "intervals": ["1m", "5m"],
    "threshold": 3.0,
    "telegram_chat_id": "your_chat_id",
    "is_active": true,
    "created_at": "2025-12-12T04:27:01.370Z",
    "last_alert_time": "2025-12-12T04:30:00.000Z"
  }
}
```

### 5. Delete Price Alert

**Endpoint:** `DELETE /api/price-alerts/:id`

**Response:**
```json
{
  "success": true,
  "message": "Price alert config deleted"
}
```

## How It Works

### Price Alert Scanner Process

1. **Initialization**: Khi ứng dụng khởi động, `PriceAlertScanner` sẽ:
   - Kết nối với MEXC API sử dụng API keys từ environment
   - Khởi tạo exchange service cho MEXC
   - Sẵn sàng để quét giá

2. **Scanning**: Mỗi `PRICE_ALERT_SCAN_INTERVAL_MS` (mặc định 5 giây):
   - Lấy tất cả active price alert configs từ database
   - Cho mỗi config, kiểm tra giá hiện tại của các symbols
   - So sánh với giá lần trước
   - Nếu thay đổi giá vượt quá threshold → gửi cảnh báo Telegram

3. **Alert Throttling**: 
   - Cảnh báo được gửi tối đa 1 lần mỗi phút cho mỗi symbol
   - Điều này tránh spam notifications

4. **Price Caching**:
   - Giá được cache trong 2 giây để tránh gọi API quá nhiều
   - Cải thiện hiệu suất và giảm tải API

## Example Usage

### cURL Example

```bash
# Create MEXC price alert
curl -X POST http://localhost:3000/api/price-alerts \
  -H "Content-Type: application/json" \
  -d '{
    "exchange": "mexc",
    "symbols": ["BTC/USDT", "ETH/USDT"],
    "intervals": ["1m", "5m"],
    "threshold": 2.5,
    "telegram_chat_id": "123456789",
    "is_active": true
  }'

# Get all MEXC alerts
curl http://localhost:3000/api/price-alerts?exchange=mexc

# Update alert
curl -X PUT http://localhost:3000/api/price-alerts/1 \
  -H "Content-Type: application/json" \
  -d '{
    "threshold": 3.0,
    "symbols": ["BTC/USDT", "ETH/USDT", "SOL/USDT"]
  }'

# Delete alert
curl -X DELETE http://localhost:3000/api/price-alerts/1
```

### JavaScript/Node.js Example

```javascript
// Create price alert
const response = await fetch('http://localhost:3000/api/price-alerts', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    exchange: 'mexc',
    symbols: ['BTC/USDT', 'ETH/USDT'],
    intervals: ['1m', '5m'],
    threshold: 2.5,
    telegram_chat_id: '123456789',
    is_active: true
  })
});

const data = await response.json();
console.log(data);
```

## Troubleshooting

### Issue: "No exchange service for mexc"
**Solution**: Kiểm tra MEXC API keys trong `.env` file:
```bash
MEXC_API_KEY=your_key
MEXC_SECRET_KEY=your_secret
```

### Issue: Alerts not being sent
**Solution**: 
1. Kiểm tra `PRICE_ALERT_CHECK_ENABLED` config:
   ```bash
   curl http://localhost:3000/api/config?key=PRICE_ALERT_CHECK_ENABLED
   ```

2. Kiểm tra Telegram chat ID có đúng không

3. Kiểm tra logs:
   ```bash
   tail -f logs/app.log | grep "PriceAlertScanner"
   ```

### Issue: API rate limiting
**Solution**: Tăng `PRICE_ALERT_SCAN_INTERVAL_MS`:
```javascript
// Trong app.js hoặc qua API config
await AppConfig.set('PRICE_ALERT_SCAN_INTERVAL_MS', '10000', 'Scan interval');
```

## Configuration Options

| Config Key | Default | Description |
|-----------|---------|-------------|
| `MEXC_ENABLED` | `true` | Enable MEXC exchange |
| `MEXC_DEFAULT_LEVERAGE` | `5` | Default leverage for MEXC |
| `MEXC_SANDBOX` | `false` | Use MEXC sandbox mode |
| `PRICE_ALERT_SCAN_INTERVAL_MS` | `5000` | Scan interval in milliseconds |
| `PRICE_ALERT_CHECK_ENABLED` | `true` | Enable price alert checking |

## Supported Exchanges

Hiện tại hỗ trợ:
- ✅ MEXC
- ✅ Gate.io
- 🔄 Binance (chỉ cho trading, không cho price alerts)

## Notes

- Price alerts được quét mỗi 5 giây (có thể điều chỉnh)
- Mỗi symbol chỉ gửi tối đa 1 cảnh báo mỗi phút
- Threshold là phần trăm (%) thay đổi giá
- Tất cả giá được lấy từ market data (không phải trading data)

## Support

Nếu gặp vấn đề, vui lòng kiểm tra:
1. Logs: `logs/app.log`
2. Database: `price_alert_config` table
3. Environment variables: `.env` file

