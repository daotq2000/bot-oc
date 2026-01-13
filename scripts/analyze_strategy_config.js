/**
 * Phân tích Strategy Configuration
 * 
 * Script này phân tích các giá trị strategy config và đánh giá hiệu quả
 * 
 * Usage: node scripts/analyze_strategy_config.js
 */

import { calculateTakeProfit, calculateLongEntryPrice, calculateShortEntryPrice, calculateNextTrailingTakeProfit } from '../src/utils/calculator.js';

// Color codes
const colors = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  red: '\x1b[31m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
  magenta: '\x1b[35m',
};

function log(message, color = 'reset') {
  console.log(`${colors[color]}${message}${colors.reset}`);
}

function logSection(title) {
  log(`\n${'='.repeat(70)}`, 'cyan');
  log(title, 'cyan');
  log('='.repeat(70), 'cyan');
}

function logWarning(message) {
  log(`⚠️  ${message}`, 'yellow');
}

function logError(message) {
  log(`❌ ${message}`, 'red');
}

function logSuccess(message) {
  log(`✅ ${message}`, 'green');
}

function logInfo(message) {
  log(`ℹ️  ${message}`, 'blue');
}

// ============================================================================
// CONFIGURATION TO ANALYZE
// ============================================================================

const config = {
  oc: 0.2,           // OC threshold (%)
  extend: 70,         // Extend (%)
  take_profit: 30,    // Take profit (30 = 3% after /10)
  reduce: 5,          // Reduce (%)
  up_reduce: 5,       // Up reduce (%)
  stoploss: 25,       // Stop loss (USDT amount)
};

logSection('📊 PHÂN TÍCH STRATEGY CONFIGURATION');
log(`\nConfig được phân tích:`, 'magenta');
log(`  OC Threshold: ${config.oc}%`, 'yellow');
log(`  Extend: ${config.extend}%`, 'yellow');
log(`  Take Profit: ${config.take_profit} (${config.take_profit / 10}%)`, 'yellow');
log(`  Reduce: ${config.reduce}%`, 'yellow');
log(`  Up Reduce: ${config.up_reduce}%`, 'yellow');
log(`  Stop Loss: ${config.stoploss} USDT`, 'yellow');

// ============================================================================
// 1. PHÂN TÍCH OC THRESHOLD
// ============================================================================

logSection('1️⃣  PHÂN TÍCH OC THRESHOLD');

log(`\nOC Threshold = ${config.oc}%`, 'blue');
logInfo('OC threshold là giá trị tối thiểu để trigger signal');

// So sánh với các giá trị thông thường
const typicalOCValues = [0.5, 1.0, 1.5, 2.0, 3.0];
const isVeryLow = config.oc < 0.5;
const isLow = config.oc >= 0.5 && config.oc < 1.0;
const isNormal = config.oc >= 1.0 && config.oc <= 2.0;
const isHigh = config.oc > 2.0;

if (isVeryLow) {
  logError(`OC = ${config.oc}% là RẤT THẤP!`);
  logWarning('⚠️  Hệ quả:');
  log('  - Sẽ trigger RẤT NHIỀU signals (có thể spam)');
  log('  - Nhiều false signals (nhiễu thị trường)');
  log('  - Tốn phí giao dịch (fees)');
  log('  - Risk quản lý nhiều positions cùng lúc');
  log('\n💡 Khuyến nghị: Tăng OC lên ít nhất 0.5% - 1.0%', 'yellow');
} else if (isLow) {
  logWarning(`OC = ${config.oc}% là THẤP`);
  log('  - Sẽ trigger nhiều signals');
  log('  - Cần monitor kỹ để tránh false signals');
} else if (isNormal) {
  logSuccess(`OC = ${config.oc}% là BÌNH THƯỜNG`);
  log('  - Số lượng signals hợp lý');
  log('  - Cân bằng giữa cơ hội và chất lượng');
} else {
  logWarning(`OC = ${config.oc}% là CAO`);
  log('  - Ít signals hơn');
  log('  - Chất lượng signals tốt hơn nhưng có thể bỏ lỡ cơ hội');
}

