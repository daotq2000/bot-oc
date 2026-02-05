# 🎯 HƯỚNG DẪN CẢI THIỆN LỢI NHUẬN BOT TRADING

**Ngày tạo**: 2026-02-04
**Mục tiêu**: Chuyển từ thua lỗ sang có lãi bền vững

---

## 📊 PHÂN TÍCH NGUYÊN NHÂN LỖ

### Vấn đề chính:
1. **Stop Loss không được đặt** (0% coverage) → Lỗ không giới hạn
2. **Win Rate thấp** (42%) → Entry filters chưa đủ chặt
3. **Sync issues cao** (89%) → Positions bị đóng không đúng cách

---

## 🔴 P0: FIX STOP LOSS (KHẨN CẤP)

### Bước 1: Đảm bảo strategies có stoploss > 0

```sql
-- Kiểm tra strategies hiện tại
SELECT id, symbol, take_profit, stoploss, reduce, up_reduce 
FROM strategies 
WHERE is_active = 1 
LIMIT 20;

-- Cập nhật stoploss nếu chưa có (ví dụ: 25 USDT cho mỗi trade)
UPDATE strategies 
SET stoploss = 25 
WHERE stoploss IS NULL OR stoploss <= 0;
```

### Bước 2: Bật Software Stop Loss trong .env

```env
# ===== STOP LOSS CONFIGURATION =====
SOFTWARE_SL_ENABLED=true
SOFTWARE_SL_CHECK_INTERVAL_MS=500

# Nếu dùng exchange SL (Binance mainnet)
# Testnet không hỗ trợ STOP_MARKET orders
```

### Bước 3: Kiểm tra config trong strategies

- **stoploss**: Số USDT tối đa chấp nhận lỗ mỗi trade
- Ví dụ: `stoploss = 25` → Mỗi trade max lỗ 25 USDT

---

## 🟡 P1: CẢI THIỆN ENTRY FILTERS

### Thêm vào file .env:

```env
# ===== ENTRY FILTERS (QUAN TRỌNG) =====

# Volatility Filter - tránh thị trường quá yên tĩnh hoặc quá biến động
VOLATILITY_FILTER_ENABLED=true
VOL_ATR_MIN_PCT=0.3      # Minimum ATR% (tránh thị trường chết)
VOL_ATR_MAX_PCT=3.0      # Maximum ATR% (tránh quá volatile)

# Volume Confirmation
VOLUME_VMA_GATE_ENABLED=true
VOLUME_VMA_MIN_RATIO=1.5  # Volume phải > 1.5x trung bình

# Pullback Confirmation - không chase price
PULLBACK_CONFIRMATION_ENABLED=true

# RVOL Filter - Relative Volume
RVOL_FILTER_ENABLED=true
RVOL_MIN=1.3              # Tăng từ 1.2 lên 1.3

# Donchian Breakout Confirmation
DONCHIAN_FILTER_ENABLED=true
DONCHIAN_PERIOD=20

# Bollinger Bands Filter
BOLLINGER_GATE_ENABLED=true

# Market Regime Detection - tránh trade trong ranging market
MARKET_REGIME_FILTER_ENABLED=true
REGIME_ADX_STRONG_TREND=30
REGIME_ADX_WEAK_TREND=20

# Funding Rate Filter - tránh extreme sentiment
FUNDING_RATE_FILTER_ENABLED=true
FUNDING_EXTREME_POSITIVE=0.08   # Giảm từ 0.10 xuống 0.08
FUNDING_EXTREME_NEGATIVE=-0.08
```

---

## 🟡 P2: CẢI THIỆN TAKE PROFIT & TRAILING

### Cấu hình Trailing Stop trong .env:

```env
# ===== TRAILING STOP & PROFIT LOCK =====
ADV_TPSL_TRAILING_ENABLED=true
ADV_TPSL_TRAILING_BUFFER_PCT=0.1

# Profit Lock Levels: [pnl%, lock%]
# Khi PnL đạt X%, lock Y% của profit
ADV_TPSL_PROFIT_LOCK_LEVELS=[[1,0],[2,0.3],[3,0.5],[5,0.7],[8,0.8]]

# Break-even: Di chuyển SL về entry + buffer khi đạt X% profit
ADV_TPSL_BREAK_EVEN_ENABLED=true
ADV_TPSL_BREAK_EVEN_PCT=1.5      # Khi profit >= 1.5%, move SL to break-even
ADV_TPSL_BREAK_EVEN_BUFFER_PCT=0.1

# Risk/Reward minimum
ADV_TPSL_RR_ENABLED=true
ADV_TPSL_MIN_RR=2.0             # Tối thiểu 2:1 R/R ratio
```

