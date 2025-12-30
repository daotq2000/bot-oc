# 📊 BÁO CÁO CHI TIẾT HỆ THỐNG BOT TRADING

## 🎯 TỔNG QUAN HỆ THỐNG

**Tên hệ thống:** Bot-OC (Open-Close Trading Bot)  
**Mô tả:** Hệ thống trading bot tự động cho các sàn giao dịch crypto (MEXC, Gate.io, Binance)  
**Phiên bản:** 1.0.0  
**Ngôn ngữ:** Node.js (ES Modules)  
**Database:** MySQL (Sequelize ORM)

---

## 🏗️ KIẾN TRÚC HỆ THỐNG

### 1. **Entry Point & Application Core**
- **File:** `src/app.js`
- **Chức năng:**
  - Khởi tạo Express server (REST API)
  - Quản lý lifecycle của các service và worker
  - Graceful shutdown handling
  - Health check endpoint (`/health`)
  - Middleware: CORS, Helmet, JSON parser

### 2. **API Routes** (`src/routes/`)
- **Bot Routes** (`bot.routes.js`): Quản lý bot CRUD
- **Strategy Routes** (`strategy.routes.js`): Quản lý chiến lược trading
- **Position Routes** (`position.routes.js`): Quản lý vị thế
- **Price Alert Routes** (`priceAlert.routes.js`): Quản lý cấu hình cảnh báo giá

---

## 📦 MODULES CHÍNH

### 🔹 **1. SERVICES MODULE** (`src/services/`)

#### **1.1. Exchange Integration Services**

##### **BinanceDirectClient.js**
- **Chức năng:** Client trực tiếp giao tiếp với Binance Futures API
- **Tính năng:**
  - Tạo lệnh (MARKET, LIMIT, TAKE_PROFIT_MARKET, STOP_MARKET)
  - Hủy lệnh
  - Lấy thông tin vị thế
  - Đóng vị thế
  - Rate limiting và retry logic
  - Queue management cho API requests
  - Hỗ trợ testnet/mainnet

##### **MexcFuturesClient.js**
- **Chức năng:** Client cho MEXC Futures API
- **Tính năng:**
  - Tạo và quản lý lệnh
  - Lấy thông tin vị thế
  - Hỗ trợ proxy và timeout configuration

##### **ExchangeService.js**
- **Chức năng:** Service wrapper cho các exchange clients
- **Tính năng:**
  - Unified interface cho Binance, MEXC, Gate.io
  - Tạo lệnh entry (MARKET/LIMIT)
  - Đóng vị thế
  - Lấy giá ticker
  - Hủy lệnh
  - Kiểm tra trạng thái lệnh

#### **1.2. Order Management Services**

##### **OrderService.js**
- **Chức năng:** Quản lý lifecycle của lệnh
- **Tính năng:**
  - Tạo entry orders
  - Xử lý lệnh LIMIT với TTL (Time To Live)
  - Retry logic cho failed orders
  - Order validation

##### **ExitOrderManager.js**
- **Chức năng:** Quản lý lệnh Take Profit và Stop Loss
- **Tính năng:**
  - Tự động quyết định loại exit order (TAKE_PROFIT_MARKET/STOP_MARKET)
  - Atomic order replacement (cancel + create)
  - Validation stop price vs market price
  - Nudge stop price để tránh lỗi -2021
  - Fallback mechanism: nếu TP/SL fail → close bằng MARKET order

##### **OrderStatusCache.js**
- **Chức năng:** Cache trạng thái lệnh từ WebSocket
- **Tính năng:**
  - LRU cache cho order status
  - Tự động update từ WebSocket events
  - Giảm số lượng REST API calls

#### **1.3. Position Management Services**

##### **PositionService.js**
- **Chức năng:** Quản lý vị thế và trailing take profit
- **Tính năng:**
  - Trailing TP logic (giảm TP theo thời gian)
  - Update TP price dựa trên `reduce` và `up_reduce`
  - Tính toán PnL
  - Đóng vị thế khi TP/SL hit
  - Lock mechanism để tránh race condition

##### **PositionLimitService.js**
- **Chức năng:** Quản lý giới hạn số lượng vị thế
- **Tính năng:**
  - Kiểm tra max concurrent trades per symbol
  - Kiểm tra max amount per coin
  - Symbol filters validation

