# TÓM TẮT CHỨC NĂNG HỆ THỐNG BOT TRADING CRYPTO

## 📋 TỔNG QUAN HỆ THỐNG

Hệ thống **Bot Trading Crypto** là một nền tảng tự động hóa giao dịch cryptocurrency trên các sàn giao dịch (MEXC, Gate.io) sử dụng chiến lược **Open-Close (OC) Pattern**. Hệ thống bao gồm:

- **Backend**: Node.js/Express API với các cron jobs tự động
- **Frontend**: React + TypeScript dashboard quản lý
- **Database**: MySQL lưu trữ bots, strategies, positions, candles, transactions
- **Telegram Bot**: Thông báo real-time về trades và events

---

## 🏗️ KIẾN TRÚC BACKEND

### **1. Database Schema (MySQL)**

#### **Bảng `bots`**
- Quản lý thông tin bot và credentials
- **Fields chính**:
  - `bot_name`, `exchange` (mexc/gate)
  - `access_key`, `secret_key`, `uid` (MEXC), `proxy`
  - `telegram_chat_id` (thông báo)
  - `future_balance_target`, `spot_transfer_threshold`, `transfer_frequency`
  - `withdraw_enabled`, `withdraw_address`, `spot_balance_threshold`
  - `is_active`

#### **Bảng `strategies`**
- Chiến lược trading cho mỗi bot
- **Fields chính**:
  - `bot_id`, `symbol` (BTC/USDT), `trade_type` (long/short/both)
  - `interval` (1m, 3m, 5m, 15m, 30m, 1h)
  - `oc` (Open-Close threshold %)
  - `extend` (Entry trigger %)
  - `amount` (Position size USDT)
  - `take_profit` (TP %)
  - `reduce`, `up_reduce` (Stop Loss động)
  - `ignore` (Ignore threshold cho opposite candles)
  - `is_active`

#### **Bảng `positions`**
- Theo dõi các vị thế đang mở/đã đóng
- **Fields chính**:
  - `strategy_id`, `order_id`, `symbol`, `side` (long/short)
  - `entry_price`, `amount`, `take_profit_price`, `stop_loss_price`
  - `current_reduce`, `minutes_elapsed` (cho dynamic SL)
  - `status` (open/closed/cancelled)
  - `pnl`, `close_price`, `close_reason` (tp_hit/sl_hit/manual/candle_end)
  - `opened_at`, `closed_at`

#### **Bảng `candles`**
- Lưu trữ dữ liệu nến từ exchange
- **Fields**: `symbol`, `interval`, `open_time`, `open`, `high`, `low`, `close`, `volume`, `close_time`

#### **Bảng `transactions`**
- Lịch sử transfer và withdraw
- **Fields**: `bot_id`, `type` (spot_to_future/future_to_spot/withdraw), `amount`, `status`, `error_message`

---

### **2. Core Services**

#### **ExchangeService**
- Kết nối với exchange (MEXC/Gate) qua CCXT
- Quản lý API credentials, proxy
- Functions: `getTickerPrice()`, `placeOrder()`, `getBalance()`, `transfer()`, `withdraw()`

#### **CandleService**
- Lấy và cập nhật dữ liệu nến từ exchange
- Tính toán OC (Open-Close %), direction (up/down)
- Functions: `updateCandles()`, `getLatestCandle()`, `calculateOC()`, `isCandleClosed()`

#### **StrategyService**
- Logic phát hiện tín hiệu trading
- **Quy trình**:
  1. Lấy latest candle từ DB
  2. Tính OC real-time (nếu nến chưa đóng) hoặc từ close price
  3. Kiểm tra OC >= threshold
  4. Xác định side (long/short) dựa trên `trade_type` và direction
  5. Tính entry price, TP, SL
  6. Kiểm tra ignore threshold (tránh opposite candles)
  7. Trả về signal nếu đủ điều kiện

#### **OrderService**
- Thực thi lệnh trading
- Functions: `executeSignal()`, `placeOrder()`, `cancelOrder()`, `closePosition()`

