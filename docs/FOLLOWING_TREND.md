# FOLLOWING_TREND Strategy (Chiến lược bám xu hướng)

Tài liệu này mô tả **chiến lược following trend** (bám xu hướng) một cách chi tiết, tập trung vào các cơ chế:

- Vào lệnh (Entry)
- Chốt lời (TP)
- Cắt lỗ (SL)
- Trailing TP (dời/chốt lời động)
- Đóng vị thế (Close position)

## 1. Khái niệm & mục tiêu

Chiến lược following trend có mục tiêu **đi theo hướng chuyển động chính của giá** (momentum) để:

- Khi thị trường có tín hiệu **bullish** (đà tăng / xu hướng tăng): ưu tiên mở **LONG**.
- Khi thị trường có tín hiệu **bearish** (đà giảm / xu hướng giảm): ưu tiên mở **SHORT**.

Trong code trước khi đảo chiến lược (theo tài liệu `STRATEGY_INVERSION_SUMMARY.md`), mapping hướng giao dịch là:

- `bullish → long`
- `bearish → short`

Tất cả các tính toán Entry / TP / SL đều dựa trên biến `side`, do đó chỉ cần xác định đúng `side` thì các phép tính phụ thuộc sẽ tự “đúng hướng”.

## 2. Định nghĩa các biến/khái niệm sử dụng

- `direction`: tín hiệu hướng thị trường do hệ thống phát hiện. Giá trị thường gặp:
  - `bullish`
  - `bearish`
- `side`: phía vị thế sẽ mở:
  - `long`
  - `short`
- `entryPrice`: giá vào lệnh.
- `tpPrice`: giá take profit.
- `slPrice`: giá stop loss ban đầu.
- `is_reverse_strategy`: cờ trong strategy config. `false` = following trend.
- `trade_type`: cờ trong strategy config, cho phép chỉ `long`, `short`, hoặc `both`.
- `oc`: Open-Close percentage, tín hiệu chính để trigger.
- `currentPrice`: giá thị trường tại thời điểm trigger.

Lưu ý: các hàm cốt lõi trong code:

- `calculateTakeProfit(...)`
- `calculateInitialStopLossByAmount(...)`
- `determineSide(...)`
- `calculateNextTrailingTakeProfit(...)`

## 3. Cơ chế xác định hướng giao dịch (Side Mapping)

Logic mapping side không hardcode trực tiếp trong consumer, mà được gom vào `determineSide(direction, trade_type, is_reverse_strategy)`.

- Với **following trend**: `is_reverse_strategy = false`

Quy tắc (theo `src/utils/sideSelector.js`):

- `direction = bullish`:
  - Nếu `trade_type` là `both` hoặc `long` ⇒ `side = long`
  - Nếu `trade_type` là `short` ⇒ **skip** (không vào lệnh)
- `direction = bearish`:
  - Nếu `trade_type` là `both` hoặc `short` ⇒ `side = short`
  - Nếu `trade_type` là `long` ⇒ **skip**

Ý nghĩa:

- Following trend luôn đi cùng hướng candle: bullish → long, bearish → short, nhưng vẫn tôn trọng giới hạn `trade_type`.

## 4. Cơ chế vào lệnh (Entry)

### 4.1. Điều kiện kích hoạt vào lệnh

Entry được trigger khi có `match` từ `realtimeOCDetector.detectOC(...)` và các điều kiện sau thỏa mãn:

- `checkOpenPosition(strategy.id)` trả về **false** (strategy chưa có vị thế đang mở).
- `side = determineSide(direction, strategy.trade_type, strategy.is_reverse_strategy)` trả về `long` hoặc `short`.

Nếu `determineSide(...)` trả về `null` (ví dụ `trade_type=long` nhưng candle bearish), bot sẽ **skip** lệnh.

### 4.2. Công thức entry (following trend)

Với following trend (`strategy.is_reverse_strategy = false`):

- **Giá vào lệnh**:
  - `entryPrice = currentPrice`
- **Loại lệnh**:
  - `MARKET` (consumer set `forceMarket=true` trong signal)

Tức là **không có entry offset/extend** trong following trend; bot vào ngay theo giá hiện tại để bám momentum.

Tham chiếu: `src/consumers/WebSocketOCConsumer.js` (`forceMarket=true`).

### 4.3. Ghi chú về `extend`

`extend` và các hàm `calculateLongEntryPrice/calculateShortEntryPrice` **chỉ được dùng cho counter-trend** (`is_reverse_strategy=true`).

## 5. Cơ chế Take Profit (TP)

### 5.1. TP mục tiêu

