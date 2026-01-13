/**
 * Phân tích nguyên nhân gây Rate Limit
 * 
 * Script này phân tích các service/job gọi Binance API và xác định
 * nguồn gốc chính gây ra rate limit
 * 
 * Usage: node scripts/analyze_rate_limit_causes.js
 */

import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';
import { Bot } from '../src/models/Bot.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

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
// CONFIGURATION VALUES
// ============================================================================

const config = {
  // PositionMonitor
  POSITION_MONITOR_INTERVAL_MS: configService.getNumber('POSITION_MONITOR_INTERVAL_MS', 25000), // 25 seconds default
  POSITION_MONITOR_BATCH_SIZE: configService.getNumber('POSITION_MONITOR_BATCH_SIZE', 3), // 3 positions per batch
  POSITION_MONITOR_BATCH_DELAY_MS: configService.getNumber('POSITION_MONITOR_BATCH_DELAY_MS', 2000), // 2 seconds
  
  // PositionSync
  POSITION_SYNC_INTERVAL_MS: configService.getNumber('POSITION_SYNC_INTERVAL_MS', 40000), // 40 seconds default
  
  // PriceAlertScanner
  PRICE_ALERT_SCAN_INTERVAL_MS: configService.getNumber('PRICE_ALERT_SCAN_INTERVAL_MS', 500), // 500ms default
  
  // EntryOrderMonitor
  ENTRY_ORDER_MONITOR_INTERVAL_MS: configService.getNumber('ENTRY_ORDER_MONITOR_INTERVAL_MS', 30000), // 30 seconds default
  
  // Binance API Limits
  BINANCE_MIN_REQUEST_INTERVAL_MS: configService.getNumber('BINANCE_MIN_REQUEST_INTERVAL_MS', 100), // 100ms
  BINANCE_MARKET_DATA_MIN_INTERVAL_MS: configService.getNumber('BINANCE_MARKET_DATA_MIN_INTERVAL_MS', 200), // 200ms
  BINANCE_REQUEST_INTERVAL_MS: configService.getNumber('BINANCE_REQUEST_INTERVAL_MS', 125), // 8 req/sec
  BINANCE_SIGNED_REQUEST_INTERVAL_MS: configService.getNumber('BINANCE_SIGNED_REQUEST_INTERVAL_MS', 150), // ~6.6 req/sec
  
  // Binance Actual Limits
  BINANCE_RATE_LIMIT_PER_MINUTE: 1200, // Binance Futures API limit
  BINANCE_RATE_LIMIT_PER_SECOND: 20, // Binance Futures API limit
};

logSection('📊 PHÂN TÍCH NGUYÊN NHÂN GÂY RATE LIMIT');

// ============================================================================
// 1. PHÂN TÍCH POSITIONMONITOR
// ============================================================================

logSection('1️⃣  POSITIONMONITOR - Phân tích requests');

