# 📊 PHÂN TÍCH: Có nên dùng Database để lưu Candles?

**Ngày**: 2026-01-22  
**Context**: Bot trading với hàng trăm symbols, cần warmup indicators với 50-100 candles

---

## 🎯 TÓM TẮT ĐỀ XUẤT

**✅ NÊN DÙNG DATABASE** với chiến lược **hybrid caching**:
- **In-memory (CandleAggregator)**: Primary source cho real-time data
- **Database (candles table)**: Persistent cache cho historical data
- **REST API**: Chỉ fallback khi cả 2 nguồn trên không đủ

**Lý do**: Giảm 90%+ REST API calls, giảm rate limit, tăng tốc warmup sau restart

---

## ✅ ƯU ĐIỂM CỦA DATABASE STORAGE

### 1. **Giảm Rate Limit Dramatically** 🚀

**Vấn đề hiện tại**:
- Mỗi lần warmup indicator → fetch REST 50-100 candles
- 100 symbols × 2 intervals (1m, 15m) = **200 REST calls**
- Binance rate limit: ~1200 requests/minute → **dễ bị ban**

**Với DB cache**:
- Lần đầu: Fetch REST → lưu DB
- Lần sau: **Đọc từ DB** → **0 REST calls**
- Chỉ cần fetch REST khi:
  - Symbol mới
  - Sau restart (nếu DB thiếu data)
  - Gap trong DB (hiếm)

**Kết quả**: Giảm từ **200 REST calls/cycle** → **< 10 REST calls/cycle** (95%+ reduction)

---

### 2. **Faster Warmup After Restart** ⚡

**Không có DB**:
- Bot restart → mất toàn bộ in-memory candles
- Phải fetch REST lại từ đầu → **5-10 phút** để warmup 100 symbols

**Với DB**:
- Bot restart → load từ DB ngay lập tức
- Warmup time: **< 30 giây** (chỉ cần fetch candles mới nhất từ REST nếu thiếu)

---

### 3. **Persistent Historical Data** 📚

**Use cases**:
- Backtesting strategies
- Historical analysis
- Debugging (xem candles trong quá khứ)
- Multi-timeframe analysis

**Không có DB**: Mất hết data sau restart

**Với DB**: Giữ lại historical data, có thể query bất kỳ lúc nào

---

### 4. **Shared Data Across Services** 🔄

**Hiện tại**:
- `IndicatorWarmup` tự fetch REST
- `PriceAlertScanner` tự fetch REST
- `RealtimeOCDetector` tự fetch REST
- → **Duplicate REST calls** cho cùng symbol/interval

**Với DB**:
- Tất cả services đọc từ **cùng 1 DB cache**
- Chỉ cần fetch REST **1 lần** → tất cả services dùng chung

---

### 5. **Better Error Recovery** 🛡️

**Không có DB**:
- REST API fail → không có data → indicators không warmup được

**Với DB**:
- REST API fail → vẫn có data từ DB (có thể hơi cũ nhưng vẫn dùng được)
- Graceful degradation

---

## ❌ NHƯỢC ĐIỂM CỦA DATABASE STORAGE

### 1. **Database Load** 💾

**Vấn đề**:
- Write operations: Mỗi candle mới → INSERT/UPDATE
- Read operations: Query candles cho warmup
- Với 100+ symbols × 4 intervals × 1 candle/minute = **400+ writes/minute**

**Giải pháp**:
- **Bulk insert**: Batch nhiều candles cùng lúc (đã có `Candle.bulkInsert`)
- **Index optimization**: Index trên `(exchange, symbol, interval, open_time)`
- **Write throttling**: Không write mỗi tick, chỉ write khi candle closed

---

### 2. **Storage Space** 💿

**Tính toán**:
- Mỗi candle: ~100 bytes (exchange, symbol, interval, open_time, OHLCV, close_time)
- 100 symbols × 4 intervals × 1440 candles/day (1m) = **57.6 MB/day**
- 100 symbols × 4 intervals × 288 candles/day (5m) = **11.5 MB/day**
- **Total: ~70 MB/day** = **~2 GB/month**

**Giải pháp**:
- **Retention policy**: Chỉ giữ candles trong N ngày (ví dụ 7-30 ngày)
- **Pruning**: Xóa candles cũ định kỳ (đã có `Candle.pruneByAge`)
- **Compression**: Có thể compress old candles (optional)

---

### 3. **Stale Data Risk** ⏰

**Vấn đề**:
- DB có thể có candles cũ (không sync với exchange)
- Nếu bot offline lâu → DB data có thể không chính xác

**Giải pháp**:
- **TTL check**: Kiểm tra `close_time` của candle mới nhất
- Nếu candle mới nhất > 5 phút → fetch REST để refresh
- **Validation**: So sánh với WebSocket data để detect stale

---

### 4. **Complexity** 🔧

**Vấn đề**:
- Thêm 1 layer (DB) → phức tạp hơn
- Cần handle DB errors, connection issues
- Cần migration scripts

**Giải pháp**:
- **Graceful fallback**: Nếu DB fail → fallback về REST
- **Error handling**: Wrap DB calls trong try-catch
- **Monitoring**: Track DB performance metrics

---

## 🏗️ KIẾN TRÚC ĐỀ XUẤT

### **Hybrid Caching Strategy** (3-tier)

