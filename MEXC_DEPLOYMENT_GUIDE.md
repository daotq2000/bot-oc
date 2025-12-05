# MEXC Exchange Deployment Guide

## 📋 Quick Start

### Prerequisites
- Node.js 14+ with npm
- MySQL database
- MEXC API credentials (API Key, Secret Key, UID)
- Existing bot infrastructure running

### Installation Steps

1. **Pull Latest Code**
   ```bash
   git pull origin main
   npm install
   ```

2. **Verify Changes**
   ```bash
   # Check constants update
   grep "BINANCE: 'binance'" src/config/constants.js
   
   # Check ExchangeService changes
   grep "MEXC configured for swap trading" src/services/ExchangeService.js
   ```

3. **Create MEXC Bot in Database**
   ```sql
   INSERT INTO bots (
     bot_name,
     exchange,
     uid,
     access_key,
     secret_key,
     telegram_chat_id,
     future_balance_target,
     spot_transfer_threshold,
     transfer_frequency,
     max_concurrent_trades,
     is_active,
     created_at,
     updated_at
   ) VALUES (
     'MEXC Trading Bot 1',
     'mexc',
     'your_mexc_uid_here',
     'your_api_key_here',
     'your_secret_key_here',
     'your_telegram_chat_id',
     20.00,
     10.00,
     15,
     5,
     1,
     NOW(),
     NOW()
   );
   ```

4. **Create Trading Strategies**
   ```sql
   INSERT INTO strategies (
     bot_id,
     symbol,
     trade_type,
     `interval`,
     oc,
     extend,
     amount,
     take_profit,
     reduce,
     up_reduce,
     `ignore`,
     is_active,
     created_at,
     updated_at
   ) VALUES (
     (SELECT id FROM bots WHERE bot_name = 'MEXC Trading Bot 1'),
     'BTCUSDT',
     'both',
     '1m',
     11.00,
     95.00,
     100.00,
     65.00,
     5.00,
     5.00,
     80.00,
     1,
     NOW(),
     NOW()
   );
   ```

5. **Start Application**
   ```bash
   npm start
   ```

6. **Monitor Logs**
   ```bash
   # Look for MEXC initialization logs
   tail -f logs/app.log | grep -i mexc
   
   # Expected logs:
   # - "MEXC UID configured for bot X"
   # - "MEXC configured for swap trading (futures) for bot X"
   # - "Exchange mexc initialized for bot X"
   ```

---

## 🔧 Configuration

### Environment Variables

```env
# Optional: Enable MEXC Sandbox Mode
MEXC_SANDBOX=false

# Optional: CCXT Sandbox Mode (affects all exchanges)
CCXT_SANDBOX=false

# Existing configuration (unchanged)
LOG_LEVEL=info
DATABASE_URL=mysql://user:password@localhost/botdb
TELEGRAM_BOT_TOKEN=your_token
```

### Bot Configuration Fields

| Field | Required | Description | Example |
|-------|----------|-------------|---------|
| bot_name | Yes | Unique bot identifier | MEXC Bot 1 |
| exchange | Yes | Exchange name | mexc |
| uid | Recommended | MEXC UID for better API performance | abc123xyz |
| access_key | Yes | MEXC API Key | your_api_key |
| secret_key | Yes | MEXC Secret Key | your_secret_key |
| telegram_chat_id | Yes | Telegram chat for notifications | 123456789 |
| future_balance_target | Yes | Target balance for futures wallet | 20.00 |
| spot_transfer_threshold | Yes | Minimum balance to trigger transfer | 10.00 |
| transfer_frequency | Yes | Transfer check frequency (minutes) | 15 |
| max_concurrent_trades | Yes | Maximum concurrent positions | 5 |
| is_active | Yes | Bot active status | 1 |

---

## 📊 Supported Features

### Trading Operations
- ✅ Market orders (buy/sell)
- ✅ Limit orders (buy/sell)
- ✅ Stop-loss orders
- ✅ Take-profit orders
- ✅ Position closing
- ✅ Leverage management

### Balance Management
- ✅ Spot balance tracking
- ✅ Futures balance tracking
- ✅ Automatic transfers (spot → futures)
- ✅ Automatic transfers (futures → spot)
- ✅ Withdrawal support

### Market Data
- ✅ Real-time price updates
- ✅ Candlestick data (1m, 3m, 5m, 15m, 30m, 1h)
- ✅ Position tracking
- ✅ PnL calculation

### Notifications
- ✅ Entry trade alerts
- ✅ Close trade alerts
- ✅ Balance alerts
- ✅ Error alerts

---

## 🚀 Deployment Scenarios

### Scenario 1: Single MEXC Bot

```sql
-- Create bot
INSERT INTO bots (bot_name, exchange, uid, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('MEXC Bot 1', 'mexc', 'uid123', 'key123', 'secret123', '123456789', 1);

-- Create strategies
INSERT INTO strategies (bot_id, symbol, trade_type, interval, oc, extend, amount, take_profit, reduce, up_reduce, is_active)
VALUES (
  (SELECT id FROM bots WHERE bot_name = 'MEXC Bot 1'),
  'BTCUSDT', 'both', '1m', 11, 95, 100, 65, 5, 5, 1
);
```