async function analyzePositionMonitor() {
  // Get all open positions
  const positions = await Position.findAll({ status: 'open' });
  const totalPositions = positions.length;
  
  log(`\nTổng số open positions: ${totalPositions}`, 'magenta');
  
  // Group by bot_id
  const positionsByBot = new Map();
  for (const pos of positions) {
    const botId = pos.bot_id || pos.strategy?.bot_id || 'unknown';
    if (!positionsByBot.has(botId)) {
      positionsByBot.set(botId, []);
    }
    positionsByBot.get(botId).push(pos);
  }
  
  log('\n📌 Positions theo Bot:', 'magenta');
  for (const [botId, botPositions] of positionsByBot.entries()) {
    log(`  Bot ${botId}: ${botPositions.length} positions`, 'yellow');
  }
  
  // Calculate API calls per cycle
  const intervalMs = config.POSITION_MONITOR_INTERVAL_MS;
  const intervalSeconds = intervalMs / 1000;
  
  // API calls per position:
  // 1. getTickerPrice() - để update position PnL
  // 2. getClosableQuantity() - khi place TP/SL (có thể gọi nhiều lần)
  // 3. getOrderAverageFillPrice() - khi place TP/SL (nếu có order_id)
  // 4. makeRequest() - để place TP/SL orders
  
  const apiCallsPerPosition = {
    updatePosition: {
      getTickerPrice: 1, // Line 97 in PositionService
      description: 'Lấy current price để tính PnL'
    },
    placeExitOrder: {
      getOrderAverageFillPrice: 0.8, // ~80% positions có order_id (Line 240)
      getClosableQuantity: 1, // Line 319
      getTickerPrice: 0.1, // Chỉ khi invalid SL (Line 540) - rare case
      createOrder: 2, // TP + SL orders (Line 347, 549)
      description: 'Đặt TP/SL orders'
    }
  };
  
  let totalCallsPerCycle = 0;
  
  // Calculate calls for updatePosition
  const updatePositionCalls = totalPositions * apiCallsPerPosition.updatePosition.getTickerPrice;
  totalCallsPerCycle += updatePositionCalls;
  
  log('\n📊 API Calls mỗi cycle (updatePosition):', 'magenta');
  log(`  getTickerPrice: ${updatePositionCalls} calls`, 'yellow');
  log(`  (Cho ${totalPositions} positions)`, 'yellow');
  
  // Calculate calls for placeExitOrder (only for positions needing TP/SL)
  // Estimate: ~30% positions cần place TP/SL mỗi cycle (positions mới hoặc chưa có TP/SL)
  const positionsNeedingTPSL = Math.ceil(totalPositions * 0.3);
  
  const placeTPSLCalls = {
    getOrderAverageFillPrice: positionsNeedingTPSL * apiCallsPerPosition.placeExitOrder.getOrderAverageFillPrice,
    getClosableQuantity: positionsNeedingTPSL * apiCallsPerPosition.placeExitOrder.getClosableQuantity,
    getTickerPrice: positionsNeedingTPSL * apiCallsPerPosition.placeExitOrder.getTickerPrice,
    createOrder: positionsNeedingTPSL * apiCallsPerPosition.placeExitOrder.createOrder,
  };
  
  const totalPlaceTPSLCalls = Object.values(placeTPSLCalls).reduce((sum, val) => sum + val, 0);
  totalCallsPerCycle += totalPlaceTPSLCalls;
  
  log('\n📊 API Calls mỗi cycle (placeExitOrder - estimated):', 'magenta');
  log(`  getOrderAverageFillPrice: ~${Math.ceil(placeTPSLCalls.getOrderAverageFillPrice)} calls`, 'yellow');
  log(`  getClosableQuantity: ~${Math.ceil(placeTPSLCalls.getClosableQuantity)} calls`, 'yellow');
  log(`  getTickerPrice: ~${Math.ceil(placeTPSLCalls.getTickerPrice)} calls`, 'yellow');
  log(`  createOrder (TP+SL): ~${Math.ceil(placeTPSLCalls.createOrder)} calls`, 'yellow');
  log(`  (Cho ~${positionsNeedingTPSL} positions cần TP/SL)`, 'yellow');
  
  log(`\n📈 Tổng API calls mỗi cycle: ~${Math.ceil(totalCallsPerCycle)} calls`, 'magenta');
  log(`   Interval: ${intervalSeconds}s (${intervalMs}ms)`, 'yellow');
  
  // Calculate requests per minute
  const cyclesPerMinute = 60 / intervalSeconds;
  const requestsPerMinute = totalCallsPerCycle * cyclesPerMinute;
  
  log(`\n📊 Tính theo phút:`, 'magenta');
  log(`   Cycles/phút: ${cyclesPerMinute.toFixed(2)}`, 'yellow');
  log(`   Requests/phút: ~${Math.ceil(requestsPerMinute)} requests/min`, 'yellow');
  log(`   Binance limit: ${config.BINANCE_RATE_LIMIT_PER_MINUTE} requests/min`, 'yellow');
  
  const usagePercent = (requestsPerMinute / config.BINANCE_RATE_LIMIT_PER_MINUTE) * 100;
  log(`   Usage: ${usagePercent.toFixed(1)}% của limit`, usagePercent > 80 ? 'red' : usagePercent > 50 ? 'yellow' : 'green');
  
  if (usagePercent > 80) {
    logError(`  ⚠️  RẤT CAO! Có nguy cơ rate limit cao!`);
  } else if (usagePercent > 50) {
    logWarning(`  ⚠️  CAO! Cần tối ưu để giảm requests.`);
  }
  
  return {
    totalCallsPerCycle: Math.ceil(totalCallsPerCycle),
    requestsPerMinute: Math.ceil(requestsPerMinute),
    usagePercent,
    positions: totalPositions,
    cyclesPerMinute: cyclesPerMinute.toFixed(2)
  };
}

// ============================================================================
// 2. PHÂN TÍCH POSITIONSYNC
// ============================================================================

