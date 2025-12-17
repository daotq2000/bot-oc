# Kiến trúc Price Alert & Strategies - Tách biệt hoàn toàn

## 📋 Tổng quan

Hệ thống đã được tái cấu trúc để **tách biệt hoàn toàn** giữa **Price Alert Logic** và **Strategies Logic**, đảm bảo:

- ✅ **Price Alert luôn chạy** (always-on), không phụ thuộc vào Strategies
- ✅ **Strategies chỉ chạy** khi có active strategies
- ✅ **Error isolation**: Lỗi ở một logic không ảnh hưởng đến logic kia
- ✅ **Lifecycle độc lập**: Mỗi logic có lifecycle riêng

---

## 🏗️ Kiến trúc

### 1. Price Alert Worker (`src/workers/PriceAlertWorker.js`)

**Đặc điểm:**
- ✅ **Luôn chạy** (always-on)
- ✅ **Không phụ thuộc** vào Strategies
- ✅ **Error boundary riêng** - lỗi không làm crash hệ thống
- ✅ Quản lý: `PriceAlertScanner`, `OcAlertScanner`

**Chức năng:**
- Khởi tạo và quản lý Price Alert scanners
- Refresh tracking symbols từ `price_alert_config` và `symbol_filters`
- Subscribe WebSocket cho Price Alert symbols
- Đảm bảo Price Alert luôn hoạt động

### 2. Strategies Worker (`src/workers/StrategiesWorker.js`)

**Đặc điểm:**
- ⚙️ **Chỉ chạy khi có active strategies**
- ✅ **Tách biệt hoàn toàn** với Price Alert
- ✅ **Error boundary riêng** - lỗi không ảnh hưởng đến Price Alert
- ✅ Quản lý: `SignalScanner`, `CandleUpdater`, `PositionMonitor`, `BalanceManager`

**Chức năng:**
- Kiểm tra active strategies định kỳ
- Tự động start/stop dựa trên số lượng active strategies
- Subscribe WebSocket cho Strategy symbols
- Quản lý lifecycle của Strategies system

### 3. Price Alert Symbol Tracker (`src/services/PriceAlertSymbolTracker.js`)

**Đặc điểm:**
- ✅ Quản lý tracking symbols tập trung
- ✅ Logic fallback rõ ràng
- ✅ Cache để tối ưu performance

**Logic tracking symbols:**

```
1. Kiểm tra cột symbols trong price_alert_config:
   ├─ Nếu symbols ≠ [] (không rỗng)
   │  └─ Parse và sử dụng symbols từ config
   │
   └─ Nếu symbols = [] (rỗng)
      └─ Fallback: Query symbol_filters table
         └─ Lấy symbols theo exchange (mexc, binance)
```

**Kết quả:**
- `trackingSymbols`: Map<exchange, Set<symbol>>
- Unique symbols per exchange
- Tự động refresh định kỳ

---

## 📁 Cấu trúc Files

```
src/
├── workers/
│   ├── PriceAlertWorker.js      # Worker cho Price Alert (always-on)
│   └── StrategiesWorker.js      # Worker cho Strategies (conditional)
│
├── services/
│   └── PriceAlertSymbolTracker.js  # Quản lý tracking symbols
│
├── jobs/
│   ├── PriceAlertScanner.js     # Scanner cho price alerts
│   ├── OcAlertScanner.js        # Scanner cho OC alerts
│   └── SignalScanner.js         # Scanner cho strategies (được quản lý bởi StrategiesWorker)
│
└── app.js                        # Khởi tạo và quản lý workers
```

---

## 🔄 Flow hoạt động

### Price Alert Flow

```
app.js
  └─> PriceAlertWorker.initialize()
      ├─> PriceAlertSymbolTracker.refresh()
      │   ├─> Load từ price_alert_config
      │   └─> Fallback: Load từ symbol_filters (nếu symbols rỗng)
      │
      ├─> PriceAlertScanner.initialize()
      ├─> OcAlertScanner.initialize()
      └─> Subscribe WebSocket cho Price Alert symbols
      
  └─> PriceAlertWorker.start()
      ├─> PriceAlertScanner.start()
      └─> OcAlertScanner.start()
```

