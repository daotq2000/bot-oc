# Changelog

## [2026-01-15] - CRITICAL FIX: Tick Queue + Dedicated TickProcessor (Backpressure + Profiling + Starvation Reconnect)

### Tổng quan
Cập nhật kiến trúc xử lý tick để WS thread **không bao giờ bị block**:
1. **WS onMessage** chỉ: parse → update cache/candle → enqueue tick → return
2. **TickProcessor** drain queue theo batch, chạy handlers tách khỏi WS thread
3. **Backpressure**: giới hạn queue size, drop-oldest khi quá tải
4. **Profiling**: cảnh báo handler chậm
5. **Reconnect** dựa trên starvation (thiếu tick) thay vì chỉ dựa latency

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **Tick queue**: `tickQueue`, `maxTickQueueSize`, drop-oldest + counters
- **Tick processor**: `_drainTickQueue()` batch drain + per-handler async invoke
- **WS isolation**: WS thread enqueue tick thay vì emit trực tiếp
- **Profiling**: log warn nếu handler > `BINANCE_WS_PRICE_HANDLER_SLOW_MS`
- **Starvation reconnect**: nếu `now - lastProcessedAt > BINANCE_WS_TICK_STARVATION_MS` thì trigger drain/reconnect

### Cấu hình
- `BINANCE_WS_MAX_TICK_QUEUE_SIZE` (default 10000)
- `BINANCE_WS_TICK_DRAIN_BATCH_SIZE` (default 500)
- `BINANCE_WS_TICK_STARVATION_MS` (default 5000)
- `BINANCE_WS_PRICE_HANDLER_SLOW_MS` (default 20)

### Lợi ích
- WS thread cực nhanh, không phụ thuộc consumer
- Không backlog vô hạn (có backpressure)
- Bot có thể lag nhưng không “đứng”
- Dễ truy ra handler gây chậm bằng profiling

---

## [2026-01-15] - CRITICAL FIX: Asynchronous Price Event Emission to Prevent Bot Blocking

### Tổng quan
**CRITICAL FIX**: 修复bot停止工作的根本原因 - price handlers阻塞消息处理：
1. **CRITICAL**: `_emitPrice`改为异步执行，使用setImmediate
2. 价格缓存仍然同步更新，确保`getPrice()`立即获取最新价格
3. Price handlers异步执行，不会阻塞消息处理流程

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **CRITICAL FIX**: `_emitPrice`改为异步执行（asynchronous）
- **Price cache sync**: 价格缓存仍然同步更新
- **Handlers async**: Price handlers异步执行，不阻塞消息处理

### Vấn đề
- **Bot vẫn ngừng hoạt động**: 虽然价格缓存更新了，但price handlers阻塞了消息处理
- **Handlers阻塞**: Price handlers同步执行，如果某个handler很慢，会阻塞整个消息处理
- **消息处理延迟**: 由于handlers阻塞，后续消息无法及时处理

### Nguyên nhân
1. **同步handlers**: `_emitPrice`同步执行所有handlers，如果某个handler很慢，会阻塞消息处理
2. **Handler阻塞**: 某些price handlers（如RealtimeOCDetector, PriceAlertScanner）可能执行很慢
3. **消息处理阻塞**: 由于handlers阻塞，WebSocket消息处理被阻塞

### Giải pháp
1. **异步handlers**: `_emitPrice`改为异步执行，使用setImmediate
2. **价格缓存同步**: 价格缓存仍然同步更新，确保`getPrice()`立即获取最新价格
3. **不阻塞消息处理**: Handlers异步执行，不会阻塞消息处理流程

### Cấu hình
- 无配置变更

### Lợi ích
1. **Bot不阻塞**: Price handlers异步执行，不会阻塞消息处理
2. **价格缓存立即更新**: 价格缓存仍然同步更新，`getPrice()`可以立即获取最新价格
3. **消息处理流畅**: 即使handlers很慢，消息处理也不会被阻塞