async function analyzePositionSync() {
  logSection('2️⃣  POSITIONSYNC - Phân tích requests');
  
  const intervalMs = config.POSITION_SYNC_INTERVAL_MS;
  const intervalSeconds = intervalMs / 1000;
  
  // PositionSync calls:
  // 1. getOpenPositions() - lấy tất cả positions từ exchange (1 call per bot)
  // 2. getTickerPrice() - có thể gọi cho một số positions (ít)
  
  const bots = await Bot.findAll({ is_active: true });
  const activeBots = bots.length;
  
  const apiCallsPerCycle = {
    getOpenPositions: activeBots, // 1 call per bot
    getTickerPrice: 0, // Minimal, only for new positions
  };
  
  const totalCallsPerCycle = Object.values(apiCallsPerCycle).reduce((sum, val) => sum + val, 0);
  
  log(`\nTổng số active bots: ${activeBots}`, 'magenta');
  log(`\n📊 API Calls mỗi cycle:`, 'magenta');
  log(`  getOpenPositions: ${apiCallsPerCycle.getOpenPositions} calls (1 per bot)`, 'yellow');
  log(`  getTickerPrice: ~${apiCallsPerCycle.getTickerPrice} calls (minimal)`, 'yellow');
  log(`  Total: ${totalCallsPerCycle} calls`, 'yellow');
  
  const cyclesPerMinute = 60 / intervalSeconds;
  const requestsPerMinute = totalCallsPerCycle * cyclesPerMinute;
  
  log(`\n📊 Tính theo phút:`, 'magenta');
  log(`   Cycles/phút: ${cyclesPerMinute.toFixed(2)}`, 'yellow');
  log(`   Requests/phút: ~${requestsPerMinute.toFixed(1)} requests/min`, 'yellow');
  
  const usagePercent = (requestsPerMinute / config.BINANCE_RATE_LIMIT_PER_MINUTE) * 100;
  log(`   Usage: ${usagePercent.toFixed(2)}% của limit`, usagePercent > 80 ? 'red' : 'green');
  
  return {
    totalCallsPerCycle,
    requestsPerMinute: requestsPerMinute.toFixed(1),
    usagePercent,
    activeBots
  };
}

// ============================================================================
// 3. PHÂN TÍCH PRICEALERTSCANNER
// ============================================================================

async function analyzePriceAlertScanner() {
  logSection('3️⃣  PRICEALERTSCANNER - Phân tích requests');
  
  const intervalMs = config.PRICE_ALERT_SCAN_INTERVAL_MS;
  
  // PriceAlertScanner mainly uses WebSocket for prices
  // But may call REST API for:
  // 1. getPrice() - fallback khi WebSocket không có giá
  
  // Get unique symbols from strategies
  const strategies = await Strategy.findAll({ is_active: true });
  const uniqueSymbols = new Set();
  for (const strategy of strategies) {
    if (strategy.symbol) {
      uniqueSymbols.add(strategy.symbol);
    }
  }
  
  const totalSymbols = uniqueSymbols.size;
  
  log(`\nTổng số unique symbols: ${totalSymbols}`, 'magenta');
  log(`\n📊 API Calls:`, 'magenta');
  log(`  PriceAlertScanner chủ yếu sử dụng WebSocket`, 'yellow');
  log(`  REST API fallback: ~0 calls (nếu WebSocket hoạt động tốt)`, 'yellow');
  log(`  Nếu WebSocket miss: có thể gọi getPrice() cho ${totalSymbols} symbols`, 'yellow');
  
  // Estimate: 5% symbols may need REST fallback
  const estimatedRestCallsPerCycle = Math.ceil(totalSymbols * 0.05);
  const cyclesPerMinute = (60 * 1000) / intervalMs; // 500ms = 120 cycles/min
  const requestsPerMinute = estimatedRestCallsPerCycle * cyclesPerMinute;
  
  log(`\n📊 Tính theo phút (nếu 5% symbols cần REST fallback):`, 'magenta');
  log(`   Cycles/phút: ${cyclesPerMinute.toFixed(0)} (${intervalMs}ms interval)`, 'yellow');
  log(`   REST fallback calls: ~${requestsPerMinute.toFixed(0)} requests/min`, 'yellow');
  
  const usagePercent = (requestsPerMinute / config.BINANCE_RATE_LIMIT_PER_MINUTE) * 100;
  log(`   Usage: ${usagePercent.toFixed(2)}% của limit`, usagePercent > 80 ? 'red' : usagePercent > 50 ? 'yellow' : 'green');
  
  if (intervalMs < 1000) {
    logWarning(`  ⚠️  Interval rất ngắn (${intervalMs}ms)! Nếu WebSocket miss nhiều sẽ gây rate limit.`);
    logInfo(`  💡 Khuyến nghị: Đảm bảo WebSocket subscription hoạt động tốt để giảm REST fallback.`);
  }
  
  return {
    totalSymbols,
    estimatedRestCallsPerCycle,
    requestsPerMinute: requestsPerMinute.toFixed(0),
    usagePercent,
    cyclesPerMinute: cyclesPerMinute.toFixed(0)
  };
}