#### **1.4. Real-time Detection Services**

##### **RealtimeOCDetector.js**
- **Chức năng:** Phát hiện Open-Close (OC) percentage từ WebSocket real-time
- **Tính năng:**
  - Không cần database candles (hoàn toàn real-time)
  - Fetch REST OPEN price khi cần (với queue và retry)
  - Cache OPEN price với LRU
  - Hỗ trợ multiple exchanges (Binance, MEXC)
  - Format symbol tự động cho từng exchange
  - Throttle queue để tránh rate limit

##### **WebSocketManager.js**
- **Chức năng:** Quản lý Binance WebSocket connections
- **Tính năng:**
  - Multiple WebSocket connections (load balancing)
  - Auto-reconnect với exponential backoff
  - Subscribe/unsubscribe symbols
  - Price cache từ WebSocket streams
  - Ping/pong để maintain connection

##### **MexcWebSocketManager.js**
- **Chức năng:** Quản lý MEXC WebSocket connection
- **Tính năng:**
  - Single WebSocket connection cho MEXC
  - Subscribe ticker streams
  - Price cache với LRU
  - Auto-reconnect
  - Domain failover (.com vs .co)

##### **PositionWebSocketClient.js**
- **Chức năng:** WebSocket client cho position updates từ exchange
- **Tính năng:**
  - Listen cho ACCOUNT_UPDATE và ORDER_TRADE_UPDATE
  - Real-time position sync
  - Order fill detection

#### **1.5. Strategy & Configuration Services**

##### **StrategyCache.js**
- **Chức năng:** Cache strategies từ database
- **Tính năng:**
  - LRU cache với TTL
  - Auto-refresh khi strategies thay đổi
  - Filter active strategies

##### **SymbolStateManager.js**
- **Chức năng:** Quản lý trạng thái symbol (đang xử lý, đã match, etc.)
- **Tính năng:**
  - Track symbols đang được xử lý
  - Prevent duplicate signal processing
  - Cooldown mechanism

##### **ConfigService.js**
- **Chức năng:** Quản lý configuration từ database
- **Tính năng:**
  - Get/set config values
  - Type conversion (string, number, boolean)
  - Default values
  - Cache configs

##### **ExchangeInfoService.js**
- **Chức năng:** Quản lý thông tin exchange (symbols, filters, leverage)
- **Tính năng:**
  - Update symbol filters từ Binance/MEXC API
  - Validate symbols
  - Get exchange info (tick size, min amount, etc.)

#### **1.6. Notification Services**

##### **TelegramService.js**
- **Chức năng:** Gửi thông báo qua Telegram
- **Tính năng:**
  - Send alerts (entry, exit, errors)
  - Send position summaries
  - Format messages với emoji
  - Rate limiting để tránh spam
  - Multiple chat IDs support

#### **1.7. Utility Services**

##### **TransferService.js**
- **Chức năng:** Chuyển tiền giữa Spot và Futures
- **Tính năng:**
  - Auto-transfer khi balance thấp
  - Configurable thresholds

##### **WithdrawService.js**
- **Chức năng:** Rút tiền tự động
- **Tính năng:**
  - Auto-withdraw khi balance đạt threshold
  - Configurable address và network

---

### 🔹 **2. JOBS MODULE** (`src/jobs/`)

#### **2.1. PositionSync.js**
- **Chức năng:** Đồng bộ vị thế từ exchange về database
- **Tần suất:** 40 giây/lần (configurable)
- **Tính năng:**
  - So sánh positions trên exchange vs database
  - Tạo missing positions trong DB
  - Đánh dấu closed positions
  - Cảnh báo size mismatch
  - Gửi Telegram alert khi đóng vị thế

#### **2.2. PositionMonitor.js**
- **Chức năng:** Giám sát vị thế mở và quản lý TP/SL orders
- **Tần suất:** 25 giây/lần (configurable)
- **Tính năng:**
  - Scan tất cả open positions
  - Đặt/cập nhật TP/SL orders
  - Trailing TP logic
  - Detect filled TP/SL orders
  - Đóng vị thế khi TP/SL hit

