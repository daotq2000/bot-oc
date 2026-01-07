-- Migration: Add price alert configuration table
-- This table stores configuration for price volatility alerts

USE bot_oc;

-- Bảng price_alert_config: Cấu hình cảnh báo biến động giá
CREATE TABLE IF NOT EXISTS price_alert_config (
  id INT PRIMARY KEY AUTO_INCREMENT,
  exchange VARCHAR(20) NOT NULL DEFAULT 'binance', -- mexc, gate, binance
  symbols TEXT NOT NULL, -- JSON array of symbols to monitor, e.g. ["BTC/USDT", "ETH/USDT"]
  intervals TEXT NOT NULL, -- JSON array of intervals, e.g. ["1m", "5m", "15m", "30m"]
  threshold DECIMAL(5,2) NOT NULL DEFAULT 5.00, -- Percentage threshold (e.g. 5.00 = 5%)
  telegram_chat_id VARCHAR(100) NOT NULL, -- Chat ID to send alerts
  is_active BOOLEAN DEFAULT TRUE,
  last_alert_time TIMESTAMP NULL, -- Track last alert time per symbol+interval to avoid spam
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_exchange (exchange),
  INDEX idx_is_active (is_active),
  INDEX idx_telegram_chat_id (telegram_chat_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- Bảng price_alert_history: Lịch sử cảnh báo (optional, để tránh spam)
CREATE TABLE IF NOT EXISTS price_alert_history (
  id INT PRIMARY KEY AUTO_INCREMENT,
  config_id INT NOT NULL,
  exchange VARCHAR(20) NOT NULL,
  symbol VARCHAR(20) NOT NULL,
  `interval` VARCHAR(5) NOT NULL,
  old_price DECIMAL(20,8) NOT NULL,
  new_price DECIMAL(20,8) NOT NULL,
  volatility DECIMAL(5,2) NOT NULL, -- Percentage
  direction ENUM('up', 'down') NOT NULL,
  sent_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (config_id) REFERENCES price_alert_config(id) ON DELETE CASCADE,
  INDEX idx_config_id (config_id),
  INDEX idx_exchange_symbol_interval (exchange, symbol, `interval`),
  INDEX idx_sent_at (sent_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

