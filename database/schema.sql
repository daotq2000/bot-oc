-- Bot Trading System Database Schema

CREATE DATABASE IF NOT EXISTS bot_oc CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE bot_oc;

-- Bảng bots: Quản lý thông tin bot và exchange credentials
CREATE TABLE IF NOT EXISTS bots (
  id INT PRIMARY KEY AUTO_INCREMENT,
  bot_name VARCHAR(100) NOT NULL,
  exchange ENUM('mexc', 'gate', 'binance') NOT NULL,
  uid VARCHAR(100),
  access_key VARCHAR(255) NOT NULL,
  secret_key VARCHAR(255) NOT NULL,
  proxy VARCHAR(255), -- format: IP:PORT:USER:PASS
  telegram_chat_id VARCHAR(100),
  future_balance_target DECIMAL(10,2) DEFAULT 20.00,
  spot_transfer_threshold DECIMAL(10,2) DEFAULT 10.00,
  transfer_frequency INT DEFAULT 15, -- minutes
  withdraw_enabled BOOLEAN DEFAULT FALSE,
  withdraw_address VARCHAR(100),
  withdraw_network VARCHAR(20) DEFAULT 'BEP20',
  spot_balance_threshold DECIMAL(10,2) DEFAULT 10.00,
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_exchange (exchange),
  INDEX idx_is_active (is_active)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng strategies: Chiến lược trading cho mỗi bot
CREATE TABLE IF NOT EXISTS strategies (
  id INT PRIMARY KEY AUTO_INCREMENT,
  bot_id INT NOT NULL,
  symbol VARCHAR(20) NOT NULL, -- BTC/USDT
  trade_type ENUM('long', 'short', 'both') DEFAULT 'both',
  `interval` VARCHAR(5) NOT NULL, -- 1m, 3m, 5m, 15m, 30m, 1h
  oc DECIMAL(5,2) NOT NULL, -- Open-Close percentage threshold
  extend DECIMAL(5,2) NOT NULL, -- Entry trigger percentage
  amount DECIMAL(10,2) NOT NULL, -- Position size in USDT
  take_profit DECIMAL(5,2) NOT NULL, -- TP percentage (stored as 40 for 4%)
  reduce DECIMAL(5,2) NOT NULL, -- Initial reduce speed
  up_reduce DECIMAL(5,2) NOT NULL, -- Reduce acceleration per minute
  `ignore` DECIMAL(5,2) NOT NULL, -- Ignore threshold for opposite candles
  is_active BOOLEAN DEFAULT TRUE,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  UNIQUE KEY unique_strategy_params (symbol, trade_type, `interval`, oc),
  INDEX idx_bot_id (bot_id),
  INDEX idx_is_active (is_active),
  INDEX idx_symbol (symbol)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng positions: Theo dõi các vị thế đang mở
CREATE TABLE IF NOT EXISTS positions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  strategy_id INT NOT NULL,
  order_id VARCHAR(100) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  side ENUM('long', 'short') NOT NULL,
  entry_price DECIMAL(20,8) NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  take_profit_price DECIMAL(20,8) NOT NULL,
  stop_loss_price DECIMAL(20,8),
  current_reduce DECIMAL(5,2),
  minutes_elapsed INT DEFAULT 0,
  status ENUM('open', 'closed', 'cancelled') DEFAULT 'open',
  pnl DECIMAL(10,4),
  close_price DECIMAL(20,8),
  close_reason VARCHAR(50), -- tp_hit, sl_hit, manual, candle_end
  opened_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  closed_at TIMESTAMP,
  FOREIGN KEY (strategy_id) REFERENCES strategies(id) ON DELETE CASCADE,
  INDEX idx_status (status),
  INDEX idx_symbol (symbol),
  INDEX idx_strategy_id (strategy_id),
  INDEX idx_opened_at (opened_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng candles: Lưu trữ dữ liệu nến (phân biệt theo exchange)
CREATE TABLE IF NOT EXISTS candles (
  id INT PRIMARY KEY AUTO_INCREMENT,
  exchange VARCHAR(20) NOT NULL, -- mexc, gate, binance
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(5) NOT NULL,
  open_time BIGINT NOT NULL,
  open DECIMAL(20,8) NOT NULL,
  high DECIMAL(20,8) NOT NULL,
  low DECIMAL(20,8) NOT NULL,
  close DECIMAL(20,8) NOT NULL,
  volume DECIMAL(20,8) NOT NULL,
  close_time BIGINT NOT NULL,
  UNIQUE KEY unique_candle (exchange, symbol, `interval`, open_time),
  INDEX idx_exchange (exchange),
  INDEX idx_symbol_interval (symbol, `interval`),
  INDEX idx_exchange_symbol_interval (exchange, symbol, `interval`),
  INDEX idx_open_time (open_time),
  INDEX idx_close_time (close_time)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- warmup_runs: Audit indicator warmup runs (for IndicatorWarmup child process)
CREATE TABLE IF NOT EXISTS warmup_runs (
  id BIGINT PRIMARY KEY AUTO_INCREMENT,
  worker VARCHAR(50) NOT NULL,
  exchange VARCHAR(20) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(5) NOT NULL,
  status ENUM('started', 'succeeded', 'failed') NOT NULL,
  details_json JSON NULL,
  started_at TIMESTAMP NULL,
  finished_at TIMESTAMP NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  INDEX idx_warmup_runs_worker_created (worker, created_at),
  INDEX idx_warmup_runs_exchange_symbol_interval (exchange, symbol, `interval`, created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng transactions: Lưu lịch sử transfer và withdraw
CREATE TABLE IF NOT EXISTS transactions (
  id INT PRIMARY KEY AUTO_INCREMENT,
  bot_id INT NOT NULL,
  type ENUM('spot_to_future', 'future_to_spot', 'withdraw') NOT NULL,
  amount DECIMAL(10,2) NOT NULL,
  status ENUM('pending', 'success', 'failed') DEFAULT 'pending',
  error_message TEXT,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (bot_id) REFERENCES bots(id) ON DELETE CASCADE,
  INDEX idx_bot_id (bot_id),
  INDEX idx_created_at (created_at),
  INDEX idx_status (status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
