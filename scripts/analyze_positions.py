#!/usr/bin/env python3
"""
Script to analyze open positions, compare DB vs Exchange, and find losing positions
"""

import json
import sys
import subprocess
from datetime import datetime
from collections import defaultdict

def run_sql_query(query):
    """Run SQL query and return results"""
    try:
        # Read database config from .env or use defaults
        result = subprocess.run(
            ['node', '-e', f'''
                const mysql = require("mysql2/promise");
                (async () => {{
                    const pool = mysql.createPool({{
                        host: process.env.DB_HOST || "localhost",
                        user: process.env.DB_USER || "root",
                        password: process.env.DB_PASSWORD || "",
                        database: process.env.DB_NAME || "bot_oc",
                        waitForConnections: true,
                        connectionLimit: 10
                    }});
                    try {{
                        const [rows] = await pool.execute(`{query}`);
                        console.log(JSON.stringify(rows));
                    }} finally {{
                        await pool.end();
                    }}
                }})();
            '''],
            capture_output=True,
            text=True,
            timeout=30
        )
        if result.returncode == 0:
            return json.loads(result.stdout)
        else:
            print(f"SQL Error: {result.stderr}", file=sys.stderr)
            return []
    except Exception as e:
        print(f"Error running SQL: {e}", file=sys.stderr)
        return []