#### **2.3. EntryOrderMonitor.js**
- **Chức năng:** Giám sát entry orders (LIMIT orders)
- **Tần suất:** 30 giây/lần
- **Tính năng:**
  - Kiểm tra trạng thái LIMIT orders
  - Auto-cancel orders quá TTL
  - Detect filled orders và tạo positions
  - WebSocket integration để detect fills nhanh hơn

#### **2.4. PriceAlertScanner.js**
- **Chức năng:** Quét và phát hiện price alerts
- **Tần suất:** 500ms/lần (configurable)
- **Tính năng:**
  - Scan tất cả active price alert configs
  - So sánh giá hiện tại vs threshold
  - Gửi Telegram alerts
  - Hỗ trợ multiple exchanges
  - WebSocket integration cho real-time prices

#### **2.5. BalanceManager.js**
- **Chức năng:** Quản lý balance và auto-transfer
- **Tần suất:** Theo cron schedule
- **Tính năng:**
  - Kiểm tra futures balance
  - Auto-transfer từ Spot → Futures khi cần
  - Auto-withdraw khi balance cao
  - Configurable thresholds

#### **2.6. SymbolsUpdater.js**
- **Chức năng:** Cập nhật danh sách symbols từ exchange
- **Tần suất:** 15 phút/lần (configurable)
- **Tính năng:**
  - Update symbol filters từ Binance
  - Update symbol filters từ MEXC
  - Validate và lưu vào database

---

### 🔹 **3. WORKERS MODULE** (`src/workers/`)

#### **3.1. StrategiesWorker.js**
- **Chức năng:** Worker chính xử lý strategies và tạo entry orders
- **Tính năng:**
  - Chỉ chạy khi có active strategies
  - Scan strategies mỗi 30 giây
  - Subscribe WebSocket cho symbols cần thiết
  - Sử dụng RealtimeOCDetector để detect OC matches
  - Tạo entry orders khi OC threshold đạt
  - Hỗ trợ LIMIT orders với extend logic
  - TTL cho LIMIT orders (5 phút default)

#### **3.2. PriceAlertWorker.js**
- **Chức năng:** Worker độc lập cho price alerts
- **Tính năng:**
  - Luôn chạy (không phụ thuộc strategies)
  - Subscribe WebSocket cho price alert symbols
  - Sử dụng PriceAlertScanner để scan
  - Gửi alerts qua Telegram
  - Auto-refresh symbols từ config

---

### 🔹 **4. CONSUMERS MODULE** (`src/consumers/`)

#### **4.1. WebSocketOCConsumer.js**
- **Chức năng:** Consumer xử lý OC signals từ WebSocket
- **Tính năng:**
  - Listen WebSocket price updates
  - Gọi RealtimeOCDetector để check OC
  - Process matched strategies
  - Tạo entry orders
  - Concurrency control (50 concurrent by default)

---

### 🔹 **5. MODELS MODULE** (`src/models/`)

#### **5.1. Bot.js**
- **Schema:** Bảng `bots`
- **Fields:**
  - Bot credentials (API keys, proxy)
  - Exchange type (mexc, gate, binance)
  - Balance management config
  - Withdraw config
  - Telegram chat ID

#### **5.2. Strategy.js**
- **Schema:** Bảng `strategies`
- **Fields:**
  - Symbol, interval, trade_type
  - OC threshold
  - Extend percentage
  - Amount, TP, SL
  - Reduce, up_reduce, ignore
  - is_active flag

#### **5.3. Position.js**
- **Schema:** Bảng `positions`
- **Fields:**
  - Entry price, amount, side
  - TP price, SL price
  - Current reduce, minutes_elapsed
  - Status (open, closed, cancelled)
  - PnL, close_price, close_reason
  - exit_order_id (TP/SL order ID)

#### **5.4. EntryOrder.js**
- **Schema:** Bảng `entry_orders`
- **Fields:**
  - Strategy ID, symbol, side
  - Order type (MARKET/LIMIT)
  - Order ID, price, amount
  - Status, expires_at
  - reservation_token (để prevent duplicate)

#### **5.5. SymbolFilter.js**
- **Schema:** Bảng `symbol_filters`
- **Fields:**
  - Exchange, symbol
  - Min amount, max leverage
  - Max concurrent trades
  - Max amount per coin
  - is_active

