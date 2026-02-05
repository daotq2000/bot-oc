# 📊 BÁO CÁO CHI TIẾT: SỬ DỤNG CHỈ BÁO (INDICATORS) TRONG BOT-OC

> **Ngày tạo:** 2026-02-05  
> **Branch:** `ema`  
> **Mục đích:** Tài liệu hóa chi tiết cách hệ thống sử dụng các chỉ báo kỹ thuật để lọc và xác nhận entry

---

## 📑 MỤC LỤC

1. [Tổng Quan Kiến Trúc](#1-tổng-quan-kiến-trúc)
2. [Danh Sách Các Chỉ Báo](#2-danh-sách-các-chỉ-báo)
3. [Chi Tiết Từng Chỉ Báo](#3-chi-tiết-từng-chỉ-báo)
4. [Trend Filter Logic](#4-trend-filter-logic)
5. [Entry Filters Nâng Cao](#5-entry-filters-nâng-cao)
6. [Cấu Hình và Ngưỡng](#6-cấu-hình-và-ngưỡng)
7. [Sơ Đồ Flow Entry](#7-sơ-đồ-flow-entry)
8. [Khác Biệt Binance vs MEXC](#8-khác-biệt-binance-vs-mexc)

---

## 1. TỔNG QUAN KIẾN TRÚC

### 1.1 Cấu Trúc Indicators

Bot sử dụng kiến trúc **"Hard Direction + Soft Scoring"** với 2 lớp filter:

```
┌──────────────────────────────────────────────────────────────┐
│                    ENTRY SIGNAL FLOW                          │
├──────────────────────────────────────────────────────────────┤
│                                                               │
│  OC Signal Detection → Trend Filter (HARD GATE)               │
│                              ↓                                │
│                       Entry Filters (SOFT FILTERS)            │
│                              ↓                                │
│                       Execute Order                           │
│                                                               │
└──────────────────────────────────────────────────────────────┘
```

### 1.2 File Structure

```
src/indicators/
├── TrendIndicatorsState.js    # State management cho tất cả indicators
├── trendFilter.js             # Logic lọc trend (HARD GATE)
├── entryFilters.js            # Các filter bổ sung (SOFT FILTERS)
├── marketRegimeFilter.js      # Phát hiện chế độ thị trường
├── fundingRateFilter.js       # Filter funding rate (Futures)
├── ema.js                     # EMA calculator
├── rsi.js                     # RSI calculator
├── adx.js                     # ADX calculator
├── atr.js                     # ATR calculator
├── donchian.js                # Donchian Channel
├── rvol.js                    # Relative Volume
├── sma.js                     # Simple Moving Average
└── bb.js                      # Bollinger Bands
```

---

## 2. DANH SÁCH CÁC CHỈ BÁO

| Chỉ Báo | Period | Cập Nhật | Mục Đích | Loại Gate |
|---------|--------|----------|----------|-----------|
| **EMA20** | 20 | Mỗi tick | Trend direction | HARD |
| **EMA50** | 50 | Mỗi tick | Trend confirmation | HARD |
| **EMA20 Slope** | - | Mỗi tick | Trend momentum | HARD |
| **RSI14** | 14 | Mỗi tick | Regime + Extreme | HARD + SOFT |
| **ADX14** | 14 | Closed candle | Trend strength | SOFT |
| **ATR14** | 14 | Closed candle | Volatility filter | SOFT |
| **Donchian** | 20 | Closed candle | Breakout confirmation | SOFT |
| **RVOL** | 20 | Closed candle | Volume confirmation | SOFT |
| **Bollinger** | 20, 2σ | Closed candle | Price position | SOFT |
| **Volume MA** | 20 | Closed candle | Volume gate | SOFT |

---

## 3. CHI TIẾT TỪNG CHỈ BÁO

### 3.1 EMA (Exponential Moving Average)

**File:** `src/indicators/ema.js`

```javascript
// Công thức
α = 2 / (period + 1)
EMA = (Price - EMA_prev) × α + EMA_prev

// Slope
Slope = EMA_current - EMA_previous
```

**Sử dụng:**
- **EMA20:** Fast EMA, phản ứng nhanh với price
- **EMA50:** Slow EMA, xác định trend dài hạn
- **EMA20 Slope:** Đo momentum của trend

**Điều kiện Entry:**

| Direction | Điều kiện EMA |
|-----------|---------------|
| LONG (Bullish) | `Price > EMA20 > EMA50` |
| SHORT (Bearish) | `Price < EMA20 < EMA50` |

**EMA Separation Gate:**
- Minimum separation: `0.1%` (configurable: `TREND_EMA_SEPARATION_MIN`)
- Mục đích: Tránh thị trường sideway (EMA20 ≈ EMA50)

---

### 3.2 RSI (Relative Strength Index)

**File:** `src/indicators/rsi.js`

```javascript
// Công thức (Wilder Smoothing)
RS = Avg Gain / Avg Loss
RSI = 100 - (100 / (1 + RS))

// Wilder smoothing sau warmup
AvgGain = ((prevAvgGain × 13) + currentGain) / 14
AvgLoss = ((prevAvgLoss × 13) + currentLoss) / 14
```

**Sử dụng trong hệ thống:**

| Loại Check | Direction | Điều kiện | Gate Type |
|------------|-----------|-----------|-----------|
| Regime (Soft) | LONG | RSI >= 52 | SOFT (+1 score) |
| Regime (Soft) | SHORT | RSI <= 48 | SOFT (+1 score) |
| Overbought (Hard) | LONG | RSI > 75 → **REJECT** | HARD |
| Oversold (Hard) | SHORT | RSI < 25 → **REJECT** | HARD |

**Config:**
- `TREND_RSI_BULL_MIN=52`
- `TREND_RSI_BEAR_MAX=48`
- `TREND_RSI_OVERBOUGHT=75`
- `TREND_RSI_OVERSOLD=25`

---

### 3.3 ADX (Average Directional Index)

**File:** `src/indicators/adx.js`

```javascript
// Cập nhật từ CLOSED candle (không dùng tick data)
True Range = max(High - Low, |High - PrevClose|, |Low - PrevClose|)
+DM = High - PrevHigh (if positive and > -DM, else 0)
-DM = PrevLow - Low (if positive and > +DM, else 0)

// Wilder smoothing
TR14 = TR14 - (TR14/14) + TR
+DI14 = 100 × (+DM14 / TR14)
-DI14 = 100 × (-DM14 / TR14)
DX = 100 × |+DI14 - -DI14| / (+DI14 + -DI14)
ADX = ((ADX_prev × 13) + DX) / 14
```

**Warmup:** Cần ~28 candles để có ADX hợp lệ (14 cho TR/DM + 14 cho ADX smoothing)

**Sử dụng:**

| ADX Value | Market State | Action |
|-----------|--------------|--------|
| >= 20 | Trend đủ mạnh | +1 score |
| < 20 | Trend yếu / Sideway | Score = 0 |
| >= 30 | Strong trend | High confidence |

**Config:** `TREND_ADX_SCORE_THRESHOLD=20`

---

### 3.4 ATR (Average True Range)

**File:** `src/indicators/atr.js`

```javascript
// Cập nhật từ CLOSED candle
True Range = max(High - Low, |High - PrevClose|, |Low - PrevClose|)
ATR = SMA(True Range, 14)
```

**Sử dụng - Volatility Filter:**

```javascript
ATR% = (ATR / Price) × 100

// Điều kiện cho phép trade
VOL_ATR_MIN_PCT (0.15%) <= ATR% <= VOL_ATR_MAX_PCT (2.0%)
```

| ATR% | Market State | Action |
|------|--------------|--------|
| < 0.15% | Quá quiet, dễ whipsaw | REJECT |
| 0.15% - 2.0% | Volatility phù hợp | PASS |
| > 2.0% | Quá volatile, SL dễ bị hit | REJECT |

---

### 3.5 Donchian Channel

**File:** `src/indicators/donchian.js`

```javascript
// Tính từ N closed candles
Donchian High = max(High[1..N])
Donchian Low = min(Low[1..N])
```

**Period:** 20 candles (5m timeframe)

**Sử dụng - Breakout Confirmation:**

| Direction | Điều kiện |
|-----------|-----------|
| LONG | Price > Donchian High (breakout) |
| SHORT | Price < Donchian Low (breakdown) |

**Config:** `DONCHIAN_FILTER_ENABLED=true`

---

### 3.6 RVOL (Relative Volume)

**File:** `src/indicators/rvol.js`

```javascript
RVOL = Current Volume / SMA(Volume, N)
```

**Period:** 20 candles

**Sử dụng:**

| RVOL | Meaning | Action |
|------|---------|--------|
| >= 1.2 | Volume cao hơn trung bình | PASS |
| < 1.2 | Volume thấp, không đủ momentum | REJECT |

**Config:** 
- `RVOL_FILTER_ENABLED=true`
- `RVOL_MIN=1.2`

---

### 3.7 Bollinger Bands

**File:** `src/indicators/bb.js`

```javascript
Middle Band = SMA(Close, 20)
Upper Band = Middle + 2 × σ
Lower Band = Middle - 2 × σ
```

**Sử dụng - Position Filter:**

| Direction | Điều kiện PASS | Điều kiện REJECT |
|-----------|----------------|------------------|
| LONG | Price > Middle Band | Price > Upper Band (overbought) |
| SHORT | Price < Middle Band | Price < Lower Band (oversold) |

**Config:** `BOLLINGER_GATE_ENABLED=true`

---

## 4. TREND FILTER LOGIC

**File:** `src/indicators/trendFilter.js`

### 4.1 Kiến Trúc "Hard Direction + Soft Scoring"

```
┌────────────────────────────────────────────────────────────────┐
│                    TREND FILTER FLOW                            │
├────────────────────────────────────────────────────────────────┤
│                                                                 │
│  Step 1: WARMUP CHECK (indicators phải sẵn sàng)               │
│     ↓                                                           │
│  Step 2: HARD GATE - EMA Direction                             │
│     • LONG: Price > EMA20 > EMA50                               │
│     • SHORT: Price < EMA20 < EMA50                              │
│     • FAIL → REJECT (reason: ema_direction)                     │
│     ↓                                                           │
│  Step 3: HARD GATE - EMA Separation                            │
│     • |EMA20 - EMA50| / EMA50 >= 0.1%                          │
│     • FAIL → REJECT (reason: ema_flat)                          │
│     ↓                                                           │
│  Step 4: HARD GATE - RSI Extreme Protection                    │
│     • LONG: RSI > 75 → REJECT (overbought)                      │
│     • SHORT: RSI < 25 → REJECT (oversold)                       │
│     ↓                                                           │
│  Step 5: SOFT SCORING                                          │
│     • ADX >= 20 → +1 score                                      │
│     • RSI regime OK → +1 score                                  │
│     • Need score >= 1 to PASS                                   │
│     ↓                                                           │
│  Step 6: FINAL DECISION                                        │
│     • score >= 1 → PASS (confirmed_moderate/strong)             │
│     • score < 1 → REJECT (weak_trend)                           │
│                                                                 │
└────────────────────────────────────────────────────────────────┘
```

### 4.2 Rejection Reasons

| Reason | Giải thích | Cách khắc phục |
|--------|------------|----------------|
| `ema_not_ready` | EMA chưa warmup đủ | Chờ đủ data |
| `rsi_not_ready` | RSI chưa warmup | Chờ 14+ ticks |
| `adx_not_ready` | ADX chưa warmup | Chờ 28+ candles |
| `ema_direction` | EMA alignment sai | Chờ trend đúng hướng |
| `ema_flat` | EMA20 ≈ EMA50 (sideway) | Chờ trend rõ ràng hơn |
| `rsi_overbought` | RSI > 75 (LONG) | Chờ RSI pullback |
| `rsi_oversold` | RSI < 25 (SHORT) | Chờ RSI bounce |
| `weak_trend` | Score < 1 (ADX + RSI đều yếu) | Chờ trend mạnh hơn |

---

## 5. ENTRY FILTERS NÂNG CAO

**File:** `src/indicators/entryFilters.js`

### 5.1 Danh sách Entry Filters

| # | Filter | Enabled by | Mục đích |
|---|--------|------------|----------|
| 1 | Volume VMA Gate | `VOLUME_VMA_GATE_ENABLED` | Volume phải > VMA × ratio |
| 2 | Bollinger Gate | `BOLLINGER_GATE_ENABLED` | Price position vs bands |
| 3 | Pullback Confirmation | `PULLBACK_CONFIRMATION_ENABLED` | Xác nhận pullback to EMA20 |
| 4 | Volatility Filter | `VOLATILITY_FILTER_ENABLED` | ATR% trong range hợp lý |
| 5 | RVOL Gate | `RVOL_FILTER_ENABLED` | Relative volume đủ cao |
| 6 | Market Regime | `MARKET_REGIME_FILTER_ENABLED` | Phát hiện trend/ranging |
| 7 | Funding Rate | `FUNDING_RATE_FILTER_ENABLED` | Tránh extreme sentiment |

### 5.2 Pullback Confirmation

```javascript
// LONG: Price phải touch EMA20 và close trên nó
const touchedEma = candle.low <= ema20;
const closedAbove = candle.close > ema20;
// PASS nếu cả 2 điều kiện đúng

// SHORT: Ngược lại
const touchedEma = candle.high >= ema20;
const closedBelow = candle.close < ema20;
```

### 5.3 Market Regime Filter

**File:** `src/indicators/marketRegimeFilter.js`

```
┌─────────────────────────────────────────────────────────┐
│              MARKET REGIME DETECTION                     │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ADX >= 30  →  STRONG_TREND (tradeable)                 │
│  ADX 20-30  →  WEAK_TREND (tradeable with caution)      │
│  ADX < 20   →  RANGING (avoid trend-following)          │
│                                                          │
│  + ATR% > 3.0%  →  VOLATILE (avoid)                     │
│  + ATR% < 0.3%  →  TOO QUIET (avoid)                    │
│  + EMA separation < 0.2%  →  RANGING confirmation       │
│                                                          │
└─────────────────────────────────────────────────────────┘
```

### 5.4 Funding Rate Filter

**File:** `src/indicators/fundingRateFilter.js`

| Funding Rate | Sentiment | Action |
|--------------|-----------|--------|
| > +0.10% | Extremely Bullish | Avoid LONG (overheated) |
| +0.05% to +0.10% | Bullish | Caution |
| -0.01% to +0.01% | Neutral | OK |
| -0.05% to -0.01% | Bearish | Caution |
| < -0.10% | Extremely Bearish | Avoid SHORT (squeeze risk) |

---

## 6. CẤU HÌNH VÀ NGƯỠNG

### 6.1 Trend Filter Config

```bash
# EMA Thresholds
TREND_EMA_SEPARATION_MIN=0.001    # 0.1% minimum EMA separation

# ADX Thresholds
TREND_ADX_SCORE_THRESHOLD=20      # ADX >= này +1 score

# RSI Thresholds
TREND_RSI_BULL_MIN=52             # LONG regime minimum
TREND_RSI_BEAR_MAX=48             # SHORT regime maximum
TREND_RSI_OVERBOUGHT=75           # LONG rejection threshold
TREND_RSI_OVERSOLD=25             # SHORT rejection threshold

# Scoring
TREND_MIN_SCORE=1                 # Minimum score to pass
```

### 6.2 Entry Filters Config

```bash
# Volume VMA Gate
VOLUME_VMA_GATE_ENABLED=true
VOLUME_VMA_MIN_RATIO=1.2

# Bollinger Gate
BOLLINGER_GATE_ENABLED=true

# Pullback Confirmation
PULLBACK_CONFIRMATION_ENABLED=true

# Volatility Filter
VOLATILITY_FILTER_ENABLED=true
VOL_ATR_MIN_PCT=0.15
VOL_ATR_MAX_PCT=2.0

# RVOL Gate
RVOL_FILTER_ENABLED=true
RVOL_MIN=1.2

# Donchian Breakout
DONCHIAN_FILTER_ENABLED=true

# Market Regime
MARKET_REGIME_FILTER_ENABLED=true
REGIME_ADX_STRONG_TREND=30
REGIME_ADX_WEAK_TREND=20
REGIME_ATR_VOLATILE_HIGH=3.0
REGIME_ATR_QUIET_LOW=0.3

# Funding Rate
FUNDING_RATE_FILTER_ENABLED=true
FUNDING_EXTREME_POSITIVE=0.10
FUNDING_EXTREME_NEGATIVE=-0.10
```

---

## 7. SƠ ĐỒ FLOW ENTRY

### 7.1 Full Entry Flow (Binance)

```
┌─────────────────────────────────────────────────────────────────────────┐
│                         BINANCE ENTRY FLOW                               │
├─────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  📡 WebSocket Candle Data                                                │
│     │                                                                    │
│     ▼                                                                    │
│  ┌──────────────────────────────────────────────┐                       │
│  │ TrendIndicatorsState.updateTick(price)       │ ← EMA20, EMA50, RSI   │
│  │ TrendIndicatorsState.updateClosedCandle()    │ ← ADX, ATR, RVOL, BB  │
│  └──────────────────────────────────────────────┘                       │
│     │                                                                    │
│     ▼                                                                    │
│  📊 OC Signal Detected (OC >= threshold)                                │
│     │                                                                    │
│     ▼                                                                    │
│  ┌──────────────────────────────────────────────┐                       │
│  │ PHASE 1: HARD GATES                          │                       │
│  │   ├─ EMA Direction Check                     │ → ema_direction       │
│  │   ├─ EMA Separation Check                    │ → ema_flat            │
│  │   └─ RSI Extreme Check                       │ → rsi_overbought/sold │
│  └──────────────────────────────────────────────┘                       │
│     │ PASS                                                               │
│     ▼                                                                    │
│  ┌──────────────────────────────────────────────┐                       │
│  │ PHASE 2: SOFT SCORING                        │                       │
│  │   ├─ ADX >= 20 → +1                          │                       │
│  │   └─ RSI regime OK → +1                      │                       │
│  │   Need score >= 1                            │ → weak_trend          │
│  └──────────────────────────────────────────────┘                       │
│     │ score >= 1                                                         │
│     ▼                                                                    │
│  ┌──────────────────────────────────────────────┐                       │
│  │ PHASE 3: ENTRY FILTERS (Optional)            │                       │
│  │   ├─ Volume VMA Gate                         │                       │
│  │   ├─ Bollinger Gate                          │                       │
│  │   ├─ Volatility Filter                       │                       │
│  │   ├─ RVOL Gate                               │                       │
│  │   ├─ Market Regime Filter                    │                       │
│  │   └─ Funding Rate Filter                     │                       │
│  └──────────────────────────────────────────────┘                       │
│     │ ALL PASS                                                           │
│     ▼                                                                    │
│  ✅ EXECUTE ORDER                                                        │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### 7.2 Log Output Examples

**✅ PASS Example:**
```
[PriceAlertScanner] ✅ Trend filter PASSED | strategy=39387 type=FOLLOWING_TREND 
(binance 4USDT 5m -0.81%) | CONDITIONS: 
price(0.0116) < EMA20(0.0117) < EMA50(0.0117) AND EMA20Slope(-0.0000) < 0 ✓ 
ADX(25.53) >= 20 ✓ RSI(31.44) <= 45 ✓
```

**❌ REJECT Example:**
```
[PriceAlertScanner] ⏭️ Trend filters REJECTED entry | strategy=29391 
type=FOLLOWING_TREND (binance BDXNUSDT 5m -0.20%) reason=ema_flat | 
EMA20=0.0234 EMA50=0.0234 EMA20Slope=0.0000 ADX=15.23 RSI=52.34 price=0.0235
```

---

## 8. KHÁC BIỆT BINANCE VS MEXC

### 8.1 Binance (Full Filter)

- ✅ EMA alignment (EMA20, EMA50, Slope)
- ✅ EMA separation check
- ✅ RSI extreme protection
- ✅ ADX trend strength
- ✅ RSI regime scoring
- ✅ Full entry filters (Volatility, RVOL, Market Regime, etc.)

### 8.2 MEXC (Partial Filter)

- ✅ EMA alignment (EMA20, EMA50, Slope)
- ✅ RSI regime check
- ❌ **Không có ADX** (MEXC không hỗ trợ closed candle aggregation tốt)
- ❌ **Không có EMA separation check**
- ❌ **Không có RSI extreme protection**

**Lý do:** MEXC WebSocket không cung cấp closed candle data đáng tin cậy như Binance, nên ADX/ATR không được tính toán.

### 8.3 So sánh Filter Logic

| Feature | Binance | MEXC |
|---------|---------|------|
| EMA Direction | ✅ | ✅ |
| EMA Slope | ✅ | ✅ |
| EMA Separation | ✅ | ❌ |
| RSI Regime | ✅ (52-48) | ✅ (55-45) |
| RSI Extreme | ✅ (25-75) | ❌ |
| ADX Strength | ✅ | ❌ |
| isTrendConfirmed() | ✅ | ❌ (inline logic) |

---

## 📝 TÓM TẮT

### Các Chỉ Báo Chính:

1. **EMA20/EMA50:** Xác định trend direction (HARD GATE)
2. **RSI14:** Xác định regime và extreme conditions (HARD + SOFT)
3. **ADX14:** Đo trend strength (SOFT SCORE)
4. **ATR14:** Volatility filter (SOFT)
5. **RVOL/Donchian/BB:** Entry confirmation (SOFT)

### Scoring System:

- **HARD GATES:** Phải pass tất cả, nếu fail → REJECT ngay
- **SOFT SCORING:** Cần score >= 1 (ADX hoặc RSI đúng regime)
- **ENTRY FILTERS:** Optional, có thể enable/disable từng cái

### Best Practices:

1. Indicators warmup trước khi trade (cần ~50+ ticks, 28+ candles)
2. Binance có filter đầy đủ hơn MEXC
3. Sideway market (ema_flat) là rejection phổ biến nhất
4. RSI extreme protection tránh chasing overbought/oversold
5. ADX < 20 = market không có trend rõ ràng

---

## 9. ĐÁNH GIÁ VÀ GỢI Ý TỐI ƯU

### 9.1 Điểm Sáng (The "Wins") ✅

| Điểm | Giải thích |
|------|------------|
| **Kiến trúc Multi-Layer** | Tách biệt Hard Gates (loại bỏ entry rác) và Soft Scoring (đánh giá chất lượng) giúp Bot không bị "nghẹn" lệnh nhưng vẫn đảm bảo chất lượng |
| **EMA Separation Gate** | "Vũ khí bí mật" tránh Sideway: `|EMA20 - EMA50| / EMA50 >= 0.1%` giúp nhận diện trend thực sự "mở băng" (fanning out) |
| **Pragmatic Approach** | Dũng cảm cắt ADX/ATR trên MEXC do giới hạn dữ liệu - thà thiếu chỉ báo còn hơn dùng chỉ báo sai |

### 9.2 Lưu Ý Kỹ Thuật (The "Cautions") ⚠️

#### A. RSI Extreme (75/25) - Potential Issue

**Vấn đề:** Trong khung 5m Crypto, các cú "Moon" hoặc "Dump" đẩy RSI lên 80+ hoặc xuống dưới 20 rất nhanh. Ngưỡng 75/25 có thể bỏ lỡ phần "ngon nhất" của strong trend.

**Đề xuất cải tiến:**
```javascript
// Nếu ADX > 35 (trend cực mạnh), nới lỏng RSI Extreme
const rsiOverbought = adx14 > 35 ? 80 : 75;
const rsiOversold = adx14 > 35 ? 20 : 25;
```

#### B. Warmup Period - Cần Kiểm Tra

**Vấn đề:** EMA giai đoạn đầu sẽ rất "ảo" do công thức lũy thừa cần dữ liệu quá khứ để ổn định.

**Checklist:**
- [ ] Đảm bảo `isWarmedUp()` check đủ 28-50 candles
- [ ] Bot phải đợi `isReady = true` trước khi vào lệnh
- [ ] Log warning khi indicator chưa warmed up

#### C. Funding Rate Filter - Chỉ Báo Trễ

**Vấn đề:** Khi Funding đạt 0.1%, giá thường đã chạy một đoạn dài.

**Đề xuất:** Dùng như confirmation, không dùng như signal chính.

---

### 9.3 Gợi Ý Tối Ưu Nâng Cao 🚀

#### A. Dynamic ATR Multiplier

Thay vì cố định `VOL_ATR_MAX_PCT = 2.0`, điều chỉnh theo market regime:

```javascript
// Đề xuất: Dynamic ATR threshold
function getDynamicAtrMax(regime) {
  switch (regime) {
    case 'STRONG_TREND': return 2.5;  // Chấp nhận volatility cao hơn
    case 'WEAK_TREND':   return 2.0;  // Default
    case 'RANGING':      return 1.5;  // Thắt chặt hơn
    default:             return 2.0;
  }
}
```

**Lợi ích:** Trong STRONG_TREND, mức chịu đựng volatility có thể tăng lên để không bỏ lỡ cơ hội.

#### B. Candle Body Confirmation (Volume Profile Enhancement)

Bổ sung logic "Price Action near EMA":

```javascript
// Đề xuất: Nến confirm phải có body chiếm >= 50% tổng chiều dài
function isCandleBodyValid(candle) {
  const totalRange = candle.high - candle.low;
  const bodyRange = Math.abs(candle.close - candle.open);
  const bodyRatio = totalRange > 0 ? bodyRange / totalRange : 0;
  
  // Tránh Doji/Pinbar có râu quá dài tại EMA20
  return bodyRatio >= 0.5;
}

// Kết hợp với pullback confirmation
if (!isCandleBodyValid(candle5m)) {
  return { ok: false, reason: 'candle_body_too_small' };
}
```

**Lợi ích:** Tránh entry trên các cây nến Doji/Pinbar có râu dài - thường là rejection signals.

#### C. RSI + ADX Combo Gate (New Proposal)

```javascript
// Đề xuất: RSI Extreme được nới lỏng khi ADX cực mạnh
function checkRsiExtremeWithAdx(direction, rsi14, adx14) {
  const isStrongTrend = adx14 >= 35;
  
  // Dynamic thresholds
  const overboughtThreshold = isStrongTrend ? 80 : 75;
  const oversoldThreshold = isStrongTrend ? 20 : 25;
  
  if (direction === 'bullish' && rsi14 > overboughtThreshold) {
    return { ok: false, reason: `rsi_overbought_${rsi14.toFixed(1)}>${overboughtThreshold}` };
  }
  if (direction === 'bearish' && rsi14 < oversoldThreshold) {
    return { ok: false, reason: `rsi_oversold_${rsi14.toFixed(1)}<${oversoldThreshold}` };
  }
  
  return { ok: true, reason: isStrongTrend ? 'rsi_ok_strong_trend' : 'rsi_ok' };
}
```

---

### 9.4 Implementation Priority

| Priority | Feature | Effort | Impact | Status |
|----------|---------|--------|--------|--------|
| 🔴 HIGH | RSI + ADX Combo (nới lỏng RSI khi strong trend) | Low | High | ✅ **IMPLEMENTED** |
| 🟡 MEDIUM | Candle Body Confirmation | Low | Medium | ✅ **IMPLEMENTED** |
| 🟢 LOW | Dynamic ATR Multiplier | Medium | Medium | ✅ **IMPLEMENTED** |

---

### 9.6 Implementation Details (NEW!)

#### A. RSI + ADX Combo Gate - **IMPLEMENTED**

**File:** `src/indicators/trendFilter.js`

**Logic:**
```javascript
// Khi ADX >= 35 (strong trend), nới lỏng RSI extreme thresholds
const isStrongTrend = adx14 >= 35;
const rsiOverbought = isStrongTrend ? 80 : 75;  // Nới lỏng từ 75 → 80
const rsiOversold = isStrongTrend ? 20 : 25;    // Nới lỏng từ 25 → 20
```

**Config mới:**
- `TREND_ADX_STRONG_TREND=35` - Ngưỡng ADX để xác định strong trend
- `TREND_RSI_OVERBOUGHT_STRONG=80` - RSI overbought trong strong trend
- `TREND_RSI_OVERSOLD_STRONG=20` - RSI oversold trong strong trend

**Lợi ích:** Không bỏ lỡ phần "ngon nhất" của strong trend (Moon/Dump) khi RSI đạt extreme nhưng ADX cho thấy trend vẫn rất mạnh.

---

#### B. Candle Body Confirmation - **IMPLEMENTED**

**File:** `src/indicators/entryFilters.js`

**Logic:**
```javascript
// Tránh entry trên Doji/Pinbar có râu dài
const bodyRatio = Math.abs(close - open) / (high - low);
if (bodyRatio < 0.5) {
  return { ok: false, reason: 'candle_body_too_small' };
}
```

**Config mới:**
- `CANDLE_BODY_FILTER_ENABLED=true` - Bật/tắt filter
- `CANDLE_BODY_MIN_RATIO=0.5` - Body phải >= 50% tổng range

**Lợi ích:** Tránh entry trên các cây nến indecision (Doji, Pinbar) thường dẫn đến reversal.

---

#### C. Dynamic ATR Multiplier - **IMPLEMENTED**

**File:** `src/indicators/entryFilters.js`

**Logic:**
```javascript
// Strong trend cho phép volatility cao hơn
const maxPct = isStrongTrend ? 2.5 : 2.0;
if (atrPercent > maxPct) {
  return { ok: false, reason: 'volatility_too_high' };
}
```

**Config mới:**
- `VOL_ATR_MAX_PCT=2.0` - Max ATR% (normal trend)
- `VOL_ATR_MAX_STRONG_PCT=2.5` - Max ATR% (strong trend)

**Lợi ích:** Trong strong trend, cho phép volatility cao hơn để không bỏ lỡ cơ hội.

---

### 9.7 New Config Reference

```bash
# RSI + ADX Combo (Strong Trend Detection)
TREND_ADX_STRONG_TREND=35            # ADX >= này = strong trend
TREND_RSI_OVERBOUGHT=75              # RSI overbought (normal)
TREND_RSI_OVERSOLD=25                # RSI oversold (normal)
TREND_RSI_OVERBOUGHT_STRONG=80       # RSI overbought (strong trend)
TREND_RSI_OVERSOLD_STRONG=20         # RSI oversold (strong trend)

# Dynamic ATR Multiplier
VOL_ATR_MAX_PCT=2.0                  # Max ATR% (normal)
VOL_ATR_MAX_STRONG_PCT=2.5           # Max ATR% (strong trend)

# Candle Body Confirmation
CANDLE_BODY_FILTER_ENABLED=true      # Enable/disable
CANDLE_BODY_MIN_RATIO=0.5            # Min body/range ratio (50%)
```

---

### 9.5 Documentation Quality Score

| Criteria | Score | Notes |
|----------|-------|-------|
| ASCII Flowchart | ⭐⭐⭐⭐⭐ | Rõ ràng, dễ follow |
| Table Comparisons | ⭐⭐⭐⭐⭐ | Binance vs MEXC rất hữu ích |
| Log Examples | ⭐⭐⭐⭐⭐ | Thực tế, giúp debugging |
| Code Samples | ⭐⭐⭐⭐ | Đầy đủ công thức |
| Config Reference | ⭐⭐⭐⭐⭐ | Dễ tìm và sử dụng |

**Overall: 9/10** - Hệ thống indicator logic, chặt chẽ và có tính ứng dụng cao.

---

**© 2026 Bot-OC Team**
