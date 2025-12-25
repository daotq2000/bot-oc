# Cấu Hình Tần Suất Scan

## Tổng Quan

Hệ thống hỗ trợ tăng tần suất scan signal mà không ảnh hưởng đến hiệu năng database thông qua:

1. **Caching strategies**: Giảm số lượng query database
2. **setInterval**: Cho phép scan với tần suất cao hơn 1 phút
3. **Batch processing tối ưu**: Xử lý nhanh hơn với delay giảm
4. **Connection pool tăng**: Hỗ trợ nhiều query đồng thời hơn

## Cấu Hình

### Environment Variables

Thêm vào file `.env`:

```bash
# Signal Scanner Interval (milliseconds)
# Default: 30000 (30 seconds)
# Minimum: 10000 (10 seconds) - recommended
# Maximum: 60000 (60 seconds) - use cron instead
SIGNAL_SCAN_INTERVAL_MS=30000

# Strategy Cache TTL (milliseconds)
# Default: 10000 (10 seconds)
# Thời gian cache danh sách strategies để giảm database load
STRATEGY_CACHE_TTL_MS=10000

# Database Connection Limit
# Default: 15 (increased from 10)
# Tăng số lượng connection pool để hỗ trợ scan tần suất cao
DB_CONNECTION_LIMIT=15
```

### Ví Dụ Cấu Hình

#### Scan mỗi 30 giây (mặc định)
```bash
SIGNAL_SCAN_INTERVAL_MS=30000
STRATEGY_CACHE_TTL_MS=10000
```

#### Scan mỗi 15 giây (tần suất cao)
```bash
SIGNAL_SCAN_INTERVAL_MS=15000
STRATEGY_CACHE_TTL_MS=5000
DB_CONNECTION_LIMIT=20
```

#### Scan mỗi 10 giây (tần suất rất cao)
```bash
SIGNAL_SCAN_INTERVAL_MS=10000
STRATEGY_CACHE_TTL_MS=5000
DB_CONNECTION_LIMIT=25
```

## Tối Ưu Hiệu Năng

### 1. Strategy Caching

- **Cơ chế**: Cache danh sách strategies trong memory
- **TTL**: Mặc định 10 giây (có thể điều chỉnh)
- **Lợi ích**: Giảm query database từ mỗi scan xuống chỉ 1 query mỗi 10 giây
- **Auto-refresh**: Cache tự động refresh khi hết hạn

### 2. Batch Processing

- **Batch size**: Tăng từ 3 lên 5 strategies/batch
- **Delay**: Giảm từ 1000ms xuống 500ms giữa các batch
- **Lợi ích**: Xử lý nhanh hơn 2x với cùng số lượng strategies

### 3. Database Connection Pool

- **Connection limit**: Tăng từ 10 lên 15 (có thể tăng thêm)
- **Keep-alive**: Đã bật để tái sử dụng connection
- **Lợi ích**: Hỗ trợ nhiều query đồng thời hơn

## So Sánh Hiệu Năng

### Trước khi tối ưu:
- Scan frequency: 60 giây
- Database queries/scan: 54 (1 query/strategy)
- Total queries/minute: 54
- Batch delay: 1000ms
- Batch size: 3

### Sau khi tối ưu (30 giây):
- Scan frequency: 30 giây
- Database queries/scan: ~5-6 (cached strategies + position checks)
- Total queries/minute: ~10-12 (giảm 78%)
- Batch delay: 500ms
- Batch size: 5

## Lưu Ý

1. **Tần suất tối thiểu**: Không nên đặt dưới 10 giây để tránh quá tải exchange API
2. **Cache TTL**: Nên đặt nhỏ hơn scan interval để đảm bảo dữ liệu mới nhất
3. **Connection limit**: Tăng theo số lượng strategies và tần suất scan
4. **Monitor**: Theo dõi database load và điều chỉnh nếu cần

## Monitoring

Kiểm tra logs để theo dõi:
- Thời gian scan: `[SignalScanner] Completed scan`
- Cache hits: Strategies được lấy từ cache
- Database load: Số lượng queries thực tế

## Troubleshooting

### Database quá tải
- Tăng `DB_CONNECTION_LIMIT`
- Tăng `STRATEGY_CACHE_TTL_MS` để cache lâu hơn
- Giảm `SIGNAL_SCAN_INTERVAL_MS`

### Scan quá chậm
- Giảm `STRATEGY_CACHE_TTL_MS` để refresh thường xuyên hơn
- Tăng batch size (trong code)
- Giảm delay giữa batches (trong code)

