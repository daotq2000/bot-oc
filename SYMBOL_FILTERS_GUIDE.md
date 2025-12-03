# Symbol Filters Population Guide

## Overview

The `symbol_filters` table stores precision information (tick_size, step_size, min_notional) for each trading symbol on Binance. This data is crucial for:

- **Price Precision**: Ensuring prices are rounded to the correct decimal places (tick_size)
- **Quantity Precision**: Ensuring quantities are formatted correctly (step_size)
- **Minimum Notional**: Ensuring orders meet the minimum notional value requirement

## Database Schema

The `symbol_filters` table has the following structure:

```sql
CREATE TABLE symbol_filters (
  id INT PRIMARY KEY AUTO_INCREMENT,
  exchange VARCHAR(255) NOT NULL,
  symbol VARCHAR(255) NOT NULL,
  tick_size VARCHAR(255) NOT NULL,
  step_size VARCHAR(255) NOT NULL,
  min_notional VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  UNIQUE KEY idx_exchange_symbol (exchange, symbol)
);
```

## How to Populate Symbol Filters

### Method 1: Using the NPM Script (Recommended)

Run the population script directly:

```bash
npm run populate-filters
```

This script will:
1. Connect to Binance API (no authentication required)
2. Fetch exchange information for all trading symbols
3. Extract precision data (tick_size, step_size, min_notional)
4. Insert/update the data in the `symbol_filters` table
5. Display progress and results

**Example Output:**
```
🚀 Starting to populate symbol_filters table...
📡 Fetching exchange info from Binance API...
📊 Found 1234 symbols on Binance
✅ Extracted filters for 1200 symbols (skipped 34)
💾 Saving 1200 symbol filters to database...
✅ Successfully saved 1200 symbol filters to database!
✨ Symbol filters population completed successfully!
```

### Method 2: Automatic on Application Startup

The symbol filters are automatically loaded and updated when the application starts:

1. **Load from Database**: Existing filters are loaded into memory cache
2. **Update from API**: Fresh data is fetched from Binance API (non-blocking)

This happens in `src/app.js`:

```javascript
// Initialize exchange info service (load symbol filters)
logger.info('Initializing exchange info service...');
await exchangeInfoService.loadFiltersFromDB();

// Update symbol filters from Binance API (async, don't wait)
exchangeInfoService.updateFiltersFromExchange()
  .catch(error => logger.error('Failed to update symbol filters from Binance:', error));
```

### Method 3: Programmatic Usage

You can also populate filters programmatically:

```javascript
import { exchangeInfoService } from './services/ExchangeInfoService.js';

// Update filters from Binance API
await exchangeInfoService.updateFiltersFromExchange();

// Load filters from database into cache
await exchangeInfoService.loadFiltersFromDB();

// Get filters for a specific symbol
const filters = exchangeInfoService.getFilters('BTCUSDT');
// Returns: { tickSize: '0.10', stepSize: '0.001', minNotional: '100' }
```

## Using Symbol Filters in Your Code

The `ExchangeInfoService` provides a singleton instance that caches all symbol filters:

```javascript
import { exchangeInfoService } from './services/ExchangeInfoService.js';

// Get filters for a symbol
const filters = exchangeInfoService.getFilters('ETHUSDT');

if (filters) {
  console.log(`Tick Size: ${filters.tickSize}`);
  console.log(`Step Size: ${filters.stepSize}`);
  console.log(`Min Notional: ${filters.minNotional}`);
}
```

## Integration with BinanceDirectClient

The `BinanceDirectClient` uses symbol filters for price and quantity formatting:

```javascript
import { BinanceDirectClient } from './services/BinanceDirectClient.js';

const client = new BinanceDirectClient(apiKey, secretKey);

// These methods use the symbol filters internally
const roundedPrice = client.roundPrice(100.456, '0.10');  // 100.50
const formattedQty = client.formatQuantity(1.2345, '0.001');  // 1.234
```

## Data Flow

```
┌─────────────────────────────────────────────────────────────┐
│                    Application Startup                      │
└────────────────────────┬────────────────────────────────────┘
                         │
                         ▼
        ┌────────────────────────────────────┐
        │  Load from Database (Synchronous)  │
        │  - Populate in-memory cache        │
        │  - Ready for immediate use         │
        └────────────────────┬───────────────┘
                             │
                             ▼
        ┌────────────────────────────────────┐
        │  Update from Binance API (Async)   │
        │  - Fetch latest exchange info      │
        │  - Update database                 │
        │  - Refresh cache                   │
        └────────────────────────────────────┘
```