// ============================================================================
// 4. PHÂN TÍCH ENTRYORDERMONITOR
// ============================================================================

async function analyzeEntryOrderMonitor() {
  logSection('4️⃣  ENTRYORDERMONITOR - Phân tích requests');
  
  const intervalMs = config.ENTRY_ORDER_MONITOR_INTERVAL_MS;
  const intervalSeconds = intervalMs / 1000;
  
  // Get pending entry orders
  let totalPendingOrders = 0;
  try {
    const { EntryOrder } = await import('../src/models/EntryOrder.js');
    if (EntryOrder && typeof EntryOrder.findAll === 'function') {
      const pendingOrders = await EntryOrder.findAll({ status: 'pending' });
      totalPendingOrders = Array.isArray(pendingOrders) ? pendingOrders.length : 0;
    } else {
      // Fallback: query database directly
      const { pool } = await import('../src/config/database.js');
      const [rows] = await pool.execute('SELECT COUNT(*) as count FROM entry_orders WHERE status = ?', ['pending']);
      totalPendingOrders = rows[0]?.count || 0;
    }
  } catch (error) {
    logWarning(`  Không thể lấy số lượng pending orders: ${error?.message || error}`);
    totalPendingOrders = 0; // Default to 0 if can't get data
  }
  
  // EntryOrderMonitor calls:
  // 1. getOrderStatus() - check status của mỗi pending order
  // 2. getTickerPrice() - có thể gọi cho một số orders (ít)
  
  const apiCallsPerCycle = {
    getOrderStatus: totalPendingOrders, // 1 call per pending order
    getTickerPrice: Math.ceil(totalPendingOrders * 0.1), // ~10% orders need price
  };
  
  const totalCallsPerCycle = Object.values(apiCallsPerCycle).reduce((sum, val) => sum + val, 0);
  
  log(`\nTổng số pending entry orders: ${totalPendingOrders}`, 'magenta');
  log(`\n📊 API Calls mỗi cycle:`, 'magenta');
  log(`  getOrderStatus: ${apiCallsPerCycle.getOrderStatus} calls`, 'yellow');
  log(`  getTickerPrice: ~${apiCallsPerCycle.getTickerPrice} calls`, 'yellow');
  log(`  Total: ${totalCallsPerCycle} calls`, 'yellow');
  
  const cyclesPerMinute = 60 / intervalSeconds;
  const requestsPerMinute = totalCallsPerCycle * cyclesPerMinute;
  
  log(`\n📊 Tính theo phút:`, 'magenta');
  log(`   Cycles/phút: ${cyclesPerMinute.toFixed(2)}`, 'yellow');
  log(`   Requests/phút: ~${requestsPerMinute.toFixed(1)} requests/min`, 'yellow');
  
  const usagePercent = (requestsPerMinute / config.BINANCE_RATE_LIMIT_PER_MINUTE) * 100;
  log(`   Usage: ${usagePercent.toFixed(2)}% của limit`, usagePercent > 80 ? 'red' : usagePercent > 50 ? 'yellow' : 'green');
  
  return {
    totalCallsPerCycle,
    requestsPerMinute: requestsPerMinute.toFixed(1),
    usagePercent,
    totalPendingOrders
  };
}

// ============================================================================
// 5. TỔNG HỢP & XẾP HẠNG
// ============================================================================

logSection('5️⃣  TỔNG HỢP & XẾP HẠNG NGUYÊN NHÂN');

