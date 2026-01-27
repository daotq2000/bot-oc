# 📊 Phân Tích Khả Năng Scale: 100 Bots Active

**Ngày phân tích**: 2026-01-22  
**Scenario**: 100 bots active đồng thời

---

## 🔢 Giả Định

### Bot Configuration:
- **Số bots**: 100
- **Max positions per bot**: 100 (theo `OrderService.js`)
- **Total positions tối đa**: 100 × 100 = **10,000 positions**
- **Average positions per bot**: Giả sử 50 positions/bot = **5,000 positions**

### System Configuration:
- **PositionMonitor interval**: 10s (sau fix)
- **TP batch size**: 10 positions
- **Monitoring batch size**: 8 positions
- **Max processing time per bot**: 5 phút (300,000ms)
- **WebSocket maxStreamsPerConn**: 20
- **WebSocket connection rate limit**: 300 connections/5 phút

---

## ⚠️ Các Bottleneck Tiềm Ẩn

### 1. PositionMonitor Cycle Time

#### Tính toán:
- **Total positions**: 5,000 positions
- **High-priority positions** (cần TP/SL): Giả sử 10% = 500 positions
- **Low-priority positions**: 4,500 positions

#### Processing time estimate:
```
High-priority (TP/SL placement):
- 500 positions ÷ 10 (batch size) = 50 batches
- Mỗi batch: ~500ms (API call + processing) + 200ms delay = 700ms
- Total: 50 × 700ms = 35,000ms = 35 giây

Low-priority (monitoring):
- 5,000 positions ÷ 8 (batch size) = 625 batches
- Mỗi batch: ~200ms (monitoring) + 100ms delay = 300ms
- Total: 625 × 300ms = 187,500ms = 187.5 giây = 3.1 phút

TOTAL CYCLE TIME: ~35s + 187s = 222 giây = 3.7 phút
```

#### ⚠️ VẤN ĐỀ:
- **Cycle time (3.7 phút) > Interval (10s)** → Bot sẽ không kịp xử lý hết positions trong 1 cycle
- Positions sẽ bị delay và accumulate qua các cycles
- Với 100 bots, mỗi bot có thể có nhiều positions → tổng số positions có thể > 5,000

---

### 2. Database Queries

#### Tính toán:
- **findOpen()**: 1 query cho tất cả positions
- **Per position queries**: 
  - `Position.findById()`: ~2-3 lần/position (TP/SL placement)
  - `Position.update()`: ~2-3 lần/position
  - `getOrderStatusWithRetry()`: ~1-2 lần/position (verify orders)
- **Total queries per cycle**: 
  - 1 (findOpen) + 5,000 × 5 = **~25,001 queries/cycle**
  - Với 10s interval: **~2,500 queries/second**

#### ⚠️ VẤN ĐỀ:
- Database có thể bị overload với 2,500 queries/second
- Cần connection pooling và query optimization

---

### 3. API Rate Limits

#### Binance Rate Limits:
- **Order placement**: 10 orders/second per API key
- **Order status check**: 10 requests/second per API key
- **Position query**: 5 requests/second per API key

#### Tính toán với 100 bots:
- **Mỗi bot có API key riêng**: 100 API keys
- **Total rate limit**: 100 × 10 = 1,000 orders/second
- **TP/SL placement**: 500 positions cần 1,000 orders (TP + SL)
- **Time needed**: 1,000 orders ÷ 1,000 orders/s = **1 giây** ✅ (OK)

#### ⚠️ VẤN ĐỀ:
- Nếu tất cả bots dùng chung API key → chỉ có 10 orders/second
- Với 1,000 orders cần: 1,000 ÷ 10 = **100 giây** ❌ (QUÁ CHẬM)

---

### 4. WebSocket Connections

#### Tính toán:
- **Symbols per bot**: Giả sử 50 symbols/bot
- **Total symbols**: 100 × 50 = 5,000 symbols (có thể trùng lặp)
- **Unique symbols**: Giả sử 1,000 unique symbols
- **Streams needed**: 1,000 symbols × 1 stream = 1,000 streams
- **Connections needed**: 1,000 ÷ 20 = **50 connections**

#### ⚠️ VẤN ĐỀ:
- **Connection rate limit**: 300 connections/5 phút = 1 connection/second
- **Time to establish 50 connections**: 50 giây (OK nếu spread out)
- Nhưng nếu cần reconnect nhiều → có thể hit rate limit

---

### 5. Memory Usage

#### Tính toán:
- **ExchangeService per bot**: ~10MB/bot = 100 × 10MB = **1GB**
- **PositionService per bot**: ~5MB/bot = 100 × 5MB = **500MB**
- **WebSocketManager**: ~100MB
- **PositionMonitor caches**: ~50MB
- **Total estimated**: **~1.65GB**

#### ✅ OK:
- Với 32GB RAM, 1.65GB chỉ chiếm ~5% → Còn nhiều headroom

---

### 6. Event Loop Delay

#### Tính toán:
- **Blocking operations per cycle**:
  - Database queries: ~25,000 queries × 5ms = 125,000ms = 125s (parallel)
  - API calls: ~1,000 calls × 100ms = 100,000ms = 100s (parallel)
  - Processing: ~5,000 positions × 10ms = 50,000ms = 50s (parallel)