### Cơ chế hoạt động
1. **价格缓存同步更新**: 收到消息后立即更新priceCache
2. **异步触发handlers**: `_emitPrice`使用setImmediate异步触发handlers
3. **不阻塞消息处理**: 即使handlers很慢，也不会阻塞后续消息处理

### Lưu ý
- 价格缓存更新是同步的，确保`getPrice()`可以立即获取最新价格
- Price handlers是异步的，不会阻塞消息处理
- 如果handler出错，会记录错误但不会crash bot

---

## [2026-01-15] - CRITICAL FIX: Synchronous Price Updates to Prevent Bot Stopping

### Tổng quan
**CRITICAL FIX**: 修复bot停止工作的根本原因 - setImmediate队列延迟导致价格更新不及时：
1. **CRITICAL**: 价格更新改为同步执行，不再使用setImmediate
2. 只将非关键操作（logging）放在setImmediate中
3. 确保价格更新立即执行，不被event loop阻塞

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **CRITICAL FIX**: Price updates改为同步执行（synchronous）
- **setImmediate only for logging**: 只将logging操作放在setImmediate中
- **Immediate price cache update**: 价格缓存立即更新，不等待setImmediate

### Vấn đề
- **Bot vẫn ngừng hoạt động**: 虽然消息被处理了，但价格更新被延迟
- **setImmediate延迟**: 当event loop被阻塞时，setImmediate队列中的任务可能不会及时执行
- **价格更新延迟**: 价格更新在setImmediate中，导致bot无法及时获取最新价格

### Nguyên nhân
1. **setImmediate队列阻塞**: 当有很多消息时，setImmediate队列可能被阻塞
2. **价格更新延迟**: 价格更新在setImmediate中，导致延迟
3. **Event loop阻塞**: latency检查的计算可能阻塞event loop

### Giải pháp
1. **同步价格更新**: 价格更新改为同步执行，立即更新priceCache和emit price events
2. **setImmediate only for logging**: 只将非关键操作（logging）放在setImmediate中
3. **立即处理**: 确保价格更新立即执行，不被event loop阻塞

### Cấu hình
- 无配置变更

### Lợi ích
1. **Bot不停止**: 价格更新立即执行，bot可以及时获取最新价格
2. **No delay**: 价格更新不再被setImmediate延迟
3. **Immediate updates**: 价格缓存和事件立即更新

### Cơ chế hoạt động
1. **同步价格更新**: 收到消息后立即更新priceCache和emit price events
2. **异步logging**: 只将logging操作放在setImmediate中
3. **立即处理**: 确保关键操作不被延迟

### Lưu ý
- 价格更新现在是同步的，可能稍微增加event loop负载
- 但这是必要的，以确保bot及时获取价格
- Logging操作仍然是异步的，不会阻塞

---

## [2026-01-15] - Fix Bot Stopping Completely: Remove Stale Message Skip & Add Message Processing Monitoring

### Tổng quan
Sửa lỗi bot hoàn toàn ngừng hoạt động khi latency tăng:
1. **CRITICAL FIX**: Không skip message ngay cả khi latency > 3000ms (stale message)
2. Thêm message processing monitoring để track bot hoạt động
3. Cải thiện error handling để không crash bot khi có lỗi
4. Thêm message stats vào getStatus() để monitor

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **CRITICAL FIX**: Removed return khi latency > 3000ms - bot sẽ tiếp tục process message
- **Message monitoring**: Thêm `_messageStats` để track received/processed/errors
- **Error handling**: Improved error handling trong message processing, không throw để tránh crash
- **Status monitoring**: Thêm message stats vào getStatus() để monitor bot hoạt động

### Vấn đề
- **Bot hoàn toàn ngừng hoạt động**: Khi latency tăng, bot ngừng xử lý messages
- **Stale message skip**: Code return khi latency > 3000ms, skip toàn bộ message processing
- **No monitoring**: Không có cách nào biết bot có đang process messages không
- **Error crash**: Một lỗi trong message processing có thể crash toàn bộ bot

