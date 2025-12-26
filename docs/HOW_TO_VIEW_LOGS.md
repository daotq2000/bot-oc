# Hướng dẫn xem Logs

## 📁 Cấu trúc Log Files

Logs được lưu trong thư mục `logs/`:

```
logs/
├── combined.log      # Tất cả logs (info và above)
├── error.log         # Chỉ errors
├── orders.log        # Order logs (info và warn)
├── orders-error.log  # Order errors
├── exceptions.log    # Uncaught exceptions
└── rejections.log    # Unhandled promise rejections
```

---

## 🔍 Các cách xem logs

### 1. Xem logs real-time (Tail)

#### Xem tất cả logs:
```bash
tail -f logs/combined.log
```

#### Xem errors:
```bash
tail -f logs/error.log
```

#### Xem order logs:
```bash
tail -f logs/orders.log
```

#### Xem nhiều files cùng lúc:
```bash
tail -f logs/combined.log logs/error.log logs/orders.log
```

---

### 2. Xem logs với format đẹp (JSON)

Logs được lưu dưới dạng JSON. Để xem đẹp hơn:

#### Real-time với jq:
```bash
tail -f logs/combined.log | jq '.'
```

#### Xem last 50 lines với jq:
```bash
tail -n 50 logs/combined.log | jq '.'
```

#### Nếu không có jq, dùng python:
```bash
tail -f logs/combined.log | python3 -m json.tool
```

---

### 3. Tìm kiếm trong logs

#### Tìm theo keyword:
```bash
grep "WebSocketOCConsumer" logs/combined.log
```

#### Tìm errors:
```bash
grep -i "error" logs/combined.log
```

#### Tìm theo symbol:
```bash
grep "BTCUSDT" logs/combined.log
```

#### Tìm theo bot_id:
```bash
grep "bot_id=1" logs/combined.log
```

#### Tìm với context (5 lines trước và sau):
```bash
grep -C 5 "MATCH FOUND" logs/combined.log
```

---

### 4. Filter logs theo level

#### Chỉ xem errors:
```bash
grep '"level":"error"' logs/combined.log
```

#### Chỉ xem warnings:
```bash
grep '"level":"warn"' logs/combined.log
```

#### Chỉ xem info:
```bash
grep '"level":"info"' logs/combined.log
```

---

### 5. Xem logs theo thời gian

#### Xem logs hôm nay:
```bash
grep "$(date +%Y-%m-%d)" logs/combined.log
```

#### Xem logs trong 1 giờ qua:
```bash
grep "$(date -d '1 hour ago' +%Y-%m-%d)" logs/combined.log
```

#### Xem logs từ một thời điểm cụ thể:
```bash
grep "2025-12-26 01:" logs/combined.log
```

---

### 6. Xem logs với statistics

#### Đếm số errors:
```bash
grep -c '"level":"error"' logs/combined.log
```

#### Đếm số matches:
```bash
grep -c "MATCH FOUND" logs/combined.log
```

#### Top 10 symbols được log nhiều nhất:
```bash
grep -oP '"symbol":"[^"]*"' logs/combined.log | sort | uniq -c | sort -rn | head -10
```

---

### 7. Xem logs của một component cụ thể

#### WebSocketOCConsumer:
```bash
grep "WebSocketOCConsumer" logs/combined.log | tail -f
```

#### RealtimeOCDetector:
```bash
grep "RealtimeOCDetector" logs/combined.log | tail -f
```

#### OrderService:
```bash
grep "OrderService" logs/combined.log | tail -f
```

#### PositionService:
```bash
grep "PositionService" logs/combined.log | tail -f
```

---

### 8. Xem logs với color (nếu terminal support)

#### Dùng ccze:
```bash
tail -f logs/combined.log | ccze -A
```

#### Dùng bat:
```bash
tail -f logs/combined.log | bat --paging=never
```

---

### 9. Xem logs từ xa (nếu chạy trên server)

#### SSH và tail:
```bash
ssh user@server "tail -f /path/to/bot-oc/logs/combined.log"
```

