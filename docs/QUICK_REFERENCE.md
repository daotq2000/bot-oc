# MEXC Implementation -[object Object] Quick Start (5 minutes)

### 1. Pull Code
```bash
git pull origin main
npm install
```

### 2. Create MEXC Bot
```sql
INSERT INTO bots (bot_name, exchange, uid, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('MEXC Bot', 'mexc', 'your_uid', 'your_key', 'your_secret', '123456789', 1);
```

### 3. Create Strategy
```sql
INSERT INTO strategies (bot_id, symbol, trade_type, interval, oc, extend, amount, take_profit, reduce, up_reduce, is_active)
VALUES ((SELECT id FROM bots WHERE bot_name = 'MEXC Bot'), 'BTCUSDT', 'both', '1m', 11, 95, 100, 65, 5, 5, 1);
```

### 4. Start App
```bash
npm start
```

### 5. Monitor
```bash
tail -f logs/app.log | grep -i mexc
```

---

## 📝 Files Changed

| File | Changes | Impact |
|------|---------|--------|
| `src/config/constants.js` | +1 line | Added BINANCE constant |
| `src/services/ExchangeService.js` | +50 lines | MEXC integration |
| `src/services/OrderService.js` | +10 lines | Error handling |
| `src/services/PositionService.js` | +5 lines | Documentation |
| `src/services/CandleService.js` | +15 lines | Format normalization |
| `src/jobs/BalanceManager.js` | 0 lines | No changes needed |

---

## 🔧 Key Changes

### ExchangeService
```javascript
// MEXC UID configuration
if (this.bot.exchange === 'mexc' && this.bot.uid) {
  this.exchange.uid = this.bot.uid;
}

// MEXC swap trading
this.exchange.options.defaultType = 'swap';

// Balance normalization
let usdtBalance = balance.USDT || balance.USDT_SWAP;

// Transfer endpoints
if (this.bot.exchange === 'mexc') {
  await this.exchange.transfer('USDT', amount, 'spot', 'swap');
}

// Position format normalization
contracts: p.contracts || Math.abs(parseFloat(p.positionAmt || 0))
```

### OrderService
```javascript
// MEXC price error fallback
const shouldFallbackToMarket = 
  em.includes('Order price is too high') ||
  em.includes('Order price is too low');
```

### CandleService
```javascript
// MEXC object format
const openTime = candle.t || candle.openTime;
const open = parseFloat(candle.o || candle.open);
```

---

## 🧪 Testing Commands

### Verify Changes
```bash
# Check constants
grep "BINANCE: 'binance'" src/config/constants.js

# Check ExchangeService
grep "MEXC configured for swap" src/services/ExchangeService.js

# Check OrderService
grep "Order price is too high" src/services/OrderService.js

# Check CandleService
grep "candle.t\|candle.o" src/services/CandleService.js
```

### Run Tests
```bash
npm test -- --testPathPattern=mexc
npm run test:integration -- --testPathPattern=mexc
```

### Monitor Logs
```bash
# MEXC initialization
tail -f logs/app.log | grep "MEXC"

# Order creation
tail -f logs/app.log | grep "Order created"

# Errors
tail -f logs/app.log | grep -i error
```

---

## 🐛 Common Issues

### Issue: "Invalid symbol"
```
Solution: Verify symbol is tradable on MEXC futures
UPDATE strategies SET symbol = 'ETHUSDT' WHERE symbol = 'INVALID';
```

### Issue: "Insufficient balance"
```
Solution: Transfer more funds to futures wallet
UPDATE bots SET spot_transfer_threshold = 50.00 WHERE exchange = 'mexc';
```

### Issue: "Order quantity is too small"
```
Solution: Increase order amount
UPDATE strategies SET amount = 100.00 WHERE bot_id = (SELECT id FROM bots WHERE exchange = 'mexc');
```

### Issue: Position not closing
```
Solution: Check if already closed by TP/SL
SELECT id, status FROM positions WHERE bot_id = (SELECT id FROM bots WHERE exchange = 'mexc') ORDER BY created_at DESC;
```

---

## 📊 MEXC vs Binance

| Feature | MEXC | Binance |
|---------|------|---------|
| API Type | CCXT | Direct |
| Transfer | spot ↔ swap | spot ↔ future |
| Balance | USDT_SWAP | USDT |
| Position | positionAmt | positionAmt |
| Candle | Array/Object | Array |
| Errors | Text | Numeric |

---

## 🚀 Deployment

### Pre-Deploy
```bash
# 1. Review changes
git diff

# 2. Run tests
npm test

# 3. Verify logs
npm start &
sleep 5
tail -f logs/app.log | grep -i mexc
```

### Deploy
```bash
# 1. Pull code
git pull

# 2. Create bot
mysql -u user -p database < create_mexc_bot.sql

# 3. Start app
npm start
```

### Post-Deploy
```bash
# 1. Monitor logs
tail -f logs/app.log

# 2. Check bot status
curl http://localhost:3000/api/bots | jq '.[] | select(.exchange == "mexc")'

# 3. Verify orders
curl http://localhost:3000/api/positions | jq '.[] | select(.bot_id == 1)'
```

---

## 📚 Documentation

- **Full Guide**: `MEXC_IMPLEMENTATION_GUIDE.md`
- **Summary**: `MEXC_IMPLEMENTATION_SUMMARY.md`
- **Checklist**: `MEXC_VERIFICATION_CHECKLIST.md`
- **Deployment**: `MEXC_DEPLOYMENT_GUIDE.md`

---

## ✅ Verification

- [x] Code changes implemented
- [x] Constants updated
- [x] ExchangeService enhanced
- [x] OrderService updated
- [x] CandleService enhanced
- [x] Documentation complete
- [x] Backward compatible
- [x] Ready for testing

---

## 🎯 Next Steps

1. **Test** (1-2 days)
   - Unit tests
   - Integration tests
   - Paper trading

2. **Deploy** (1 day)
   - Code deploy
   - Bot creation
   - Strategy setup

3. **Monitor** (Ongoing)
   - Log monitoring
   - Error tracking
   - Performance metrics

---

## 📞 Quick Help

**Question**: How to create MEXC bot?
**Answer**: See "Quick Start" section above

**Question**: What changed?
**Answer**: See "Files Changed" table above

**Question**: How to test?
**Answer**: See "Testing Commands" section above

**Question**: What's different from Binance?
**Answer**: See "MEXC vs Binance" table above

**Question**: How to troubleshoot?
**Answer**: See "Common Issues" section above

---

**Status**: ✅ Ready for Testing & Deployment
**Last Updated**: 2025-12-05
