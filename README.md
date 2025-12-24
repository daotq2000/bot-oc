# Bot OC - Automated Crypto Trading System

Hệ thống bot trading crypto tự động cho sàn MEXC và Gate.io với các tính năng:
- Giao dịch futures tự động dựa trên chiến lược nến
- Quản lý nhiều bot và chiến lược
- Tích hợp Telegram để monitoring
- Tự động chuyển tiền giữa ví Spot và Futures
- Tự động rút tiền về ví BEP20
- Sử dụng proxy để tránh bị ban

## Yêu Cầu Hệ Thống

- Node.js v18+
- MySQL 8.0+
- Telegram Bot Token (tùy chọn)

## Cài Đặt

### 1. Clone repository và cài đặt dependencies

```bash
git clone <repository-url>
cd bot-oc
npm install
```

### 2. Cấu hình Database

Tạo database và import schema:

```bash
mysql -u root -p < database/schema.sql
```

### 3. Cấu hình Environment Variables

Tạo file `.env` từ `.env.example`:

```bash
cp .env.example .env
```

Chỉnh sửa file `.env` với thông tin của bạn:

```env
# Database Configuration
DB_HOST=localhost
DB_PORT=3306
DB_USER=root
DB_PASSWORD=your_password
DB_NAME=bot_oc

# Telegram Bot Configuration
TELEGRAM_BOT_TOKEN=your_telegram_bot_token

# Server Configuration
PORT=3000
NODE_ENV=development

# Logging
LOG_LEVEL=info
```

### 4. Tạo Telegram Bot (Tùy chọn)

1. Mở Telegram và tìm @BotFather
2. Gửi lệnh `/newbot` và làm theo hướng dẫn
3. Copy token và thêm vào file `.env`

## Sử Dụng

### Khởi động ứng dụng

```bash
npm start
```

Hoặc chạy ở chế độ development với auto-reload:

```bash
npm run dev
```

### Tạo Bot

Sử dụng API để tạo bot mới:

```bash
POST /api/bots
Content-Type: application/json

{
  "bot_name": "MEXC Bot 1",
  "exchange": "mexc",
  "uid": "your_uid",
  "access_key": "your_access_key",
  "secret_key": "your_secret_key",
  "proxy": "IP:PORT:USER:PASS",
  "telegram_chat_id": "your_chat_id",
  "future_balance_target": 20.00,
  "spot_transfer_threshold": 10.00,
  "transfer_frequency": 15,
  "withdraw_enabled": false,
  "withdraw_address": "",
  "withdraw_network": "BEP20",
  "spot_balance_threshold": 10.00,
  "is_active": true
}
```

### Tạo Chiến Lược

```bash
POST /api/strategies
Content-Type: application/json

{
  "bot_id": 1,
  "symbol": "BTC/USDT",
  "trade_type": "both",
  "interval": "1m",
  "oc": 2.00,
  "extend": 10.00,
  "amount": 10.00,
  "take_profit": 50.00,
  "reduce": 5.00,
  "up_reduce": 5.00,
  "ignore": 50.00,
  "is_active": true
}
```

### Xem Thống Kê

```bash
GET /api/stats
```

## API Endpoints

### Bots
- `GET /api/bots` - List all bots
- `GET /api/bots/:id` - Get bot details
- `POST /api/bots` - Create new bot
- `PUT /api/bots/:id` - Update bot
- `DELETE /api/bots/:id` - Delete bot

### Strategies
- `GET /api/strategies` - List all strategies
- `GET /api/strategies/:id` - Get strategy details
- `POST /api/strategies` - Create new strategy
- `PUT /api/strategies/:id` - Update strategy
- `DELETE /api/strategies/:id` - Delete strategy

### Positions
- `GET /api/positions` - List all positions
- `GET /api/positions/:id` - Get position details
- `POST /api/positions/:id/close` - Close position manually

### Transactions
- `POST /api/transfer` - Manual transfer
- `POST /api/withdraw` - Manual withdraw
- `GET /api/stats` - Trading statistics

## Telegram Commands

Nếu đã cấu hình Telegram bot, bạn có thể sử dụng các lệnh sau:

- `/start` - Bắt đầu bot
- `/help` - Xem danh sách lệnh
- `/status` - Xem trạng thái hệ thống
- `/bots` - Liệt kê tất cả bots
- `/strategies` - Liệt kê các chiến lược
- `/positions` - Xem các vị thế đang mở
- `/balance [bot_id]` - Xem số dư của bot
- `/stats` - Xem thống kê trading

## Logic Giao Dịch

