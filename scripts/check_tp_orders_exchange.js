#!/usr/bin/env node

/**
 * Script để kiểm tra TP orders trên exchange
 * So sánh với database để tìm mismatch
 */

import dotenv from 'dotenv';
import logger from '../src/utils/logger.js';
import pool from '../src/config/database.js';
import { Bot } from '../src/models/Bot.js';
import { ExchangeService } from '../src/services/ExchangeService.js';
import { Position } from '../src/models/Position.js';

dotenv.config();

async function checkTpOrdersOnExchange() {
  console.log('\n=== KIỂM TRA TP ORDERS TRÊN EXCHANGE ===\n');

  try {
    // Lấy bot 3 (testnet)
    const bot = await Bot.findById(3);
    if (!bot) {
      throw new Error('Bot id=3 not found');
    }
    console.log(`📊 Bot: ${bot.bot_name} (${bot.exchange}, testnet=${bot.binance_testnet})`);

    const exchangeService = new ExchangeService(bot);
    await exchangeService.initialize();

    // 1. Lấy tất cả open positions từ database
    console.log('\n📋 1. KIỂM TRA POSITIONS TRONG DATABASE:');
    const positions = await Position.findOpen();
    console.log(`   - Số open positions: ${positions.length}`);

    if (positions.length === 0) {
      console.log('   ⚠️  Không có open positions nào trong database');
      console.log('   → Không thể kiểm tra TP orders');
      return;
    }

    for (const pos of positions) {
      console.log(`\n   Position ID: ${pos.id}`);
      console.log(`   - Symbol: ${pos.symbol}`);
      console.log(`   - Side: ${pos.side}`);
      console.log(`   - Entry Price: ${pos.entry_price}`);
      console.log(`   - TP Price: ${pos.take_profit_price}`);
      console.log(`   - TP Order ID (DB): ${pos.tp_order_id || 'NULL'}`);
      console.log(`   - SL Order ID (DB): ${pos.sl_order_id || 'NULL'}`);
      console.log(`   - Entry Order ID: ${pos.order_id}`);
    }

    // 2. Query tất cả open orders từ exchange
    console.log('\n📡 2. KIỂM TRA ORDERS TRÊN EXCHANGE:');
    
    // Lấy tất cả symbols từ positions
    const symbols = [...new Set(positions.map(p => p.symbol))];
    console.log(`   - Symbols cần kiểm tra: ${symbols.join(', ')}`);

    const allExchangeOrders = [];
    for (const symbol of symbols) {
      try {
        // Query open orders cho từng symbol
        const normalizedSymbol = exchangeService.binanceDirectClient.normalizeSymbol(symbol);
        const orders = await exchangeService.binanceDirectClient.makeRequest(
          '/fapi/v1/openOrders',
          'GET',
          { symbol: normalizedSymbol },
          true
        );

        if (Array.isArray(orders)) {
          console.log(`\n   📊 ${symbol}: ${orders.length} open orders`);
          orders.forEach((order, idx) => {
            console.log(`     ${idx + 1}. Order ID: ${order.orderId || order.order_id}`);
            console.log(`        - Type: ${order.type || 'N/A'}`);
            console.log(`        - Side: ${order.side || 'N/A'}`);
            console.log(`        - Status: ${order.status || 'N/A'}`);
            console.log(`        - Price: ${order.price || 'N/A'}`);
            console.log(`        - Stop Price: ${order.stopPrice || order.stop_price || 'N/A'}`);
            console.log(`        - Quantity: ${order.origQty || order.orig_quantity || 'N/A'}`);
            console.log(`        - Reduce Only: ${order.reduceOnly || order.reduce_only || 'N/A'}`);
            console.log(`        - Position Side: ${order.positionSide || order.position_side || 'N/A'}`);
            
            allExchangeOrders.push({
              symbol: symbol,
              orderId: String(order.orderId || order.order_id),
              type: order.type,
              side: order.side,
              price: order.price,
              stopPrice: order.stopPrice || order.stop_price,
              ...order
            });
          });

          // Tìm TAKE_PROFIT orders
          const tpOrders = orders.filter(o => 
            (o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT_LIMIT') ||
            (o.type === 'LIMIT' && o.reduceOnly === true && o.side === (positions.find(p => p.symbol === symbol)?.side === 'long' ? 'SELL' : 'BUY'))
          );
          
          if (tpOrders.length > 0) {
            console.log(`\n     ✅ Tìm thấy ${tpOrders.length} TAKE_PROFIT orders:`);
            tpOrders.forEach((tp, idx) => {
              console.log(`       ${idx + 1}. Order ID: ${tp.orderId || tp.order_id}, Type: ${tp.type}, Price: ${tp.price || tp.stopPrice}`);
            });
          } else {
            console.log(`\n     ⚠️  KHÔNG tìm thấy TAKE_PROFIT orders nào cho ${symbol}`);
          }
        }
      } catch (e) {
        console.error(`   ❌ Lỗi khi query orders cho ${symbol}: ${e?.message || e}`);
      }
    }

    // 3. So sánh database vs exchange
    console.log('\n🔍 3. SO SÁNH DATABASE VS EXCHANGE:');
    
    for (const pos of positions) {
      const dbTpOrderId = pos.tp_order_id;
      const exchangeTpOrders = allExchangeOrders.filter(o => 
        o.symbol === pos.symbol && 
        (o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT_LIMIT' ||
         (o.type === 'LIMIT' && o.reduceOnly === true))
      );

      console.log(`\n   Position ${pos.id} (${pos.symbol}):`);
      console.log(`   - TP Order ID trong DB: ${dbTpOrderId || 'NULL'}`);
      console.log(`   - TP Orders trên Exchange: ${exchangeTpOrders.length}`);
      
      if (dbTpOrderId) {
        const foundOnExchange = exchangeTpOrders.some(o => String(o.orderId) === String(dbTpOrderId));
        if (foundOnExchange) {
          console.log(`   ✅ TP order ${dbTpOrderId} có trên exchange`);
        } else {
          console.log(`   ⚠️  TP order ${dbTpOrderId} KHÔNG có trên exchange (có thể đã fill/cancel)`);
        }
      } else {
        console.log(`   ⚠️  Position không có tp_order_id trong DB`);
        if (exchangeTpOrders.length > 0) {
          console.log(`   ⚠️  Nhưng có ${exchangeTpOrders.length} TP orders trên exchange (có thể không sync)`);
        }
      }

      if (exchangeTpOrders.length > 0 && !dbTpOrderId) {
        console.log(`   ⚠️  CẢNH BÁO: Có TP orders trên exchange nhưng không có trong DB!`);
        exchangeTpOrders.forEach(tp => {
          console.log(`      - Order ID: ${tp.orderId}, Type: ${tp.type}, Price: ${tp.price || tp.stopPrice}`);
        });
      }
    }

    // 4. Tổng kết
    console.log('\n📈 4. TỔNG KẾT:');
    const totalTpOrdersOnExchange = allExchangeOrders.filter(o => 
      o.type === 'TAKE_PROFIT' || o.type === 'TAKE_PROFIT_MARKET' || o.type === 'TAKE_PROFIT_LIMIT' ||
      (o.type === 'LIMIT' && o.reduceOnly === true)
    ).length;
    
    const positionsWithTpInDb = positions.filter(p => p.tp_order_id).length;
    
    console.log(`   - Positions có TP order trong DB: ${positionsWithTpInDb}/${positions.length}`);
    console.log(`   - TP orders trên Exchange: ${totalTpOrdersOnExchange}`);
    
    if (totalTpOrdersOnExchange === 0 && positions.length > 0) {
      console.log(`\n   ❌ VẤN ĐỀ: Không có TP orders nào trên exchange!`);
      console.log(`   → Có thể:`);
      console.log(`     1. placeExitOrder() không được gọi`);
      console.log(`     2. createTakeProfitLimit() trả về null hoặc lỗi`);
      console.log(`     3. Orders bị reject bởi exchange`);
      console.log(`     4. Orders đã fill ngay lập tức`);
    }

  } catch (error) {
    console.error('\n❌ LỖI:', error?.message || error);
    console.error('Stack:', error?.stack);
    process.exit(1);
  }
}

checkTpOrdersOnExchange()
  .then(() => {
    console.log('\n✅ Kiểm tra hoàn thành!\n');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Kiểm tra thất bại:', error?.message || error);
    process.exit(1);
  });

