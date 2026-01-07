# Cập Nhật MEXC Endpoint Sang .CO Domain

**Ngày:** 2025-12-23  
**Trạng thái:** ✅ Đã cập nhật thành công

---

## Tóm Tắt

Đã cập nhật cấu hình MEXC để sử dụng endpoint `.co` thay vì `.com` để cải thiện khả năng kết nối từ một số khu vực.

---

## Các Thay Đổi

### 1. Cập Nhật Database Config
- **MEXC_FUTURES_WS_URL**: `wss://contract.mexc.com/edge` → `wss://contract.mexc.co/edge`
- **MEXC_FUTURES_REST_BASE**: `https://contract.mexc.co` → `https://contract.mexc.co`

### 2. Cập Nhật Code
- **app.js**: Thay đổi default endpoint sang `.co`
- **MexcWebSocketManager.js**: Cải thiện logic ưu tiên `.co` domain

### 3. Logic Failover
- Ưu tiên sử dụng endpoint `.co` mặc định
- Tự động fallback sang `.com` nếu `.co` không kết nối được
- Theo dõi số lần fail để quyết định endpoint nào ưu tiên

---

## Cách Sử Dụng

### Kiểm Tra Cấu Hình Hiện Tại
```bash
node scripts/update_mexc_endpoint_to_co.js
```

### Test WebSocket Connection
```bash
node scripts/test_websocket_connection.js
```

### Kiểm Tra Trạng Thái Alert Modules
```bash
node scripts/check_alert_modules.js
```

---

## Lưu Ý

1. **Cần Restart Ứng Dụng**: Sau khi cập nhật config, cần restart ứng dụng để áp dụng thay đổi
2. **Auto Fallback**: Nếu endpoint `.co` không kết nối được, hệ thống sẽ tự động thử endpoint `.com`
3. **Monitoring**: Theo dõi logs để đảm bảo WebSocket kết nối thành công

---

## Kết Quả Mong Đợi

- ✅ MEXC WebSocket kết nối thành công với endpoint `.co`
- ✅ Price alerts cho MEXC hoạt động bình thường
- ✅ Tự động fallback nếu có vấn đề với endpoint `.co`

---

## Troubleshooting

### Nếu WebSocket vẫn không kết nối được:

1. **Kiểm tra Network/Firewall**:
   - Đảm bảo không bị chặn kết nối đến `wss://contract.mexc.co/edge`
   - Thử ping hoặc curl để test connectivity

2. **Kiểm tra Logs**:
   ```bash
   grep "MEXC-WS" logs/*.log | tail -20
   ```

3. **Thử Endpoint Khác**:
   - Có thể thử `wss://wbs.mexc.co/ws` nếu endpoint chính không hoạt động
   - Hoặc quay lại `.com` nếu `.co` không khả dụng

4. **Sử dụng REST API Fallback**:
   - Module alert có fallback sang REST API
   - Tuy nhiên sẽ chậm hơn và tốn tài nguyên hơn WebSocket

---

## Files Đã Thay Đổi

1. `src/app.js` - Cập nhật default endpoint
2. `src/services/MexcWebSocketManager.js` - Cải thiện logic ưu tiên endpoint
3. `scripts/update_mexc_endpoint_to_co.js` - Script để cập nhật config

---

## Verification

Sau khi restart ứng dụng, kiểm tra:
- MEXC WebSocket kết nối thành công
- Price alerts cho MEXC hoạt động
- Logs không có lỗi ECONNREFUSED