- **Total blocking time**: ~275s (nhưng parallel nên thực tế ~30-60s)

#### ⚠️ VẤN ĐỀ:
- Với 10s interval và 30-60s processing time → Event loop sẽ bị block
- Watchdog sẽ trigger degrade mode thường xuyên
- WebSocket messages sẽ bị stale

---

## 🚨 KẾT LUẬN: Bot KHÔNG CÂN NỔI với 100 bots

### Vấn đề chính:
1. ❌ **Cycle time (3.7 phút) > Interval (10s)** → Positions bị delay nghiêm trọng
2. ❌ **Database queries quá nhiều** → 2,500 queries/second có thể overload DB
3. ❌ **Event loop delay** → 30-60s blocking time với 10s interval
4. ⚠️ **API rate limits** → OK nếu mỗi bot có API key riêng, nhưng không OK nếu shared

---

## 💡 GIẢI PHÁP ĐỀ XUẤT

### 1. Tăng PositionMonitor Interval (Tạm thời)
- **Từ 10s → 30s hoặc 60s** cho 100 bots
- Trade-off: Positions mới sẽ có TP/SL chậm hơn (30-60s thay vì 10-15s)
- Nhưng đảm bảo cycle hoàn thành trước cycle tiếp theo

### 2. Tối Ưu Database Queries
- **Batch queries**: Thay vì 5,000 queries riêng lẻ, batch thành 100 queries
- **Connection pooling**: Tăng pool size lên 50-100 connections
- **Query optimization**: Index trên `status`, `bot_id`, `opened_at`
- **Caching**: Cache positions trong memory, chỉ refresh mỗi 5-10s

### 3. Tối Ưu Processing
- **Parallel processing**: Process nhiều bots đồng thời (đã có)
- **Skip low-priority positions**: Chỉ monitor positions có TP/SL, skip positions đã có đầy đủ
- **Throttle ADV_TPSL**: Giảm ADV_TPSL processing khi có nhiều bots

### 4. Horizontal Scaling
- **Multiple instances**: Chia 100 bots thành 2-3 instances
  - Instance 1: Bots 1-33
  - Instance 2: Bots 34-66
  - Instance 3: Bots 67-100
- **Load balancing**: Distribute bots across instances

### 5. Optimize Event Loop
- **Worker threads**: Move heavy operations (OHLCV fetching, indicators) to worker threads
- **Async batching**: Process positions in smaller, non-blocking batches
- **Defer non-critical work**: Delay ADV_TPSL processing khi system busy

### 6. Database Optimization
- **Read replicas**: Use read replicas cho `findOpen()` queries
- **Partitioning**: Partition positions table by `bot_id` hoặc `created_at`
- **Materialized views**: Pre-compute open positions count per bot

---

## 📊 KỊCH BẢN TỐI ƯU

### Configuration cho 100 bots:
```javascript
POSITION_MONITOR_INTERVAL_MS = 30000  // 30s (tăng từ 10s)
POSITION_MONITOR_BATCH_SIZE = 10     // Tăng từ 5
POSITION_MONITOR_TP_BATCH_SIZE = 20  // Tăng từ 10
POSITION_MONITOR_MONITORING_BATCH_SIZE = 15  // Tăng từ 8
ADV_TPSL_MAX_POSITIONS_PER_CYCLE = 10  // Giảm từ 25
ADV_TPSL_ENABLED = false  // Tắt khi có > 50 bots
```

### Expected performance:
- **Cycle time**: ~2-3 phút (vẫn > 30s interval, nhưng acceptable)
- **TP/SL delay**: 30-60s (thay vì 10-15s)
- **Database load**: ~500 queries/second (giảm từ 2,500)
- **Event loop delay**: ~10-20s (giảm từ 30-60s)

---

## 🎯 KHUYẾN NGHỊ

### Ngắn hạn (1-2 tuần):
1. ✅ Tăng PositionMonitor interval lên 30s
2. ✅ Tối ưu database queries (batch, caching)
3. ✅ Giảm ADV_TPSL processing
4. ✅ Monitor performance metrics

### Trung hạn (1-2 tháng):
1. ⚠️ Implement horizontal scaling (multiple instances)
2. ⚠️ Database read replicas
3. ⚠️ Worker threads cho heavy operations

### Dài hạn (3-6 tháng):
1. 🔮 Microservices architecture
2. 🔮 Message queue (RabbitMQ/Kafka) cho position updates
3. 🔮 Redis caching layer
4. 🔮 Auto-scaling based on load

---

## 📈 MONITORING METRICS

Cần monitor các metrics sau khi scale lên 100 bots:
- PositionMonitor cycle time
- Database query time và throughput
- API rate limit usage
- Event loop delay
- Memory usage
- WebSocket connection count và stability
- TP/SL placement success rate và delay

---

**Kết luận**: Với configuration hiện tại, hệ thống **KHÔNG thể handle 100 bots** một cách ổn định. Cần implement các optimizations trên trước khi scale.