#### **PositionService**
- Quản lý và cập nhật positions
- **Tính năng**:
  - Kiểm tra TP/SL và đóng position tự động
  - Cập nhật dynamic Stop Loss (giảm dần theo thời gian)
  - Tính PnL real-time

#### **TransferService**
- Tự động chuyển balance giữa Spot ↔ Futures
- **Logic**:
  - Kiểm tra `future_balance_target`
  - Nếu Futures < target: chuyển từ Spot → Futures
  - Nếu Futures > target: chuyển từ Futures → Spot
  - Chạy theo `transfer_frequency` (minutes)

#### **WithdrawService**
- Tự động rút tiền về BEP20 wallet
- **Điều kiện**:
  - `withdraw_enabled = true`
  - Spot balance >= `spot_balance_threshold`
  - Có `withdraw_address`

#### **TelegramService**
- Gửi thông báo qua Telegram
- **Events**: Position opened/closed, Balance transfer, Withdraw, Errors

---

### **3. Cron Jobs (Tự động hóa)**

#### **CandleUpdater** ⏰
- **Tần suất**: Mỗi 1 phút (configurable)
- **Chức năng**: Cập nhật dữ liệu nến cho tất cả active strategies
- **Logic**: Group theo `bot_id + symbol + interval` để tránh duplicate

#### **SignalScanner** ⏰
- **Tần suất**: Mỗi 10 giây (configurable)
- **Chức năng**: Quét tất cả active strategies để tìm trading signals
- **Logic**:
  1. Lấy danh sách active strategies (có cache)
  2. Kiểm tra strategy đã có open position chưa
  3. Gọi `StrategyService.checkSignal()`
  4. Nếu có signal → `OrderService.executeSignal()`
  5. Xử lý batch (5 strategies/lần) để tránh rate limit

#### **PositionMonitor** ⏰
- **Tần suất**: Mỗi 30 giây (configurable)
- **Chức năng**: Giám sát và cập nhật tất cả open positions
- **Logic**:
  1. Lấy danh sách open positions
  2. Cập nhật current price, PnL
  3. Kiểm tra TP/SL → đóng position nếu hit
  4. Cập nhật dynamic Stop Loss (giảm dần theo `reduce` + `up_reduce`)
  5. Kiểm tra unfilled orders (candle đã đóng nhưng order chưa fill) → cancel

#### **BalanceManager** ⏰
- **Tần suất**: 
  - Balance check: Theo `transfer_frequency` của mỗi bot (default 15 phút)
  - Withdraw check: Mỗi giờ
- **Chức năng**: Tự động quản lý balance và withdraw
- **Logic**:
  1. Kiểm tra Futures balance vs `future_balance_target`
  2. Tự động transfer Spot ↔ Futures
  3. Nếu `withdraw_enabled` và đủ điều kiện → withdraw về BEP20

---

### **4. API Endpoints**

#### **Bots Management**
- `GET /api/bots` - Lấy danh sách bots
- `GET /api/bots/:id` - Lấy chi tiết bot
- `POST /api/bots` - Tạo bot mới
- `PUT /api/bots/:id` - Cập nhật bot
- `DELETE /api/bots/:id` - Xóa bot
- `POST /api/bots/:id/toggle` - Bật/tắt bot

#### **Strategies Management**
- `GET /api/strategies?bot_id=:id` - Lấy strategies của bot
- `GET /api/strategies/:id` - Lấy chi tiết strategy
- `POST /api/strategies` - Tạo strategy mới
- `PUT /api/strategies/:id` - Cập nhật strategy
- `DELETE /api/strategies/:id` - Xóa strategy
- `POST /api/strategies/:id/toggle` - Bật/tắt strategy

#### **Positions Management**
- `GET /api/positions?status=open&bot_id=:id` - Lấy positions (filter)
- `GET /api/positions/:id` - Lấy chi tiết position
- `POST /api/positions/:id/close` - Đóng position thủ công

#### **Transactions**
- `GET /api/transactions?bot_id=:id` - Lấy lịch sử transactions

#### **Stats & Dashboard**
- `GET /api/stats` - Thống kê tổng quan:
  - Total/Active bots
  - Total/Active strategies
  - Open/Closed positions
  - Total PnL