Sau khi có `entryPrice` và `side`, hệ thống tính `tpPrice` ban đầu bằng hàm `calculateTakeProfit(entryPrice, take_profit, side)`.

**Công thức:**

1.  **Lấy % từ config**: `actualTPPercent = strategy.take_profit / 10`. 
    - Ví dụ: `take_profit = 55` thì `%TP` là `5.5%`.
2.  **Tính giá TP**:
    - **Long**: `tpPrice = entryPrice * (1 + actualTPPercent / 100)`
    - **Short**: `tpPrice = entryPrice * (1 - actualTPPercent / 100)`

File: `src/utils/calculator.js`

### 5.2. Khi nào đạt TP

Một vị thế được đóng do TP khi:

- **Lệnh `TAKE_PROFIT_MARKET` được khớp**: Khi đặt lệnh vào, một lệnh TP đi kèm sẽ được đặt trên sàn. Khi giá chạm `tpPrice`, lệnh này được trigger và đóng vị thế.
- **Giá vượt quá TP ban đầu**: `PositionService` có một cơ chế an toàn. Nếu giá thị trường **vượt qua `initial_tp_price`** (giá TP gốc), nó sẽ đóng vị thế bằng lệnh `MARKET` để chốt lời tốt hơn.

### 5.3. TP một phần

Hiện tại hệ thống **không hỗ trợ** chốt lời theo nhiều tầng. `tpPrice` là mục tiêu duy nhất để đóng toàn bộ vị thế.

## 6. Cơ chế Stop Loss (SL)

### 6.1. SL ban đầu

SL được tính theo **USDT amount cố định** (`strategy.stoploss`) chứ không theo %.

Hàm dùng trong code path mở lệnh (`WebSocketOCConsumer`): `calculateInitialStopLossByAmount(entryPrice, quantity, stoplossAmount, side)`.

**Công thức:**

- `quantity = strategy.amount / entryPrice`
- `priceDiff = stoplossAmount / quantity`
- `slPrice`:
  - **Long**: `slPrice = entryPrice - priceDiff`
  - **Short**: `slPrice = entryPrice + priceDiff`

Điều kiện:

- Chỉ set SL khi `strategy.stoploss > 0`. Nếu `stoploss` null/0 thì **không đặt SL**.

**Tính chất:**

- SL được set 1 lần và **giữ nguyên**. Code có ghi rõ: *Stop Loss should remain static after initial setup*.

Tham chiếu: `src/utils/calculator.js`, `src/services/PositionService.js`.

### 6.2. Khi nào SL trigger

Khi SL order trên sàn được trigger và fill (WS cache báo `closed`), position sẽ được đóng theo cơ chế WS-driven.

### 6.3. Mục tiêu của SL

- Giới hạn thua lỗ theo một mức USDT cố định.
- Không trailing SL để tránh các đóng sớm ngoài ý muốn.
## 7. Trailing TP (Chốt lời động)

Trailing TP là cơ chế **dời giá exit (take profit/stop) theo thời gian** để thoát lệnh sớm hơn nếu giá không đi đúng kỳ vọng.

Điểm quan trọng:

- Trailing trong hệ thống này là **time-based** (dựa trên phút trôi qua), *không phải* trailing theo biến động giá.
- SL **không trailing**. Chỉ có TP/exit order được dời.

### 7.1. Tham số cấu hình liên quan

- `reduce`: % trailing cho **SHORT**.
- `up_reduce`: % trailing cho **LONG**.
- `initial_tp_price`: TP gốc (được lưu khi mở position hoặc được tính lại nếu thiếu).
- `minutes_elapsed`: số phút đã trail (được update theo thời gian thực dựa trên `opened_at`).

### 7.2. Công thức trailing step (mỗi phút)

Hàm dùng: `calculateNextTrailingTakeProfit(prevTP, entryPrice, initialTP, trailingPercent, side, minutesElapsed)`.

Trong `PositionService`, mỗi lần update chỉ process tối đa **1 phút** (`minutesElapsed = 1`).

- `totalRange = abs(initialTP - entryPrice)`
- `stepPerMinute = totalRange * (trailingPercent / 100)`

Tính `newTP`:

- Với **LONG**: `newTP = max(prevTP - stepPerMinute, entryPrice)`
- Với **SHORT**: `newTP = prevTP + stepPerMinute`

Giải thích:

- LONG: TP sẽ **giảm dần** về entry để thoát sớm hơn nếu giá không tiếp tục tăng.
- SHORT: TP sẽ **tăng dần** về entry (và có thể vượt entry), nhằm tạo cơ chế thoát sớm khi giá đi ngược.

Tham chiếu: `src/utils/calculator.js`.

