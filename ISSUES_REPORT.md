# 📋 Báo Cáo Các Vấn Đề Tồn Đọng Trên Hệ Thống

**Thời gian kiểm tra**: 2026-01-22 09:48:56  
**Nguồn dữ liệu**: `logs/combined.log`, `logs/error.log`, code analysis

---

## ✅ 1. MEXC WebSocket - ĐANG HOẠT ĐỘNG BÌNH THƯỜNG

### Trạng thái:
- ✅ **Connected**: WebSocket đang kết nối và hoạt động
- ✅ **Subscribed**: 753 symbols đang được subscribe
- ✅ **Last activity**: 2026-01-22 09:48:56 - "MEXC WebSocket subscribed to 753 symbols"

### Kết luận:
**MEXC WebSocket không có vấn đề**, đang hoạt động bình thường và nhận dữ liệu realtime.

---

## 🚨 2. TP/SL DELAY NGHIÊM TRỌNG - VẤN ĐỀ NGHIÊM TRỌNG NHẤT

### Mô tả:
Nhiều position đã mở từ **34 giây đến 55,479 giây (hơn 15 giờ)** mà vẫn chưa có TP/SL được tạo.

### Bằng chứng từ error.log:
```
Position 1349 (WLDUSDT): 54,739s (15.2 giờ) - exit_order_id=138037914, sl_order_id=NULL
Position 1350 (KAITOUSDT): 54,739s (15.2 giờ) - exit_order_id=70563597, sl_order_id=NULL
Position 1351 (WALUSDT): 54,739s (15.2 giờ) - exit_order_id=66564399, sl_order_id=NULL
Position 1352 (USUSDT): 54,739s (15.2 giờ) - exit_order_id=15794238, sl_order_id=NULL
Position 1353 (IOTXUSDT): 54,739s (15.2 giờ) - exit_order_id=84183614, sl_order_id=NULL
Position 1346 (TREEUSDT): 54,742s (15.2 giờ) - exit_order_id=42719992, sl_order_id=NULL
Position 1347 (PUFFERUSDT): 54,742s (15.2 giờ) - exit_order_id=31966362, sl_order_id=NULL
Position 1348 (XNYUSDT): 54,742s (15.2 giờ) - exit_order_id=60774590, sl_order_id=NULL
Position 1344 (THEUSDT): 54,743s (15.2 giờ) - exit_order_id=71363333, sl_order_id=NULL
```

**Gần đây (09:41-09:47):**
```
Position 1366 (PTBUSDT): 34s - exit_order_id=NULL, sl_order_id=NULL
Position 1365 (STBLUSDT): 42s - exit_order_id=NULL, sl_order_id=NULL
Position 1364 (EDUUSDT): 58s - exit_order_id=NULL, sl_order_id=NULL
Position 1363 (PROMUSDT): 175s - exit_order_id=NULL, sl_order_id=NULL
Position 1362 (STABLEUSDT): 178s - exit_order_id=NULL, sl_order_id=NULL
Position 1361 (PTBUSDT): 180s - exit_order_id=NULL, sl_order_id=NULL
Position 1360 (OGNUSDT): 182s - exit_order_id=NULL, sl_order_id=NULL
Position 1359 (STBLUSDT): 202s - exit_order_id=NULL, sl_order_id=NULL
Position 1358 (币安人生USDT): 204s - exit_order_id=NULL, sl_order_id=NULL
```

### Phân tích:
1. **Có TP nhưng thiếu SL**: Nhiều position có `exit_order_id` (TP đã tạo) nhưng `sl_order_id=NULL` (SL chưa tạo)
2. **Cả TP và SL đều thiếu**: Nhiều position có cả `exit_order_id=NULL` và `sl_order_id=NULL`
3. **CRITICAL SAFETY CHECK được trigger**: Hệ thống đã phát hiện và cố gắng force tạo TP/SL, nhưng vẫn có delay

### Nguyên nhân có thể:
1. **PositionMonitor cycle delay**: Interval giữa các lần chạy có thể quá dài
2. **Batch processing bottleneck**: Xử lý theo batch có thể bỏ sót một số position
3. **API rate limiting**: Binance API có thể reject requests do rate limit
4. **Watchdog degrade mode**: Khi degrade mode được kích hoạt, advanced features bị tắt, có thể ảnh hưởng đến TP/SL placement
5. **PositionSync không set flag**: `tp_sl_pending` flag có thể không được set đúng cách

### Giải pháp đề xuất:
1. ✅ **Đã có**: PositionMonitor đã có logic ưu tiên positions mới (sort by `opened_at`, newest first)
2. ✅ **Đã có**: EntryOrderMonitor đã có logic place TP ngay sau khi fill
3. ⚠️ **Cần cải thiện**: Giảm PositionMonitor cycle interval cho positions mới
4. ⚠️ **Cần cải thiện**: Tăng batch size cho TP/SL placement
5. ⚠️ **Cần cải thiện**: Thêm retry mechanism mạnh hơn cho TP/SL placement
6. ⚠️ **Cần cải thiện**: Đảm bảo cả TP và SL đều được tạo (hiện tại có thể chỉ tạo TP)

---

## ⚠️ 3. WATCHDOG DEGRADE MODE - ĐÃ KÍCH HOẠT 2 LẦN

### Mô tả:
Watchdog service đã phát hiện event loop delay cao và kích hoạt "degrade mode" để bảo vệ WebSocket.

### Bằng chứng:
```
2026-01-22 09:35:19: [Watchdog] 🚨 Entering degrade mode for 10 minutes to protect WS
2026-01-22 09:46:13: [Watchdog] 🚨 Entering degrade mode for 10 minutes to protect WS
```