#### **Manual Operations**
- `POST /api/transfer` - Chuyển balance thủ công
- `POST /api/withdraw` - Rút tiền thủ công

---

## 🎨 KIẾN TRÚC FRONTEND

### **1. Tech Stack**
- **Framework**: React 18+ với Vite
- **Language**: TypeScript
- **Styling**: TailwindCSS + shadcn/ui components
- **State Management**: Zustand (lightweight)
- **Data Fetching**: TanStack Query (React Query)
- **Routing**: React Router v6
- **Forms**: React Hook Form + Zod validation
- **Charts**: Recharts
- **Real-time**: Socket.io client
- **Icons**: Lucide React
- **Notifications**: React Hot Toast

### **2. Pages & Features**

#### **Dashboard Page (`/`)**
- **Stats Cards**: Total PnL, Total Volume, Active Bots, Win Rate
- **PnL Chart**: Biểu đồ PnL theo thời gian (24h/7d/30d/all)
- **Active Bots Widget**: Danh sách bots đang chạy với status
- **Recent Trades**: 10 positions gần nhất

#### **Bots Page (`/bots`)**
- **Bot List**: Grid view các bot cards
- **Bot Card**: Hiển thị:
  - Bot name, Exchange, Status (Active/Paused)
  - PnL, Số strategies, Số open positions
  - Actions: View, Edit, Delete
- **Bot Form Dialog**: 
  - Thêm/Sửa bot
  - Form fields: Bot name, Exchange, API keys, Proxy, Balance settings, Withdraw settings, Telegram Chat ID
  - Validation với Zod schema

#### **Bot Detail Page (`/bots/:id`)**
- **Stats Cards**: Balance, Open Positions, Today PnL, Total Volume
- **Tabs**: Strategies, Positions, Transactions, Settings
- **Strategies Tab**: 
  - Danh sách strategies của bot
  - Strategy cards với thông tin: Symbol, Trade Type, Interval, Parameters, Stats
  - Actions: Edit, Delete, Toggle Active
- **Positions Tab**: Bảng positions đang mở/đã đóng
- **Transactions Tab**: Lịch sử transfers và withdrawals

#### **Strategies Page (`/bots/:botId/strategies`)**
- **Strategy List**: Danh sách strategies
- **Strategy Form Dialog**:
  - **Basic Settings**: Symbol, Trade Type, Interval
  - **Strategy Parameters**: 
    - OC (%) - slider với tooltip
    - Extend (%) - slider với tooltip
    - Amount ($) - input
    - Take Profit - slider (stored as 40 = 4%)
    - Reduce, Up Reduce - sliders
    - Ignore (%) - slider
  - **Strategy Calculator**: 
    - Visual calculator hiển thị entry price, TP, profit cho LONG và SHORT
    - Tính toán real-time khi thay đổi parameters
    - Input "Open Price" để simulate

#### **Positions Page (`/positions`)**
- **Open Positions Table**:
  - Columns: Symbol, Side, Entry Price, Current Price, TP, PnL, Action
  - Filters: Bot, Symbol, Side
  - Auto-refresh toggle
  - Real-time updates qua WebSocket
- **Closed Positions Table**:
  - Columns: Symbol, Side, Entry, Close, PnL, Reason, Time
  - Filters tương tự
- **Position Detail Dialog**:
  - Chi tiết position: Entry, Current, TP, SL, PnL, Time elapsed
  - Mini price chart
  - Close Position button

#### **Transactions Page (`/transactions`)**
- **Transactions Table**:
  - Columns: Time, Type, Amount, Status, Bot
  - Filters: Type, Bot, Date range

#### **Settings Page (`/settings`)**
- **Tabs**: General, Notifications, Security, API
- **General**: Currency, Timezone, Theme, Auto-refresh interval

---

### **3. Components Structure**

#### **UI Components** (`components/ui/`)
- `button.tsx`, `card.tsx`, `dialog.tsx`, `form.tsx`
- `input.tsx`, `select.tsx`, `table.tsx`, `tabs.tsx`
- `badge.tsx`, `switch.tsx`, `tooltip.tsx`

