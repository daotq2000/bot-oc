# Changelog

## [2026-01-15] - Improve WebSocket Latency Handling: Immediate Reconnect + Skip Stale Messages

### Tổng quan
Cải thiện xử lý latency cao trong WebSocket để phản ứng nhanh hơn và tránh sử dụng stale data:
1. Immediate reconnect khi detect extreme latency (> 5s)
2. Giảm thresholds để phản ứng nhanh hơn
3. Skip stale messages (> 3s latency) để tránh sử dụng dữ liệu cũ

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **Thêm extreme latency threshold**: 5000ms - reconnect ngay lập tức khi detect
- **Giảm highLatencyCountThreshold**: Từ 10 xuống 5 events
- **Giảm latencyCheckWindow**: Từ 30s xuống 10s để phản ứng nhanh hơn
- **Immediate reconnect**: Reconnect ngay khi latency > 5s (không chờ 5 events)
- **Skip stale messages**: Bỏ qua messages có latency > 3s để tránh sử dụng stale data

### Lợi ích
1. **Phản ứng nhanh hơn**: Reconnect ngay khi detect extreme latency (> 5s)
2. **Tránh stale data**: Skip messages có latency > 3s
3. **Better thresholds**: Giảm thresholds để phát hiện và xử lý latency cao sớm hơn
4. **Performance**: Không xử lý stale messages, giảm CPU load

### Cấu hình
- `highLatencyThreshold`: 2000ms (2 giây)
- `extremeLatencyThreshold`: 5000ms (5 giây) - reconnect immediately
- `highLatencyCountThreshold`: 5 events (giảm từ 10)
- `latencyCheckWindow`: 10000ms (10 giây, giảm từ 30s)
- Stale message threshold: 3000ms (3 giây) - skip messages

### Lưu ý
- Extreme latency (> 5s) sẽ trigger immediate reconnect
- Messages có latency > 3s sẽ bị skip để tránh stale data
- Persistent high latency (5+ events > 2s trong 10s) sẽ trigger reconnect

---

## [2026-01-15] - Optimize WebSocket Latency: Auto-Reconnect + Non-blocking Processing

### Tổng quan
Tối ưu hóa WebSocket để giảm latency và tự động reconnect khi latency cao liên tục:
1. Thêm latency monitoring và auto-reconnect khi latency cao liên tục
2. Tối ưu message processing để không block WebSocket event loop
3. Kiểm tra network và server load

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **Thêm latency monitoring**: Track latency history trong 30 giây, tự động reconnect nếu có 10+ lần latency > 2000ms
- **Non-blocking message processing**: Sử dụng `setImmediate()` để defer message processing, không block WebSocket event loop
- **Auto-reconnect on persistent high latency**: Tự động reconnect khi detect latency cao liên tục
- **Configurable thresholds**: 
  - `highLatencyThreshold`: 2000ms (default)
  - `highLatencyCountThreshold`: 10 events (default)
  - `latencyCheckWindow`: 30000ms (30 seconds)

### Lợi ích
1. **Giảm latency**: Non-blocking processing giúp WebSocket nhận message nhanh hơn
2. **Auto-recovery**: Tự động reconnect khi latency cao liên tục, không cần manual intervention
3. **Better monitoring**: Track latency history để debug và optimize
4. **Performance**: Không block WebSocket event loop, giúp xử lý message nhanh hơn

### Kết quả kiểm tra
- **Network**: Ping đến Binance bị block (ICMP), nhưng HTTP/WebSocket vẫn hoạt động (0.4s response time)
- **Server Load**: 
  - CPU: 16% user, 4.9% sys (load average: 1.95-2.21)
  - Memory: 9.4GB/31GB used (30%), 20GB available
  - Disk: 78% used (171GB/234GB)
- **Status**: Server load bình thường, không có bottleneck

### Lưu ý
- Auto-reconnect chỉ trigger khi có 10+ lần latency > 2000ms trong 30 giây
- Message vẫn được process ngay cả khi schedule reconnect
- Reconnect được schedule async để không block message processing

