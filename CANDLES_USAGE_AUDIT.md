# 📊 AUDIT: Services/Jobs sử dụng table `candles`

**Ngày**: 2026-01-22  
**Mục đích**: Kiểm tra tất cả services/jobs sử dụng dữ liệu từ table `candles` và mục đích sử dụng

---

## 🎯 TÓM TẮT

**Tổng số**: **6 services/jobs** sử dụng candles (trực tiếp hoặc gián tiếp)

**Phân loại**:
- **Trực tiếp DB**: 3 services (CandleDbFlusher, IndicatorWarmup, CandleService)
- **Gián tiếp (qua CandleAggregator)**: 3 services (PriceAlertScanner, RealtimeOCDetector, WebSocketOCConsumer)

---

## 📋 CHI TIẾT TỪNG SERVICE/JOB

### **1. CandleDbFlusher** (Service/Job)

**File**: `src/services/CandleDbFlusher.js`

**Sử dụng DB**:
- `Candle.bulkInsert()` - Insert closed candles vào DB
- `Candle.pruneByLimit()` - Prune old candles theo retention policy

**Mục đích**:
1. **Persist candles**: Drain closed candles từ CandleAggregator → persist vào DB
2. **Retention management**: Prune candles cũ theo retention policy (1m=600, 5m=400)

**Frequency**:
- Flush: Mỗi 10 giây (default)
- Prune: Mỗi 30 phút (default)

**Impact**:
- ✅ **WRITE**: Bulk insert closed candles
- ✅ **DELETE**: Prune old candles để giữ DB size bounded

**Dependencies**:
- `CandleAggregator` (source)
- `Candle` model (DB operations)

---

### **2. IndicatorWarmup** (Service)

**File**: `src/indicators/IndicatorWarmup.js`

**Sử dụng DB**:
- `candleService.getHistoricalCandles()` → `Candle.getCandles()` (gián tiếp)

**Mục đích**:
1. **Warmup indicators**: Fetch historical candles để warmup EMA/RSI/ADX/ATR
2. **Cache open prices**: Cache open prices từ warmup candles vào RealtimeOCDetector

**Frequency**:
- On startup: Warmup tất cả symbols
- On new symbol: Warmup khi có symbol mới

**Impact**:
- ✅ **READ**: Fetch candles từ DB để warmup indicators
- ✅ **Fallback**: Nếu DB không đủ → fetch REST API

**Dependencies**:
- `CandleService` (getHistoricalCandles)
- `TrendIndicatorsState` (feed candles vào)

**Candles cần**:
- 1m: 50 candles (default)
- 15m: 50 candles (default)
- 5m: 0 candles (default, disabled)

---

### **3. CandleService** (Service)

**File**: `src/services/CandleService.js`

**Sử dụng DB**:
- `Candle.getCandles()` - Read candles từ DB
- `Candle.bulkInsert()` - Persist candles sau REST fetch

**Mục đích**:
1. **Single source of truth**: Centralized candle fetching (Aggregator → DB → REST)
2. **Cache management**: Persist candles sau REST fetch để lần sau dùng DB

**Strategy**:
```
1. CandleAggregator (in-memory, WebSocket)
   ↓ (if not enough)
2. DB cache (candles table)
   ↓ (if not enough)
3. REST API (BinanceDirectClient)
   ↓ (after fetch)
   → Persist to DB
```

**Impact**:
- ✅ **READ**: Get candles từ DB khi Aggregator không đủ
- ✅ **WRITE**: Persist candles sau REST fetch

**Dependencies**:
- `CandleAggregator` (source 1)
- `Candle` model (source 2)
- `BinanceDirectClient` (source 3)

**Used by**:
- `IndicatorWarmup` (primary consumer)

---

### **4. PriceAlertScanner** (Job)

**File**: `src/jobs/PriceAlertScanner.js`

**Sử dụng candles**:
- `webSocketManager.getLatestCandle()` - Get latest closed candle từ CandleAggregator
- **KHÔNG trực tiếp DB** (chỉ dùng CandleAggregator)

**Mục đích**:
1. **Update ADX**: Update ADX indicator từ closed 1m candles
2. **Trend indicators**: Maintain trend indicators state cho price alerts

**Frequency**:
- Mỗi tick (real-time price update)

**Impact**:
- ⚠️ **INDIRECT**: Chỉ dùng CandleAggregator (in-memory), không trực tiếp DB
- ✅ **READ**: Get latest closed candle để update ADX

**Dependencies**:
- `CandleAggregator` (via WebSocketManager)
- `TrendIndicatorsState` (feed closed candle vào)

**Note**: Không trực tiếp sử dụng DB, nhưng candles trong CandleAggregator có thể đến từ DB (qua CandleService)

---

### **5. RealtimeOCDetector** (Service)

**File**: `src/services/RealtimeOCDetector.js`

**Sử dụng candles**:
- `webSocketManager.getLatestCandle()` - Get latest candle từ CandleAggregator
- **KHÔNG trực tiếp DB** (chỉ dùng CandleAggregator)

**Mục đích**:
1. **Get accurate open price**: Lấy open price từ latest candle để tính OC%
2. **Open price cache**: Cache open prices từ candles

**Frequency**:
- Mỗi khi cần tính OC% (real-time)