#### **5.6. PriceAlertConfig.js**
- **Schema:** Bảng `price_alert_configs`
- **Fields:**
  - Exchange, symbol, interval
  - Threshold (OC percentage)
  - Telegram chat ID
  - is_active

#### **5.7. AppConfig.js**
- **Schema:** Bảng `app_configs`
- **Fields:**
  - Key, value, description
  - Dynamic configuration storage

---

### 🔹 **6. UTILS MODULE** (`src/utils/`)

#### **6.1. logger.js**
- **Chức năng:** Winston logger configuration
- **Tính năng:**
  - Multiple log levels
  - File rotation
  - Separate log files (combined, error, exceptions, orders)
  - Format với timestamp và service name

#### **6.2. LRUCache.js**
- **Chức năng:** LRU Cache implementation
- **Tính năng:**
  - Least Recently Used eviction
  - Max size limit
  - TTL support

#### **6.3. MemoryMonitor.js**
- **Chức năng:** Giám sát memory usage
- **Tính năng:**
  - Auto-cleanup khi memory cao
  - Cleanup price caches
  - Log memory stats

#### **6.4. LogThrottle.js**
- **Chức năng:** Throttle logging để tránh spam
- **Tính năng:**
  - Rate limiting cho log messages
  - Prevent duplicate logs

#### **6.5. calculator.js**
- **Chức năng:** Utility functions cho tính toán
- **Tính năng:**
  - Price calculations
  - Percentage calculations
  - Rounding functions

#### **6.6. validator.js**
- **Chức năng:** Validation functions
- **Tính năng:**
  - Validate inputs
  - Sanitize data

#### **6.7. sideSelector.js**
- **Chức năng:** Logic chọn side (long/short)
- **Tính năng:**
  - Dựa trên OC direction
  - Strategy trade_type

---

## 🎯 CÁC TÍNH NĂNG CHÍNH

### 1. **Real-time OC Detection**
- ✅ Phát hiện OC percentage từ WebSocket (không cần database candles)
- ✅ Fetch REST OPEN price khi cần (với queue và retry)
- ✅ Cache OPEN price để giảm API calls
- ✅ Hỗ trợ multiple exchanges (Binance, MEXC)

### 2. **Entry Order Management**
- ✅ MARKET orders (immediate execution)
- ✅ LIMIT orders với extend logic
- ✅ TTL cho LIMIT orders (auto-cancel sau 5 phút)
- ✅ Reservation token để prevent duplicate orders

### 3. **Exit Order Management (TP/SL)**
- ✅ TAKE_PROFIT_MARKET orders
- ✅ STOP_MARKET orders
- ✅ Atomic replacement (cancel + create)
- ✅ Trailing TP logic (giảm TP theo thời gian)
- ✅ Validation và nudge stop price
- ✅ Fallback: close bằng MARKET nếu TP/SL fail

### 4. **Position Management**
- ✅ Real-time position sync từ exchange
- ✅ Trailing TP với reduce và up_reduce
- ✅ Auto-close khi TP/SL hit
- ✅ Lock mechanism để tránh race condition
- ✅ PnL calculation

### 5. **Risk Management**
- ✅ Max concurrent trades per symbol
- ✅ Max amount per coin
- ✅ Symbol filters (min amount, max leverage)
- ✅ Position limits

### 6. **Price Alerts**
- ✅ Independent price alert system
- ✅ Multiple exchanges support
- ✅ WebSocket integration
- ✅ Telegram notifications

### 7. **Balance Management**
- ✅ Auto-transfer Spot → Futures
- ✅ Auto-withdraw
- ✅ Configurable thresholds

### 8. **WebSocket Integration**
- ✅ Binance WebSocket (multiple connections)
- ✅ MEXC WebSocket (single connection)
- ✅ Auto-reconnect
- ✅ Price caching
- ✅ Domain failover (MEXC .com vs .co)

### 9. **Telegram Integration**
- ✅ Entry/Exit alerts
- ✅ Position summaries
- ✅ Error notifications
- ✅ Multiple chat IDs
- ✅ Rate limiting

### 10. **Database & Caching**
- ✅ Sequelize ORM
- ✅ LRU caches cho strategies, prices, configs
- ✅ TTL cho caches
- ✅ Performance indexes

---

## 🔄 WORKFLOW CHÍNH

