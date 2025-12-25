# Chẩn Đoán Module Alert - Binance & MEXC

**Ngày:** 2025-12-23  
**Trạng thái:** ⚠️ MEXC WebSocket không kết nối được

---

## Tóm Tắt

### ✅ Binance Alert Module
- **Trạng thái:** Hoạt động bình thường
- **WebSocket:** ✅ Kết nối thành công
- **Price Data:** ✅ Có thể lấy giá real-time
- **Configs:** ✅ 1 active config (534 symbols)
- **Vấn đề:** Không có

### ❌ MEXC Alert Module  
- **Trạng thái:** Không hoạt động
- **WebSocket:** ❌ Không kết nối được (ECONNREFUSED)
- **Price Data:** ❌ Không có (do WebSocket không kết nối)
- **Configs:** ✅ 1 active config (35 symbols)
- **Vấn đề:** WebSocket không thể kết nối đến endpoint

---

## Chi Tiết Vấn Đề

### 1. MEXC WebSocket Connection Failed

**Lỗi:**
```
ECONNREFUSED - Cannot connect to MEXC WebSocket endpoint
```

**Nguyên nhân có thể:**
1. Network/Firewall block endpoint MEXC
2. Endpoint không khả dụng từ server hiện tại
3. Cần sử dụng endpoint `.co` thay vì `.com` (region block)

**Endpoints đang thử:**
- `wss://contract.mexc.com/edge` (primary)
- `wss://wbs-api.mexc.com/ws`
- `wss://contract.mexc.co/edge` (fallback)
- `wss://wbs.mexc.co/ws` (fallback)

**Giải pháp:**
- Module alert có fallback sang REST API khi WebSocket không có giá
- Tuy nhiên, REST API sẽ chậm hơn và tốn tài nguyên hơn
- Cần kiểm tra network/firewall để cho phép kết nối MEXC WebSocket

---

## Các Thay Đổi Đã Thực Hiện

### 1. Cải thiện app.js
- Thêm import MEXC WebSocket để đảm bảo được khởi tạo
- Thêm logging để theo dõi trạng thái WebSocket

### 2. Cải thiện PriceAlertWorker
- Cải thiện logic subscribe WebSocket
- Thêm kiểm tra và retry khi WebSocket không kết nối
- Thêm logging chi tiết hơn

### 3. Tạo Scripts Diagnostic
- `scripts/check_alert_modules.js` - Kiểm tra trạng thái tổng thể
- `scripts/test_websocket_connection.js` - Test kết nối WebSocket

---

## Giải Pháp Khuyến Nghị

### Giải Pháp Ngắn Hạn (Tạm Thời)
1. **Sử dụng REST API fallback:**
   - Module alert đã có logic fallback sang REST API
   - Tuy nhiên sẽ chậm hơn và tốn tài nguyên hơn
   - Cần đảm bảo REST API endpoint hoạt động

2. **Kiểm tra Network/Firewall:**
   - Cho phép kết nối đến MEXC WebSocket endpoints
   - Thử sử dụng endpoint `.co` thay vì `.com`

### Giải Pháp Dài Hạn
1. **Sửa Network/Firewall:**
   - Cho phép kết nối đến `wss://contract.mexc.com/edge`
   - Hoặc sử dụng endpoint `.co` nếu `.com` bị block

2. **Cải thiện Error Handling:**
   - Tự động retry với endpoint khác khi một endpoint fail
   - Log chi tiết hơn về lỗi kết nối

3. **Monitoring:**
   - Thêm alert khi WebSocket không kết nối được
   - Theo dõi tỷ lệ thành công của các endpoint

---

## Kiểm Tra Nhanh

### Chạy script kiểm tra:
```bash
node scripts/check_alert_modules.js
```

### Chạy script test WebSocket:
```bash
node scripts/test_websocket_connection.js
```

### Kiểm tra logs:
```bash
# Tìm lỗi MEXC WebSocket
grep "MEXC-WS" logs/*.log | grep -i error

# Kiểm tra trạng thái kết nối
grep "MEXC-WS.*Connected" logs/*.log
```

---

## Kết Luận

1. **Binance Alert Module:** ✅ Hoạt động bình thường
2. **MEXC Alert Module:** ❌ Không hoạt động do WebSocket không kết nối được
3. **Giải pháp:** Cần sửa network/firewall hoặc sử dụng REST API fallback

**Lưu ý:** Module alert có fallback sang REST API, nhưng sẽ chậm hơn và tốn tài nguyên hơn WebSocket. Nên ưu tiên sửa WebSocket connection.

