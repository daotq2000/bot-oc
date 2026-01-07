/**
 * Script tính toán trailing TP với reduce và up_reduce
 * Ví dụ cụ thể: reduce = 10, up_reduce = 10
 */

import { calculateTakeProfit, calculateNextTrailingTakeProfit } from '../src/utils/calculator.js';

/**
 * Tính toán và hiển thị trailing TP cho một position
 */
function calculateTrailingTPExample() {
  console.log('\n=== VÍ DỤ TÍNH TOÁN TRAILING TP ===\n');
  
  // ===== VÍ DỤ 1: LONG POSITION =====
  console.log('📈 VÍ DỤ 1: LONG POSITION');
  console.log('─'.repeat(60));
  
  const longEntry = 50000; // Entry price
  const longTakeProfit = 65.0; // 6.5%
  const longReduce = 10; // Không dùng cho LONG
  const longUpReduce = 10; // Dùng cho LONG: 10% mỗi phút
  
  // Tính initial TP
  const longInitialTP = calculateTakeProfit(longEntry, longTakeProfit, 'long');
  const longTotalRange = Math.abs(longInitialTP - longEntry);
  const longStepPerMinute = longTotalRange * (longUpReduce / 100);
  
  console.log(`Entry Price: ${longEntry.toFixed(2)} USDT`);
  console.log(`Take Profit: ${longTakeProfit} (tương đương ${longTakeProfit/10}%)`);
  console.log(`Initial TP: ${longInitialTP.toFixed(2)} USDT`);
  console.log(`Khoảng cách (Initial TP - Entry): ${longTotalRange.toFixed(2)} USDT`);
  console.log(`up_reduce: ${longUpReduce}%`);
  console.log(`\n➡️ Mỗi phút TP dịch chuyển: ${longStepPerMinute.toFixed(2)} USDT (${longUpReduce}% của ${longTotalRange.toFixed(2)} USDT)`);
  console.log(`\n📊 Bảng dịch chuyển TP theo thời gian:\n`);
  console.log('Phút | TP Price (USDT) | Dịch chuyển (USDT) | % còn lại');
  console.log('─'.repeat(60));
  
  let prevTP = longInitialTP;
  for (let minute = 0; minute <= 10; minute++) {
    if (minute === 0) {
      console.log(`${minute.toString().padStart(5)} | ${prevTP.toFixed(2).padStart(15)} | ${'Initial'.padStart(18)} | ${'100.00%'.padStart(10)}`);
    } else {
      const newTP = calculateNextTrailingTakeProfit(prevTP, longEntry, longInitialTP, longUpReduce, 'long', 1);
      const moved = prevTP - newTP;
      const remainingPercent = ((newTP - longEntry) / longTotalRange * 100).toFixed(2);
      console.log(`${minute.toString().padStart(5)} | ${newTP.toFixed(2).padStart(15)} | ${moved.toFixed(2).padStart(18)} | ${remainingPercent + '%'.padStart(6)}`);
      prevTP = newTP;
    }
  }
  
  // Tính thời gian để TP về đến entry
  const minutesToEntry = longTotalRange / longStepPerMinute;
  console.log(`\n⏱️  Thời gian để TP về đến Entry: ${minutesToEntry.toFixed(2)} phút (${(minutesToEntry/60).toFixed(2)} giờ)`);
  
  // ===== VÍ DỤ 2: SHORT POSITION =====
  console.log('\n\n📉 VÍ DỤ 2: SHORT POSITION');
  console.log('─'.repeat(60));
  
  const shortEntry = 50000; // Entry price
  const shortTakeProfit = 65.0; // 6.5%
  const shortReduce = 10; // Dùng cho SHORT: 10% mỗi phút
  const shortUpReduce = 10; // Không dùng cho SHORT
  
  // Tính initial TP
  const shortInitialTP = calculateTakeProfit(shortEntry, shortTakeProfit, 'short');
  const shortTotalRange = Math.abs(shortInitialTP - shortEntry);
  const shortStepPerMinute = shortTotalRange * (shortReduce / 100);
  
  console.log(`Entry Price: ${shortEntry.toFixed(2)} USDT`);
  console.log(`Take Profit: ${shortTakeProfit} (tương đương ${shortTakeProfit/10}%)`);
  console.log(`Initial TP: ${shortInitialTP.toFixed(2)} USDT`);
  console.log(`Khoảng cách (Entry - Initial TP): ${shortTotalRange.toFixed(2)} USDT`);
  console.log(`reduce: ${shortReduce}%`);
  console.log(`\n➡️ Mỗi phút TP dịch chuyển: ${shortStepPerMinute.toFixed(2)} USDT (${shortReduce}% của ${shortTotalRange.toFixed(2)} USDT)`);
  console.log(`\n📊 Bảng dịch chuyển TP theo thời gian:\n`);
  console.log('Phút | TP Price (USDT) | Dịch chuyển (USDT) | % còn lại');
  console.log('─'.repeat(60));
  
  prevTP = shortInitialTP;
  for (let minute = 0; minute <= 10; minute++) {
    if (minute === 0) {
      console.log(`${minute.toString().padStart(5)} | ${prevTP.toFixed(2).padStart(15)} | ${'Initial'.padStart(18)} | ${'100.00%'.padStart(10)}`);
    } else {
      const newTP = calculateNextTrailingTakeProfit(prevTP, shortEntry, shortInitialTP, shortReduce, 'short', 1);
      const moved = newTP - prevTP;
      const remainingPercent = ((shortEntry - newTP) / shortTotalRange * 100).toFixed(2);
      console.log(`${minute.toString().padStart(5)} | ${newTP.toFixed(2).padStart(15)} | ${moved.toFixed(2).padStart(18)} | ${remainingPercent + '%'.padStart(6)}`);
      prevTP = newTP;
    }
  }
  
  // Tính thời gian để TP về đến entry
  const shortMinutesToEntry = shortTotalRange / shortStepPerMinute;
  console.log(`\n⏱️  Thời gian để TP về đến Entry: ${shortMinutesToEntry.toFixed(2)} phút (${(shortMinutesToEntry/60).toFixed(2)} giờ)`);
  
  // ===== TÓM TẮT =====
  console.log('\n\n📋 TÓM TẮT');
  console.log('─'.repeat(60));
  console.log(`Với reduce = ${shortReduce} và up_reduce = ${longUpReduce}:`);
  console.log(`\n1. LONG Position:`);
  console.log(`   - Sử dụng: up_reduce = ${longUpReduce}%`);
  console.log(`   - Mỗi phút dịch chuyển: ${longStepPerMinute.toFixed(2)} USDT`);
  console.log(`   - Thời gian về Entry: ${minutesToEntry.toFixed(2)} phút`);
  console.log(`\n2. SHORT Position:`);
  console.log(`   - Sử dụng: reduce = ${shortReduce}%`);
  console.log(`   - Mỗi phút dịch chuyển: ${shortStepPerMinute.toFixed(2)} USDT`);
  console.log(`   - Thời gian về Entry: ${shortMinutesToEntry.toFixed(2)} phút`);
  console.log(`\n💡 Lưu ý:`);
  console.log(`   - LONG: TP dịch chuyển TỪ TRÊN XUỐNG (từ Initial TP về Entry)`);
  console.log(`   - SHORT: TP dịch chuyển TỪ DƯỚI LÊN (từ Initial TP về Entry)`);
  console.log(`   - Mỗi phút dịch chuyển = ${shortReduce}% của khoảng cách (Initial TP - Entry)`);
  console.log(`   - Với ${shortReduce}% mỗi phút, sau 10 phút sẽ dịch chuyển ${shortReduce * 10}% = 100% (về đến Entry)`);
  console.log(`\n`);
}

// Chạy tính toán
calculateTrailingTPExample();