### **1. Strategy Signal Detection Flow**
```
WebSocket Price Update
    ↓
RealtimeOCDetector.checkOC()
    ↓
Calculate OC percentage
    ↓
Match với active strategies
    ↓
WebSocketOCConsumer.processMatch()
    ↓
Create Entry Order (MARKET/LIMIT)
    ↓
EntryOrderMonitor tracks order
    ↓
Order Filled → Create Position
```

### **2. Position Management Flow**
```
Position Created
    ↓
PositionMonitor scans (25s interval)
    ↓
Place TP/SL orders
    ↓
PositionMonitor updates TP (trailing)
    ↓
TP/SL Hit → Close Position
    ↓
Telegram Alert
```

### **3. Entry LIMIT Order Flow**
```
LIMIT Order Created
    ↓
EntryOrderMonitor tracks (30s interval)
    ↓
Check if filled or expired
    ↓
If expired (TTL) → Cancel
    ↓
If filled → Create Position
```

---

## 📊 PERFORMANCE & OPTIMIZATION

### **1. Caching Strategy**
- ✅ LRU caches cho strategies, prices, configs
- ✅ TTL-based expiration
- ✅ Memory-aware cleanup

### **2. Rate Limiting**
- ✅ Queue-based API request management
- ✅ Retry với exponential backoff
- ✅ Throttle logging

### **3. WebSocket Optimization**
- ✅ Multiple connections (Binance)
- ✅ Price caching
- ✅ Selective subscription

### **4. Database Optimization**
- ✅ Indexes trên các columns thường query
- ✅ Connection pooling
- ✅ Query optimization

---

## 🔒 SECURITY & RELIABILITY

### **1. Error Handling**
- ✅ Try-catch blocks
- ✅ Graceful degradation
- ✅ Error logging

### **2. Rate Limit Protection**
- ✅ Queue management
- ✅ Retry logic
- ✅ Cooldown mechanisms

### **3. Data Validation**
- ✅ Input validation
- ✅ Price validation
- ✅ Order validation

### **4. Atomic Operations**
- ✅ Transaction support
- ✅ Lock mechanisms
- ✅ Race condition prevention

---

## 📈 MONITORING & LOGGING

### **1. Logging**
- ✅ Winston logger
- ✅ Multiple log files (combined, error, exceptions, orders)
- ✅ Log rotation
- ✅ Structured logging

### **2. Memory Monitoring**
- ✅ Auto-cleanup khi memory cao
- ✅ Cache size limits
- ✅ Memory stats logging

### **3. Health Checks**
- ✅ `/health` endpoint
- ✅ Database connection check
- ✅ WebSocket status

---

## 🚀 DEPLOYMENT & CONFIGURATION

### **1. Environment Variables**
- Database connection
- Exchange API keys (stored in DB)
- Telegram bot token
- Proxy settings

### **2. Database Migrations**
- Sequelize migrations
- Schema versioning
- Rollback support

### **3. PM2 Process Management**
- Auto-restart
- Log management
- Process monitoring

---

## 📝 CONFIGURATION OPTIONS

### **App Configs (app_configs table)**
- `ENABLE_ALERTS`: Master switch cho Telegram alerts
- `SIGNAL_SCAN_INTERVAL_MS`: Interval cho signal scanner
- `PRICE_ALERT_SCAN_INTERVAL_MS`: Interval cho price alert scanner
- `ENTRY_ORDER_TTL_MINUTES`: TTL cho LIMIT orders
- `WS_MATCH_CONCURRENCY`: Max concurrency cho OC processing
- `REALTIME_OC_ENABLED`: Enable/disable real-time OC detection
- Và nhiều configs khác...

---

## 🎓 KẾT LUẬN

Hệ thống Bot-OC là một trading bot tự động hoàn chỉnh với:
- ✅ Real-time OC detection từ WebSocket
- ✅ Entry/Exit order management
- ✅ Position management với trailing TP
- ✅ Risk management
- ✅ Multi-exchange support (Binance, MEXC, Gate.io)
- ✅ Telegram notifications
- ✅ High-performance với caching và optimization
- ✅ Reliable với error handling và retry logic

Hệ thống được thiết kế để xử lý high-frequency trading với độ tin cậy cao và performance tối ưu.