### Scenario 2: Multi-Exchange Setup (Binance + MEXC + Gate.io)

```sql
-- Binance bot
INSERT INTO bots (bot_name, exchange, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('Binance Bot', 'binance', 'binance_key', 'binance_secret', '123456789', 1);

-- MEXC bot
INSERT INTO bots (bot_name, exchange, uid, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('MEXC Bot', 'mexc', 'mexc_uid', 'mexc_key', 'mexc_secret', '123456789', 1);

-- Gate.io bot
INSERT INTO bots (bot_name, exchange, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('Gate Bot', 'gate', 'gate_key', 'gate_secret', '123456789', 1);
```

### Scenario 3: Gradual Rollout

**Phase 1: Paper Trading**
```sql
-- Create MEXC bot with small amounts
INSERT INTO bots (bot_name, exchange, uid, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('MEXC Paper Trading', 'mexc', 'uid123', 'key123', 'secret123', '123456789', 1);

-- Create strategies with small amounts
INSERT INTO strategies (bot_id, symbol, amount, is_active)
VALUES ((SELECT id FROM bots WHERE bot_name = 'MEXC Paper Trading'), 'BTCUSDT', 10.00, 1);
```

**Phase 2: Small Live Trading**
```sql
-- Update strategy amount
UPDATE strategies SET amount = 50.00 WHERE bot_id = (SELECT id FROM bots WHERE bot_name = 'MEXC Paper Trading');
```

**Phase 3: Full Deployment**
```sql
-- Update strategy amount to production
UPDATE strategies SET amount = 100.00 WHERE bot_id = (SELECT id FROM bots WHERE bot_name = 'MEXC Paper Trading');
```

---

## 🔍 Monitoring & Troubleshooting

### Health Check

```bash
# Check if MEXC bot is running
curl http://localhost:3000/api/bots | jq '.[] | select(.exchange == "mexc")'

# Expected response:
# {
#   "id": 1,
#   "bot_name": "MEXC Trading Bot 1",
#   "exchange": "mexc",
#   "is_active": true
# }
```

### Log Monitoring

```bash
# Monitor MEXC-specific logs
tail -f logs/app.log | grep -i mexc

# Monitor order creation
tail -f logs/app.log | grep "Order created"

# Monitor position updates
tail -f logs/app.log | grep "Position"

# Monitor errors
tail -f logs/app.log | grep -i error
```

### Common Issues & Solutions

#### Issue 1: "Invalid symbol" Error
```
Error: Invalid symbol
```

**Cause**: Symbol not available on MEXC futures

**Solution**:
1. Verify symbol is tradable on MEXC
2. Check symbol format (e.g., BTC/USDT)
3. Update strategy with valid symbol

```sql
-- Check available symbols
SELECT DISTINCT symbol FROM strategies WHERE bot_id = (SELECT id FROM bots WHERE exchange = 'mexc');

-- Update to valid symbol
UPDATE strategies SET symbol = 'ETHUSDT' WHERE symbol = 'INVALID';
```

#### Issue 2: "Insufficient balance" Error
```
Error: Insufficient balance
```

**Cause**: Not enough balance in futures wallet

**Solution**:
1. Check balance in MEXC account
2. Transfer from spot to futures
3. Increase transfer threshold

```sql
-- Check bot balance settings
SELECT future_balance_target, spot_transfer_threshold FROM bots WHERE exchange = 'mexc';

-- Increase transfer threshold
UPDATE bots SET spot_transfer_threshold = 50.00 WHERE exchange = 'mexc';
```

#### Issue 3: "Order quantity is too small" Error
```
Error: Order quantity is too small
```

**Cause**: Order amount below MEXC minimum notional

**Solution**:
1. Increase order amount in strategy
2. Check MEXC minimum notional requirements
3. Update strategy amount

```sql
-- Check current strategy amounts
SELECT symbol, amount FROM strategies WHERE bot_id = (SELECT id FROM bots WHERE exchange = 'mexc');

-- Increase amount
UPDATE strategies SET amount = 100.00 WHERE bot_id = (SELECT id FROM bots WHERE exchange = 'mexc');
```

#### Issue 4: Position Not Closing
```
Warning: ReduceOnly close skipped
```

**Cause**: Position already closed or race condition

**Solution**:
1. Check if position was closed by TP/SL
2. Verify position exists on exchange
3. Check balance and permissions

```sql
-- Check position status
SELECT id, symbol, status FROM positions WHERE bot_id = (SELECT id FROM bots WHERE exchange = 'mexc') ORDER BY created_at DESC LIMIT 10;

-- Check closed positions
SELECT id, symbol, close_reason, pnl FROM positions WHERE bot_id = (SELECT id FROM bots WHERE exchange = 'mexc') AND status = 'closed' ORDER BY closed_at DESC LIMIT 10;
```