// Ví dụ cụ thể
log('\n📌 Ví dụ:', 'magenta');
const exampleOpenOC = 50000;
const exampleClose1 = 50000 * (1 + config.oc / 100); // OC = 0.2%
const exampleClose2 = 50000 * (1 + 0.5 / 100); // OC = 0.5%
log(`  Với Open = $50,000:`);
log(`  - OC ${config.oc}%: Close = $${exampleClose1.toFixed(2)} → ✅ Trigger`);
log(`  - OC 0.5%: Close = $${exampleClose2.toFixed(2)} → ❌ Không trigger với OC 0.5%`);

// ============================================================================
// 2. PHÂN TÍCH EXTEND
// ============================================================================

logSection('2️⃣  PHÂN TÍCH EXTEND');

log(`\nExtend = ${config.extend}%`, 'blue');
logInfo('Extend xác định entry price cách xa current price bao nhiêu');

// Tính entry price với ví dụ
const exampleCurrent = 50000;
const exampleOpenExtend = 49500;
const deltaExtend = Math.abs(exampleCurrent - exampleOpenExtend); // 500
const extendRatio = config.extend / 100; // 0.7

const longEntry = calculateLongEntryPrice(exampleCurrent, exampleOpenExtend, config.extend);
const shortEntry = calculateShortEntryPrice(exampleCurrent, exampleOpenExtend, config.extend);

log('\n📌 Ví dụ với Current = $50,000, Open = $49,500:', 'magenta');
log(`  Delta = |${exampleCurrent} - ${exampleOpenExtend}| = $${deltaExtend}`);
log(`  Extend Ratio = ${config.extend}% = ${extendRatio}`);
log(`  LONG Entry = $${exampleCurrent} - ${extendRatio} × $${deltaExtend} = $${longEntry.toFixed(2)}`);
log(`  SHORT Entry = $${exampleCurrent} + ${extendRatio} × $${deltaExtend} = $${shortEntry.toFixed(2)}`);
log(`  Entry cách Current: ${((Math.abs(exampleCurrent - longEntry) / exampleCurrent) * 100).toFixed(2)}%`);

const typicalExtendValues = [10, 20, 30, 40, 50, 60, 70, 80];
const isVeryHighExtend = config.extend >= 70;

if (isVeryHighExtend) {
  logWarning(`Extend = ${config.extend}% là RẤT CAO!`);
  logWarning('⚠️  Hệ quả:');
  log('  - Entry price sẽ RẤT XA current price');
  log('  - Khó khớp lệnh (cần pullback lớn)');
  log('  - Có thể bỏ lỡ nhiều cơ hội');
  log('  - Nhưng nếu khớp thì entry tốt hơn (pullback sâu)');
  log('\n💡 Khuyến nghị: Giảm extend xuống 40-60% để tăng khả năng khớp lệnh', 'yellow');
} else if (config.extend >= 50) {
  logWarning(`Extend = ${config.extend}% là CAO`);
  log('  - Entry xa current price');
  log('  - Cần pullback lớn để khớp');
} else if (config.extend >= 30) {
  logSuccess(`Extend = ${config.extend}% là BÌNH THƯỜNG`);
  log('  - Entry hợp lý');
  log('  - Cân bằng giữa chất lượng entry và khả năng khớp');
} else {
  logWarning(`Extend = ${config.extend}% là THẤP`);
  log('  - Entry gần current price');
  log('  - Dễ khớp nhưng entry có thể không tốt');
}

// ============================================================================
// 3. PHÂN TÍCH TAKE PROFIT
// ============================================================================

logSection('3️⃣  PHÂN TÍCH TAKE PROFIT');

const actualTPPercent = config.take_profit / 10; // 30 / 10 = 3%
log(`\nTake Profit = ${config.take_profit} (${actualTPPercent}%)`, 'blue');

// Ví dụ tính TP
const exampleEntryTP = 50000;
const longTP = calculateTakeProfit(exampleEntryTP, config.take_profit, 'long');
const shortTP = calculateTakeProfit(exampleEntryTP, config.take_profit, 'short');