---

## [2026-01-15] - Optimize OC Detection: Real-time WebSocket Integration + Faster Polling

### Tổng quan
Tối ưu hóa hệ thống detect OC để giảm delay và tránh tình trạng "long đỉnh short đáy" bằng cách:
1. Tích hợp WebSocket price handlers cho PriceAlertScanner (realtime OC detection)
2. Giảm scan interval từ 500ms xuống 100ms
3. Thêm throttling tối ưu để giảm delay trong xử lý price ticks

### Files thay đổi

#### 1. `src/jobs/PriceAlertScanner.js`
- **Thêm method `registerPriceHandlers()`**: Đăng ký WebSocket price handlers cho MEXC và Binance để detect OC realtime
- **Thêm method `handlePriceTick()`**: Xử lý price ticks từ WebSocket ngay lập tức, bypass polling delay
- **Thêm method `processPriceTickForConfigs()`**: Xử lý OC detection cho tất cả configs matching exchange/symbol
- **Giảm scan interval**: Từ 500ms xuống 100ms (config: `PRICE_ALERT_SCAN_INTERVAL_MS`)
- **Thêm throttling**: `PRICE_ALERT_TICK_MIN_INTERVAL_MS` (default 50ms) để tránh xử lý quá nhiều ticks
- **Tích hợp vào `start()`**: Gọi `registerPriceHandlers()` khi start để enable realtime detection

### Lợi ích
1. **Realtime OC Detection**: OC được detect ngay khi price tick arrives từ WebSocket, không cần chờ polling interval
2. **Giảm delay**: Từ 500ms polling delay xuống ~50ms (throttle) hoặc realtime (nếu không throttle)
3. **Tránh "long đỉnh short đáy"**: Detect OC sớm hơn giúp entry vào đúng thời điểm, không bị trễ
4. **Dual-mode**: WebSocket realtime + polling safety-net (backup khi WS miss)
5. **Performance**: Throttling giúp tránh xử lý quá nhiều ticks, giảm CPU load

### Cấu hình
- `PRICE_ALERT_SCAN_INTERVAL_MS`: Scan interval cho polling safety-net (default: 100ms, giảm từ 500ms)
- `PRICE_ALERT_TICK_MIN_INTERVAL_MS`: Throttle interval cho WebSocket price ticks (default: 50ms)

### Lưu ý
- WebSocket handlers được đăng ký khi `start()` được gọi
- Polling vẫn chạy như safety-net khi WebSocket miss ticks
- Throttling giúp tránh xử lý quá nhiều ticks cho cùng một symbol

---

## [2026-01-15] - Fix MEXC Price Alert: Missing Exchange Parameter

### Tổng quan
Sửa lỗi MEXC price alert không được gửi do thiếu parameter `exchange` trong `alertData`, khiến `sendVolatilityAlert` không xác định đúng `alertType` (price_mexc vs price_binance).

### Files thay đổi

#### 1. `src/jobs/PriceAlertScanner.js`
- **Lỗi**: Trong method `sendPriceAlert()`, khi gọi `sendVolatilityAlert()`, không truyền `exchange` vào `alertData`
- **Hậu quả**: `sendVolatilityAlert` không biết exchange là MEXC hay Binance, nên mặc định dùng `alertType='price_binance'` cho tất cả alerts
- **Fix**: Thêm `exchange` vào `alertData` khi gọi `sendVolatilityAlert()`
- **Kết quả**: MEXC alerts sẽ sử dụng đúng `alertType='price_mexc'` và bot token đúng

### Lợi ích
1. **MEXC alerts hoạt động**: MEXC alerts giờ đây sẽ sử dụng đúng bot token và alertType
2. **Phân biệt exchange**: Mỗi exchange sẽ sử dụng đúng bot token riêng của nó
3. **Debug dễ dàng**: Có thể thấy rõ alertType trong log