**Impact**:
- ⚠️ **INDIRECT**: Chỉ dùng CandleAggregator (in-memory), không trực tiếp DB
- ✅ **READ**: Get latest candle để lấy open price

**Dependencies**:
- `CandleAggregator` (via WebSocketManager)
- `openPriceCache` (cache open prices)

**Note**: Không trực tiếp sử dụng DB, nhưng candles trong CandleAggregator có thể đến từ DB (qua CandleService)

---

### **6. WebSocketOCConsumer** (Consumer)

**File**: `src/consumers/WebSocketOCConsumer.js`

**Sử dụng candles**:
- `webSocketManager.getLatestCandle()` - Get latest closed candles từ CandleAggregator
- **KHÔNG trực tiếp DB** (chỉ dùng CandleAggregator)

**Mục đích**:
1. **Update indicators**: Update ADX/ATR từ closed candles (1m, 5m, 15m)
2. **Filter trades**: Dùng indicators (tính từ candles) để filter trades

**Frequency**:
- Mỗi khi có OC signal (real-time)

**Impact**:
- ⚠️ **INDIRECT**: Chỉ dùng CandleAggregator (in-memory), không trực tiếp DB
- ✅ **READ**: Get latest closed candles để update indicators

**Dependencies**:
- `CandleAggregator` (via WebSocketManager)
- `TrendIndicatorsState` (feed closed candles vào)

**Note**: Không trực tiếp sử dụng DB, nhưng candles trong CandleAggregator có thể đến từ DB (qua CandleService)

---

## 📊 PHÂN LOẠI THEO MỤC ĐÍCH

### **1. Persist & Retention (WRITE/DELETE)**

**Services**:
- `CandleDbFlusher`

**Mục đích**:
- Persist closed candles vào DB
- Prune old candles theo retention policy

**DB Operations**:
- `INSERT` (bulkInsert)
- `DELETE` (pruneByLimit)

---

### **2. Indicator Warmup (READ)**

**Services**:
- `IndicatorWarmup`
- `CandleService` (supporting)

**Mục đích**:
- Fetch historical candles để warmup indicators
- Đảm bảo indicators ready trước khi trade

**DB Operations**:
- `SELECT` (getCandles)

**Candles cần**:
- 50-100 candles per symbol/interval

---

### **3. Real-time Indicator Updates (READ - Indirect)**

**Services**:
- `PriceAlertScanner`
- `RealtimeOCDetector`
- `WebSocketOCConsumer`

**Mục đích**:
- Update indicators từ closed candles (real-time)
- Get accurate open price để tính OC%

**DB Operations**:
- ⚠️ **INDIRECT**: Chỉ dùng CandleAggregator (in-memory)
- ✅ **INDIRECT READ**: Candles trong CandleAggregator có thể đến từ DB (qua CandleService)

**Note**: Không trực tiếp query DB, nhưng candles trong CandleAggregator có thể được load từ DB khi restart

---

## 🔍 FLOW TỔNG THỂ

### **Write Flow**:
```
WebSocket → CandleAggregator → CandleDbFlusher → DB (candles table)
```

### **Read Flow**:
```
IndicatorWarmup → CandleService → DB (candles table)
                                    ↓
                            CandleAggregator (in-memory)
                                    ↓
                    PriceAlertScanner / RealtimeOCDetector / WebSocketOCConsumer
```

---

## 📈 STATISTICS

### **Direct DB Usage**:
- **3 services**: CandleDbFlusher, IndicatorWarmup, CandleService
- **Operations**: INSERT, SELECT, DELETE

### **Indirect DB Usage** (via CandleAggregator):
- **3 services**: PriceAlertScanner, RealtimeOCDetector, WebSocketOCConsumer
- **Operations**: READ (from in-memory cache, có thể được load từ DB)

### **Total**:
- **6 services/jobs** sử dụng candles (trực tiếp hoặc gián tiếp)

---

## 🎯 KẾT LUẬN

### **Services trực tiếp sử dụng DB**:
1. **CandleDbFlusher**: Persist & prune candles
2. **IndicatorWarmup**: Warmup indicators từ DB
3. **CandleService**: Centralized candle fetching (DB là source 2)

### **Services gián tiếp sử dụng DB** (qua CandleAggregator):
4. **PriceAlertScanner**: Update ADX từ closed candles
5. **RealtimeOCDetector**: Get accurate open price
6. **WebSocketOCConsumer**: Update indicators từ closed candles

### **Mục đích chính**:
- **Indicator warmup**: Đảm bảo indicators ready trước khi trade
- **Real-time updates**: Update indicators từ closed candles
- **OC detection**: Get accurate open price để tính OC%
- **Persistence**: Lưu candles để dùng sau restart

---

## 💡 RECOMMENDATIONS

### **1. Monitoring**:
- Track DB read/write operations cho candles table
- Monitor CandleDbFlusher stats (insert/prune rates)
- Monitor CandleService cache hit rates (Aggregator vs DB vs REST)

### **2. Optimization**:
- Ensure indexes are optimal (đã có indexes cho common queries)
- Monitor prune frequency (30 phút có thể tối ưu)
- Consider batch read optimization nếu có nhiều concurrent reads

### **3. Documentation**:
- Document retention policy (1m=600, 5m=400)
- Document warmup requirements (50 candles default)
- Document indirect usage (via CandleAggregator)