log('\n📌 Ví dụ với Entry = $50,000:', 'magenta');
log(`  LONG TP = $${exampleEntryTP} × (1 + ${actualTPPercent}%) = $${longTP.toFixed(2)}`);
log(`  SHORT TP = $${exampleEntryTP} × (1 - ${actualTPPercent}%) = $${shortTP.toFixed(2)}`);
log(`  Profit khi đạt TP: ${actualTPPercent}%`);

const typicalTPValues = [1.5, 2.0, 2.5, 3.0, 4.0, 5.0];
const isLowTP = actualTPPercent < 2.0;
const isNormalTP = actualTPPercent >= 2.0 && actualTPPercent <= 4.0;
const isHighTP = actualTPPercent > 4.0;

if (isLowTP) {
  logWarning(`TP = ${actualTPPercent}% là THẤP!`);
  logWarning('⚠️  Hệ quả:');
  log('  - Dễ đạt TP (take profit nhanh)');
  log('  - Nhưng profit nhỏ');
  log('  - Có thể bỏ lỡ trend lớn');
  log('\n💡 Khuyến nghị: Tăng TP lên 2.5-4% để tối ưu risk/reward', 'yellow');
} else if (isNormalTP) {
  logSuccess(`TP = ${actualTPPercent}% là BÌNH THƯỜNG`);
  log('  - Cân bằng giữa khả năng đạt TP và profit');
} else {
  logWarning(`TP = ${actualTPPercent}% là CAO`);
  log('  - Profit lớn nhưng khó đạt TP');
  log('  - Cần trend mạnh');
}

// ============================================================================
// 4. PHÂN TÍCH REDUCE & UP_REDUCE (TRAILING TP)
// ============================================================================

logSection('4️⃣  PHÂN TÍCH TRAILING TP (Reduce & Up Reduce)');

log(`\nReduce = ${config.reduce}%`, 'blue');
log(`Up Reduce = ${config.up_reduce}%`, 'blue');
logInfo('Reduce/Up Reduce xác định tốc độ trailing TP về phía entry');

// Ví dụ trailing TP
const exampleInitialTP = 51500; // 3% từ entry 50000
const exampleEntryTrail = 50000;
const totalRange = Math.abs(exampleInitialTP - exampleEntryTrail); // 1500

log('\n📌 Ví dụ Trailing TP:', 'magenta');
log(`  Entry = $${exampleEntryTrail}`);
log(`  Initial TP = $${exampleInitialTP} (${actualTPPercent}%)`);
log(`  Total Range = $${totalRange}`);
log(`  Trailing Speed = ${config.reduce}% của range mỗi phút`);

const stepPerMinute = totalRange * (config.reduce / 100);
log(`  Step per minute = $${totalRange} × ${config.reduce}% = $${stepPerMinute.toFixed(2)}`);

// Tính TP sau 1, 5, 10 phút
for (const minutes of [1, 5, 10]) {
  const newTP = calculateNextTrailingTakeProfit(
    exampleInitialTP,
    exampleEntryTrail,
    exampleInitialTP,
    config.reduce,
    'long',
    minutes
  );
  const movedPercent = ((exampleInitialTP - newTP) / totalRange) * 100;
  log(`  Sau ${minutes} phút: TP = $${newTP.toFixed(2)} (đã move ${movedPercent.toFixed(1)}% về entry)`);
}

const typicalReduceValues = [5, 10, 15, 20, 30, 40];
const isLowReduce = config.reduce < 10;
const isNormalReduce = config.reduce >= 10 && config.reduce <= 30;
const isHighReduce = config.reduce > 30;

if (isLowReduce) {
  logWarning(`Reduce = ${config.reduce}% là THẤP!`);
  logWarning('⚠️  Hệ quả:');
  log('  - TP trail CHẬM về entry');
  log('  - Mất nhiều thời gian để TP gần entry');
  log('  - Nhưng an toàn hơn (ít risk đóng position sớm)');
  log('\n💡 Khuyến nghị: Tăng reduce lên 10-20% để TP trail nhanh hơn', 'yellow');
} else if (isNormalReduce) {
  logSuccess(`Reduce = ${config.reduce}% là BÌNH THƯỜNG`);
  log('  - Tốc độ trailing hợp lý');
} else {
  logWarning(`Reduce = ${config.reduce}% là CAO`);
  log('  - TP trail NHANH về entry');
  log('  - Có thể đóng position sớm');
}