### 7.3. Cách xác định `trailingPercent`

Trong `PositionService`:

- Nếu `side === 'long'` ⇒ `trailingPercent = upReduce` (từ `position.up_reduce`).
- Nếu `side === 'short'` ⇒ `trailingPercent = reduce` (từ `position.reduce`).

Nếu `reduce <= 0` và `upReduce <= 0` ⇒ **static mode** (TP không dời).

### 7.4. Điều kiện update theo thời gian (không phải theo giá)

- `opened_at` được dùng để tính `totalMinutesElapsed = floor((now - opened_at)/60s)`.
- Nếu `totalMinutesElapsed <= position.minutes_elapsed` ⇒ không trail (chưa sang phút mới).
- Nếu gap quá lớn (đặc biệt > 30 phút) hệ thống sẽ reset để chỉ process 1 phút/lần nhằm tránh TP nhảy quá mạnh.

### 7.5. Update exit order trên sàn (replace)

Khi có `newTP`:

- Nếu `newTP` chưa “cross entry” (profit zone) ⇒ replace bằng `TAKE_PROFIT_MARKET`.
- Nếu `newTP` đã “cross entry” (loss zone) ⇒ `ExitOrderManager` sẽ tự switch sang `STOP_MARKET`.

Việc switch này giúp hợp lệ với quy tắc sàn (đặc biệt Binance Futures) và tránh lỗi `-2021`.

Tham chiếu: `src/services/PositionService.js`, `src/services/ExitOrderManager.js`.

## 8. Cơ chế Close Position (đóng vị thế)

Vị thế được đóng chủ yếu theo cơ chế **exchange-confirmed** (WS-driven): hệ thống ưu tiên chờ xác nhận fill/cancel từ WebSocket thay vì suy luận bằng REST polling.

### 8.1. Đóng do TP (exit order fill)

- Position có một `exit_order_id` (lệnh đóng) trên sàn.
- Khi lệnh này được WS báo `FILLED/closed`, DB/Telegram sẽ được cập nhật theo flow đóng lệnh.

Loại lệnh exit phụ thuộc vào việc TP đang ở profit zone hay loss zone:

- **Profit zone**: `TAKE_PROFIT_MARKET`
- **Loss zone** (TP đã cross entry do trailing): `STOP_MARKET`

Quy tắc switch nằm trong `ExitOrderManager._decideExitType(...)`.

### 8.2. Đóng do SL (hard stoploss fill)

- Nếu strategy có `stoploss > 0`, hệ thống đặt một SL order riêng (`sl_order_id`).
- Khi SL order được WS báo fill, position được đóng.

### 8.3. Đóng do giá vượt quá TP ban đầu (market close để lock profit)

Trong `PositionService.updatePosition(...)` có guard:

- Nếu có `initial_tp_price` (hoặc tính lại được từ `take_profit`) và:
  - **Long**: `currentPrice > initialTP`
  - **Short**: `currentPrice < initialTP`

thì hệ thống sẽ **đóng position ngay bằng MARKET** với reason `price_exceeded_initial_tp`.

### 8.4. Đóng do lỗi khi đặt exit order (`-2021 would immediately trigger`)

Nếu đặt `TAKE_PROFIT_MARKET/STOP_MARKET` gặp lỗi `-2021` (order sẽ trigger ngay), `ExitOrderManager` có fallback:

- Gửi `MARKET close` để đóng vị thế ngay.

### 8.5. Đóng do đảo hướng tín hiệu

Hệ thống **không tự đóng** position chỉ vì `direction` đảo chiều. Close chỉ xảy ra bởi:

- TP/exit order
- SL order
- Các cơ chế market-close đặc biệt ở trên

### 8.6. Đóng thủ công / điều kiện hệ thống

Ví dụ:

- Force close
- Giới hạn rủi ro theo ngày
- Lỗi kết nối/khẩn cấp

## 9. Invariants (điểm cần đảm bảo để chiến lược đúng)

- `side` phải phản ánh đúng following trend: `bullish → long`, `bearish → short`.
- TP/SL phải tính từ `entryPrice` và phụ thuộc `side`.
- Với trailing, mọi cập nhật mức chốt/stop phải tuân theo chiều có lợi của `side`.
- Close position phải luôn đồng nhất với hướng vị thế hiện tại (đóng long khác đóng short).

---

Nếu bạn muốn, mình có thể đọc thêm code trong `src/consumers/WebSocketOCConsumer.js` để:

- Bổ sung chính xác các công thức (entry offset, tp/sl %, step trailing...)
- Viết phần thông số cấu hình (config) đúng theo hệ thống hiện tại