### Nguyên nhân
1. **Stale message return**: Khi latency > 3000ms, code return ở dòng 907, skip toàn bộ message processing (setImmediate ở dòng 915)
2. **No error recovery**: Lỗi trong message processing có thể crash bot
3. **No monitoring**: Không có stats để biết bot có đang hoạt động không

### Giải pháp
1. **Không skip stale message**: Chỉ log warning khi latency > 3000ms, nhưng vẫn process message
2. **Message monitoring**: Track totalReceived, totalProcessed, totalErrors, lastMessageAt, lastProcessedAt
3. **Error recovery**: Wrap message processing trong try-catch, log error nhưng không throw
4. **Status monitoring**: Thêm message stats vào getStatus() để có thể monitor bot hoạt động

### Cấu hình
- `_messageStats`: Track message processing stats
- `getStatus().messageStats`: Hiển thị message processing stats trong status

### Lợi ích
1. **Bot không ngừng hoạt động**: Message luôn được process, ngay cả khi latency cao
2. **No data loss**: Không skip message, đảm bảo không mất dữ liệu giá
3. **Monitoring**: Có thể monitor bot hoạt động qua message stats
4. **Error recovery**: Bot không crash khi có lỗi trong message processing

### Cơ chế hoạt động
1. **Message processing**: Tất cả messages được process trong setImmediate, không skip
2. **Latency warning**: Log warning khi latency > 3000ms, nhưng vẫn process
3. **Error handling**: Try-catch trong message processing, log error nhưng không throw
4. **Stats tracking**: Track received/processed/errors để monitor bot hoạt động

### Lưu ý
- Message luôn được process, ngay cả khi latency cao (>3000ms)
- Stale message chỉ log warning, không skip
- Error trong message processing không crash bot
- Message stats có thể được monitor qua getStatus()

---

## [2026-01-15] - Fix Bot Stopping When Latency Increases: Message Processing & Reconnect Storm Prevention

### Tổng quan
Sửa lỗi bot ngừng hoạt động khi latency tăng cao:
1. Không skip message processing khi phát hiện EXTREME latency
2. Thêm reconnect queue size limit để tránh reconnect storm
3. Thêm connection health check trước khi schedule reconnect
4. Cải thiện logic xử lý latency để không làm gián đoạn message processing

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **Fix message processing**: Không return khi phát hiện EXTREME latency, tiếp tục process message
- **Reconnect queue limit**: Thêm maxReconnectQueueSize (default: 50) để tránh reconnect storm
- **Connection health check**: Check connection state trước khi schedule reconnect
- **Improved error handling**: Better error handling trong reconnect scheduling

### Vấn đề
- **Bot ngừng hoạt động**: Khi latency tăng cao, bot ngừng nhận và xử lý price updates
- **Message loss**: Khi phát hiện EXTREME latency, code return sớm, bỏ qua message hiện tại
- **Reconnect storm**: Nhiều connections cùng reconnect, gây quá tải và có thể bị Binance limit
- **Connection disconnect**: Connections bị đứt do reconnect storm hoặc Binance rate limiting

### Nguyên nhân
1. **Message processing bị skip**: Khi phát hiện EXTREME latency (p95 > 4000ms), code return ở dòng 866, bỏ qua message hiện tại
2. **Reconnect storm**: Không có giới hạn queue size, nhiều connections cùng reconnect
3. **Không check connection state**: Schedule reconnect ngay cả khi connection đã đóng

### Giải pháp
1. **Tiếp tục process message**: Không return khi phát hiện EXTREME latency, chỉ schedule reconnect
2. **Reconnect queue limit**: Giới hạn queue size (default: 50), skip reconnect nếu queue đầy
3. **Connection health check**: Check connection state (OPEN/CONNECTING) trước khi schedule reconnect
4. **Better error handling**: Improved error handling trong reconnect scheduling

### Cấu hình
- `maxReconnectQueueSize`: 50 (default, có thể config qua BINANCE_WS_MAX_RECONNECT_QUEUE_SIZE)
- `extremeLatencyThreshold`: 4000ms (không đổi)
- `latencyReconnectCooldownMs`: 30s (không đổi)

