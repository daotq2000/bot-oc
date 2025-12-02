# Quick Start Guide

## Bước 1: Cài đặt Dependencies

```bash
npm install
```

## Bước 2: Setup Database

```bash
# Tạo database và import schema
mysql -u root -p < database/schema.sql
```

## Bước 3: Cấu hình Environment

Tạo file `.env`:

```env
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=bot_oc
TELEGRAM_BOT_TOKEN=your_token
PORT=3000
NODE_ENV=development
LOG_LEVEL=info
```

## Bước 4: Tạo Bot đầu tiên

Sử dụng API hoặc trực tiếp trong database:

```sql
INSERT INTO bots (
  bot_name, exchange, access_key, secret_key, 
  proxy, telegram_chat_id, is_active
) VALUES (
  'My First Bot', 'mexc', 'your_access_key', 'your_secret_key',
  'IP:PORT:USER:PASS', 'your_chat_id', TRUE
);
```

## Bước 5: Tạo Chiến Lược

```sql
INSERT INTO strategies (
  bot_id, symbol, interval, oc, extend, amount,
  take_profit, reduce, up_reduce, ignore, is_active
) VALUES (
  1, 'BTC/USDT', '1m', 2.00, 10.00, 10.00,
  50.00, 5.00, 5.00, 50.00, TRUE
);
```

## Bước 6: Khởi động Bot

```bash
npm start
```

## Kiểm tra hoạt động

1. Kiểm tra logs trong thư mục `logs/`
2. Kiểm tra API: `curl http://localhost:3000/api/stats`
3. Sử dụng Telegram bot: `/status`

## Cấu hình Test (Khuyến nghị)

- **OC**: 2% (nến phải có OC >= 2%)
- **Interval**: 1m (1 phút)
- **Amount**: 10 USDT (số tiền mỗi lệnh)
- **Extend**: 10% (giá phải điều chỉnh 10% từ open)
- **Take Profit**: 50 (= 5% lợi nhuận)
- **Reduce**: 5 (tốc độ giảm SL ban đầu)
- **Up Reduce**: 5 (tăng tốc độ giảm mỗi phút)
- **Ignore**: 50% (ngưỡng bỏ qua nến ngược)

## Lưu ý

- Đảm bảo API keys có quyền futures trading
- Proxy format: `IP:PORT:USER:PASS`
- Telegram chat_id: Gửi `/start` cho bot và lấy chat_id từ logs
- Test với số tiền nhỏ trước khi chạy thật