// ============================================================================
// 5. PHÂN TÍCH STOP LOSS
// ============================================================================

logSection('5️⃣  PHÂN TÍCH STOP LOSS');

log(`\nStop Loss = ${config.stoploss} USDT`, 'blue');
logInfo('Stop Loss bây giờ tính theo số tiền USDT cố định (không phải %)');

// Ví dụ tính SL
const exampleAmount = 1000; // $1,000 position
const exampleEntryPriceSL = 50000;
const exampleQuantity = exampleAmount / exampleEntryPriceSL; // 0.02 BTC

// Tính SL price (giả sử LONG)
const priceDiff = config.stoploss / exampleQuantity; // 25 / 0.02 = 1250
const exampleSL = exampleEntryPriceSL - priceDiff; // 50000 - 1250 = 48750
const slPercent = ((exampleEntryPriceSL - exampleSL) / exampleEntryPriceSL) * 100;

log('\n📌 Ví dụ với Position $1,000, Entry = $50,000:', 'magenta');
log(`  Quantity = $${exampleAmount} / $${exampleEntryPriceSL} = ${exampleQuantity.toFixed(4)} BTC`);
log(`  SL Amount = ${config.stoploss} USDT`);
log(`  Price Diff = ${config.stoploss} / ${exampleQuantity.toFixed(4)} = $${priceDiff.toFixed(2)}`);
log(`  SL Price = $${exampleEntryPriceSL} - $${priceDiff.toFixed(2)} = $${exampleSL.toFixed(2)}`);
log(`  SL % = ${slPercent.toFixed(2)}%`);

const typicalSLPercent = [1.0, 1.5, 2.0, 2.5, 3.0, 5.0];
const isTightSL = slPercent < 2.0;
const isNormalSL = slPercent >= 2.0 && slPercent <= 3.0;
const isWideSL = slPercent > 3.0;

if (isTightSL) {
  logWarning(`SL = ${slPercent.toFixed(2)}% là CHẶT!`);
  logWarning('⚠️  Hệ quả:');
  log('  - Dễ bị stop out (nhiễu thị trường)');
  log('  - Risk cao');
  log('  - Nhưng loss nhỏ khi bị stop');
  log('\n💡 Khuyến nghị: Tăng SL amount lên để SL rộng hơn (2-3%)', 'yellow');
} else if (isNormalSL) {
  logSuccess(`SL = ${slPercent.toFixed(2)}% là BÌNH THƯỜNG`);
  log('  - Cân bằng giữa risk và loss');
} else {
  logWarning(`SL = ${slPercent.toFixed(2)}% là RỘNG`);
  log('  - An toàn hơn (ít bị stop out)');
  log('  - Nhưng loss lớn khi bị stop');
}

// ============================================================================
// 6. TỔNG HỢP & ĐÁNH GIÁ
// ============================================================================

logSection('6️⃣  TỔNG HỢP & ĐÁNH GIÁ TỔNG THỂ');

log('\n📊 Đánh giá từng tham số:', 'magenta');

const issues = [];
const warnings = [];
const positives = [];

// OC
if (isVeryLow) {
  issues.push('OC quá thấp (0.2%) → quá nhiều signals');
} else if (isLow) {
  warnings.push('OC thấp (0.2%) → nhiều signals');
}

// Extend
if (isVeryHighExtend) {
  issues.push('Extend quá cao (70%) → entry xa, khó khớp lệnh');
} else if (config.extend >= 50) {
  warnings.push('Extend cao (70%) → entry xa');
}

// TP
if (isLowTP) {
  warnings.push('TP thấp (3%) → profit nhỏ');
} else {
  positives.push('TP hợp lý (3%)');
}