async function generateSummary() {
  log('\n🚀 Đang phân tích...\n', 'blue');
  
  const positionMonitor = await analyzePositionMonitor();
  const positionSync = await analyzePositionSync();
  const priceAlertScanner = await analyzePriceAlertScanner();
  const entryOrderMonitor = await analyzeEntryOrderMonitor();
  
  // Calculate total
  const totalRequestsPerMinute = 
    parseFloat(positionMonitor.requestsPerMinute) +
    parseFloat(positionSync.requestsPerMinute) +
    parseFloat(priceAlertScanner.requestsPerMinute) +
    parseFloat(entryOrderMonitor.requestsPerMinute);
  
  const totalUsagePercent = (totalRequestsPerMinute / config.BINANCE_RATE_LIMIT_PER_MINUTE) * 100;
  
  logSection('📊 TỔNG HỢP TẤT CẢ');
  
  log('\n📈 Requests per minute từ mỗi service:', 'magenta');
  
  const services = [
    {
      name: 'PositionMonitor',
      requestsPerMin: parseFloat(positionMonitor.requestsPerMinute),
      usagePercent: positionMonitor.usagePercent,
      description: `Quét ${positionMonitor.positions} positions mỗi ${config.POSITION_MONITOR_INTERVAL_MS / 1000}s`,
      details: positionMonitor
    },
    {
      name: 'PositionSync',
      requestsPerMin: parseFloat(positionSync.requestsPerMinute),
      usagePercent: positionSync.usagePercent,
      description: `Đồng bộ ${positionSync.activeBots} bots mỗi ${config.POSITION_SYNC_INTERVAL_MS / 1000}s`,
      details: positionSync
    },
    {
      name: 'PriceAlertScanner',
      requestsPerMin: parseFloat(priceAlertScanner.requestsPerMinute),
      usagePercent: priceAlertScanner.usagePercent,
      description: `Scan ${priceAlertScanner.totalSymbols} symbols mỗi ${config.PRICE_ALERT_SCAN_INTERVAL_MS}ms (chủ yếu WebSocket)`,
      details: priceAlertScanner
    },
    {
      name: 'EntryOrderMonitor',
      requestsPerMin: parseFloat(entryOrderMonitor.requestsPerMinute),
      usagePercent: entryOrderMonitor.usagePercent,
      description: `Monitor ${entryOrderMonitor.totalPendingOrders} pending orders mỗi ${config.ENTRY_ORDER_MONITOR_INTERVAL_MS / 1000}s`,
      details: entryOrderMonitor
    }
  ];
  
  // Sort by requests per minute (descending)
  services.sort((a, b) => b.requestsPerMin - a.requestsPerMin);
  
  let rank = 1;
  for (const service of services) {
    const percentage = (service.requestsPerMin / totalRequestsPerMinute) * 100;
    const color = rank === 1 ? 'red' : rank === 2 ? 'yellow' : 'green';
    log(`\n${rank}. ${service.name}:`, color);
    log(`   Requests/min: ~${service.requestsPerMin.toFixed(1)} (${percentage.toFixed(1)}% tổng)`, 'yellow');
    log(`   Usage: ${service.usagePercent.toFixed(1)}% của Binance limit`, service.usagePercent > 50 ? 'red' : 'green');
    log(`   ${service.description}`, 'cyan');
    rank++;
  }
  
  log('\n📊 TỔNG CỘNG:', 'magenta');
  log(`   Total requests/min: ~${totalRequestsPerMinute.toFixed(1)}`, 'yellow');
  log(`   Binance limit: ${config.BINANCE_RATE_LIMIT_PER_MINUTE} requests/min`, 'yellow');
  log(`   Total usage: ${totalUsagePercent.toFixed(1)}% của limit`, totalUsagePercent > 80 ? 'red' : totalUsagePercent > 50 ? 'yellow' : 'green');
  
  if (totalUsagePercent > 80) {
    logError(`\n❌ RẤT NGUY HIỂM! Total usage > 80%, có nguy cơ rate limit cao!`);
  } else if (totalUsagePercent > 50) {
    logWarning(`\n⚠️  CẢNH BÁO! Total usage > 50%, cần tối ưu để giảm requests.`);
  } else {
    logSuccess(`\n✅ Total usage < 50%, an toàn.`);
  }
  
  // Identify top contributors
  logSection('🎯 TOP NGUYÊN NHÂN GÂY RATE LIMIT');
  
  const topService = services[0];
  log(`\n${topService.name} là nguyên nhân chính:`, 'red');
  log(`   Đóng góp: ${((topService.requestsPerMin / totalRequestsPerMinute) * 100).toFixed(1)}% tổng requests`, 'yellow');
  log(`   ${topService.description}`, 'cyan');
  
  // Recommendations
  logSection('💡 KHUYẾN NGHỊ TỐI ƯU');
  
  const recommendations = [];
  
  if (topService.name === 'PositionMonitor') {
    recommendations.push({
      service: 'PositionMonitor',
      issue: 'Quá nhiều getTickerPrice() calls',
      solution: [
        '✅ Sử dụng WebSocket cache thay vì REST API (đã implement)',
        '⚠️  Tăng interval: 25s → 40-60s (giảm frequency)',
        '⚠️  Batch processing: Xử lý ít positions hơn mỗi cycle',
        '⚠️  Cache prices: Chỉ update khi giá thay đổi đáng kể',
        '⚠️  Skip positions: Bỏ qua positions đã có TP/SL và không cần update'
      ]
    });
  }
  
  if (totalUsagePercent > 80) {
    recommendations.push({
      service: 'General',
      issue: 'Total usage quá cao',
      solution: [
        '⚠️  Tăng tất cả intervals lên 20-30%',
        '⚠️  Giảm batch sizes trong PositionMonitor',
        '⚠️  Kiểm tra WebSocket subscriptions đang hoạt động tốt',
        '⚠️  Tắt PriceAlertScanner REST fallback (chỉ dùng WebSocket)',
        '⚠️  Giảm số lượng positions hoặc optimize logic'
      ]
    });
  }
  
  if (positionMonitor.positions > 50) {
    recommendations.push({
      service: 'PositionMonitor',
      issue: `Quá nhiều positions (${positionMonitor.positions})`,
      solution: [
        '⚠️  Giảm số lượng positions đang mở',
        '⚠️  Tăng interval: 25s → 40s hoặc 60s',
        '⚠️  Batch size: 3 → 2 (giảm parallel processing)',
        '⚠️  Batch delay: 2s → 3s (tăng delay giữa batches)'
      ]
    });
  }
  
  if (recommendations.length === 0) {
    logSuccess('  Code đã được tối ưu tốt! Không có vấn đề nghiêm trọng.');
  } else {
    for (const rec of recommendations) {
      log(`\n  ${rec.service}: ${rec.issue}`, 'yellow');
      for (const sol of rec.solution) {
        log(`    ${sol}`, 'cyan');
      }
    }
  }
  
  // Configuration suggestions
  logSection('⚙️  CONFIG ĐỀ XUẤT');
  
  log('\nĐể giảm rate limit, khuyến nghị cập nhật config:', 'magenta');
  
  const currentIntervals = {
    'POSITION_MONITOR_INTERVAL_MS': config.POSITION_MONITOR_INTERVAL_MS,
    'POSITION_SYNC_INTERVAL_MS': config.POSITION_SYNC_INTERVAL_MS,
    'PRICE_ALERT_SCAN_INTERVAL_MS': config.PRICE_ALERT_SCAN_INTERVAL_MS,
    'ENTRY_ORDER_MONITOR_INTERVAL_MS': config.ENTRY_ORDER_MONITOR_INTERVAL_MS,
  };
  
  const suggestedIntervals = {
    'POSITION_MONITOR_INTERVAL_MS': Math.max(40000, config.POSITION_MONITOR_INTERVAL_MS * 1.5),
    'POSITION_SYNC_INTERVAL_MS': Math.max(60000, config.POSITION_SYNC_INTERVAL_MS * 1.5),
    'PRICE_ALERT_SCAN_INTERVAL_MS': config.PRICE_ALERT_SCAN_INTERVAL_MS, // Keep low, uses WebSocket
    'ENTRY_ORDER_MONITOR_INTERVAL_MS': Math.max(45000, config.ENTRY_ORDER_MONITOR_INTERVAL_MS * 1.5),
  };
  
  log('\nConfig hiện tại vs đề xuất:', 'yellow');
  for (const [key, current] of Object.entries(currentIntervals)) {
    const suggested = suggestedIntervals[key];
    const diff = ((suggested - current) / current * 100).toFixed(0);
    const color = suggested > current ? 'yellow' : 'green';
    log(`  ${key}:`, 'cyan');
    log(`    Hiện tại: ${current}ms`, 'yellow');
    log(`    Đề xuất: ${suggested}ms (${diff > 0 ? '+' : ''}${diff}%)`, color);
  }
  
  log('\n' + '='.repeat(70), 'cyan');
  log('✅ Phân tích hoàn tất!', 'green');
  log('='.repeat(70) + '\n', 'cyan');
}

// Run analysis
generateSummary().catch(error => {
  logError(`\n❌ Fatal error: ${error.message}`);
  console.error(error);
  process.exit(1);
});