### Lợi ích
1. **Bot không ngừng hoạt động**: Message vẫn được process ngay cả khi latency cao
2. **Tránh reconnect storm**: Queue limit ngăn quá nhiều connections cùng reconnect
3. **Better connection management**: Health check đảm bảo chỉ reconnect connections hợp lệ
4. **No message loss**: Message không bị skip khi phát hiện latency cao

### Cơ chế hoạt động
1. **Latency detection**: Khi phát hiện EXTREME latency, schedule reconnect nhưng vẫn tiếp tục process message
2. **Reconnect queue**: Connections được queue và process theo maxConcurrentReconnects (default: 2)
3. **Queue limit**: Nếu queue đầy (>50), skip reconnect và reset flag để retry sau
4. **Health check**: Chỉ schedule reconnect nếu connection state là OPEN hoặc CONNECTING

### Lưu ý
- Message processing không bị gián đoạn khi phát hiện latency cao
- Reconnect queue có giới hạn để tránh storm
- Connection state được check trước khi schedule reconnect
- Bot vẫn hoạt động bình thường ngay cả khi có nhiều connections cần reconnect

---

## [2026-01-15] - Fix 414 Error (URI Too Long): URL Length Limit & Connection Splitting

### Tổng quan
Sửa lỗi 414 "URI Too Long" do URL WebSocket quá dài khi có quá nhiều streams:
1. Giảm maxStreamsPerConn từ 1000 xuống 200 để tránh URL quá dài
2. Thêm URL length checking trước khi tạo connection
3. Tự động split connection nếu URL quá dài
4. Tính toán max streams dựa trên URL length limit

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **Giảm maxStreamsPerConn**: Từ 1000 xuống 200 streams/connection
- **Thêm maxUrlLength**: 8000 ký tự (an toàn dưới 8192)
- **URL length checking**: Check độ dài URL trước khi tạo connection
- **Connection splitting**: Tự động split connection nếu URL quá dài
- **Calculate max streams**: Tính toán max streams dựa trên URL length

### Vấn đề
- **Lỗi 414**: "URI Too Long" khi URL WebSocket quá dài
- **Nguyên nhân**: Với 1000 streams, URL có thể dài > 20,000 ký tự
- **Giới hạn URL**: Thường là 2048-8192 ký tự tùy server

### Giải pháp
1. **Giảm maxStreamsPerConn**: 200 streams/connection (thay vì 1000)
2. **URL length check**: Check độ dài URL trước khi connect
3. **Auto-split**: Tự động split connection nếu URL quá dài
4. **Calculate max streams**: Tính toán dựa trên URL length limit

### Tính toán
- Base URL: ~45 ký tự
- Mỗi stream: ~20 ký tự (ví dụ: `btcusdt@bookTicker/`)
- Với 200 streams: 45 + 200*20 = ~4045 ký tự (an toàn)
- Với 1000 streams: 45 + 1000*20 = ~20,045 ký tự (quá dài!)

### Cấu hình
- `maxStreamsPerConn`: 200 (giảm từ 1000)
- `maxUrlLength`: 8000 ký tự (an toàn dưới 8192)

### Lợi ích
1. **Tránh 414 error**: URL không vượt quá giới hạn
2. **Auto-split**: Tự động split connection nếu cần
3. **URL monitoring**: Log warning khi URL gần giới hạn
4. **Safe connection**: Mỗi connection có URL length hợp lý

### Lưu ý
- Mỗi connection tối đa 200 streams (thay vì 1000)
- URL length được check trước khi connect
- Connection tự động split nếu URL quá dài
- Warning log khi URL > 7000 ký tự

---

## [2026-01-15] - Compliance với Binance WebSocket Limits: Rate Limiting & Connection Management