### Công Thức Tính Toán

1. **OC (Open-Close) Percentage**:
   ```
   OC = ((close_price - open_price) / open_price) * 100
   ```

2. **Entry Price**:
   - LONG: `entry = open - (open * oc * extend / 10000)`
   - SHORT: `entry = open + (open * oc * extend / 10000)`

3. **Take Profit**:
   - `actual_tp_percent = (oc * take_profit / 1000)`
   - LONG: `tp = entry * (1 + actual_tp_percent / 100)`
   - SHORT: `tp = entry * (1 - actual_tp_percent / 100)`

4. **Dynamic Stop Loss**:
   - `current_sl = tp_price + ((reduce + minutes * up_reduce) * oc / 100)`

## Cấu Hình Extend & LIMIT (Quan Trọng)

- **`EXTEND_LIMIT_MAX_DIFF_RATIO`**  
  - Được seed trong `src/app.js` và có thể chỉnh trong bảng `app_configs`.  
  - Ý nghĩa: **tỉ lệ chênh lệch tối đa** giữa `currentPrice` và `entryPrice` **so với toàn bộ quãng đường extend** (từ `open` đến `entry`) để bot vẫn cho phép đặt lệnh LIMIT khi *extend chưa chạm đủ 100%*.  
  - Giá trị:
    - `0.5` (mặc định) = cho phép đặt LIMIT nếu giá hiện tại còn cách entry **≤ 50%** quãng đường extend.
    - `0.3` = chặt hơn, yêu cầu giá phải gần entry hơn (≤ 30% quãng đường).
    - `0.8` = thoáng hơn, cho phép đặt LIMIT dù giá còn khá xa entry (≤ 80% quãng đường).
  - Được sử dụng trong `WebSocketOCConsumer` khi `ENABLE_LIMIT_ON_EXTEND_MISS = true`.

- **`EXTEND_LIMIT_AUTO_CANCEL_MINUTES`**  
  - Được seed trong `src/app.js` và có thể chỉnh trong `app_configs`.  
  - Ý nghĩa: **số phút tối đa** mà một **lệnh entry LIMIT (bao gồm lệnh đặt ra từ extend-miss)** được phép treo mà **không được khớp**, sau đó sẽ:
    1. Bot gọi `cancelOrder` trên sàn.
    2. Đánh dấu `entry_orders` tương ứng là `canceled` với lý do `expired_ttl`.
  - Mặc định: `10` phút.  
  - Logic auto-cancel được triển khai trong `EntryOrderMonitor.pollOpenEntryOrders`, sử dụng `EXTEND_LIMIT_AUTO_CANCEL_MINUTES` để tính TTL.

## Cấu Hình Test

Để test bot, sử dụng config sau:

```
OC: 2
Interval: 1m
Amount: 10 USDT
Extend: 10
Take Profit: 50 (= 5%)
Reduce: 5
Up Reduce: 5
Ignore: 50
```

## Lưu Ý Bảo Mật

1. Chỉ login vào MEXC qua GenLogin browser, không dùng Chrome
2. Chỉ dùng 1 device + GenLogin proxy
3. Enable whitelist withdrawal trong MEXC settings
4. Enable quick withdrawal không cần verification
5. Không share API keys hoặc bot configs
6. Sử dụng proxy cho tất cả requests đến exchange

## Cấu Trúc Dự Án

```
bot-oc/
├── database/
│   └── schema.sql          # Database schema
├── src/
│   ├── config/             # Configuration files
│   ├── controllers/        # API controllers
│   ├── jobs/               # Cron jobs
│   ├── models/             # Database models
│   ├── routes/             # API routes
│   ├── services/           # Business logic services
│   ├── telegram/           # Telegram bot
│   ├── utils/              # Utility functions
│   └── app.js              # Main application
├── logs/                   # Log files (auto-created)
├── .env                    # Environment variables
├── .env.example            # Example env file
├── package.json
└── README.md
```

## Troubleshooting

### Database Connection Error
- Kiểm tra thông tin database trong `.env`
- Đảm bảo MySQL đang chạy
- Kiểm tra quyền truy cập của user

### Exchange Connection Error
- Kiểm tra API keys
- Kiểm tra proxy configuration (nếu có)
- Đảm bảo API keys có quyền futures trading

### Telegram Bot Not Working
- Kiểm tra `TELEGRAM_BOT_TOKEN` trong `.env`
- Đảm bảo bot đã được start với BotFather
- Kiểm tra chat_id trong bot configuration

## License

ISC

## Support

Nếu gặp vấn đề, vui lòng tạo issue trên repository.

