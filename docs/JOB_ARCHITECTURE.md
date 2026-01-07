# Kiến trúc Job: SignalScanner vs PriceAlertJob

## Tổng quan

Bot sử dụng hai job riêng biệt để theo dõi giá, nhưng chúng phục vụ hai mục đích khác nhau và không duplicate về chức năng.

## 1. `SignalScanner` (Module Trade)

- **File:** `src/jobs/SignalScanner.js`
- **Nhiệm vụ:** Tìm tín hiệu hợp lệ để **đặt lệnh trade**.
- **Nguồn dữ liệu:** Bảng `strategies`.
- **Tần suất:** Mặc định mỗi phút (hoặc theo `SCAN_INTERVALS.SIGNAL_SCAN`).

### Logic hoạt động:

1. Lấy tất cả `strategies` đang active.
2. Với mỗi strategy, kiểm tra đồng thời các điều kiện:
   - **OC Threshold:** `|OC| >= strategy.oc`
   - **Extend Condition:** Giá phải pullback về entry price.
   - **Ignore Logic:** Bỏ qua nếu nến trước đó ngược hướng và giá chưa retracement đủ.
3. Nếu **tất cả** điều kiện đều đạt → tạo signal.
4. Gửi signal đến `OrderService` để đặt lệnh.
5. `OrderService` sau khi đặt lệnh thành công sẽ gọi `TelegramService` để gửi thông báo **đã vào lệnh**.

**Kết luận:** `SignalScanner` chỉ quan tâm đến việc **thực thi trade** một cách an toàn.

## 2. `PriceAlertJob` (Module Alert)

- **File:** `src/jobs/PriceAlertJob.js`
- **Nhiệm vụ:** Gửi cảnh báo biến động giá qua Telegram, **không liên quan đến trade**.
- **Nguồn dữ liệu:** Bảng `price_alert_config`.
- **Tần suất:** Mặc định mỗi 10 giây.

### Logic hoạt động:

1. Lấy tất cả `price_alert_config` đang active.
2. Với mỗi config, kiểm tra điều kiện duy nhất:
   - **Volatility Threshold:** `|Giá hiện tại - Giá mở nến| / Giá mở nến * 100 >= threshold`
3. Nếu điều kiện đạt → gọi `TelegramService` để gửi **alert biến động giá**.

**Kết luận:** `PriceAlertJob` chỉ quan tâm đến việc **thông báo** về biến động giá.

## So sánh

| Tiêu chí | `SignalScanner` | `PriceAlertJob` |
|---|---|---|
| **Mục đích** | Đặt lệnh trade | Gửi alert Telegram |
| **Nguồn cấu hình** | `strategies` | `price_alert_config` |
| **Logic** | Phức tạp (OC + extend + ignore) | Đơn giản (chỉ OC) |
| **Kết quả** | Đặt lệnh | Gửi tin nhắn |
| **Tần suất** | Chậm hơn (mỗi phút) | Nhanh hơn (mỗi 10 giây) |

## Tại sao thiết kế như vậy?

Việc tách biệt hai job mang lại sự linh hoạt:

- **Alert không cần trade:** Bạn có thể theo dõi biến động của một symbol mà không cần tạo strategy để trade nó.
- **Ngưỡng khác nhau:** Bạn có thể muốn nhận alert khi OC > 1% nhưng chỉ vào lệnh khi OC > 2% và có pullback.
- **Hiệu suất:** `PriceAlertJob` chạy thường xuyên hơn để cung cấp cảnh báo nhanh, trong khi `SignalScanner` chạy chậm hơn để tránh trade quá nhiều.

Đây là thiết kế có chủ đích để **tách biệt logic cảnh báo và logic giao dịch**, giúp hệ thống linh hoạt và dễ quản lý hơn.
