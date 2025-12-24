# Log Level Configuration Guide

## Overview

The bot supports dynamic log level configuration through `app_configs` table. This allows you to change logging verbosity without modifying code or environment variables.

---

## Current Configuration

**Check current log level:**
```bash
node scripts/get_log_level.js
```

**Output:**
```
Current Level: info
Console Output: info
combined.log: info
error.log: error (always)
```

---

## Log Levels

| Level | Description | Use Case |
|-------|-------------|----------|
| `error` | Only errors | Production (minimal logs) |
| `warn` | Warnings + errors | Production (recommended) |
| `info` | General info + warnings + errors | Development/Testing (default) |
| `debug` | Detailed debugging | Troubleshooting |
| `verbose` | Very detailed | Deep debugging |

---

## Change Log Level

### Method 1: Using Script (Recommended)

```bash
# Set to info (default)
node scripts/set_log_level.js info

# Set to debug (detailed)
node scripts/set_log_level.js debug

# Set to warn (production)
node scripts/set_log_level.js warn
```

The script will:
1. Update `app_configs` table
2. Restart bot automatically
3. Show confirmation

### Method 2: Manual Database Update

```sql
-- Update log level
UPDATE app_configs 
SET config_value = 'debug' 
WHERE config_key = 'LOG_LEVEL';

-- Restart bot
pm2 restart bot-oc
```

### Method 3: Environment Variable (Legacy)

```bash
# Set in .env
LOG_LEVEL=debug

# Or export
export LOG_LEVEL=debug

# Restart bot
pm2 restart bot-oc
```

**Note:** app_configs takes priority over environment variables.

---

## Log Files

### File Structure

```
logs/
├── combined.log      # Info/Debug logs (based on LOG_LEVEL)
├── error.log         # Error logs only
├── exceptions.log    # Uncaught exceptions
└── rejections.log    # Unhandled promise rejections
```

### File Rotation

- **Max Size:** 10 MB per file (configurable via `LOG_FILE_MAX_SIZE_MB`)
- **Max Files:** 5 rotated files (configurable via `LOG_FILE_MAX_FILES`)
- **Naming:** `combined.log`, `combined.log.1`, `combined.log.2`, etc.

---

## Viewing Logs

### Real-time Logs

```bash
# PM2 logs (console output)
pm2 logs bot-oc

# Combined log file
tail -f logs/combined.log

# Error log file
tail -f logs/error.log

# Pretty print JSON logs
tail -f logs/combined.log | jq -r '"\(.timestamp) [\(.level)] \(.message)"'
```

### Search Logs

```bash
# Search for specific pattern
grep "TP Trail" logs/combined.log

# Search with context
grep -A 5 -B 5 "error" logs/combined.log

# Count occurrences
grep -c "Signal detected" logs/combined.log

# Filter by level
grep '"level":"info"' logs/combined.log
grep '"level":"error"' logs/combined.log
```

---

## Log Level Impact

### `error` Level
- **Logs:** Only errors
- **File Size:** Very small (~1-5 MB/day)
- **Performance:** Best
- **Use:** Production (stable)

### `warn` Level
- **Logs:** Warnings + errors
- **File Size:** Small (~5-20 MB/day)
- **Performance:** Good
- **Use:** Production (recommended)

### `info` Level (Default)
- **Logs:** Info + warnings + errors
- **File Size:** Medium (~50-200 MB/day)
- **Performance:** Acceptable
- **Use:** Development/Testing

### `debug` Level
- **Logs:** Debug + info + warnings + errors
- **File Size:** Large (~200-500 MB/day)
- **Performance:** Slower
- **Use:** Troubleshooting

### `verbose` Level
- **Logs:** Everything
- **File Size:** Very large (>500 MB/day)
- **Performance:** Slowest
- **Use:** Deep debugging only

---

## Best Practices

### Development
```bash
node scripts/set_log_level.js info
```

### Production
```bash
node scripts/set_log_level.js warn
```

### Troubleshooting
```bash
# Enable debug temporarily
node scripts/set_log_level.js debug

# Reproduce issue
# ...

# Restore to normal
node scripts/set_log_level.js warn
```

### Performance Optimization
```bash
# If bot is slow or memory usage is high
node scripts/set_log_level.js warn

# Reduce file size
UPDATE app_configs SET config_value = '5' WHERE config_key = 'LOG_FILE_MAX_SIZE_MB';
UPDATE app_configs SET config_value = '3' WHERE config_key = 'LOG_FILE_MAX_FILES';
pm2 restart bot-oc
```

---

## Monitoring

### Check Log File Sizes

```bash
ls -lh logs/
du -sh logs/
```

### Clean Old Logs

```bash
# Remove old rotated logs
rm logs/*.log.[1-9]

# Keep only latest
rm logs/combined.log.*
rm logs/error.log.*
```

### Archive Logs

```bash
# Archive before cleaning
tar -czf logs-backup-$(date +%Y%m%d).tar.gz logs/
mv logs-backup-*.tar.gz ~/backups/
```

---

## Troubleshooting

### Logs Not Appearing

1. Check log level:
   ```bash
   node scripts/get_log_level.js
   ```

2. Check file permissions:
   ```bash
   ls -la logs/
   ```

3. Check disk space:
   ```bash
   df -h
   ```

4. Restart bot:
   ```bash
   pm2 restart bot-oc
   ```

### Too Many Logs

1. Reduce log level:
   ```bash
   node scripts/set_log_level.js warn
   ```

2. Reduce file size:
   ```sql
   UPDATE app_configs SET config_value = '5' WHERE config_key = 'LOG_FILE_MAX_SIZE_MB';
   ```

3. Clean old logs:
   ```bash
   rm logs/*.log.[1-9]
   ```

---

## Configuration Reference

### app_configs Table

```sql
SELECT * FROM app_configs WHERE config_key LIKE 'LOG%';
```

| Key | Default | Description |
|-----|---------|-------------|
| `LOG_LEVEL` | `info` | Log verbosity level |
| `LOG_FILE_MAX_SIZE_MB` | `10` | Max file size before rotation |
| `LOG_FILE_MAX_FILES` | `5` | Number of rotated files to keep |

---

## Examples

### Enable Debug for TP Trailing

```bash
# Enable debug
node scripts/set_log_level.js debug

# Watch TP trailing logs
tail -f logs/combined.log | grep "TP Trail"

# Restore
node scripts/set_log_level.js info
```

### Monitor Binance Alerts

```bash
# Ensure info level
node scripts/set_log_level.js info

# Watch for alerts
tail -f logs/combined.log | grep -E "OcTick|Alert|Signal"
```

### Production Monitoring

```bash
# Set to warn for production
node scripts/set_log_level.js warn

# Monitor errors only
tail -f logs/error.log
```

---

## Summary

- ✅ Log level configurable via `app_configs`
- ✅ Change without code modification
- ✅ Auto-restart with new level
- ✅ Scripts for easy management
- ✅ File rotation enabled

**Quick Commands:**
```bash
node scripts/get_log_level.js           # Check current level
node scripts/set_log_level.js info      # Set to info
node scripts/set_log_level.js debug     # Set to debug
tail -f logs/combined.log               # Watch logs
```

