# Changelog

## [2024-12-XX] - Indicator Warmup Implementation (Option C: REST Snapshot) - Updated with 5m Support

### Tổng quan
Triển khai pre-warm indicators bằng cách fetch ~100 closed 1m candles và ~100 closed 5m candles từ Binance public REST API để ADX(14) đạt trạng thái "ready" ngay sau khi bot khởi động, thay vì phải đợi ~30 phút.

### Files thay đổi

#### 1. `src/indicators/IndicatorWarmup.js` (NEW, Updated)
- **Mục đích**: Service để pre-warm indicators bằng historical kline data (cả 1m và 5m)
- **Chức năng**:
  - `fetchBinanceKlines(symbol, interval, limit)`: Fetch closed candles từ Binance Futures public API (không cần auth)
    - Hỗ trợ cả `1m` và `5m` intervals
  - `warmupSymbol(exchange, symbol, state)`: Warmup 1 symbol, feed cả 1m và 5m candles vào indicator state
    - **1m candles**: Dùng cho ADX calculation (nếu state dùng 1m interval) và EMA/RSI ticks
    - **5m candles**: Dùng cho additional EMA/RSI ticks (better warmup) và future 5m ADX support
  - `warmupBatch(indicators, concurrency)`: Warmup nhiều symbols song song (mặc định 5 concurrent)
- **Đặc điểm**:
  - Fetch cả 1m và 5m candles **song song** (parallel) để tối ưu thời gian
  - Timeout 30s per symbol (cho cả 2 requests)
  - Chỉ hỗ trợ Binance (MEXC cần endpoint riêng)
  - Non-blocking, graceful error handling
  - Log chi tiết: `fed=1m:X 5m:Y total:Z` để track warmup progress

#### 2. `src/consumers/WebSocketOCConsumer.js`
- **Thay đổi**:
  - Import `IndicatorWarmup`
  - Thêm `_warmupService`, `_warmupEnabled`, `_warmupConcurrency`, `_warmedUpSymbols` vào constructor
  - Thêm method `_warmupIndicatorsForSubscribedSymbols()`:
    - Lấy tất cả FOLLOWING_TREND strategies từ strategy cache
    - Chỉ warmup Binance symbols (skip counter-trend strategies)
    - Gọi `_warmupService.warmupBatch()` để warmup song song
    - Mark symbols as warmed up sau khi warmup thành công
    - Log progress và kết quả
  - Thêm method `_warmupNewSymbols()`:
    - Tự động warmup các symbols mới khi có FOLLOWING_TREND strategy mới được thêm
    - Chỉ warmup symbols chưa được warmup (check `_warmedUpSymbols` Set)
    - Được gọi tự động trong `subscribeWebSockets()` sau khi refresh subscriptions
  - Gọi warmup trong `initialize()` sau khi register price handlers
  - Tích hợp warmup vào `subscribeWebSockets()` để warmup real-time khi có strategy mới
  - Sửa exchange key trong `processMatch()`: dùng `match.exchange` thay vì `strategy.exchange` (reliable hơn)
  - Track `warmedUp` flag trong indicator cache để tránh re-warmup

#### 3. `src/indicators/TrendIndicatorsState.js`
- **Thay đổi**:
  - Thêm method `isWarmedUp()`: Check xem indicators đã ready chưa (EMA, RSI, ADX đều có giá trị hợp lệ)

### Config mới (optional, có defaults)
- `INDICATORS_WARMUP_ENABLED` (default: `true`): Bật/tắt warmup
- `INDICATORS_WARMUP_CONCURRENCY` (default: `5`): Số symbols warmup song song

### Lợi ích
1. **Giảm downtime**: Bot có thể trade ngay sau restart thay vì đợi ~30 phút để ADX ready
2. **Real-time warmup**: Tự động warmup indicators khi có FOLLOWING_TREND strategy mới được thêm (không cần restart bot)
3. **An toàn**: Chỉ warmup FOLLOWING_TREND strategies (counter-trend không cần indicators)
4. **Non-blocking**: Warmup failure không block bot startup hoặc subscription refresh
5. **Scalable**: Batch warmup với concurrency limit để tránh rate limit
6. **Smart deduplication**: Không warmup lại những symbols đã warmup rồi (track bằng `_warmedUpSymbols` Set)

### Lưu ý
- Hiện tại chỉ hỗ trợ Binance (MEXC cần implement endpoint riêng)
- Warmup sử dụng public REST API (không cần auth), nhưng vẫn có rate limit
- Nếu warmup fail, indicators sẽ warmup dần từ live ticks (progressive warmup)

