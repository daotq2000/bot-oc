#!/usr/bin/env node

/**
 * Script để phân tích positions và take_profit orders
 * - Fetch positions từ exchange
 * - So sánh với DB
 * - Kiểm tra TP orders
 * - Kiểm tra trailing TP logic
 */

import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
import pool from '../src/config/database.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { Position } from '../src/models/Position.js';
import { Strategy } from '../src/models/Strategy.js';

dotenv.config();

async function analyzePositions(botId = 2) {
  console.log(`\n=== PHÂN TÍCH POSITIONS VÀ TAKE_PROFIT - BOT ${botId} ===\n`);

  try {
    // 1. Lấy bot info
    const bot = await Bot.findById(botId);
    if (!bot) {
      throw new Error(`Bot ${botId} not found`);
    }
    console.log(`📊 Bot: ${bot.bot_name} (${bot.exchange}, testnet=${bot.binance_testnet})`);

    // 2. Initialize ExchangeService
    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();

    // 3. Fetch positions từ exchange
    console.log('\n📡 1. FETCH POSITIONS TỪ EXCHANGE:');
    let exchangePositions = [];
    try {
      if (bot.exchange === 'binance') {
        // Fetch từ Binance Futures API
        const normalizedSymbol = null; // Get all positions
        const positionsData = await exchangeService.binanceDirectClient.makeRequest(
          '/fapi/v2/positionRisk',
          'GET',
          {},
          true
        );
        
        // Filter chỉ positions có quantity > 0
        exchangePositions = (positionsData || []).filter(p => {
          const positionAmt = parseFloat(p.positionAmt || p.positionAmount || 0);
          return Math.abs(positionAmt) > 0;
        });
      } else {
        console.log(`   ⚠️  Exchange ${bot.exchange} không hỗ trợ fetch positions từ API`);
      }
    } catch (e) {
      console.error(`   ❌ Lỗi khi fetch positions từ exchange: ${e?.message || e}`);
    }
    console.log(`   - Số positions trên exchange: ${exchangePositions.length}`);

    // 4. Lấy positions từ DB
    console.log('\n💾 2. LẤY POSITIONS TỪ DATABASE:');
    const [dbPositions] = await pool.execute(
      `SELECT p.*, s.symbol as strategy_symbol, s.oc, s.take_profit, s.reduce, s.up_reduce, s.stoploss
       FROM positions p
       JOIN strategies s ON p.strategy_id = s.id
       WHERE p.bot_id = ? AND p.status = 'open'
       ORDER BY p.opened_at DESC`,
      [botId]
    );
    console.log(`   - Số open positions trong DB: ${dbPositions.length}`);

    // 5. Phân tích từng position
    console.log('\n🔍 3. PHÂN TÍCH CHI TIẾT:');
    
    const issues = {
      noTpOrder: [],
      tpNotTrailing: [],
      tpOrderMissing: [],
      tpPriceMismatch: []
    };

    for (const position of dbPositions) {
      console.log(`\n   📍 Position ID: ${position.id} (${position.symbol})`);
      console.log(`      - Side: ${position.side}`);
      console.log(`      - Entry Price: ${position.entry_price}`);
      console.log(`      - Amount: ${position.amount}`);
      console.log(`      - TP Price (DB): ${position.take_profit_price || 'NULL'}`);
      console.log(`      - TP Order ID (DB): ${position.tp_order_id || 'NULL'}`);
      console.log(`      - SL Order ID (DB): ${position.sl_order_id || 'NULL'}`);
      console.log(`      - Strategy: OC=${position.oc}, TP=${position.take_profit}, Reduce=${position.reduce}, UpReduce=${position.up_reduce}`);

      // Check 1: Không có TP order
      if (!position.tp_order_id) {
        console.log(`      ⚠️  VẤN ĐỀ: Không có TP order ID trong DB`);
        issues.noTpOrder.push({
          positionId: position.id,
          symbol: position.symbol,
          side: position.side,
          entryPrice: position.entry_price,
          tpPrice: position.take_profit_price
        });
      } else {
        // Check 2: TP order có tồn tại trên exchange không
        try {
          const tpOrderStatus = await exchangeService.getOrderStatus(position.symbol, position.tp_order_id);
          const orderStatus = (tpOrderStatus?.status || '').toLowerCase();
          console.log(`      - TP Order Status: ${orderStatus}`);
          
          if (orderStatus === 'filled' || orderStatus === 'canceled' || orderStatus === 'cancelled' || orderStatus === 'expired') {
            console.log(`      ⚠️  VẤN ĐỀ: TP order đã ${orderStatus} nhưng DB vẫn còn`);
            issues.tpOrderMissing.push({
              positionId: position.id,
              symbol: position.symbol,
              tpOrderId: position.tp_order_id,
              status: orderStatus
            });
          } else if (orderStatus === 'new' || orderStatus === 'open') {
            // Check 3: TP price có đúng không
            const tpOrderPrice = parseFloat(tpOrderStatus?.price || tpOrderStatus?.stopPrice || 0);
            const dbTpPrice = parseFloat(position.take_profit_price || 0);
            
            if (tpOrderPrice > 0 && dbTpPrice > 0) {
              const priceDiff = Math.abs(tpOrderPrice - dbTpPrice);
              const priceDiffPercent = (priceDiff / dbTpPrice) * 100;
              
              if (priceDiffPercent > 0.1) { // More than 0.1% difference
                console.log(`      ⚠️  VẤN ĐỀ: TP price mismatch - DB: ${dbTpPrice}, Exchange: ${tpOrderPrice}, Diff: ${priceDiffPercent.toFixed(2)}%`);
                issues.tpPriceMismatch.push({
                  positionId: position.id,
                  symbol: position.symbol,
                  dbTpPrice,
                  exchangeTpPrice: tpOrderPrice,
                  diffPercent: priceDiffPercent
                });
              }
            }

            // Check 4: Trailing TP logic
            // Tính toán TP price mong đợi dựa trên reduce/up_reduce
            const entryPrice = parseFloat(position.entry_price || 0);
            const currentTpPrice = parseFloat(position.take_profit_price || 0);
            const oc = parseFloat(position.oc || 1);
            const takeProfit = parseFloat(position.take_profit || 50);
            const reduce = parseFloat(position.reduce || 0);
            const upReduce = parseFloat(position.up_reduce || 0);
            
            if (entryPrice > 0 && currentTpPrice > 0) {
              // Tính initial TP price
              const { calculateTakeProfit } = await import('../src/utils/calculator.js');
              const initialTpPrice = calculateTakeProfit(entryPrice, oc, takeProfit, position.side);
              
              // Kiểm tra xem có nên trailing không
              let expectedTpPrice = initialTpPrice;
              
              // Lấy current price để check trailing
              try {
                const currentPrice = await exchangeService.getTickerPrice(position.symbol);
                if (currentPrice && currentPrice > 0) {
                  console.log(`      - Current Price: ${currentPrice}`);
                  
                  // Tính expected TP với trailing
                  if (position.side === 'long') {
                    // Long: TP tăng theo up_reduce khi price tăng
                    if (currentPrice > entryPrice && upReduce > 0) {
                      const priceIncrease = currentPrice - entryPrice;
                      const priceIncreasePercent = (priceIncrease / entryPrice) * 100;
                      const trailingAmount = (priceIncreasePercent / upReduce) * (takeProfit / 100) * entryPrice;
                      expectedTpPrice = initialTpPrice + trailingAmount;
                    }
                    // Long: TP giảm theo reduce khi price giảm (nhưng không thấp hơn entry)
                    if (currentPrice < entryPrice && reduce > 0) {
                      const priceDecrease = entryPrice - currentPrice;
                      const priceDecreasePercent = (priceDecrease / entryPrice) * 100;
                      const trailingAmount = (priceDecreasePercent / reduce) * (takeProfit / 100) * entryPrice;
                      expectedTpPrice = Math.max(initialTpPrice - trailingAmount, entryPrice);
                    }
                  } else if (position.side === 'short') {
                    // Short: TP giảm theo up_reduce khi price giảm
                    if (currentPrice < entryPrice && upReduce > 0) {
                      const priceDecrease = entryPrice - currentPrice;
                      const priceDecreasePercent = (priceDecrease / entryPrice) * 100;
                      const trailingAmount = (priceDecreasePercent / upReduce) * (takeProfit / 100) * entryPrice;
                      expectedTpPrice = initialTpPrice - trailingAmount;
                    }
                    // Short: TP tăng theo reduce khi price tăng (nhưng không cao hơn entry)
                    if (currentPrice > entryPrice && reduce > 0) {
                      const priceIncrease = currentPrice - entryPrice;
                      const priceIncreasePercent = (priceIncrease / entryPrice) * 100;
                      const trailingAmount = (priceIncreasePercent / reduce) * (takeProfit / 100) * entryPrice;
                      expectedTpPrice = Math.min(initialTpPrice + trailingAmount, entryPrice);
                    }
                  }
                  
                  const tpDiff = Math.abs(currentTpPrice - expectedTpPrice);
                  const tpDiffPercent = (tpDiff / expectedTpPrice) * 100;
                  
                  if (tpDiffPercent > 0.1) { // More than 0.1% difference
                    console.log(`      ⚠️  VẤN ĐỀ: TP không trailing đúng - Current: ${currentTpPrice}, Expected: ${expectedTpPrice.toFixed(8)}, Diff: ${tpDiffPercent.toFixed(2)}%`);
                    issues.tpNotTrailing.push({
                      positionId: position.id,
                      symbol: position.symbol,
                      side: position.side,
                      entryPrice,
                      currentPrice,
                      currentTpPrice,
                      expectedTpPrice,
                      diffPercent: tpDiffPercent,
                      reduce,
                      upReduce
                    });
                  } else {
                    console.log(`      ✅ TP trailing đúng: ${currentTpPrice} (expected: ${expectedTpPrice.toFixed(8)})`);
                  }
                }
              } catch (e) {
                console.log(`      ⚠️  Không thể lấy current price: ${e?.message || e}`);
              }
            }
          }
        } catch (e) {
          console.log(`      ⚠️  Không thể check TP order trên exchange: ${e?.message || e}`);
          issues.tpOrderMissing.push({
            positionId: position.id,
            symbol: position.symbol,
            tpOrderId: position.tp_order_id,
            error: e?.message || e
          });
        }
      }
    }

    // 6. Tổng kết
    console.log('\n📊 4. TỔNG KẾT VẤN ĐỀ:');
    console.log(`   - Positions không có TP order: ${issues.noTpOrder.length}`);
    console.log(`   - TP orders đã mất trên exchange: ${issues.tpOrderMissing.length}`);
    console.log(`   - TP price mismatch: ${issues.tpPriceMismatch.length}`);
    console.log(`   - TP không trailing đúng: ${issues.tpNotTrailing.length}`);

    if (issues.noTpOrder.length > 0) {
      console.log(`\n   ❌ VẤN ĐỀ 1: ${issues.noTpOrder.length} positions không có TP order:`);
      issues.noTpOrder.forEach(issue => {
        console.log(`      - Position ${issue.positionId} (${issue.symbol}, ${issue.side})`);
      });
    }

    if (issues.tpOrderMissing.length > 0) {
      console.log(`\n   ❌ VẤN ĐỀ 2: ${issues.tpOrderMissing.length} TP orders đã mất trên exchange:`);
      issues.tpOrderMissing.forEach(issue => {
        console.log(`      - Position ${issue.positionId} (${issue.symbol}), TP Order: ${issue.tpOrderId}, Status: ${issue.status || issue.error}`);
      });
    }

    if (issues.tpPriceMismatch.length > 0) {
      console.log(`\n   ❌ VẤN ĐỀ 3: ${issues.tpPriceMismatch.length} TP price mismatch:`);
      issues.tpPriceMismatch.forEach(issue => {
        console.log(`      - Position ${issue.positionId} (${issue.symbol}), DB: ${issue.dbTpPrice}, Exchange: ${issue.exchangeTpPrice}, Diff: ${issue.diffPercent.toFixed(2)}%`);
      });
    }

    if (issues.tpNotTrailing.length > 0) {
      console.log(`\n   ❌ VẤN ĐỀ 4: ${issues.tpNotTrailing.length} TP không trailing đúng:`);
      issues.tpNotTrailing.forEach(issue => {
        console.log(`      - Position ${issue.positionId} (${issue.symbol}, ${issue.side})`);
        console.log(`        Entry: ${issue.entryPrice}, Current: ${issue.currentPrice}`);
        console.log(`        TP Current: ${issue.currentTpPrice}, Expected: ${issue.expectedTpPrice.toFixed(8)}`);
        console.log(`        Reduce: ${issue.reduce}, UpReduce: ${issue.upReduce}, Diff: ${issue.diffPercent.toFixed(2)}%`);
      });
    }

    if (issues.noTpOrder.length === 0 && 
        issues.tpOrderMissing.length === 0 && 
        issues.tpPriceMismatch.length === 0 && 
        issues.tpNotTrailing.length === 0) {
      console.log(`\n   ✅ Không có vấn đề nào được phát hiện!`);
    }

    return issues;

  } catch (error) {
    console.error('\n❌ LỖI:', error?.message || error);
    console.error('Stack:', error?.stack);
    process.exit(1);
  }
}

const botId = process.argv[2] ? parseInt(process.argv[2]) : 2;
analyzePositions(botId)
  .then((issues) => {
    console.log('\n✅ Phân tích hoàn thành!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Phân tích thất bại:', error?.message || error);
    process.exit(1);
  });