### Event loop delay metrics (từ combined.log):
```
09:47:47: mean=191.1ms max=938.5ms (streak=12/3)
09:47:55: mean=227.9ms max=946.3ms (streak=13/3)
09:48:06: mean=149.0ms max=941.6ms (streak=14/3)
09:48:15: mean=137.3ms max=465.0ms (streak=15/3)
09:48:25: mean=138.5ms max=475.5ms (streak=16/3)
```

### Tác động:
- **Advanced trading features bị tắt**: Khi degrade mode, `ADV_TPSL_ENABLED` bị disable
- **Có thể ảnh hưởng đến TP/SL placement**: Nếu TP/SL placement logic phụ thuộc vào advanced features
- **WebSocket được bảo vệ**: Đây là mục đích của degrade mode, nhưng có thể ảnh hưởng đến functionality

### Giải pháp đề xuất:
1. ✅ **Đã có**: Watchdog service đã được implement
2. ⚠️ **Cần cải thiện**: Tách TP/SL placement khỏi advanced features để không bị ảnh hưởng bởi degrade mode
3. ⚠️ **Cần cải thiện**: Giảm event loop delay bằng cách optimize các heavy operations
4. ⚠️ **Cần cải thiện**: Tăng threshold cho degrade mode hoặc giảm thời gian degrade (hiện tại 10 phút)

---

## ❌ 4. BINANCE API ERROR -2022: REDUCEONLY ORDER REJECTED

### Mô tả:
Khi đóng position, Binance API trả về lỗi `-2022: ReduceOnly Order is rejected`.

### Bằng chứng:
```
2026-01-22 09:41:24: [ExchangeService] ❌ Retry without reduceOnly also failed for bot 2 (PIPPINUSDT): Binance API Error -2022: ReduceOnly Order is rejected.
2026-01-22 09:43:26: [ExchangeService] ❌ Retry without reduceOnly also failed for bot 2 (PIPPINUSDT): Binance API Error -2022: ReduceOnly Order is rejected.
```

### Nguyên nhân:
- Position có thể đã được đóng một phần hoặc đóng hoàn toàn
- Order có thể đã bị reject do điều kiện không hợp lệ
- Có thể là vấn đề với position state synchronization

### Giải pháp đề xuất:
1. ⚠️ **Cần cải thiện**: Kiểm tra position state trước khi đóng
2. ⚠️ **Cần cải thiện**: Xử lý lỗi -2022 một cách graceful hơn
3. ⚠️ **Cần cải thiện**: Sync position state với exchange trước khi đóng

---

## ❌ 5. MEXC API ERROR 404: NOT FOUND

### Mô tả:
Khi update symbol filters từ MEXC, API trả về lỗi 404 Not Found.

### Bằng chứng:
```
2026-01-22 09:45:01: Error updating symbol filters (MEXC) via CCXT: mexc {"code":404,"msg":"Not Found"}
```

### Nguyên nhân:
- MEXC API endpoint có thể đã thay đổi
- CCXT library có thể không tương thích với MEXC API mới nhất
- Có thể là vấn đề với MEXC sandbox/production endpoint

### Giải pháp đề xuất:
1. ⚠️ **Cần kiểm tra**: Verify MEXC API endpoint trong CCXT
2. ⚠️ **Cần cải thiện**: Thêm fallback mechanism khi update symbol filters fail
3. ⚠️ **Cần cải thiện**: Log chi tiết hơn để debug

---

## ⚠️ 6. EVENT LOOP DELAY CAO

### Mô tả:
Event loop delay trung bình 137-227ms, max 938-946ms, vượt quá ngưỡng an toàn.

### Metrics:
- **Mean delay**: 137-227ms (ngưỡng an toàn: <100ms)
- **Max delay**: 465-946ms (ngưỡng an toàn: <200ms)
- **Streak**: 12-16 lần liên tiếp vượt ngưỡng

### Tác động:
- WebSocket messages có thể bị stale
- Position monitoring có thể bị delay
- TP/SL placement có thể bị chậm

### Giải pháp đề xuất:
1. ✅ **Đã có**: Watchdog service đã được implement
2. ⚠️ **Cần cải thiện**: Optimize heavy operations (OHLCV fetching, indicator calculations)
3. ⚠️ **Cần cải thiện**: Tăng caching để giảm API calls
4. ⚠️ **Cần cải thiện**: Batch processing để giảm overhead

---

## 📊 TỔNG KẾT VÀ ĐỘ ƯU TIÊN

### Vấn đề nghiêm trọng nhất:
1. 🚨 **TP/SL DELAY** - Cần fix ngay lập tức
2. ⚠️ **Watchdog degrade mode** - Cần tách TP/SL khỏi advanced features
3. ❌ **Binance API Error -2022** - Cần xử lý graceful hơn
4. ❌ **MEXC API Error 404** - Cần kiểm tra và fix
5. ⚠️ **Event loop delay** - Cần optimize

### Hành động đề xuất:
1. **Ngay lập tức**: Fix TP/SL delay bằng cách:
   - Giảm PositionMonitor cycle interval cho positions mới
   - Tăng batch size cho TP/SL placement
   - Đảm bảo cả TP và SL đều được tạo
   - Thêm retry mechanism mạnh hơn

2. **Ngắn hạn**: Tách TP/SL placement khỏi advanced features để không bị ảnh hưởng bởi degrade mode

3. **Trung hạn**: Optimize event loop delay và fix API errors

---

**Báo cáo được tạo tự động từ log analysis**