### Lưu ý
- Nếu vẫn thấy lỗi "Chat not found", có thể do:
  - Chat ID `-1003052914854` không tồn tại hoặc bot không có quyền gửi message
  - Cần kiểm tra lại chat ID trong database hoặc thêm bot vào group/channel

---

## [2026-01-15] - Add Threshold Debug Logging to PriceAlertScanner

### Tổng quan
Thêm log chi tiết để debug threshold check trong `PriceAlertScanner`, giúp xác định tại sao alert không được gửi.

### Files thay đổi

#### 1. `src/jobs/PriceAlertScanner.js`
- **Thay đổi**: Thêm log chi tiết cho threshold check:
  - Log khi checkAlertConfig được gọi: hiển thị config id, exchange, threshold, telegram_chat_id
  - Log khi threshold được đáp ứng: `✅ Threshold met | OC=X% >= threshold=Y% | Sending alert`
  - Log khi alert bị throttled: `⏭️ Alert throttled | timeSinceLastAlert < minAlertInterval`
  - Log khi OC dưới threshold: `⏭️ OC below threshold | OC=X% < threshold=Y%`

### Lợi ích
1. **Debug dễ dàng**: Có thể thấy chính xác tại sao alert không được gửi (threshold quá cao, throttled, v.v.)
2. **Visibility**: Có thể thấy threshold value trong config và so sánh với OC value
3. **Monitoring**: Có thể monitor threshold check trong real-time

---

## [2026-01-15] - Add detectOC Logging to PriceAlertScanner

### Tổng quan
Thêm log "detectOC" vào `PriceAlertScanner` để hiển thị khi nào OC được detect, giúp debug và monitor dễ dàng hơn.

### Files thay đổi

#### 1. `src/jobs/PriceAlertScanner.js`
- **Thay đổi**: Thêm log `detectOC` trong method `checkSymbolPrice()`:
  - Log mỗi khi OC được detect (ngay cả khi không gửi Telegram alert)
  - Format: `[PriceAlertScanner] 🔍 detectOC | EXCHANGE SYMBOL INTERVAL OC=X% (open=Y, current=Z)`
  - Giúp theo dõi tất cả các OC movements, không chỉ những cái đạt threshold

### Lợi ích
1. **Visibility**: Có thể thấy tất cả OC movements trong log, không chỉ những cái đạt threshold
2. **Debug dễ dàng**: Dễ dàng trace xem OC có được detect không và giá trị OC là bao nhiêu
3. **Monitoring**: Có thể monitor OC activity trong real-time

---

## [2026-01-15] - Fix Syntax Error in PriceAlertScanner.js

### Tổng quan
Sửa lỗi cú pháp JavaScript trong `PriceAlertScanner.js` khiến `PriceAlertWorker` không thể khởi động được.

### Files thay đổi

#### 1. `src/jobs/PriceAlertScanner.js`
- **Lỗi**: Thiếu dấu đóng ngoặc `}` cho constructor ở dòng 62
- **Fix**: Thêm dấu đóng ngoặc `}` sau dòng 62 để đóng constructor trước khi định nghĩa method `_getTrendKey()`
- **Kết quả**: `PriceAlertWorker` có thể khởi động thành công

#### 2. `src/indicators/IndicatorWarmup.js`
- **Cải thiện**: Thêm error handling chi tiết cho `fetchBinanceKlines()`:
  - Parse JSON response với try-catch riêng
  - Log chi tiết response text khi parse JSON thất bại
  - Giúp debug dễ dàng hơn khi Binance API trả về lỗi

#### 3. `src/app.js`
- **Cải thiện**: Cải thiện logging trong `catch` block của `PriceAlertWorker`:
  - Log toàn bộ stack trace thay vì chỉ error message
  - Giúp xác định chính xác vị trí lỗi trong tương lai

### Lợi ích
1. **Bot có thể khởi động**: `PriceAlertWorker` giờ đây có thể khởi động thành công
2. **Debug dễ dàng hơn**: Logging chi tiết giúp xác định lỗi nhanh chóng
3. **Robust hơn**: Error handling tốt hơn cho Binance API calls

---

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

