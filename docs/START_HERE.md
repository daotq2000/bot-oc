# 🚀 START HERE - MEXC Setup Guide

## Welcome! 👋

Your trading bot has been successfully updated with **MEXC exchange support** and **Price Alert functionality**.

This file will guide you through everything you need to know.

---

## ⚡ 5-Minute Quick Start

### Step 1: Get Your API Keys

**MEXC API Keys:**
1. Go to https://www.mexc.com/user/setting/api
2. Click "Create API Key"
3. Select permissions: Futures Trading + Read
4. Copy: API Key, Secret Key, UID

**Telegram Bot:**
1. Message @BotFather on Telegram
2. Send `/newbot`
3. Follow instructions to create bot
4. Copy the token

**Telegram Chat ID:**
1. Message @userinfobot on Telegram
2. Send `/start`
3. Copy your Chat ID

### Step 2: Update .env File

```bash
# Add these lines to your .env file:
MEXC_API_KEY=your_mexc_api_key
MEXC_SECRET_KEY=your_mexc_secret_key
MEXC_UID=your_mexc_uid

TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_CHAT_ID=your_telegram_chat_id
```

### Step 3: Start Application

```bash
npm start
```

### Step 4: Create Your First Price Alert

```bash
curl -X POST http://localhost:3000/api/price-alerts \
  -H "Content-Type: application/json" \
  -d '{
    "exchange": "mexc",
    "symbols": ["BTC/USDT", "ETH/USDT"],
    "intervals": ["1m", "5m"],
    "threshold": 2.5,
    "telegram_chat_id": "your_chat_id",
    "is_active": true
  }'
```

### Step 5: Verify Setup

```bash
# Check logs
tail -f logs/app.log | grep -i "mexc\|price.*alert"
```

You should see:
```
[INFO] PriceAlertScanner initialized for mexc exchange
[INFO] PriceAlertScanner started with interval 5000ms
```

✅ **Done!** Your bot is now monitoring MEXC prices!

---

## 📚 Documentation Files

### Essential Reading (in order):

1. **MEXC_QUICK_REFERENCE.md** ⭐ START HERE
   - 5-minute overview
   - API endpoints
   - Common issues

2. **MEXC_ENV_SETUP.md**
   - Detailed setup instructions
   - How to get API keys
   - Environment configuration

3. **MEXC_PRICE_ALERT_SETUP.md**
   - Complete API documentation
   - Request/response examples
   - Troubleshooting

4. **examples/mexc-price-alert-example.js**
   - Runnable code examples
   - All API operations

### Additional Resources:

- **ORIGINAL_ISSUE_EXPLANATION.md** - About auto-cancel issue
- **MEXC_IMPLEMENTATION_SUMMARY.md** - Technical details
- **SETUP_COMPLETE.md** - Overview of all changes
- **README_MEXC.md** - Feature summary
- **IMPLEMENTATION_COMPLETE.txt** - Complete checklist

---

## 🎯 What You Can Do Now

### ✅ Trade on MEXC
- Open positions on MEXC Futures
- Automatic leverage configuration
- Position management

### ✅ Monitor Prices
- Real-time price tracking
- Multiple symbols
- Configurable thresholds

### ✅ Get Alerts
- Automatic Telegram notifications
- When price changes exceed threshold
- Throttled to prevent spam

### ✅ Manage Alerts via API
- Create price alerts
- List all alerts
- Update alert settings
- Delete alerts

---

## 🔧 Configuration

### Default Settings
```
MEXC_ENABLED=true
MEXC_DEFAULT_LEVERAGE=5
PRICE_ALERT_SCAN_INTERVAL_MS=5000
PRICE_ALERT_CHECK_ENABLED=true
```

### For Min5 Timeframe (Recommended)
```
ENTRY_ORDER_TTL_MINUTES=60
ENABLE_CANDLE_END_CANCEL_FOR_ENTRY=false
max_concurrent_trades=10
EXTEND_LIMIT_MAX_DIFF_RATIO=0.5
```

See **ORIGINAL_ISSUE_EXPLANATION.md** for details about these settings.

#### Giải thích nhanh config:
- **EXTEND_LIMIT_MAX_DIFF_RATIO**  
  - Tỉ lệ (0–1) cho biết **giá hiện tại được phép lệch bao nhiêu so với entry** (quy đổi theo toàn bộ quãng đường extend từ open → entry) mà bot vẫn đặt LIMIT khi extend chưa chạm đủ 100%.  
  - Ví dụ: `0.5` = cho phép đặt LIMIT nếu giá còn cách entry ≤ 50% quãng đường extend.

