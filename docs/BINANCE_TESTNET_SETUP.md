# Binance Testnet Configuration

## ⚠️ Lưu Ý Quan Trọng

Binance đã **deprecate testnet/sandbox mode cho futures** theo thông báo từ CCXT. Xem: https://t.me/ccxt_announcements/92

## ✅ Đã Cấu Hình

### 1. Bot Configuration
- **Bot ID**: 2
- **Bot Name**: Binance Futures Bot
- **Exchange**: binance
- **API Key**: `qK4FcyvMgtJ1sU1YNmZNGP6S9XDWf9T5tNhOscM5VFPccz1onEfvCdcJfLflJSD6`
- **Secret Key**: `20ARlADnok7kxFwUzObqxIufXTm0dZtqjwAIZoiHABOQpfYDsIvol0lM9WzsXFeB`
- **Status**: Active

### 2. Environment Variables
- `BINANCE_SANDBOX=true` đã được thêm vào `.env`

### 3. Strategies
- **Total**: 687 strategies
- **All active**: Yes
- **Symbols**: Tất cả futures symbols từ `binance-future.txt`
- **Parameters**:
  - OC: 2%
  - Interval: 1m
  - Extend: 60%
  - Trade Type: both
  - Amount: $100
  - Reduce: 5
  - Up Reduce: 5
  - Ignore: 80%

## 🔧 Hoạt Động

### Public Data (Hoạt động)
- ✅ Fetch ticker prices
- ✅ Fetch OHLCV (candles)
- ✅ Price alerts (không cần API keys)

### Private API (Có thể không hoạt động với testnet)
- ⚠️ Balance fetch (testnet deprecated)
- ⚠️ Order placement (cần demo trading)
- ⚠️ Transfer operations

## 💡 Giải Pháp

### Option 1: Sử dụng Binance Demo Trading
Binance cung cấp Demo Trading thay vì testnet:
- Đăng ký tại: https://www.binance.com/en/my/demo
- Sử dụng API keys từ demo account
- Không cần sandbox mode

### Option 2: Chỉ sử dụng Public Data
- Price alerts sẽ hoạt động (chỉ cần public data)
- Trading operations sẽ không hoạt động với testnet keys

### Option 3: Sử dụng Mainnet với số tiền nhỏ
- Tạo API keys từ mainnet account
- Sử dụng số tiền nhỏ để test
- **Cẩn thận**: Đây là real trading!

## 🧪 Test Connection

Đã test và xác nhận:
- ✅ Exchange service khởi tạo thành công
- ✅ Ticker price fetch hoạt động
- ✅ OHLCV fetch hoạt động
- ❌ Balance fetch không hoạt động (testnet deprecated)

## 📝 Next Steps

1. **Cho Price Alerts**: Đã sẵn sàng, không cần API keys
2. **Cho Trading**: Cần sử dụng Demo Trading hoặc Mainnet

## 🔍 Verify Configuration

```bash
# Check bot config
docker exec -i crypto-mysql mysql -u root -prootpassword bot_oc -e "SELECT id, bot_name, exchange, is_active FROM bots WHERE exchange = 'binance';"

# Check strategies count
docker exec -i crypto-mysql mysql -u root -prootpassword bot_oc -e "SELECT COUNT(*) as total FROM strategies WHERE bot_id = 2;"
```

---

**Status**: Bot đã được cấu hình với testnet API keys. Price alerts sẽ hoạt động, nhưng trading operations có thể cần Demo Trading hoặc Mainnet.