def analyze_positions():
    """Main analysis function"""
    print("=" * 80)
    print("📊 POSITION ANALYSIS REPORT")
    print("=" * 80)
    print(f"Generated at: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}\n")
    
    # 1. Get open positions from database
    print("1️⃣  Fetching open positions from database...")
    db_positions_query = """
        SELECT 
            p.id,
            p.bot_id,
            p.strategy_id,
            p.symbol,
            p.side,
            p.entry_price,
            p.amount,
            p.quantity,
            p.take_profit_price,
            p.stop_loss_price,
            p.pnl,
            p.pnl_percent,
            p.status,
            p.opened_at,
            p.created_at,
            b.exchange,
            b.binance_testnet,
            s.is_reverse_strategy,
            s.oc_threshold,
            s.extend,
            s.take_profit,
            s.stoploss
        FROM positions p
        LEFT JOIN bots b ON p.bot_id = b.id
        LEFT JOIN strategies s ON p.strategy_id = s.id
        WHERE p.status = 'open'
        ORDER BY p.opened_at DESC
    """
    
    db_positions = run_sql_query(db_positions_query)
    print(f"   Found {len(db_positions)} open positions in database\n")
    
    # 2. Analyze by exchange
    print("2️⃣  Analyzing by exchange...")
    by_exchange = defaultdict(list)
    for pos in db_positions:
        exchange = pos.get('exchange', 'unknown')
        is_testnet = pos.get('binance_testnet', False)
        key = f"{exchange}{'_testnet' if is_testnet else ''}"
        by_exchange[key].append(pos)
    
    for exchange, positions in by_exchange.items():
        print(f"   {exchange}: {len(positions)} positions")
    print()
    
    # 3. Analyze losing positions
    print("3️⃣  Analyzing losing positions...")
    losing_positions = [p for p in db_positions if p.get('pnl', 0) < 0]
    print(f"   Total losing positions: {len(losing_positions)}")
    
    if losing_positions:
        total_loss = sum(p.get('pnl', 0) for p in losing_positions)
        avg_loss = total_loss / len(losing_positions) if losing_positions else 0
        max_loss = min(p.get('pnl', 0) for p in losing_positions)
        
        print(f"   Total loss: {total_loss:.2f} USDT")
        print(f"   Average loss: {avg_loss:.2f} USDT")
        print(f"   Max loss: {max_loss:.2f} USDT")
        
        # Analyze by reason
        print("\n   Top losing positions:")
        sorted_losing = sorted(losing_positions, key=lambda x: x.get('pnl', 0))[:10]
        for i, pos in enumerate(sorted_losing, 1):
            print(f"   {i}. {pos.get('symbol')} {pos.get('side')} | "
                  f"Entry: {pos.get('entry_price', 0):.8f} | "
                  f"PnL: {pos.get('pnl', 0):.2f} USDT ({pos.get('pnl_percent', 0):.2f}%) | "
                  f"SL: {pos.get('stop_loss_price', 0) or 'N/A'}")
    print()
    
    # 4. Analyze winning positions
    print("4️⃣  Analyzing winning positions...")
    winning_positions = [p for p in db_positions if p.get('pnl', 0) > 0]
    print(f"   Total winning positions: {len(winning_positions)}")
    
    if winning_positions:
        total_profit = sum(p.get('pnl', 0) for p in winning_positions)
        avg_profit = total_profit / len(winning_positions) if winning_positions else 0
        max_profit = max(p.get('pnl', 0) for p in winning_positions)
        
        print(f"   Total profit: {total_profit:.2f} USDT")
        print(f"   Average profit: {avg_profit:.2f} USDT")
        print(f"   Max profit: {max_profit:.2f} USDT")
    print()
    
    # 5. Analyze by strategy type
    print("5️⃣  Analyzing by strategy type...")
    by_strategy_type = defaultdict(lambda: {'total': 0, 'winning': 0, 'losing': 0, 'total_pnl': 0})
    
    for pos in db_positions:
        is_reverse = pos.get('is_reverse_strategy', 0)
        strategy_type = 'COUNTER_TREND' if is_reverse else 'FOLLOWING_TREND'
        by_strategy_type[strategy_type]['total'] += 1
        pnl = pos.get('pnl', 0)
        by_strategy_type[strategy_type]['total_pnl'] += pnl
        if pnl > 0:
            by_strategy_type[strategy_type]['winning'] += 1
        elif pnl < 0:
            by_strategy_type[strategy_type]['losing'] += 1
    
    for strategy_type, stats in by_strategy_type.items():
        win_rate = (stats['winning'] / stats['total'] * 100) if stats['total'] > 0 else 0
        print(f"   {strategy_type}:")
        print(f"      Total: {stats['total']} | Winning: {stats['winning']} | Losing: {stats['losing']}")
        print(f"      Win Rate: {win_rate:.2f}% | Total PnL: {stats['total_pnl']:.2f} USDT")
    print()
    
    # 6. Analyze positions without SL
    print("6️⃣  Analyzing positions without Stop Loss...")
    no_sl_positions = [p for p in db_positions if not p.get('stop_loss_price') or p.get('stop_loss_price') == 0]
    print(f"   Positions without SL: {len(no_sl_positions)}")
    if no_sl_positions:
        print("   ⚠️  WARNING: These positions are at risk!")
        for pos in no_sl_positions[:5]:
            print(f"      - {pos.get('symbol')} {pos.get('side')} | "
                  f"Entry: {pos.get('entry_price', 0):.8f} | "
                  f"PnL: {pos.get('pnl', 0):.2f} USDT")
    print()
    
    # 7. Analyze positions without TP
    print("7️⃣  Analyzing positions without Take Profit...")
    no_tp_positions = [p for p in db_positions if not p.get('take_profit_price') or p.get('take_profit_price') == 0]
    print(f"   Positions without TP: {len(no_tp_positions)}")
    if no_tp_positions:
        print("   ⚠️  WARNING: These positions may not exit at profit target!")
        for pos in no_tp_positions[:5]:
            print(f"      - {pos.get('symbol')} {pos.get('side')} | "
                  f"Entry: {pos.get('entry_price', 0):.8f} | "
                  f"PnL: {pos.get('pnl', 0):.2f} USDT")
    print()
    
    # 8. Analyze by time opened
    print("8️⃣  Analyzing by time opened...")
    now = datetime.now()
    recent_positions = []
    old_positions = []
    
    for pos in db_positions:
        opened_at_str = pos.get('opened_at')
        if opened_at_str:
            try:
                opened_at = datetime.fromisoformat(str(opened_at_str).replace('Z', '+00:00'))
                hours_open = (now - opened_at.replace(tzinfo=None)).total_seconds() / 3600
                if hours_open < 24:
                    recent_positions.append((pos, hours_open))
                else:
                    old_positions.append((pos, hours_open))
            except:
                pass
    
    print(f"   Positions opened < 24h: {len(recent_positions)}")
    print(f"   Positions opened >= 24h: {len(old_positions)}")
    
    if old_positions:
        print("   ⚠️  WARNING: Old positions that may need review:")
        sorted_old = sorted(old_positions, key=lambda x: x[1], reverse=True)[:5]
        for pos, hours in sorted_old:
            print(f"      - {pos.get('symbol')} {pos.get('side')} | "
                  f"Open for {hours:.1f}h | "
                  f"PnL: {pos.get('pnl', 0):.2f} USDT")
    print()
    
    # 9. Summary
    print("=" * 80)
    print("📊 SUMMARY")
    print("=" * 80)
    total_pnl = sum(p.get('pnl', 0) for p in db_positions)
    print(f"Total Open Positions: {len(db_positions)}")
    print(f"Winning: {len(winning_positions)} | Losing: {len(losing_positions)}")
    print(f"Total PnL: {total_pnl:.2f} USDT")
    print(f"Win Rate: {(len(winning_positions) / len(db_positions) * 100) if db_positions else 0:.2f}%")
    print(f"Positions without SL: {len(no_sl_positions)}")
    print(f"Positions without TP: {len(no_tp_positions)}")
    print()
    
    # 10. Recommendations
    print("=" * 80)
    print("💡 RECOMMENDATIONS")
    print("=" * 80)
    
    if len(no_sl_positions) > 0:
        print("⚠️  CRITICAL: Some positions don't have Stop Loss!")
        print("   → Check PositionMonitor logs for SL placement errors")
    
    if len(no_tp_positions) > 0:
        print("⚠️  WARNING: Some positions don't have Take Profit!")
        print("   → Check PositionMonitor logs for TP placement errors")
    
    if len(losing_positions) > len(winning_positions):
        print("⚠️  WARNING: More losing positions than winning!")
        print("   → Review entry conditions and trend filters")
        print("   → Check if SL is being hit too early")
    
    if len(old_positions) > 0:
        print("⚠️  INFO: Some positions are open for > 24h")
        print("   → Review if these should still be open")
        print("   → Check trailing TP logic")
    
    print()
    print("=" * 80)

if __name__ == '__main__':
    analyze_positions()