### Tổng quan
Cập nhật code để tuân thủ giới hạn WebSocket chính thức của Binance:
1. Set maxStreamsPerConn = 200 (do URL length limit, không phải 1000)
2. Implement rate limiting cho subscribe/unsubscribe (5 messages/s)
3. Implement connection rate limiting (300 connections/5 phút)
4. Queue-based subscribe/unsubscribe để tránh vượt quá giới hạn

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **maxStreamsPerConn**: 200 (do URL length limit, không thể dùng 1000)
- **Subscribe rate limiting**: Queue-based với 5 messages/s limit
- **Connection rate limiting**: Track và giới hạn 300 connections mới mỗi 5 phút
- **Queue processor**: Process subscribe/unsubscribe queue mỗi 200ms (5 messages/s)
- **Record connections**: Track connection history để enforce rate limit

### Binance Limits (theo tài liệu chính thức)
- **Max streams/connection**: 1024 streams (theo lý thuyết, nhưng bị giới hạn bởi URL length)
- **URL length limit**: ~8000 ký tự (thực tế)
- **Subscribe/unsubscribe rate**: 5 messages/s
- **New connections**: 300 connections/5 phút trên cùng IP
- **Total subscriptions**: 1000 active subscriptions/session (user data stream)

### Cấu hình
- `maxStreamsPerConn`: 200 (do URL length limit)
- `maxUrlLength`: 8000 ký tự
- `subscribeRateLimit`: 5 messages/s
- `maxNewConnectionsPer5Min`: 300 connections/5 phút
- `connectionHistoryWindow`: 5 phút

### Lợi ích
1. **Tuân thủ Binance limits**: Không bị disconnect do vượt quá giới hạn
2. **Rate limiting**: Tránh vượt quá 5 messages/s cho subscribe/unsubscribe
3. **Connection management**: Tránh tạo quá nhiều connections mới
4. **Queue-based**: Subscribe/unsubscribe được queue và process theo rate limit

### Cơ chế hoạt động
1. **Subscribe rate limiting**: Queue subscribe/unsubscribe messages, process 1 message mỗi 200ms
2. **Connection rate limiting**: Track connection history, block nếu đạt 300 connections/5 phút
3. **Stream limit**: Mỗi connection tối đa 200 streams (do URL length limit)

### Lưu ý
- Subscribe/unsubscribe actions được queue và process theo rate limit
- Connection creation được track và rate limited
- Nếu đạt connection rate limit, sẽ log warning và block creation
- **LƯU Ý**: maxStreamsPerConn = 200 (không phải 1000) do URL length limit

---

## [2026-01-15] - Implement LIFO Symbol Management: Reduce Latency by Unsubscribing Unused Symbols

### Tổng quan
Implement giải pháp triệt để để giảm latency bằng cách quản lý symbols theo LIFO (Last In First Out):
1. Track symbol usage (lastAccess, accessCount)
2. Max total streams limit (2000 streams) để tránh quá tải
3. Auto-unsubscribe symbols không được sử dụng trong 10 phút
4. Symbol priority system - unsubscribe symbols cũ nhất trước

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **Thêm LIFO symbol management**: Track symbol usage với `symbolUsage` Map
- **Max total streams limit**: `maxTotalStreams = 2000` để tránh quá tải
- **Auto cleanup unused symbols**: Unsubscribe symbols không được sử dụng trong 10 phút
- **Track symbol usage**: Update `lastAccess` mỗi khi symbol được access (getPrice, getBook, price updates)
- **Force cleanup**: Tự động cleanup khi đạt max streams limit
- **Symbol cleanup timer**: Cleanup mỗi 2 phút

### Cấu hình
- `maxTotalStreams`: 2000 streams (giảm từ unlimited)
- `symbolUnusedTimeout`: 10 phút - unsubscribe symbols không được sử dụng
- `symbolCleanupInterval`: 2 phút - cleanup interval

### Lợi ích
1. **Giảm latency**: Giảm số lượng streams → giảm messages → giảm latency
2. **Tự động cleanup**: Unsubscribe symbols không được sử dụng tự động
3. **Tránh quá tải**: Max streams limit ngăn chặn quá tải WebSocket
4. **LIFO priority**: Unsubscribe symbols cũ nhất trước (không ảnh hưởng symbols đang active)