#### Dùng tmux/screen để giữ session:
```bash
# Start tmux
tmux new -s logs

# Tail logs
tail -f logs/combined.log

# Detach: Ctrl+B, then D
# Reattach: tmux attach -t logs
```

---

### 10. Scripts tiện ích

#### Xem logs với filter tự động:

**File: `scripts/view_logs.sh`**
```bash
#!/bin/bash

LOG_FILE="logs/combined.log"
LEVEL=${1:-"all"}  # all, error, warn, info, debug

case $LEVEL in
  error)
    tail -f $LOG_FILE | grep '"level":"error"'
    ;;
  warn)
    tail -f $LOG_FILE | grep '"level":"warn"'
    ;;
  info)
    tail -f $LOG_FILE | grep '"level":"info"'
    ;;
  *)
    tail -f $LOG_FILE
    ;;
esac
```

**Usage:**
```bash
chmod +x scripts/view_logs.sh
./scripts/view_logs.sh error    # Chỉ xem errors
./scripts/view_logs.sh warn      # Chỉ xem warnings
./scripts/view_logs.sh          # Xem tất cả
```

---

## 📊 Log Format

Logs được format dưới dạng JSON:

```json
{
  "level": "info",
  "message": "[WebSocketOCConsumer] 🎯 Found 1 match(es) for binance BTCUSDT",
  "service": "bot-oc",
  "timestamp": "2025-12-26 01:03:55"
}
```

### Log Levels:
- `error`: Errors cần attention
- `warn`: Warnings
- `info`: Thông tin quan trọng
- `debug`: Debug information (chỉ khi LOG_LEVEL=debug)

---

## 🎯 Common Use Cases

### 1. Monitor system health:
```bash
tail -f logs/combined.log | grep -E "(error|warn|MATCH FOUND)"
```

### 2. Monitor specific symbol:
```bash
tail -f logs/combined.log | grep "BTCUSDT"
```

### 3. Monitor orders:
```bash
tail -f logs/orders.log
```

### 4. Debug một issue:
```bash
# Set log level to debug
export LOG_LEVEL=debug
# Restart app
# Then tail logs
tail -f logs/combined.log | grep "YourComponent"
```

### 5. Find all errors trong ngày:
```bash
grep "$(date +%Y-%m-%d)" logs/error.log
```

---

## 🔧 Configuration

### Thay đổi log level:

#### Environment variable:
```bash
export LOG_LEVEL=debug
npm start
```

#### Hoặc trong `.env`:
```bash
LOG_LEVEL=debug
```

#### Hoặc runtime (nếu có API):
```javascript
logger.setLevel('debug');
```

### Log levels:
- `error`: Chỉ errors
- `warn`: Warnings và errors
- `info`: Info, warnings, errors (default)
- `debug`: Tất cả logs (rất verbose)

---

## 📝 Tips

1. **Rotate logs:** Logs tự động rotate khi đạt maxsize (10MB cho combined.log)
2. **Disk space:** Monitor disk space, logs có thể chiếm nhiều dung lượng
3. **Performance:** Xem logs real-time có thể ảnh hưởng performance nếu quá nhiều
4. **Filter early:** Dùng grep để filter trước khi tail để giảm output

---

## 🚀 Quick Commands

```bash
# Xem tất cả logs real-time
tail -f logs/combined.log

# Xem errors real-time
tail -f logs/error.log

# Xem last 100 lines
tail -n 100 logs/combined.log

# Tìm "MATCH FOUND"
grep "MATCH FOUND" logs/combined.log

# Đếm errors hôm nay
grep "$(date +%Y-%m-%d)" logs/error.log | wc -l

# Xem logs với jq (đẹp hơn)
tail -f logs/combined.log | jq '.'

# Monitor một symbol cụ thể
tail -f logs/combined.log | grep "BTCUSDT"
```

---

## 📚 Related Files

- `src/utils/logger.js` - Logger configuration
- `logs/` - Log directory
- `.env` - LOG_LEVEL configuration