## Troubleshooting

### Issue: "Failed to fetch exchange info from Binance"

**Causes:**
- Network connectivity issue
- Binance API is down
- Rate limiting (too many requests)

**Solution:**
- Check your internet connection
- Wait a few minutes and try again
- Verify Binance API status at https://status.binance.com

### Issue: "No filters found for symbol XXXUSDT"

**Causes:**
- Symbol filters not yet populated
- Symbol is not trading on Binance
- Symbol name is incorrect

**Solution:**
- Run `npm run populate-filters` to populate the table
- Verify the symbol exists on Binance
- Check the symbol name format (should be uppercase, e.g., BTCUSDT)

### Issue: "Database connection failed"

**Causes:**
- Database is not running
- Connection credentials are incorrect
- Database doesn't exist

**Solution:**
- Ensure MySQL/MariaDB is running
- Check `.env` file for correct database credentials
- Run migrations: `npm run migrate`

## Performance Considerations

- **Initial Load**: Loading ~1200 symbols into memory takes ~100-200ms
- **Cache Hit**: Subsequent lookups are O(1) operations
- **API Update**: Fetching from Binance API takes ~2-5 seconds (non-blocking)
- **Database Upsert**: Bulk inserting 1200 records takes ~500-1000ms

## Maintenance

### Regular Updates

The symbol filters are automatically updated on application startup. For manual updates:

```bash
npm run populate-filters
```

### Database Cleanup

To remove old or unused symbol filters:

```sql
-- Remove filters for non-trading symbols
DELETE FROM symbol_filters 
WHERE symbol NOT IN (
  SELECT symbol FROM symbol_filters 
  WHERE updated_at > DATE_SUB(NOW(), INTERVAL 7 DAY)
);

-- View all symbols in the table
SELECT COUNT(*) as total_symbols FROM symbol_filters;
SELECT * FROM symbol_filters LIMIT 10;
```

## Related Files

- **Model**: `src/models/SymbolFilter.js`
- **Service**: `src/services/ExchangeInfoService.js`
- **Client**: `src/services/BinanceDirectClient.js`
- **Script**: `src/scripts/populateSymbolFilters.js`
- **Migration**: `migrations/20251202164500-create-symbol-filters.cjs`

## API Reference

### ExchangeInfoService

#### `async updateFiltersFromExchange()`
Fetches all symbol filters from Binance API and updates the database.

#### `async loadFiltersFromDB()`
Loads all symbol filters from the database into the in-memory cache.

#### `getFilters(symbol)`
Returns the filters for a specific symbol from the cache.
- **Parameters**: `symbol` (string) - Trading symbol (e.g., BTCUSDT)
- **Returns**: Object with `tickSize`, `stepSize`, `minNotional` or `null` if not found

## Examples

### Example 1: Format a Price

```javascript
import { exchangeInfoService } from './services/ExchangeInfoService.js';
import { BinanceDirectClient } from './services/BinanceDirectClient.js';

const filters = exchangeInfoService.getFilters('BTCUSDT');
const client = new BinanceDirectClient('', '', false);

const price = 45678.456;
const roundedPrice = client.roundPrice(price, filters.tickSize);
console.log(`Original: ${price}, Rounded: ${roundedPrice}`);
// Output: Original: 45678.456, Rounded: 45678.50
```

### Example 2: Format a Quantity

```javascript
import { exchangeInfoService } from './services/ExchangeInfoService.js';
import { BinanceDirectClient } from './services/BinanceDirectClient.js';

const filters = exchangeInfoService.getFilters('ETHUSDT');
const client = new BinanceDirectClient('', '', false);

const quantity = 1.23456789;
const formattedQty = client.formatQuantity(quantity, filters.stepSize);
console.log(`Original: ${quantity}, Formatted: ${formattedQty}`);
// Output: Original: 1.23456789, Formatted: 1.234
```

### Example 3: Check Minimum Notional

```javascript
import { exchangeInfoService } from './services/ExchangeInfoService.js';

const filters = exchangeInfoService.getFilters('BTCUSDT');
const quantity = 0.001;
const price = 45000;
const notional = quantity * price;

if (notional < parseFloat(filters.minNotional)) {
  console.log(`Order notional ${notional} is below minimum ${filters.minNotional}`);
}
```

## See Also

- [Binance API Documentation](https://binance-docs.github.io/apidocs/)
- [BinanceDirectClient Documentation](./src/services/BinanceDirectClient.js)
- [Database Schema](./database/schema.sql)

