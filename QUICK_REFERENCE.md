# Symbol Filters - Quick Reference

## 🚀 Quick Start

### Populate Symbol Filters
```bash
npm run populate-filters
```

### Start Application (Auto-loads Filters)
```bash
npm start
```

## 📊 What Gets Populated

| Field | Example | Purpose |
|-------|---------|---------|
| `symbol` | BTCUSDT | Trading pair identifier |
| `tick_size` | 0.10 | Price precision (decimal places) |
| `step_size` | 0.001 | Quantity precision (decimal places) |
| `min_notional` | 100 | Minimum order value in USDT |

## 💻 Usage Examples

### Get Filters for a Symbol
```javascript
import { exchangeInfoService } from './services/ExchangeInfoService.js';

const filters = exchangeInfoService.getFilters('BTCUSDT');
console.log(filters);
// Output: { tickSize: '0.10', stepSize: '0.001', minNotional: '100' }
```

### Format Price According to Precision
```javascript
import { BinanceDirectClient } from './services/BinanceDirectClient.js';

const client = new BinanceDirectClient('', '', false);
const roundedPrice = client.roundPrice(45678.456, '0.10');
// Result: 45678.50
```

### Format Quantity According to Precision
```javascript
import { BinanceDirectClient } from './services/BinanceDirectClient.js';

const client = new BinanceDirectClient('', '', false);
const formattedQty = client.formatQuantity(1.23456789, '0.001');
// Result: 1.234
```

## 🗄️ Database Queries

### Count Total Symbols
```sql
SELECT COUNT(*) as total FROM symbol_filters;
```

### Find Symbol Filters
```sql
SELECT * FROM symbol_filters WHERE symbol = 'BTCUSDT';
```

### View All Symbols
```sql
SELECT symbol, tick_size, step_size, min_notional FROM symbol_filters LIMIT 20;
```

### Update Specific Symbol
```sql
UPDATE symbol_filters 
SET tick_size = '0.10', step_size = '0.001' 
WHERE symbol = 'BTCUSDT';
```

## 📋 Checklist

- [ ] Run `npm run populate-filters` to populate the table
- [ ] Verify data with `SELECT COUNT(*) FROM symbol_filters;`
- [ ] Start application with `npm start`
- [ ] Check logs for "Loaded X symbol filters into cache"
- [ ] Test with a trading operation

## 🔗 Related Files

| File | Purpose |
|------|---------|
| `src/scripts/populateSymbolFilters.js` | Population script |
| `src/services/ExchangeInfoService.js` | Filter service |
| `src/models/SymbolFilter.js` | Database model |
| `src/services/BinanceDirectClient.js` | Binance API client |
| `SYMBOL_FILTERS_GUIDE.md` | Full documentation |

## ⚡ Performance

| Operation | Time |
|-----------|------|
| Fetch from API | 2-5 seconds |
| Load into cache | 100-200ms |
| Database lookup | O(1) |
| Cache lookup | O(1) |

## 🆘 Common Issues

| Issue | Solution |
|-------|----------|
| "Failed to fetch exchange info" | Check internet connection |
| "No filters found for symbol" | Run `npm run populate-filters` |
| "Database connection failed" | Check MySQL is running |
| "Symbol not found" | Verify symbol name (e.g., BTCUSDT) |

## 📞 Support

For detailed information, see:
- [SYMBOL_FILTERS_GUIDE.md](./SYMBOL_FILTERS_GUIDE.md) - Full documentation
- [IMPLEMENTATION_SUMMARY.md](./IMPLEMENTATION_SUMMARY.md) - Technical details