```
┌─────────────────────────────────────────────────┐
│ 1. CandleAggregator (In-Memory)                │
│    - Real-time candles từ WebSocket            │
│    - Fastest access (0ms)                      │
│    - Limited retention (~200 candles/symbol)   │
└─────────────────────────────────────────────────┘
                    ↓ (if not enough)
┌─────────────────────────────────────────────────┐
│ 2. Database Cache (candles table)               │
│    - Historical candles (persistent)            │
│    - Fast access (~10-50ms)                    │
│    - Retention: 7-30 days                      │
└─────────────────────────────────────────────────┘
                    ↓ (if not enough)
┌─────────────────────────────────────────────────┐
│ 3. REST API (BinanceDirectClient)              │
│    - Last resort                                │
│    - Slow access (~200-500ms)                  │
│    - Rate limited                               │
└─────────────────────────────────────────────────┘
```

---

## 📋 IMPLEMENTATION PLAN

### **Phase 1: Basic DB Caching** ✅ (Đã implement)

**Status**: ✅ COMPLETED

- `CandleService.getHistoricalCandles()`:
  1. Check CandleAggregator
  2. Check DB cache
  3. Fetch REST if needed
  4. Save to DB after REST fetch

**Kết quả**: Đã giảm REST calls đáng kể

---

### **Phase 2: Optimize DB Writes** ⏳

**Vấn đề**: Hiện tại chưa tự động write candles vào DB từ WebSocket

**Giải pháp**:
- **Periodic batch write**: Mỗi 1-5 phút, batch write candles từ CandleAggregator → DB
- **On candle close**: Write ngay khi candle closed (real-time)

**Code**:
```javascript
// In WebSocketManager or CandleAggregator
setInterval(async () => {
  const closedCandles = aggregator.getClosedCandlesSince(lastWriteTime);
  if (closedCandles.length > 0) {
    await Candle.bulkInsert(closedCandles.map(c => ({
      exchange: 'binance',
      symbol: c.symbol,
      interval: c.interval,
      open_time: c.startTime,
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume,
      close_time: c.closeTime || (c.startTime + intervalMs - 1)
    })));
    lastWriteTime = Date.now();
  }
}, 60000); // Every minute
```

---

### **Phase 3: Smart Pruning** ⏳

**Vấn đề**: DB sẽ lớn dần nếu không prune

**Giải pháp**:
- **Retention policy**: Chỉ giữ candles trong N ngày
- **Prune job**: Chạy định kỳ (mỗi ngày) để xóa candles cũ

**Code**:
```javascript
// In a cron job or scheduled task
async function pruneOldCandles() {
  const retentionDays = 7; // Keep 7 days
  const retentionMs = retentionDays * 24 * 60 * 60 * 1000;
  
  // Get all unique (exchange, symbol, interval) combinations
  const keys = await getCandleKeys();
  
  for (const { exchange, symbol, interval } of keys) {
    await Candle.pruneByAge(exchange, symbol, interval, retentionMs);
  }
}
```

---

### **Phase 4: Stale Data Detection** ⏳

**Vấn đề**: DB có thể có stale data

**Giải pháp**:
- Check `close_time` của candle mới nhất
- Nếu > 5 phút → fetch REST để refresh

**Code**:
```javascript
// In CandleService.getHistoricalCandles()
const dbCandles = await this.getFromDb(exchange, symbol, interval, limit);
if (dbCandles.length > 0) {
  const latestCandle = dbCandles[dbCandles.length - 1];
  const ageMs = Date.now() - latestCandle.startTime;
  const intervalMs = this._getIntervalMs(interval);
  
  // If latest candle is > 2 intervals old, might be stale
  if (ageMs > intervalMs * 2) {
    // Fetch REST to refresh
    const restCandles = await this.getFromRest(exchange, symbol, interval, limit);
    // Merge and update DB
  }
}
```

---

## 💡 ĐỀ XUẤT CUỐI CÙNG

### **✅ NÊN DÙNG DATABASE** với các điều kiện:

1. **✅ Implement ngay**:
   - ✅ DB caching trong `CandleService` (đã có)
   - ✅ Write candles vào DB sau REST fetch (đã có)
   - ⏳ Periodic batch write từ CandleAggregator → DB (cần thêm)

2. **✅ Optimize sau**:
   - ⏳ Retention policy (7-30 ngày)
   - ⏳ Pruning job (daily)
   - ⏳ Stale data detection

3. **✅ Monitoring**:
   - Track DB size
   - Track DB query performance
   - Track REST call reduction

---

## 📊 METRICS TO TRACK

### **Before DB Caching**:
- REST calls per warmup cycle: **200+**
- Warmup time after restart: **5-10 phút**
- Rate limit hits: **Frequent**

### **After DB Caching** (Expected):
- REST calls per warmup cycle: **< 10** (95% reduction)
- Warmup time after restart: **< 30 giây** (90% faster)
- Rate limit hits: **Rare**

---

## 🎯 KẾT LUẬN

**✅ NÊN DÙNG DATABASE** vì:

1. **Giảm rate limit**: 95%+ reduction trong REST calls
2. **Faster warmup**: 90%+ faster sau restart
3. **Persistent data**: Giữ lại historical data cho analysis
4. **Shared cache**: Tất cả services dùng chung 1 cache
5. **Cost**: Chấp nhận được (~2 GB/month, có thể prune)

**Trade-off**:
- Database load: Có thể handle được với bulk insert + indexing
- Storage: Có thể prune old data
- Complexity: Tăng một chút nhưng đáng giá

---

**Recommendation**: **✅ IMPLEMENT FULLY** với hybrid caching strategy (Aggregator → DB → REST)

