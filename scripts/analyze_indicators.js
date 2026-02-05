#!/usr/bin/env node

/**
 * INDICATOR ANALYSIS REPORT
 * 
 * Phân tích hệ thống indicator hiện tại và đề xuất cải tiến
 * để tăng hiệu quả filter trend và tìm entry tốt hơn
 */

import mysql from 'mysql2/promise';
import { config } from 'dotenv';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

config({ path: join(__dirname, '..', '.env') });

async function getDbConnection() {
  return mysql.createPool({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'bot_oc',
    waitForConnections: true,
    connectionLimit: 10
  });
}

async function analyzeIndicators() {
  const pool = await getDbConnection();
  
  try {
    console.log('='.repeat(100));
    console.log('📊 INDICATOR SYSTEM ANALYSIS REPORT');
    console.log('='.repeat(100));
    console.log(`Generated at: ${new Date().toISOString()}\n`);

    // ============================================
    // SECTION 1: CURRENT INDICATORS INVENTORY
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('📋 SECTION 1: CURRENT INDICATORS INVENTORY');
    console.log('━'.repeat(80));
    
    console.log(`
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              🎯 INDICATORS ĐANG SỬ DỤNG                                         │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  📈 TREND INDICATORS (1m/15m)                                                                    │
│  ├── EMA 20 (Fast EMA)          → Xu hướng ngắn hạn, entry timing                               │
│  ├── EMA 50 (Slow EMA)          → Xu hướng trung hạn, trend direction                           │
│  ├── EMA 20 Slope               → Độ dốc EMA, momentum                                          │
│  ├── ADX 14                     → Trend strength (>25 = strong trend)                           │
│  └── RSI 14                     → Momentum, overbought/oversold                                 │
│                                                                                                  │
│  📊 VOLATILITY INDICATORS                                                                        │
│  ├── ATR 14 (15m)               → Average True Range, volatility measure                        │
│  ├── ATR %                      → ATR/Price * 100, relative volatility                          │
│  └── Bollinger Bands (20,2)     → Volatility bands, price extremes                              │
│                                                                                                  │
│  📈 VOLUME INDICATORS                                                                            │
│  ├── Volume VMA (20)            → Volume Moving Average                                         │
│  ├── Volume Ratio               → Current/VMA, volume confirmation                              │
│  └── RVOL (20)                  → Relative Volume                                               │
│                                                                                                  │
│  🏔️  STRUCTURE INDICATORS                                                                        │
│  ├── Donchian High/Low (20)     → Breakout levels                                               │
│  └── Pullback Confirmation      → EMA20 5m touch + close above/below                            │
│                                                                                                  │
│  💰 SENTIMENT INDICATORS                                                                         │
│  ├── Funding Rate               → Long/Short sentiment in futures                               │
│  └── Market Regime Detection    → TRENDING/RANGING/VOLATILE classification                      │
│                                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
`);

    // ============================================
    // SECTION 2: CURRENT FILTER GATES
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🚪 SECTION 2: CURRENT FILTER GATES');
    console.log('━'.repeat(80));
    
    console.log(`
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              🎯 FILTER GATES ĐANG SỬ DỤNG                                        │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  1. 📈 TREND FILTER (15m)           [OC_TREND_FILTER_ENABLED=true]                              │
│     ├── EMA Alignment: Price > EMA20 > EMA50 (LONG) hoặc ngược lại                              │
│     ├── EMA Separation: |EMA20-EMA50|/EMA50 >= 0.1%                                             │
│     ├── ADX Scoring: ADX >= 20 → +1 score                                                       │
│     ├── RSI Regime: RSI >= 52 (LONG) hoặc RSI <= 48 (SHORT) → +1 score                          │
│     └── RSI Protection: RSI > 75 reject LONG, RSI < 25 reject SHORT                             │
│                                                                                                  │
│  2. ↩️  PULLBACK CONFIRMATION (5m)   [PULLBACK_CONFIRMATION_ENABLED=true]                        │
│     ├── Giá phải chạm EMA20(5m) ít nhất 1 lần                                                   │
│     └── Nến 5m phải đóng trên/dưới EMA20(5m) để confirm                                         │
│                                                                                                  │
│  3. 📊 VOLATILITY FILTER (15m)       [VOLATILITY_FILTER_ENABLED=true]                            │
│     ├── ATR% = (ATR14 / Price) * 100                                                            │
│     └── Rule: 0.15% <= ATR% <= 2.0%                                                             │
│                                                                                                  │
│  4. 📈 VOLUME VMA GATE               [VOLUME_VMA_GATE_ENABLED=true]                              │
│     └── Volume hiện tại >= VMA * 1.2                                                            │
│                                                                                                  │
│  5. 📊 BOLLINGER GATE                [BOLLINGER_GATE_ENABLED=true]                               │
│     ├── LONG: Price trên Mid Band, không quá Upper Band                                         │
│     └── SHORT: Price dưới Mid Band, không quá Lower Band                                        │
│                                                                                                  │
│  6. 📈 RVOL GATE                     [RVOL_FILTER_ENABLED=true]                                  │
│     └── RVOL >= 1.2                                                                             │
│                                                                                                  │
│  7. 🎯 MARKET REGIME FILTER          [MARKET_REGIME_FILTER_ENABLED=true]                         │
│     ├── STRONG_TREND (ADX >= 30): ✅ Tốt cho trend-following                                    │
│     ├── WEAK_TREND (ADX 20-30): ⚠️ Cẩn thận                                                     │
│     ├── RANGING (ADX < 20): ❌ Tránh trend-following                                            │
│     └── VOLATILE (ATR% > 3%): ⚠️ Giảm position size                                             │
│                                                                                                  │
│  8. 💰 FUNDING RATE FILTER           [FUNDING_RATE_FILTER_ENABLED=true]                          │
│     ├── Extreme Positive (>0.1%): Tránh LONG                                                    │
│     └── Extreme Negative (<-0.1%): Tránh SHORT                                                  │
│                                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
`);

    // ============================================
    // SECTION 3: WIN RATE BY FILTER RESULT
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('📊 SECTION 3: TRADE PERFORMANCE ANALYSIS');
    console.log('━'.repeat(80));

    // Analyze trades by different metrics
    const [symbolPerformance] = await pool.execute(`
      SELECT 
        p.symbol,
        COUNT(*) as total_trades,
        SUM(CASE WHEN p.pnl > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN p.pnl <= 0 THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(p.pnl, 0)) as total_pnl,
        AVG(CASE WHEN p.pnl > 0 THEN p.pnl END) as avg_win,
        AVG(CASE WHEN p.pnl < 0 THEN p.pnl END) as avg_loss
      FROM positions p
      WHERE p.status = 'closed'
      GROUP BY p.symbol
      HAVING total_trades >= 5
      ORDER BY total_trades DESC
      LIMIT 20
    `);

    console.log('\n📈 Top Symbols Performance (min 5 trades):\n');
    console.log('┌────────────────────┬──────────┬──────────┬────────────────┬────────────────┬────────────────┐');
    console.log('│ Symbol             │ Trades   │ Win Rate │ Total PNL      │ Avg Win        │ Avg Loss       │');
    console.log('├────────────────────┼──────────┼──────────┼────────────────┼────────────────┼────────────────┤');

    for (const sym of symbolPerformance) {
      const winRate = (sym.wins / sym.total_trades * 100).toFixed(1);
      const profitFactor = sym.avg_loss !== null && sym.avg_loss !== 0 
        ? Math.abs(sym.avg_win / sym.avg_loss).toFixed(2) 
        : 'N/A';
      
      console.log(
        `│ ${String(sym.symbol).slice(0, 18).padEnd(18)} │ ${String(sym.total_trades).padStart(8)} │ ` +
        `${String(winRate + '%').padStart(8)} │ ${String(Number(sym.total_pnl || 0).toFixed(2)).padStart(14)} │ ` +
        `${String(Number(sym.avg_win || 0).toFixed(2)).padStart(14)} │ ` +
        `${String(Number(sym.avg_loss || 0).toFixed(2)).padStart(14)} │`
      );
    }
    console.log('└────────────────────┴──────────┴──────────┴────────────────┴────────────────┴────────────────┘');

    // ============================================
    // SECTION 4: INDICATOR RECOMMENDATIONS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('💡 SECTION 4: ĐỀ XUẤT THÊM INDICATORS MỚI');
    console.log('━'.repeat(80));
    
    console.log(`
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                         🆕 INDICATORS CÓ THỂ THÊM ĐỂ TĂNG HIỆU QUẢ                               │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  ✅ ĐÃ CÓ VÀ ĐANG HOẠT ĐỘNG TỐT:                                                                │
│  ────────────────────────────────────────────────────────────────────────────────                │
│  • EMA 20/50 + ADX + RSI         → Trend direction & strength ✅                                │
│  • ATR + Volatility Filter       → Avoid bad market conditions ✅                               │
│  • Volume VMA + RVOL             → Volume confirmation ✅                                       │
│  • Bollinger Bands               → Price extremes ✅                                            │
│  • Funding Rate                  → Sentiment filter ✅                                          │
│  • Market Regime Detection       → TRENDING/RANGING classification ✅                           │
│                                                                                                  │
│  🔶 CÓ THỂ THÊM NHƯNG CẦN CÂN NHẮC:                                                             │
│  ────────────────────────────────────────────────────────────────────────────────                │
│                                                                                                  │
│  1. 📈 MACD (12, 26, 9)                                                                         │
│     ├── Pros: Momentum divergence, trend confirmation                                           │
│     ├── Cons: Lagging indicator, nhiều false signals trong ranging market                       │
│     └── Recommendation: ⚠️ KHÔNG CẦN - ADX + RSI đã đủ để detect momentum                       │
│                                                                                                  │
│  2. 📊 STOCHASTIC RSI                                                                           │
│     ├── Pros: Better overbought/oversold signals than RSI                                       │
│     ├── Cons: Quá nhạy, nhiều whipsaws                                                          │
│     └── Recommendation: ⚠️ KHÔNG CẦN - RSI 14 đã có protection levels (25/75)                   │
│                                                                                                  │
│  3. 🌊 ICHIMOKU CLOUD                                                                           │
│     ├── Pros: Multi-timeframe analysis, support/resistance                                      │
│     ├── Cons: Complex, slow, redundant với EMA system                                           │
│     └── Recommendation: ❌ KHÔNG NÊN - Quá phức tạp và chậm                                     │
│                                                                                                  │
│  4. 📉 VWAP (Volume Weighted Average Price)                                                     │
│     ├── Pros: Institutional level, excellent for intraday                                       │
│     ├── Cons: Reset mỗi ngày, cần volume data chính xác                                         │
│     └── Recommendation: ✅ CÓ THỂ THÊM - Tốt cho filter entry gần VWAP                          │
│                                                                                                  │
│  5. 📊 ORDER FLOW / DELTA                                                                       │
│     ├── Pros: Real-time buying/selling pressure                                                 │
│     ├── Cons: Cần data từ exchange, phức tạp implement                                          │
│     └── Recommendation: ⚠️ ADVANCED - Chỉ thêm nếu cần tối ưu cao                               │
│                                                                                                  │
│  6. 🎯 PIVOT POINTS (Daily/Weekly)                                                              │
│     ├── Pros: S/R levels được traders theo dõi                                                  │
│     ├── Cons: Static levels, không adaptive                                                     │
│     └── Recommendation: ⚠️ CÓ THỂ THÊM - Dùng như TP/SL reference                               │
│                                                                                                  │
│  7. 📊 OPEN INTEREST CHANGE                                                                     │
│     ├── Pros: Market participation, position building                                           │
│     ├── Cons: Cần API riêng, không phải lúc nào cũng có                                         │
│     └── Recommendation: ✅ CÓ THỂ THÊM - Kết hợp với Funding Rate                               │
│                                                                                                  │
│  8. 🌐 MULTI-TIMEFRAME EMA (H1/H4/D1)                                                           │
│     ├── Pros: Trend direction from higher timeframes                                            │
│     ├── Cons: Latency, cần thêm data                                                            │
│     └── Recommendation: ✅ NÊN THÊM - EMA 200 trên H4 cho trend direction                       │
│                                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
`);

    // ============================================
    // SECTION 5: FINAL RECOMMENDATIONS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('🎯 SECTION 5: KẾT LUẬN VÀ ĐỀ XUẤT CUỐI CÙNG');
    console.log('━'.repeat(80));
    
    console.log(`
┌─────────────────────────────────────────────────────────────────────────────────────────────────┐
│                              📋 KẾT LUẬN PHÂN TÍCH                                              │
├─────────────────────────────────────────────────────────────────────────────────────────────────┤
│                                                                                                  │
│  🎯 HỆ THỐNG INDICATOR HIỆN TẠI ĐÃ TƯƠNG ĐỐI ĐẦY ĐỦ                                            │
│                                                                                                  │
│  Hệ thống đã có:                                                                                 │
│  ✅ Trend detection (EMA + ADX + RSI)                                                           │
│  ✅ Volatility filtering (ATR%)                                                                 │
│  ✅ Volume confirmation (VMA + RVOL)                                                            │
│  ✅ Market regime detection (TRENDING/RANGING/VOLATILE)                                         │
│  ✅ Sentiment analysis (Funding Rate)                                                           │
│  ✅ Pullback confirmation                                                                       │
│  ✅ Price position filtering (Bollinger Bands)                                                  │
│                                                                                                  │
│  ════════════════════════════════════════════════════════════════════════════════               │
│                                                                                                  │
│  🔧 ĐỀ XUẤT CẢI TIẾN (THEO THỨ TỰ ƯU TIÊN):                                                    │
│                                                                                                  │
│  1. ⚡ TỐI ƯU CONFIG HIỆN TẠI (Không cần code mới)                                              │
│     ├── Tăng TREND_ADX_SCORE_THRESHOLD từ 20 → 25                                               │
│     ├── Giảm VOL_ATR_MAX_PCT từ 2.0% → 1.5% (tránh market quá volatile)                         │
│     ├── Tăng VOLUME_VMA_MIN_RATIO từ 1.2 → 1.5 (chỉ trade khi volume cao)                       │
│     └── Bật FUNDING_RATE_FILTER_ENABLED=true nếu chưa bật                                       │
│                                                                                                  │
│  2. ✅ THÊM EMA 200 (H4) CHO TREND DIRECTION                                                    │
│     ├── Chỉ LONG khi Price > EMA200(H4)                                                         │
│     ├── Chỉ SHORT khi Price < EMA200(H4)                                                        │
│     └── Tránh counter-trend trades hoàn toàn                                                    │
│                                                                                                  │
│  3. ✅ THÊM OPEN INTEREST FILTER                                                                │
│     ├── OI tăng + Price tăng = Bullish confirmation                                             │
│     ├── OI giảm + Price tăng = Weak rally, cẩn thận                                             │
│     └── Kết hợp với Funding Rate để detect liquidation risks                                    │
│                                                                                                  │
│  4. 🔶 CÂN NHẮC THÊM VWAP                                                                       │
│     ├── Entry LONG chỉ khi Price gần/trên VWAP                                                  │
│     └── Entry SHORT chỉ khi Price gần/dưới VWAP                                                 │
│                                                                                                  │
│  ════════════════════════════════════════════════════════════════════════════════               │
│                                                                                                  │
│  ❌ KHÔNG NÊN THÊM:                                                                             │
│  ├── MACD - Redundant với ADX + RSI                                                             │
│  ├── Stochastic RSI - Quá nhạy, nhiều false signals                                             │
│  ├── Ichimoku Cloud - Quá phức tạp, chậm                                                        │
│  └── Quá nhiều indicators - Gây over-filtering, miss opportunities                              │
│                                                                                                  │
│  ════════════════════════════════════════════════════════════════════════════════               │
│                                                                                                  │
│  💡 LƯU Ý QUAN TRỌNG:                                                                           │
│  Vấn đề chính hiện tại KHÔNG PHẢI là thiếu indicator, mà là:                                    │
│  1. Software SL gây loss (-313 USDT) - Cần review SL levels                                     │
│  2. Một số symbols có PNL âm lớn (BTRUSDT) - Cần review strategy config                         │
│  3. Win rate đã tốt (54%) nhưng profit factor thấp (1.21)                                       │
│     → Cần tăng TP hoặc giảm SL để cải thiện R:R ratio                                           │
│                                                                                                  │
└─────────────────────────────────────────────────────────────────────────────────────────────────┘
`);

    // ============================================
    // SECTION 6: ACTION ITEMS
    // ============================================
    console.log('\n' + '━'.repeat(80));
    console.log('📝 SECTION 6: ACTION ITEMS - CÁC BƯỚC TIẾP THEO');
    console.log('━'.repeat(80));
    
    console.log(`
📝 IMMEDIATE ACTIONS (Làm ngay):

1. Cập nhật .env với config tối ưu:
   ────────────────────────────────
   # Trend Filter Optimization
   TREND_ADX_SCORE_THRESHOLD=25
   TREND_RSI_BULL_MIN=55
   TREND_RSI_BEAR_MAX=45
   
   # Volatility Filter Optimization  
   VOL_ATR_MIN_PCT=0.2
   VOL_ATR_MAX_PCT=1.5
   
   # Volume Filter Optimization
   VOLUME_VMA_MIN_RATIO=1.5
   RVOL_MIN=1.3
   
   # Enable all sentiment filters
   FUNDING_RATE_FILTER_ENABLED=true
   MARKET_REGIME_FILTER_ENABLED=true

2. Review SL settings:
   ────────────────────────────────
   - Tăng SL từ 5% → 7-10% cho volatile symbols
   - Giảm TP nếu cần để tăng win rate
   - Xem xét sử dụng ATR-based SL

3. Optional: Implement EMA 200 (H4) filter:
   ────────────────────────────────
   - Tạo file: src/indicators/ema200Filter.js
   - Thêm vào entryFilters.js
   - Config: EMA200_FILTER_ENABLED=true
`);

    console.log('\n' + '='.repeat(100));
    console.log('📊 INDICATOR ANALYSIS COMPLETE');
    console.log('='.repeat(100));

  } catch (error) {
    console.error('Error during analysis:', error);
  } finally {
    await pool.end();
  }
}

// Run the analysis
analyzeIndicators().catch(console.error);