### Strategies Flow

```
app.js
  └─> StrategiesWorker.initialize()
      ├─> SignalScanner.initialize()
      ├─> CandleUpdater.initialize()
      ├─> PositionMonitor.initialize()
      └─> BalanceManager.initialize()
      
  └─> StrategiesWorker.checkAndSubscribe()
      ├─> Kiểm tra active strategies
      ├─> Nếu có: start() và subscribe WebSocket
      └─> Nếu không: stop()
```

---

## 🛡️ Error Isolation

### Price Alert Worker

```javascript
try {
  // Price Alert operations
} catch (error) {
  logger.error('[PriceAlertWorker] Error:', error);
  // Continue - Price Alert should be resilient
  // Không throw - đảm bảo không crash hệ thống
}
```

### Strategies Worker

```javascript
try {
  // Strategies operations
} catch (error) {
  logger.error('[StrategiesWorker] Error:', error);
  // Continue - Strategies failure should not affect Price Alert
  // Không throw - đảm bảo Price Alert vẫn hoạt động
}
```

---

## ⚙️ Configuration

### Price Alert Configs

```javascript
PRICE_ALERT_SYMBOL_REFRESH_INTERVAL_MS = 30000  // Refresh symbols mỗi 30s
PRICE_ALERT_WS_SUBSCRIBE_INTERVAL_MS = 60000    // Update WS subscriptions mỗi 60s
PRICE_ALERT_CHECK_ENABLED = true                // Enable Price Alert
PRICE_ALERT_USE_SYMBOL_FILTERS = true           // Fallback to symbol_filters
PRICE_ALERT_MAX_SYMBOLS = 5000                   // Max symbols per exchange
```

### Strategies Configs

```javascript
STRATEGIES_CHECK_INTERVAL_MS = 30000            // Check active strategies mỗi 30s
STRATEGIES_WS_SUBSCRIBE_INTERVAL_MS = 60000     // Update WS subscriptions mỗi 60s
```

---

## ✅ Kết quả đạt được

### 1. Tách biệt hoàn toàn

- ✅ Price Alert và Strategies có lifecycle riêng
- ✅ Không dùng chung error handling
- ✅ Không phụ thuộc lẫn nhau

### 2. Price Alert luôn chạy

- ✅ Always-on, không phụ thuộc vào Strategies
- ✅ Tiếp tục hoạt động ngay cả khi Strategies crash
- ✅ Error boundary riêng đảm bảo không crash

### 3. Strategies conditional

- ✅ Chỉ chạy khi có active strategies
- ✅ Tự động start/stop dựa trên số lượng strategies
- ✅ Error boundary riêng không ảnh hưởng Price Alert

### 4. Tracking symbols rõ ràng

- ✅ Logic fallback rõ ràng: config → symbol_filters
- ✅ Unique symbols per exchange
- ✅ Cache để tối ưu performance
- ✅ Tự động refresh định kỳ

### 5. Dễ mở rộng

- ✅ Code rõ ràng, tách biệt trách nhiệm
- ✅ Dễ thêm exchange mới (chỉ cần thêm vào PriceAlertSymbolTracker)
- ✅ Dễ test từng component riêng biệt

---

## 🚀 Sử dụng

### Khởi động hệ thống

```bash
npm start
```

Hệ thống sẽ tự động:
1. Khởi tạo Price Alert Worker (always-on)
2. Khởi tạo Strategies Worker (conditional)
3. Subscribe WebSocket cho từng worker
4. Bắt đầu scan theo interval

### Kiểm tra status

```javascript
// Price Alert status
priceAlertWorker.getStatus()

// Strategies status
strategiesWorker.getStatus()
```

---

## 📝 Notes

- **Price Alert** luôn được ưu tiên và đảm bảo hoạt động
- **Strategies** có thể fail mà không ảnh hưởng đến Price Alert
- Mỗi worker có error boundary riêng
- WebSocket subscriptions được quản lý riêng cho từng worker