#### **Layout Components** (`components/layout/`)
- `Sidebar.tsx` - Navigation sidebar với collapse
- `Header.tsx` - Top header
- `MainLayout.tsx` - Wrapper layout
- `PageHeader.tsx` - Page title và actions

#### **Feature Components**
- **Dashboard**: `StatsCard.tsx`, `PnLChart.tsx`, `ActiveBotsWidget.tsx`, `RecentTrades.tsx`
- **Bots**: `BotCard.tsx`, `BotList.tsx`, `BotForm.tsx`, `BotStatus.tsx`, `BotStats.tsx`
- **Strategies**: `StrategyCard.tsx`, `StrategyList.tsx`, `StrategyForm.tsx`, `StrategyCalculator.tsx`
- **Positions**: `PositionTable.tsx`, `PositionCard.tsx`, `PositionChart.tsx`, `ClosePositionDialog.tsx`
- **Common**: `LoadingSpinner.tsx`, `EmptyState.tsx`, `ErrorBoundary.tsx`, `ConfirmDialog.tsx`

---

### **4. State Management & Hooks**

#### **Zustand Stores** (`store/`)
- `botStore.ts` - Quản lý bots state
- `strategyStore.ts` - Quản lý strategies state
- `uiStore.ts` - UI state (sidebar collapsed, theme, etc.)

#### **React Query Hooks** (`hooks/`)
- `useBots.ts` - Fetch/mutate bots
- `useStrategies.ts` - Fetch/mutate strategies
- `usePositions.ts` - Fetch/mutate positions
- `useDashboard.ts` - Fetch dashboard stats
- `useWebSocket.ts` - WebSocket connection
- `useRealTimeUpdates.ts` - Real-time data updates

#### **API Service** (`services/api.ts`)
- Wrapper cho tất cả API calls
- Error handling
- Response normalization

---

## 🔄 QUY TRÌNH HOẠT ĐỘNG

### **1. Setup Bot**
1. User tạo bot mới qua Frontend
2. Nhập API credentials (access_key, secret_key)
3. Cấu hình balance settings, withdraw settings
4. Bot được lưu vào database với `is_active = true`

### **2. Tạo Strategy**
1. User chọn bot → tạo strategy
2. Cấu hình:
   - Symbol (BTC/USDT), Trade Type (long/short/both)
   - Interval (1m, 3m, 5m, ...)
   - OC threshold, Extend, Amount, TP, Reduce, Ignore
3. Strategy được lưu vào database với `is_active = true`

### **3. Tự động Trading (Cron Jobs)**

#### **Bước 1: CandleUpdater**
- Mỗi 1 phút: Cập nhật dữ liệu nến từ exchange → database

#### **Bước 2: SignalScanner**
- Mỗi 10 giây: Quét strategies
- Với mỗi strategy:
  1. Lấy latest candle từ DB
  2. Tính OC real-time (nếu nến chưa đóng) hoặc từ close price
  3. Nếu `|OC| >= threshold`:
     - Xác định direction (up/down)
     - Kiểm tra `trade_type` → quyết định side (long/short/both)
     - Tính entry price, TP, SL
     - Kiểm tra ignore threshold (tránh opposite candles)
     - Nếu đủ điều kiện → tạo signal
  4. Nếu có signal → `OrderService.executeSignal()`:
     - Place order trên exchange
     - Tạo position trong database
     - Gửi Telegram notification

#### **Bước 3: PositionMonitor**
- Mỗi 30 giây: Giám sát open positions
- Với mỗi position:
  1. Lấy current price từ exchange
  2. Tính PnL
  3. Kiểm tra TP/SL:
     - Nếu `current_price >= TP` (long) hoặc `current_price <= TP` (short) → Close position (TP hit)
     - Nếu `current_price <= SL` (long) hoặc `current_price >= SL` (short) → Close position (SL hit)
  4. Cập nhật dynamic Stop Loss:
     - `new_SL = old_SL + (reduce + up_reduce * minutes_elapsed)`
  5. Nếu position đóng → Gửi Telegram notification với PnL