- **ENTRY_ORDER_TTL_MINUTES**  
  - Thời gian (phút) cho phép các **lệnh entry LIMIT** (bao gồm cả lệnh do logic extend-miss tạo ra) treo mà không khớp.  
  - Hết thời gian này, job `EntryOrderMonitor` sẽ tự:
    - Hủy lệnh trên sàn.
    - Đánh dấu entry tương ứng trong DB là `expired_ttl`.

---

## 📡 API Quick Reference

```
GET    /api/price-alerts              Get all alerts
GET    /api/price-alerts/:id          Get alert by ID
POST   /api/price-alerts              Create alert
PUT    /api/price-alerts/:id          Update alert
DELETE /api/price-alerts/:id          Delete alert
```

---

## ❓ Common Issues

### "No exchange service for mexc"
→ Check MEXC_API_KEY in .env

### Alerts not being sent
→ Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID

### Orders being auto-cancelled
→ Read ORIGINAL_ISSUE_EXPLANATION.md

### API rate limiting
→ Increase PRICE_ALERT_SCAN_INTERVAL_MS

---

## 📋 Checklist

- [ ] Got MEXC API keys
- [ ] Got Telegram bot token
- [ ] Got Telegram chat ID
- [ ] Updated .env file
- [ ] Started application
- [ ] Created first price alert
- [ ] Received Telegram notification
- [ ] Tested API endpoints

---

## 🎓 Learning Path

### Beginner (30 min)
1. Read MEXC_QUICK_REFERENCE.md (5 min)
2. Follow MEXC_ENV_SETUP.md (10 min)
3. Create first alert (5 min)
4. Verify setup (10 min)

### Intermediate (1 hour)
1. Read MEXC_PRICE_ALERT_SETUP.md (15 min)
2. Run code examples (15 min)
3. Test all API endpoints (15 min)
4. Monitor and adjust (15 min)

### Advanced (2 hours)
1. Read MEXC_IMPLEMENTATION_SUMMARY.md (20 min)
2. Review source code (30 min)
3. Read ORIGINAL_ISSUE_EXPLANATION.md (15 min)
4. Optimize configuration (30 min)
5. Performance testing (25 min)

---

## 🔐 Security Tips

⚠️ **Important**:
- Never commit .env file
- Keep API keys secret
- Use IP whitelist on MEXC
- Rotate keys regularly
- Monitor API usage

---

## [object Object] Tips

1. **Start small**: Create 1-2 alerts first
2. **Monitor logs**: `tail -f logs/app.log | grep -i mexc`
3. **Test Telegram**: Send test message first
4. **Gradual expansion**: Add more symbols after verifying
5. **Adjust thresholds**: Start with 2-3%, adjust based on volatility

---

## 📞 Need Help?

### Setup Issues
→ Read **MEXC_ENV_SETUP.md**

### API Questions
→ Read **MEXC_PRICE_ALERT_SETUP.md**

### Auto-Cancel Issue
→ Read **ORIGINAL_ISSUE_EXPLANATION.md**

### Code Examples
→ See **examples/mexc-price-alert-example.js**

### Technical Details
→ Read **MEXC_IMPLEMENTATION_SUMMARY.md**

---

## 🎉 You're Ready!

Your bot now supports:
- ✅ MEXC Futures trading
- ✅ Real-time price monitoring
- ✅ Automatic Telegram alerts
- ✅ Price alert management

### Next Step:
👉 **Read MEXC_QUICK_REFERENCE.md**

---

## 📊 What's New

### Files Created:
- `src/jobs/PriceAlertScanner.js` - Price monitoring job
- Multiple documentation files
- Code examples

### Files Modified:
- `src/app.js` - Added PriceAlertScanner

### Features Added:
- MEXC exchange integration
- Real-time price monitoring
- Telegram alerts
- REST API for alerts

---

## 🚀 Get Started Now!

1. **Read**: MEXC_QUICK_REFERENCE.md (5 min)
2. **Setup**: MEXC_ENV_SETUP.md (10 min)
3. **Create**: Your first price alert (5 min)
4. **Verify**: Check logs and Telegram (5 min)

**Total: 25 minutes to full setup!**

---

**Last Updated**: 2025-12-12  
**Status**: ✅ Ready to Use

👉 **Next: Read MEXC_QUICK_REFERENCE.md**