### Cơ chế hoạt động
1. **Track usage**: Mỗi khi symbol được access (getPrice, getBook, price update), update `lastAccess`
2. **Cleanup check**: Mỗi 2 phút, check symbols không được sử dụng > 10 phút
3. **LIFO unsubscribe**: Sort symbols theo `lastAccess` (oldest first), unsubscribe từng symbol
4. **Force cleanup**: Khi đạt max streams limit, force cleanup để free up 500 streams

### Lưu ý
- Symbols đang active (được access trong 10 phút) sẽ không bị unsubscribe
- Cleanup tự động chạy mỗi 2 phút
- Khi đạt max streams limit, sẽ tự động cleanup để free up space

---

## [2026-01-15] - Fix Error Logging: Prevent Serialization Issues in PositionWebSocketClient

### Tổng quan
Sửa lỗi serialize error message trong `PositionWebSocketClient` để tránh error message bị hiển thị sai trong log:
1. Safely extract error message từ Error object
2. Log error với metadata (code, status, stack) để dễ debug
3. Tránh serialize error object trực tiếp gây ra vấn đề hiển thị

### Files thay đổi

#### 1. `src/services/PositionWebSocketClient.js`
- **Sửa `createListenKey` error logging**: Safely extract error message, log với metadata
- **Sửa `connect` error logging**: Safely extract error message, log với metadata
- **Tránh serialize error object trực tiếp**: Convert error thành string một cách an toàn

### Lợi ích
1. **Error message rõ ràng**: Error message được hiển thị đúng trong log
2. **Better debugging**: Log thêm metadata (code, status, stack) để dễ debug
3. **Tránh serialization issues**: Không còn error message bị serialize sai như object với keys là số

### Lưu ý
- Error message sẽ được extract an toàn từ Error object
- Metadata (code, status, stack) được log riêng để dễ đọc
- Tránh serialize error object trực tiếp gây ra vấn đề hiển thị

---

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

## [2026-01-15] - Fix Binance OC Bucket Alignment for Alerts

### Tổng quan
Đảm bảo việc tính OC alert (Binance) bám đúng nến thực tế (1m/5m/15m/30m) bằng cách:
1. Sửa `ts` cho stream `bookTicker` để dùng `receivedAt` thay vì `eventTime=0`
2. Đồng bộ `ts` cho `trade`/`kline` với `eventTime` (fallback `receivedAt` khi thiếu)
3. Thêm log debug bucket trong `RealtimeOCDetector` để so sánh trực tiếp với chart

### Files thay đổi

#### 1. `src/services/WebSocketManager.js`
- **bookTicker**:
  - Trước đây: `_emitPrice({ ..., ts: eventTime })` với `eventTime=0` → `ts=0`, làm cho `RealtimeOCDetector` tính `bucketStart=0` và không lấy được open từ kline cache
  - Sau khi sửa: `_emitPrice({ ..., ts: receivedAt })` để bucket của alert bám theo thời gian thực (phút hiện tại), khớp với `CandleAggregator`
- **trade/kline**:
  - Dùng `ts: eventTime || receivedAt` cho cả `ingestTick`/`ingestKline` và `_emitPrice` để ưu tiên timestamp từ Binance, fallback sang thời gian nhận khi thiếu

#### 2. `src/services/RealtimeOCDetector.js`
- **onAlertTick()**:
  - Thêm log debug:
    - Format: `[RealtimeOCDetector] 🔍 OC bucket debug | EXCHANGE SYMBOL INTERVAL bucketStart=... oc=X% open=Y current=Z source=...`
    - Giúp verify bucketStart & open của alert khớp với nến thực tế trên chart (Binance Futures)

### Lợi ích
1. **OC alert align với nến**: Mỗi alert OC Binance sẽ dùng open đúng bucket 1m/5m/15m/30m từ WebSocket kline cache
2. **Dễ debug sai lệch**: Có thể grep log `OC bucket debug` để so sánh trực tiếp open/oc với chart
3. **Phân biệt rõ bug vs design**: Nếu OC alert thấp hơn max trong nến, có thể biết do thiết kế step/throttle hay do bucket/open sai

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