#### **Bước 4: BalanceManager**
- Mỗi 15 phút (hoặc theo `transfer_frequency`):
  1. Kiểm tra Futures balance
  2. Nếu `Futures < future_balance_target`:
     - Transfer từ Spot → Futures
  3. Nếu `Futures > future_balance_target`:
     - Transfer từ Futures → Spot
- Mỗi giờ:
  1. Nếu `withdraw_enabled = true` và `Spot >= spot_balance_threshold`:
     - Withdraw về BEP20 wallet

---

## 📊 CHIẾN LƯỢC TRADING (OC Pattern)

### **Nguyên lý**
- **OC (Open-Close)**: Phần trăm thay đổi giá từ mở nến đến đóng nến
- **Signal**: Khi `|OC| >= threshold` → có thể vào lệnh

### **Ví dụ: LONG Signal**
1. Nến mở tại $50,000
2. Giá hiện tại $50,500 → OC = +1%
3. Nếu `oc_threshold = 1%` và `extend = 50%`:
   - Entry price = $50,000 × (1 - 1% × 50%) = $49,750
   - Nếu giá chạm $49,750 → Vào lệnh LONG
   - TP = Entry × (1 + TP%) = $49,750 × 1.004 = $49,949
   - SL = Entry × (1 - SL%) = $49,750 × 0.996 = $49,551

### **Dynamic Stop Loss**
- SL tự động di chuyển gần entry price theo thời gian
- `new_SL = old_SL + (reduce + up_reduce × minutes_elapsed)`
- Giảm rủi ro khi position đang profit

### **Ignore Threshold**
- Tránh vào lệnh khi có opposite candle (ví dụ: LONG khi có SHORT candle mạnh)
- Nếu `|OC_opposite| >= ignore_threshold` → Skip signal

---

## 🔔 TELEGRAM NOTIFICATIONS

### **Events được gửi thông báo**
1. **Position Opened**: Symbol, Side, Entry Price, Amount
2. **Position Closed**: Symbol, Side, PnL, Close Reason (TP/SL/Manual)
3. **Balance Transfer**: Type, Amount, Status
4. **Withdraw**: Amount, Address, Status
5. **Errors**: Bot errors, API errors, Order failures

---

## 🧪 TESTING

### **Unit Tests**
- **Calculator Utils**: Test các hàm tính toán (OC, entry, TP, SL, PnL)
- **Models**: Test database operations (Bot, Strategy, Position, Candle)
- **Services**: Test business logic (CandleService, StrategyService, OrderService)

### **Test Coverage**
- Jest với ESM support
- Babel config cho ES Modules
- Mock database và external services

---

## 🚀 DEPLOYMENT

### **Backend**
- Node.js server trên port 3000
- MySQL database (Docker)
- Environment variables: Database config, Telegram bot token, API keys

### **Frontend**
- Vite build → static files
- Serve qua nginx hoặc CDN
- Proxy `/api` và `/socket.io` đến backend

---

## 📝 TÓM TẮT TÍNH NĂNG CHÍNH

✅ **Quản lý Bots**: Tạo, sửa, xóa, bật/tắt bots  
✅ **Quản lý Strategies**: Tạo chiến lược trading với parameters chi tiết  
✅ **Tự động Trading**: Phát hiện signals và thực thi orders tự động  
✅ **Quản lý Positions**: Giám sát, cập nhật, đóng positions tự động  
✅ **Balance Management**: Tự động transfer Spot ↔ Futures  
✅ **Auto Withdraw**: Tự động rút tiền về BEP20 wallet  
✅ **Real-time Updates**: WebSocket cho positions và stats  
✅ **Telegram Notifications**: Thông báo real-time về trades  
✅ **Dashboard**: Thống kê tổng quan, charts, recent trades  
✅ **Responsive UI**: Mobile-friendly với TailwindCSS  
✅ **Type Safety**: TypeScript cho cả backend và frontend  
✅ **Error Handling**: Comprehensive error logging và user feedback  

---

**Hệ thống hoàn toàn tự động hóa từ việc phát hiện signals đến quản lý positions và balance, giúp người dùng không cần can thiệp thủ công trong quá trình trading.**
