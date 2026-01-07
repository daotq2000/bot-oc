# TP Order TTL Information

## Tóm tắt: TP Orders KHÔNG bị hủy theo TTL

### 1. ENTRY Orders (position.order_id)
- **TTL**: `ENTRY_ORDER_TTL_MINUTES` (default: 30 phút, có thể config trong `app_configs`)
- **Logic**: Entry orders sẽ bị tự động hủy sau TTL nếu chưa được filled
- **File**: `src/jobs/PositionMonitor.js:773-791`
- **Comment**: "TP/SL orders (exit_order_id, sl_order_id) are NEVER cancelled by this TTL"

### 2. TP Orders (exit_order_id)
- **TTL**: **KHÔNG CÓ TTL** - TP orders không bao giờ bị hủy tự động theo thời gian
- **Chỉ bị hủy trong các trường hợp sau**:

#### a) Position được đóng
- Khi position được close (filled, stopped, hoặc manual close)
- TP order sẽ tự động bị hủy bởi Binance khi position đóng

#### b) Order được filled
- Khi giá chạm TP price, order sẽ được filled và position đóng
- Đây là trường hợp bình thường, không phải "hủy"

#### c) Dedupe logic (duplicate orders)
- Khi có nhiều TP orders trên exchange (duplicate)
- Dedupe sẽ cancel các orders cũ, giữ lại order mới nhất hoặc order trong DB
- **File**: `src/jobs/PositionMonitor.js:_dedupeCloseOrdersOnExchange()`
- **Timing**: Chạy SAU khi tạo order mới thành công (để tránh miss hit TP)

#### d) Atomic replace pattern
- Khi TP price thay đổi (trailing TP), ExitOrderManager sẽ:
  1. Tạo order mới với price mới
  2. Cancel order cũ
- **File**: `src/services/ExitOrderManager.js:placeOrReplaceExitOrder()`
- **Pattern**: Create new → Cancel old (atomic replace)

#### e) Invalid SL detected
- Khi phát hiện invalid SL (SL <= entry cho SHORT hoặc SL >= entry cho LONG)
- System sẽ force close position ngay lập tức
- TP order sẽ bị cancel trước khi force close
- **File**: `src/jobs/PositionMonitor.js:500-511`

#### f) Manual cancellation
- User có thể cancel TP order thủ công qua Binance UI hoặc API

### 3. SL Orders (sl_order_id)
- **TTL**: **KHÔNG CÓ TTL** - Tương tự TP orders
- Chỉ bị hủy khi position đóng hoặc được replace

## Kết luận

**TP orders KHÔNG có TTL và sẽ tồn tại cho đến khi:**
1. Position đóng (filled hoặc closed)
2. Order được replace (trailing TP)
3. Order bị cancel bởi dedupe logic (duplicate)
4. Invalid SL detected (force close)
5. Manual cancellation

**Điều này đảm bảo TP order luôn active và sẵn sàng đóng position khi giá chạm TP price, không bị mất do timeout.**

