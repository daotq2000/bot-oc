# Hướng Dẫn Sử Dụng Price Alert Module

## 📋 Tổng Quan

Module **Price Alert** tự động theo dõi biến động giá trên Binance và gửi cảnh báo qua Telegram khi giá vượt quá ngưỡng cấu hình.

## 🔧 Tính Năng

- ✅ Quét giá real-time mỗi 30 giây
- ✅ Tính toán biến động giá theo thời gian thực (không chờ nến đóng)
- ✅ Gửi cảnh báo qua Telegram với format đẹp
- ✅ Hỗ trợ nhiều symbols và intervals
- ✅ Cấu hình threshold linh hoạt
- ✅ Tránh spam alerts (cache mechanism)

## 📊 Database Schema

### Bảng `price_alert_config`
- `id`: ID cấu hình
- `exchange`: Exchange name (mexc, gate, binance)
- `symbols`: JSON array các symbols cần theo dõi, ví dụ: `["BTC/USDT", "ETH/USDT"]`
- `intervals`: JSON array các intervals, ví dụ: `["1m", "5m", "15m", "30m"]`
- `threshold`: Ngưỡng biến động (%), ví dụ: `5.00` = 5%
- `telegram_chat_id`: Chat ID để gửi cảnh báo
- `is_active`: Bật/tắt cấu hình
- `last_alert_time`: Thời gian cảnh báo cuối cùng

### Bảng `price_alert_history`
- Lưu lịch sử các cảnh báo đã gửi (optional)

## 🚀 Cách Sử Dụng

### 1. Tạo Price Alert Config

**Qua API:**
```bash
POST /api/price-alerts
Content-Type: application/json

{
  "exchange": "binance",
  "symbols": ["BTC/USDT", "ETH/USDT", "BNB/USDT"],
  "intervals": ["1m", "5m", "15m", "30m"],
  "threshold": 5.00,
  "telegram_chat_id": "-1001234567890",
  "is_active": true
}
```

**Qua SQL (nếu cần):**
```sql
INSERT INTO price_alert_config (
  exchange, symbols, intervals, threshold, telegram_chat_id, is_active
) VALUES (
  'binance',
  '["BTC/USDT", "ETH/USDT"]',
  '["1m", "5m", "15m"]',
  5.00,
  '-1001234567890',
  TRUE
);
```

### 2. Cấu Hình Environment Variables

Đảm bảo có `TELEGRAM_BOT_TOKEN` trong `.env`:
```
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
```

### 3. Job Tự Động Chạy

Job sẽ tự động:
- Quét mỗi 30 giây
- Fetch giá real-time từ Binance
- Tính toán biến động so với giá mở nến
- Gửi cảnh báo nếu vượt threshold

## 📱 Format Cảnh Báo

### Với dao động < 10%
```
📈 BAGWORK_USDT 1️⃣5️⃣ 9.66% 🟢
┌ 0.004350 → 0.004770
└ ⏰ 05:10:11 PM
```

### Với dao động ≥ 10%
```
🔥 BAGWORK_USDT 1️⃣ 20.66% 🟢 🚀🚀
┌ 0.004350 → 0.004770
└ ⏰ 05:10:11 PM
```

### Giải Thích Format:
- **📈/🔥**: Icon cảnh báo (📈 cho < 10%, 🔥 cho ≥ 10%)
- **BAGWORK_USDT**: Tên symbol
- **1️⃣5️⃣**: Interval emoji (1m = 1️⃣, 5m = 5️⃣, 15m = 1️⃣5️⃣, 30m = 3️⃣0️⃣)
- **9.66%**: Phần trăm biến động
- **🟢/🔴**: Hướng biến động (🟢 = tăng, 🔴 = giảm)
- **🚀🚀**: Số tên lửa = volatility / 10 (ví dụ: 20% = 2 tên lửa, 50% = 5 tên lửa)
- **┌ 0.004350 → 0.004770**: Giá cũ → Giá mới
- **└ ⏰ 05:10:11 PM**: Thời gian cảnh báo

## 🔄 API Endpoints

### GET /api/price-alerts
Lấy tất cả configs
```bash
GET /api/price-alerts?exchange=binance
```

### GET /api/price-alerts/:id
Lấy config theo ID

### POST /api/price-alerts
Tạo config mới

### PUT /api/price-alerts/:id
Cập nhật config

### DELETE /api/price-alerts/:id
Xóa config

## ⚙️ Cấu Hình Nâng Cao

### Thay Đổi Interval Quét
Mặc định: 30 giây. Để thay đổi, sửa trong `src/jobs/PriceAlertJob.js`:
```javascript
const intervalMs = 30000; // 30 seconds
```

### Thay Đổi Threshold Mặc Định
Có thể set trong database hoặc qua API khi tạo config.

### Tránh Spam Alerts
Hệ thống tự động cache để tránh gửi cảnh báo trùng lặp:
- Chỉ gửi khi giá thay đổi đáng kể so với lần cảnh báo trước
- Cache key: `exchange:symbol:interval`

## 🐛 Troubleshooting

### Không nhận được cảnh báo
1. Kiểm tra `is_active = TRUE` trong database
2. Kiểm tra `TELEGRAM_BOT_TOKEN` đã được set
3. Kiểm tra `telegram_chat_id` đúng
4. Kiểm tra logs: `logs/combined.log`

### Cảnh báo quá nhiều
1. Tăng `threshold` trong config
2. Kiểm tra symbols và intervals có quá nhiều không

### Lỗi kết nối Binance
- Binance API có rate limits
- Job sẽ tự động retry
- Kiểm tra network connection

## 📝 Ví Dụ Sử Dụng

### Theo dõi BTC/USDT với threshold 3%
```json
{
  "exchange": "binance",
  "symbols": ["BTC/USDT"],
  "intervals": ["1m", "5m"],
  "threshold": 3.00,
  "telegram_chat_id": "-1001234567890"
}
```

### Theo dõi nhiều altcoins với threshold 10%
```json
{
  "exchange": "binance",
  "symbols": ["DOGE/USDT", "SHIB/USDT", "PEPE/USDT"],
  "intervals": ["1m", "5m", "15m"],
  "threshold": 10.00,
  "telegram_chat_id": "-1001234567890"
}
```

## 🔍 Logic Tính Toán

1. **Fetch giá real-time**: Lấy giá hiện tại từ Binance API
2. **Lấy giá mở nến**: Fetch candle mới nhất, lấy giá `open`
3. **Tính biến động**: `|(newPrice - oldPrice) / oldPrice| * 100`
4. **So sánh threshold**: Nếu `volatility >= threshold` → Gửi cảnh báo
5. **Cache**: Lưu giá để tránh spam

## ✅ Checklist

- [ ] Database migration đã chạy
- [ ] `TELEGRAM_BOT_TOKEN` đã được set
- [ ] Tạo price alert config
- [ ] Job đang chạy (kiểm tra logs)
- [ ] Test với symbol có biến động lớn

---

**Module sẵn sàng sử dụng!** 🎉