### Cấu hình ATR-based TP/SL:

```env
# ===== ATR-BASED TP/SL (Dynamic levels) =====
ADV_TPSL_ATR_ENABLED=true
ADV_TPSL_ATR_TIMEFRAME=1h
ADV_TPSL_ATR_PERIOD=14
ADV_TPSL_ATR_TP_MULT=2.5        # TP = Entry ± 2.5*ATR
ADV_TPSL_ATR_SL_MULT=1.5        # SL = Entry ± 1.5*ATR
```

---

## 🟡 P3: CẢI THIỆN POSITION MANAGEMENT

### Giảm số positions đồng thời:

```env
# ===== POSITION LIMITS =====
# Giảm từ 1000 xuống 200-300
MAX_CONCURRENT_TRADES=200

# Giới hạn exposure per symbol (USDT)
MAX_AMOUNT_PER_COIN=500

# Minimum notional để tránh dust orders
MIN_NOTIONAL=50
```

### Partial Take Profit:

```env
# ===== PARTIAL TAKE PROFIT =====
ADV_TPSL_PARTIAL_TP_ENABLED=true

# Levels: { pct: profit%, close_pct: close% }
# Ví dụ: Khi profit 2%, close 30%; profit 4%, close 50%; profit 6%, close remaining
PARTIAL_TP_LEVELS=[{"pct":2,"close_pct":30},{"pct":4,"close_pct":50},{"pct":6,"close_pct":100}]
```

---

## 📈 CHIẾN LƯỢC TỐI ƯU THEO MARKET

### 1. Trending Market (ADX > 25):
```json
{
  "oc": 2.0,
  "extend": 20,
  "take_profit": 80,
  "stoploss": 30,
  "reduce": 30,
  "up_reduce": 30,
  "trade_type": "both"
}
```

### 2. Ranging/Sideways Market (ADX < 20):
```json
{
  "oc": 0.8,
  "extend": 50,
  "take_profit": 45,
  "stoploss": 20,
  "reduce": 40,
  "up_reduce": 40,
  "trade_type": "both"
}
```

### 3. Conservative (An toàn):
```json
{
  "oc": 1.2,
  "extend": 40,
  "take_profit": 50,
  "stoploss": 20,
  "reduce": 45,
  "up_reduce": 45,
  "trade_type": "both"
}
```

---

## 🔧 CHECKLIST TRIỂN KHAI

### Ngay lập tức (Hôm nay):
- [ ] Update .env với các cấu hình trên
- [ ] Chạy SQL update stoploss cho strategies
- [ ] Restart bot
- [ ] Verify SL orders được đặt (kiểm tra trong Binance)

### Ngắn hạn (Tuần này):
- [ ] Monitor win rate sau khi bật filters
- [ ] Điều chỉnh VOL_ATR_MIN_PCT, VOL_ATR_MAX_PCT
- [ ] Kiểm tra Trailing Stop hoạt động đúng

### Trung hạn (2 tuần):
- [ ] Phân tích lại PnL report
- [ ] Tối ưu parameters theo kết quả thực tế
- [ ] Consider partial TP levels

---

## 📊 METRICS CẦN THEO DÕI

| Metric | Mục tiêu | Cách đo |
|--------|----------|---------|
| Win Rate | > 50% | `wins / total_closed` |
| SL Coverage | 100% | `positions_with_sl / total_open` |
| TP Coverage | 100% | `positions_with_tp / total_open` |
| Avg Win | > 2x Avg Loss | `avg_win_pnl / abs(avg_loss_pnl)` |
| Max Drawdown | < 10% | Peak-to-trough decline |
| Profit Factor | > 1.5 | `gross_profit / gross_loss` |

---

## ⚠️ CẢNH BÁO

1. **KHÔNG trade mà không có SL** - Đây là nguyên nhân chính gây lỗ sâu
2. **Giảm position size** khi test cấu hình mới
3. **Backup database** trước khi update strategies
4. **Monitor kỹ** 24-48h đầu sau khi thay đổi

---

## 🎯 KỲ VỌNG SAU CẢI THIỆN

| Giai đoạn | Win Rate | Monthly PnL | Note |
|-----------|----------|-------------|------|
| Hiện tại | 42% | Lỗ | SL = 0% |
| Sau P0 | 45% | Hòa vốn | SL = 100% |
| Sau P1 | 50%+ | +5-10% | Filters chặt hơn |
| Sau P2+P3 | 55%+ | +10-15% | Full optimization |

---

*Document created: 2026-02-04*
*Author: AI Analysis based on codebase scan*
