#!/usr/bin/env node

/**
 * PnL Analysis Script
 * Thống kê và phân tích PnL của positions đang mở và đã đóng
 */

import dotenv from 'dotenv';
import pool from '../src/config/database.js';
import { Position } from '../src/models/Position.js';

dotenv.config();

async function analyzePnL() {
  try {
    console.log('='.repeat(80));
    console.log('📊 PnL Analysis Report');
    console.log('='.repeat(80));
    console.log('');

    // 1. Thống kê tổng quan
    console.log('📈 TỔNG QUAN:');
    console.log('-'.repeat(80));
    
    const [totalStats] = await pool.execute(`
      SELECT 
        COUNT(*) as total_positions,
        SUM(CASE WHEN status = 'open' THEN 1 ELSE 0 END) as open_positions,
        SUM(CASE WHEN status = 'closed' THEN 1 ELSE 0 END) as closed_positions,
        SUM(CASE WHEN status = 'closed' AND COALESCE(pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN status = 'closed' AND COALESCE(pnl, 0) < 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN status = 'closed' AND COALESCE(pnl, 0) = 0 THEN 1 ELSE 0 END) as breakeven,
        SUM(CASE WHEN status = 'closed' THEN COALESCE(pnl, 0) ELSE 0 END) as total_pnl,
        AVG(CASE WHEN status = 'closed' THEN COALESCE(pnl, 0) ELSE NULL END) as avg_pnl,
        MAX(CASE WHEN status = 'closed' THEN COALESCE(pnl, 0) ELSE NULL END) as max_profit,
        MIN(CASE WHEN status = 'closed' THEN COALESCE(pnl, 0) ELSE NULL END) as max_loss
      FROM positions
    `);

    const stats = totalStats[0];
    const winRate = stats.closed_positions > 0 
      ? ((stats.wins / stats.closed_positions) * 100).toFixed(2) 
      : '0.00';
    const avgWin = stats.wins > 0 
      ? (stats.total_pnl > 0 ? (stats.total_pnl / stats.wins).toFixed(2) : '0.00')
      : '0.00';
    const avgLoss = stats.losses > 0 
      ? (stats.total_pnl < 0 ? (Math.abs(stats.total_pnl) / stats.losses).toFixed(2) : '0.00')
      : '0.00';

    console.log(`Tổng số positions: ${stats.total_positions}`);
    console.log(`  - Đang mở: ${stats.open_positions}`);
    console.log(`  - Đã đóng: ${stats.closed_positions}`);
    console.log(``);
    console.log(`Kết quả đã đóng:`);
    console.log(`  - Thắng: ${stats.wins} (${winRate}%)`);
    console.log(`  - Thua: ${stats.losses}`);
    console.log(`  - Hòa: ${stats.breakeven}`);
    console.log(``);
    console.log(`PnL:`);
    console.log(`  - Tổng PnL: ${Number(stats.total_pnl || 0).toFixed(2)} USDT`);
    console.log(`  - PnL trung bình: ${Number(stats.avg_pnl || 0).toFixed(2)} USDT`);
    console.log(`  - Lợi nhuận lớn nhất: ${Number(stats.max_profit || 0).toFixed(2)} USDT`);
    console.log(`  - Lỗ lớn nhất: ${Number(stats.max_loss || 0).toFixed(2)} USDT`);
    console.log(`  - Lợi nhuận trung bình (thắng): ${avgWin} USDT`);
    console.log(`  - Lỗ trung bình (thua): ${avgLoss} USDT`);
    console.log('');

    // 2. Thống kê theo bot
    console.log('🤖 THEO BOT:');
    console.log('-'.repeat(80));
    
    const [botStats] = await pool.execute(`
      SELECT 
        b.id as bot_id,
        b.bot_name,
        b.exchange,
        b.binance_testnet,
        COUNT(*) as total_positions,
        SUM(CASE WHEN p.status = 'open' THEN 1 ELSE 0 END) as open_positions,
        SUM(CASE WHEN p.status = 'closed' THEN 1 ELSE 0 END) as closed_positions,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) < 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) ELSE 0 END) as total_pnl,
        AVG(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) ELSE NULL END) as avg_pnl
      FROM positions p
      JOIN strategies s ON p.strategy_id = s.id
      JOIN bots b ON s.bot_id = b.id
      GROUP BY b.id, b.bot_name, b.exchange, b.binance_testnet
      ORDER BY total_pnl DESC
    `);

    for (const bot of botStats) {
      const botWinRate = bot.closed_positions > 0 
        ? ((bot.wins / bot.closed_positions) * 100).toFixed(2) 
        : '0.00';
      const testnet = bot.binance_testnet ? ' (TESTNET)' : '';
      console.log(`Bot ${bot.bot_id}: ${bot.bot_name}${testnet}`);
      console.log(`  Positions: ${bot.total_positions} (${bot.open_positions} mở, ${bot.closed_positions} đóng)`);
      console.log(`  Win Rate: ${botWinRate}% (${bot.wins}W/${bot.losses}L)`);
      console.log(`  Total PnL: ${Number(bot.total_pnl || 0).toFixed(2)} USDT`);
      console.log(`  Avg PnL: ${Number(bot.avg_pnl || 0).toFixed(2)} USDT`);
      console.log('');
    }

    // 3. Thống kê theo symbol
    console.log('💰 THEO SYMBOL (Top 20):');
    console.log('-'.repeat(80));
    
    const [symbolStats] = await pool.execute(`
      SELECT 
        p.symbol,
        COUNT(*) as total_positions,
        SUM(CASE WHEN p.status = 'open' THEN 1 ELSE 0 END) as open_positions,
        SUM(CASE WHEN p.status = 'closed' THEN 1 ELSE 0 END) as closed_positions,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN p.status = 'closed' AND COALESCE(p.pnl, 0) < 0 THEN 1 ELSE 0 END) as losses,
        SUM(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) ELSE 0 END) as total_pnl,
        AVG(CASE WHEN p.status = 'closed' THEN COALESCE(p.pnl, 0) ELSE NULL END) as avg_pnl
      FROM positions p
      WHERE p.status = 'closed'
      GROUP BY p.symbol
      ORDER BY total_pnl DESC
      LIMIT 20
    `);

    for (const symbol of symbolStats) {
      const symbolWinRate = symbol.closed_positions > 0 
        ? ((symbol.wins / symbol.closed_positions) * 100).toFixed(2) 
        : '0.00';
      console.log(`${symbol.symbol}:`);
      console.log(`  Positions: ${symbol.closed_positions} (${symbol.wins}W/${symbol.losses}L) - Win Rate: ${symbolWinRate}%`);
      console.log(`  Total PnL: ${Number(symbol.total_pnl || 0).toFixed(2)} USDT | Avg: ${Number(symbol.avg_pnl || 0).toFixed(2)} USDT`);
    }
    console.log('');

    // 4. Thống kê theo close reason
    console.log('📋 THEO LÝ DO ĐÓNG:');
    console.log('-'.repeat(80));
    
    const [reasonStats] = await pool.execute(`
      SELECT 
        COALESCE(close_reason, 'unknown') as close_reason,
        COUNT(*) as count,
        SUM(CASE WHEN COALESCE(pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN COALESCE(pnl, 0) < 0 THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(pnl, 0)) as total_pnl,
        AVG(COALESCE(pnl, 0)) as avg_pnl
      FROM positions
      WHERE status = 'closed'
      GROUP BY close_reason
      ORDER BY total_pnl DESC
    `);

    for (const reason of reasonStats) {
      const reasonWinRate = reason.count > 0 
        ? ((reason.wins / reason.count) * 100).toFixed(2) 
        : '0.00';
      console.log(`${reason.close_reason}:`);
      console.log(`  Số lượng: ${reason.count} (${reason.wins}W/${reason.losses}L) - Win Rate: ${reasonWinRate}%`);
      console.log(`  Total PnL: ${Number(reason.total_pnl || 0).toFixed(2)} USDT | Avg: ${Number(reason.avg_pnl || 0).toFixed(2)} USDT`);
    }
    console.log('');

    // 5. Phân tích positions đang mở
    console.log('🔓 POSITIONS ĐANG MỞ:');
    console.log('-'.repeat(80));
    
    const [openPositions] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.amount,
        p.take_profit_price,
        p.stop_loss_price,
        p.current_reduce,
        p.opened_at,
        b.bot_name,
        DATEDIFF(NOW(), p.opened_at) as days_open,
        TIMESTAMPDIFF(HOUR, p.opened_at, NOW()) as hours_open
      FROM positions p
      JOIN strategies s ON p.strategy_id = s.id
      JOIN bots b ON s.bot_id = b.id
      WHERE p.status = 'open'
      ORDER BY p.opened_at ASC
    `);

    if (openPositions.length === 0) {
      console.log('Không có positions đang mở.');
    } else {
      console.log(`Tổng số: ${openPositions.length} positions đang mở`);
      console.log('');
      
      // Group by bot
      const openByBot = {};
      for (const pos of openPositions) {
        const botKey = `${pos.bot_name} (Bot ${pos.bot_id})`;
        if (!openByBot[botKey]) {
          openByBot[botKey] = [];
        }
        openByBot[botKey].push(pos);
      }

      for (const [botName, positions] of Object.entries(openByBot)) {
        const totalValue = positions.reduce((sum, p) => sum + (p.entry_price * p.amount), 0);
        console.log(`${botName}: ${positions.length} positions (Total Value: ${totalValue.toFixed(2)} USDT)`);
      }
    }
    console.log('');

    // 6. Top winners và losers
    console.log('🏆 TOP WINNERS (Top 10):');
    console.log('-'.repeat(80));
    
    const [topWinners] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.close_price,
        p.amount,
        p.pnl,
        p.close_reason,
        p.opened_at,
        p.closed_at,
        TIMESTAMPDIFF(MINUTE, p.opened_at, p.closed_at) as duration_minutes,
        b.bot_name
      FROM positions p
      JOIN strategies s ON p.strategy_id = s.id
      JOIN bots b ON s.bot_id = b.id
      WHERE p.status = 'closed' AND p.pnl > 0
      ORDER BY p.pnl DESC
      LIMIT 10
    `);

    for (const winner of topWinners) {
      const duration = winner.duration_minutes < 60 
        ? `${winner.duration_minutes}m`
        : `${Math.floor(winner.duration_minutes / 60)}h ${winner.duration_minutes % 60}m`;
      console.log(`#${winner.id} ${winner.symbol} ${winner.side.toUpperCase()}: +${Number(winner.pnl).toFixed(2)} USDT`);
      console.log(`  Entry: ${Number(winner.entry_price).toFixed(8)} → Exit: ${Number(winner.close_price).toFixed(8)}`);
      console.log(`  Amount: ${Number(winner.amount).toFixed(4)} | Duration: ${duration} | Reason: ${winner.close_reason || 'N/A'}`);
      console.log(`  Bot: ${winner.bot_name}`);
    }
    console.log('');

    console.log('💸 TOP LOSERS (Top 10):');
    console.log('-'.repeat(80));
    
    const [topLosers] = await pool.execute(`
      SELECT 
        p.id,
        p.symbol,
        p.side,
        p.entry_price,
        p.close_price,
        p.amount,
        p.pnl,
        p.close_reason,
        p.opened_at,
        p.closed_at,
        TIMESTAMPDIFF(MINUTE, p.opened_at, p.closed_at) as duration_minutes,
        b.bot_name
      FROM positions p
      JOIN strategies s ON p.strategy_id = s.id
      JOIN bots b ON s.bot_id = b.id
      WHERE p.status = 'closed' AND p.pnl < 0
      ORDER BY p.pnl ASC
      LIMIT 10
    `);

    for (const loser of topLosers) {
      const duration = loser.duration_minutes < 60 
        ? `${loser.duration_minutes}m`
        : `${Math.floor(loser.duration_minutes / 60)}h ${loser.duration_minutes % 60}m`;
      console.log(`#${loser.id} ${loser.symbol} ${loser.side.toUpperCase()}: ${Number(loser.pnl).toFixed(2)} USDT`);
      console.log(`  Entry: ${Number(loser.entry_price).toFixed(8)} → Exit: ${Number(loser.close_price).toFixed(8)}`);
      console.log(`  Amount: ${Number(loser.amount).toFixed(4)} | Duration: ${duration} | Reason: ${loser.close_reason || 'N/A'}`);
      console.log(`  Bot: ${loser.bot_name}`);
    }
    console.log('');

    // 7. Phân tích theo thời gian
    console.log('📅 THEO THỜI GIAN (7 ngày gần nhất):');
    console.log('-'.repeat(80));
    
    const [timeStats] = await pool.execute(`
      SELECT 
        DATE(closed_at) as date,
        COUNT(*) as count,
        SUM(CASE WHEN COALESCE(pnl, 0) > 0 THEN 1 ELSE 0 END) as wins,
        SUM(CASE WHEN COALESCE(pnl, 0) < 0 THEN 1 ELSE 0 END) as losses,
        SUM(COALESCE(pnl, 0)) as total_pnl
      FROM positions
      WHERE status = 'closed' AND closed_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)
      GROUP BY DATE(closed_at)
      ORDER BY date DESC
    `);

    for (const day of timeStats) {
      const dayWinRate = day.count > 0 
        ? ((day.wins / day.count) * 100).toFixed(2) 
        : '0.00';
      console.log(`${day.date}: ${day.count} positions (${day.wins}W/${day.losses}L) - Win Rate: ${dayWinRate}% | PnL: ${Number(day.total_pnl || 0).toFixed(2)} USDT`);
    }
    console.log('');

    // 8. Đề xuất cải thiện
    console.log('💡 ĐỀ XUẤT CẢI THIỆN:');
    console.log('='.repeat(80));
    
    const recommendations = [];
    
    // Check win rate
    if (stats.closed_positions > 0) {
      const currentWinRate = parseFloat(winRate);
      if (currentWinRate < 50) {
        recommendations.push({
          priority: 'HIGH',
          issue: `Win rate thấp (${winRate}%)`,
          suggestion: 'Xem xét cải thiện entry filters, tăng độ chính xác của signals'
        });
      } else if (currentWinRate < 60) {
        recommendations.push({
          priority: 'MEDIUM',
          issue: `Win rate có thể cải thiện (${winRate}%)`,
          suggestion: 'Tối ưu hóa TP/SL ratios, cải thiện timing entry'
        });
      }
    }

    // Check average loss vs average win
    if (stats.losses > 0 && stats.wins > 0) {
      const avgWinNum = parseFloat(avgWin);
      const avgLossNum = parseFloat(avgLoss);
      const riskRewardRatio = avgLossNum > 0 ? (avgWinNum / avgLossNum).toFixed(2) : 'N/A';
      
      if (avgLossNum > avgWinNum) {
        recommendations.push({
          priority: 'HIGH',
          issue: `Lỗ trung bình (${avgLoss}) lớn hơn lợi nhuận trung bình (${avgWin})`,
          suggestion: 'Điều chỉnh Stop Loss chặt hơn hoặc Take Profit xa hơn để cải thiện Risk/Reward ratio'
        });
      }
      
      if (riskRewardRatio !== 'N/A' && parseFloat(riskRewardRatio) < 1.5) {
        recommendations.push({
          priority: 'MEDIUM',
          issue: `Risk/Reward ratio thấp (${riskRewardRatio}:1)`,
          suggestion: 'Nên có Risk/Reward ratio tối thiểu 1.5:1 hoặc 2:1'
        });
      }
    }

    // Check max loss
    if (stats.max_loss < -100) {
      recommendations.push({
        priority: 'HIGH',
        issue: `Có lỗ lớn nhất: ${Number(stats.max_loss).toFixed(2)} USDT`,
        suggestion: 'Xem xét thêm trailing stop loss hoặc giảm position size cho các symbols có volatility cao'
      });
    }

    // Check open positions
    if (stats.open_positions > 50) {
      recommendations.push({
        priority: 'MEDIUM',
        issue: `Có nhiều positions đang mở (${stats.open_positions})`,
        suggestion: 'Xem xét giảm số lượng positions đồng thời để quản lý risk tốt hơn'
      });
    }

    // Analyze close reasons
    for (const reason of reasonStats) {
      if (reason.total_pnl < 0 && reason.count > 5) {
        const reasonWinRate = ((reason.wins / reason.count) * 100).toFixed(2);
        recommendations.push({
          priority: 'MEDIUM',
          issue: `Close reason "${reason.close_reason}" có win rate thấp (${reasonWinRate}%) và tổng lỗ ${Number(reason.total_pnl).toFixed(2)} USDT`,
          suggestion: `Xem xét cải thiện logic cho close reason này hoặc tránh các điều kiện dẫn đến close reason này`
        });
      }
    }

    if (recommendations.length === 0) {
      console.log('✅ Không có vấn đề nghiêm trọng được phát hiện.');
    } else {
      const highPriority = recommendations.filter(r => r.priority === 'HIGH');
      const mediumPriority = recommendations.filter(r => r.priority === 'MEDIUM');
      
      if (highPriority.length > 0) {
        console.log('🔴 ƯU TIÊN CAO:');
        highPriority.forEach((rec, i) => {
          console.log(`${i + 1}. ${rec.issue}`);
          console.log(`   → ${rec.suggestion}`);
          console.log('');
        });
      }
      
      if (mediumPriority.length > 0) {
        console.log('🟡 ƯU TIÊN TRUNG BÌNH:');
        mediumPriority.forEach((rec, i) => {
          console.log(`${i + 1}. ${rec.issue}`);
          console.log(`   → ${rec.suggestion}`);
          console.log('');
        });
      }
    }

    console.log('='.repeat(80));
    console.log('Report generated at:', new Date().toISOString());
    console.log('='.repeat(80));

  } catch (error) {
    console.error('❌ Error analyzing PnL:', error);
    process.exit(1);
  } finally {
    await pool.end();
  }
}

analyzePnL();

