-- Migration: Add Binance support and exchange column to candles table
-- Run this migration to add Binance exchange support and separate candles by exchange

USE bot_oc;

-- Step 1: Add 'binance' to exchange enum in bots table
ALTER TABLE bots MODIFY COLUMN exchange ENUM('mexc', 'gate', 'binance') NOT NULL;

-- Step 2: Add exchange column to candles table
ALTER TABLE candles ADD COLUMN exchange VARCHAR(20) NOT NULL DEFAULT 'mexc' AFTER symbol;

-- Step 3: Update existing candles to have exchange based on strategy's bot
-- This assumes all existing candles belong to strategies that have bots
-- For existing data, we'll set a default and let the system update it
UPDATE candles c
INNER JOIN strategies s ON c.symbol = s.symbol AND c.`interval` = s.`interval`
INNER JOIN bots b ON s.bot_id = b.id
SET c.exchange = b.exchange;

-- Step 4: Drop old unique constraint
ALTER TABLE candles DROP INDEX unique_candle;

-- Step 5: Add new unique constraint including exchange
ALTER TABLE candles ADD UNIQUE KEY unique_candle (exchange, symbol, `interval`, open_time);

-- Step 6: Add index for exchange
ALTER TABLE candles ADD INDEX idx_exchange (exchange);
ALTER TABLE candles ADD INDEX idx_exchange_symbol_interval (exchange, symbol, `interval`);

-- Step 7: Remove default value after migration (optional, for new inserts)
ALTER TABLE candles MODIFY COLUMN exchange VARCHAR(20) NOT NULL;

