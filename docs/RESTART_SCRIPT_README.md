# Script Force Restart Bot

Script `restart_bot.sh` để force restart bot service với các bước:
1. Stop và delete PM2 process
2. Kill tất cả processes còn lại
3. Clear logs (PM2 logs và project logs)
4. Restart bot với PID mới
5. Hiển thị status và logs

## Cách sử dụng

```bash
cd /home/daotran2/Documents/Github/bot-oc
./restart_bot.sh
```

Hoặc:

```bash
bash restart_bot.sh
```

## Các bước script thực hiện

### 1. Stop PM2 Process
- Dừng và xóa process từ PM2
- Đảm bảo không còn process nào trong PM2 list

### 2. Kill Remaining Processes
- Tìm và kill tất cả processes đang chạy `app.js`
- Kill process đang sử dụng port 3000 (nếu có)
- Đảm bảo không còn process nào đang chạy

### 3. Clear Logs
- Clear PM2 logs: `pm2 flush bot-oc`
- Clear project logs: `logs/combined.log` và `logs/error.log`
- Tạo log directory nếu chưa có

### 4. Restart Bot
- Start bot với PM2: `pm2 start src/app.js --name bot-oc`
- Save PM2 configuration: `pm2 save`
- Đợi 3 giây để bot khởi động

### 5. Show Status
- Hiển thị PM2 status
- Hiển thị 10 dòng logs gần nhất

## Output mẫu

```
🔄 Force Restart Bot Service
==============================

📌 Step 1: Stopping PM2 process...
✅ PM2 process stopped/deleted

📌 Step 2: Killing remaining processes...
✅ All processes killed

📌 Step 3: Clearing logs...
✅ PM2 logs cleared
✅ Project logs cleared

📌 Step 4: Starting bot with PM2...
✅ Bot started (PID: 37807)

📌 Step 5: Bot Status
==============================
[PM2 status output]

✅ Bot restarted successfully!
```

## Lưu ý

- Script sẽ kill tất cả processes liên quan đến bot
- Logs sẽ bị xóa hoàn toàn
- Bot sẽ được restart với PID mới
- PM2 configuration sẽ được save tự động

## Troubleshooting

Nếu script gặp lỗi:
1. Kiểm tra quyền thực thi: `chmod +x restart_bot.sh`
2. Kiểm tra PM2 đã cài đặt: `which pm2`
3. Kiểm tra bot name trong script: `BOT_NAME="bot-oc"`
4. Kiểm tra project directory: `PROJECT_DIR="/home/daotran2/Documents/Github/bot-oc"`

