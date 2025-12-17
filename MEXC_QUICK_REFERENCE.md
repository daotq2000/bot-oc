# MEXC Price Alert -[object Object] 5-Minute Setup

### 1. Get API Keys
- MEXC: https://www.mexc.com/user/setting/api
- Telegram: Message @BotFather on Telegram

### 2. Update .env
```bash
MEXC_API_KEY=your_key
MEXC_SECRET_KEY=your_secret
MEXC_UID=your_uid
TELEGRAM_BOT_TOKEN=your_token
TELEGRAM_CHAT_ID=your_chat_id
```

### 3. Start App
```bash
npm start
```

### 4. Create Alert
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

---

## 📡 API Endpoints

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/price-alerts` | Get all alerts |
| GET | `/api/price-alerts/:id` | Get alert by ID |
| POST | `/api/price-alerts` | Create alert |
| PUT | `/api/price-alerts/:id` | Update alert |
| DELETE | `/api/price-alerts/:id` | Delete alert |

---

## 🔧 Configuration

| Key | Default | Description |
|-----|---------|-------------|
| `MEXC_ENABLED` | `true` | Enable MEXC |
| `MEXC_DEFAULT_LEVERAGE` | `5` | Default leverage |
| `PRICE_ALERT_SCAN_INTERVAL_MS` | `5000` | Scan interval (ms) |
| `PRICE_ALERT_CHECK_ENABLED` | `true` | Enable alerts |

---

## 📊 Example Alert Response

```json
{
  "success": true,
  "data": {
    "id": 1,
    "exchange": "mexc",
    "symbols": ["BTC/USDT", "ETH/USDT"],
    "intervals": ["1m", "5m"],
    "threshold": 2.5,
    "telegram_chat_id": "123456789",
    "is_active": true,
    "created_at": "2025-12-12T04:27:01.370Z",
    "last_alert_time": null
  }
}
```

---

## [object Object]

| Problem | Solution |
|---------|----------|
| "No exchange service for mexc" | Check MEXC_API_KEY in .env |
| Alerts not sent | Check TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID |
| API rate limit | Increase PRICE_ALERT_SCAN_INTERVAL_MS |
| High CPU usage | Reduce number of symbols or increase interval |

---

## 📚 Full Documentation

- **Setup Guide**: `MEXC_ENV_SETUP.md`
- **API Reference**: `MEXC_PRICE_ALERT_SETUP.md`
- **Implementation Details**: `MEXC_IMPLEMENTATION_SUMMARY.md`
- **Code Examples**: `examples/mexc-price-alert-example.js`

---

## 💡 Tips

1. **Start small**: Create 1-2 alerts first
2. **Monitor logs**: `tail -f logs/app.log | grep -i mexc`
3. **Test Telegram**: Send test message to verify bot works
4. **Adjust threshold**: Start with 2-3%, adjust based on needs
5. **Use intervals**: Combine 1m, 5m, 1h for better coverage

---

## ✅ Verification

After setup, you should see in logs:
```
[INFO] PriceAlertScanner initialized for mexc exchange
[INFO] PriceAlertScanner started with interval 5000ms
```

When price changes:
```
[INFO] Price alert sent for BTC/USDT on mexc (change: 2.50%)
```

---

## 🔐 Security

⚠️ **IMPORTANT**:
- Never commit `.env` file
- Rotate API keys regularly
- Use IP whitelist on MEXC
- Monitor API usage

---

**Last Updated**: 2025-12-12  
**Status**: ✅ Production Ready