---

## 📈 Performance Optimization

### Rate Limiting
- MEXC has API rate limits
- CCXT handles rate limiting automatically
- Sequential bot processing prevents rate limit issues

```javascript
// BalanceManager processes bots sequentially
for (const bot of bots) {
  await this.manageBotBalances(bot);
  await new Promise(resolve => setTimeout(resolve, 2000)); // 2s delay
}
```

### Caching
- Exchange info cached to reduce API calls
- Fallback to REST API if cache miss

```javascript
// Cache hit
const tickSize = exchangeInfoService.getTickSize(symbol);

// Cache miss - fallback to REST API
if (!tickSize) {
  const tickSize = await exchangeService.getTickSize(symbol);
}
```

### Connection Pooling
- CCXT manages connection pooling
- No additional configuration needed

---

## 🧪 Testing Before Production

### 1. Unit Tests
```bash
# Run unit tests
npm test -- --testPathPattern=mexc

# Expected: All tests pass
```

### 2. Integration Tests
```bash
# Run integration tests
npm run test:integration -- --testPathPattern=mexc

# Expected: All tests pass
```

### 3. Paper Trading
```bash
# Create paper trading bot
INSERT INTO bots (bot_name, exchange, uid, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('MEXC Paper Trading', 'mexc', 'uid123', 'key123', 'secret123', '123456789', 1);

# Monitor for 24-48 hours
# Check: Order execution, position tracking, balance management
```

### 4. Small Live Trading
```bash
# Create live trading bot with small amounts
INSERT INTO bots (bot_name, exchange, uid, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('MEXC Live Small', 'mexc', 'uid123', 'key123', 'secret123', '123456789', 1);

# Monitor for 24-48 hours with small amounts (e.g., $10-50)
# Check: Order execution, position tracking, balance management, PnL
```

### 5. Production Deployment
```bash
# Create production bot
INSERT INTO bots (bot_name, exchange, uid, access_key, secret_key, telegram_chat_id, is_active)
VALUES ('MEXC Production', 'mexc', 'uid123', 'key123', 'secret123', '123456789', 1);

# Monitor closely for first week
# Check: All operations, error rates, performance metrics
```

---

## 📞 Support & Resources

### Documentation Files
- `MEXC_IMPLEMENTATION_GUIDE.md` - Detailed implementation guide
- `MEXC_IMPLEMENTATION_SUMMARY.md` - Summary of changes
- `MEXC_VERIFICATION_CHECKLIST.md` - Verification checklist
- `MEXC_DEPLOYMENT_GUIDE.md` - This file

### MEXC Resources
- [MEXC API Documentation](https://mxcdeveloper.com/en)
- [MEXC Futures API](https://mxcdeveloper.com/en/futures)
- [MEXC Support](https://support.mexc.com/)

### CCXT Resources
- [CCXT MEXC Exchange](https://docs.ccxt.com/en/latest/manual/exchanges/mexc.html)
- [CCXT Futures Trading](https://docs.ccxt.com/en/latest/manual/trading.html)
- [CCXT GitHub](https://github.com/ccxt/ccxt)

### Project Resources
- Project Repository: [Your Repo URL]
- Issue Tracker: [Your Issue Tracker URL]
- Documentation: [Your Docs URL]

---

## ✅ Deployment Checklist

### Pre-Deployment
- [ ] All code changes reviewed
- [ ] Tests passing (unit + integration)
- [ ] Documentation complete
- [ ] MEXC API credentials obtained
- [ ] Database backup created
- [ ] Rollback plan documented

### Deployment
- [ ] Code deployed to production
- [ ] Database migrations run
- [ ] MEXC bot created
- [ ] Strategies configured
- [ ] Application restarted
- [ ] Health checks passing

### Post-Deployment
- [ ] Monitor logs for errors
- [ ] Verify order execution
- [ ] Verify position tracking
- [ ] Verify balance management
- [ ] Monitor for 24 hours
- [ ] Gather performance metrics

### Rollback Plan
- [ ] Disable MEXC bot: `UPDATE bots SET is_active = 0 WHERE exchange = 'mexc';`
- [ ] Revert code changes if needed
- [ ] Restart application
- [ ] Verify system stability

---

## 🎓 Learning Path

1. **Understand MEXC API**
   - Read MEXC API documentation
   - Understand futures trading concepts
   - Learn about leverage and margin

2. **Understand CCXT**
   - Read CCXT documentation
   - Understand CCXT exchange interface
   - Learn about error handling

3. **Understand Implementation**
   - Read implementation guide
   - Review code changes
   - Understand exchange-specific logic

4. **Test & Deploy**
   - Run tests
   - Paper trading
   - Small live trading
   - Production deployment

---

## 📝 Sign-Off

**Deployment Status**: Ready
**Documentation**: Complete
**Testing**: Recommended before production
**Support**: Available

---

**Last Updated**: 2025-12-05
**Version**: 1.0
**Status**: Production Ready (Pending Testing)