// Reduce
if (isLowReduce) {
  warnings.push('Reduce thấp (5%) → TP trail chậm');
} else {
  positives.push('Reduce hợp lý (5%)');
}

// SL
if (isTightSL) {
  warnings.push(`SL chặt (${slPercent.toFixed(2)}%) → dễ bị stop out`);
} else if (isNormalSL) {
  positives.push(`SL hợp lý (${slPercent.toFixed(2)}%)`);
}

log('\n❌ Vấn đề nghiêm trọng:', 'red');
if (issues.length === 0) {
  log('  Không có vấn đề nghiêm trọng', 'green');
} else {
  issues.forEach(issue => logError(`  - ${issue}`));
}

log('\n⚠️  Cảnh báo:', 'yellow');
if (warnings.length === 0) {
  log('  Không có cảnh báo', 'green');
} else {
  warnings.forEach(warning => logWarning(`  - ${warning}`));
}

log('\n✅ Điểm tốt:', 'green');
if (positives.length === 0) {
  log('  Cần cải thiện các tham số', 'yellow');
} else {
  positives.forEach(positive => logSuccess(`  - ${positive}`));
}

// Risk/Reward Ratio
const riskRewardRatio = actualTPPercent / slPercent;
log('\n📈 Risk/Reward Ratio:', 'magenta');
log(`  Risk (SL): ${slPercent.toFixed(2)}%`);
log(`  Reward (TP): ${actualTPPercent}%`);
log(`  R/R Ratio: ${riskRewardRatio.toFixed(2)}:1`);

if (riskRewardRatio < 1) {
  logError('  R/R Ratio < 1:1 → Risk lớn hơn Reward!');
  logWarning('  Khuyến nghị: Tăng TP hoặc giảm SL để R/R >= 1.5:1');
} else if (riskRewardRatio < 1.5) {
  logWarning('  R/R Ratio < 1.5:1 → Cần cải thiện');
  logWarning('  Khuyến nghị: R/R nên >= 1.5:1 để profitable');
} else {
  logSuccess(`  R/R Ratio ${riskRewardRatio.toFixed(2)}:1 → Tốt!`);
}

// ============================================================================
// KHUYẾN NGHỊ
// ============================================================================

logSection('💡 KHUYẾN NGHỊ');

log('\nĐể tối ưu strategy này, khuyến nghị:', 'magenta');

const recommendations = [];

if (isVeryLow) {
  recommendations.push({
    param: 'OC',
    current: config.oc,
    recommended: '0.5 - 1.0',
    reason: 'Giảm số lượng signals, tăng chất lượng'
  });
}

if (isVeryHighExtend) {
  recommendations.push({
    param: 'Extend',
    current: config.extend,
    recommended: '40 - 60',
    reason: 'Tăng khả năng khớp lệnh, vẫn giữ entry tốt'
  });
}

if (isLowTP) {
  recommendations.push({
    param: 'Take Profit',
    current: config.take_profit,
    recommended: '25 - 40 (2.5% - 4%)',
    reason: 'Tăng profit, tối ưu R/R ratio'
  });
}

if (isLowReduce) {
  recommendations.push({
    param: 'Reduce',
    current: config.reduce,
    recommended: '10 - 20',
    reason: 'TP trail nhanh hơn về entry'
  });
}

if (isTightSL && riskRewardRatio < 1.5) {
  recommendations.push({
    param: 'Stop Loss',
    current: config.stoploss,
    recommended: 'Tăng lên để SL = 2-3%',
    reason: 'Giảm risk bị stop out, cải thiện R/R ratio'
  });
}

if (recommendations.length === 0) {
  logSuccess('  Strategy config đã khá tốt!');
} else {
  recommendations.forEach(rec => {
    log(`\n  ${rec.param}:`, 'yellow');
    log(`    Hiện tại: ${rec.current}`);
    log(`    Khuyến nghị: ${rec.recommended}`);
    log(`    Lý do: ${rec.reason}`);
  });
}

log('\n' + '='.repeat(70), 'cyan');
log('✅ Phân tích hoàn tất!', 'green');
log('='.repeat(70) + '\n', 'cyan');

