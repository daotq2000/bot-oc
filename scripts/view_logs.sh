#!/bin/bash

# View logs script
# Usage: ./scripts/view_logs.sh [level] [file]
#   level: all, error, warn, info, debug (default: all)
#   file: combined, error, orders (default: combined)

LOG_DIR="logs"
LEVEL=${1:-"all"}
FILE=${2:-"combined"}

# Map file names
case $FILE in
  combined)
    LOG_FILE="$LOG_DIR/combined.log"
    ;;
  error)
    LOG_FILE="$LOG_DIR/error.log"
    ;;
  orders)
    LOG_FILE="$LOG_DIR/orders.log"
    ;;
  orders-error)
    LOG_FILE="$LOG_DIR/orders-error.log"
    ;;
  *)
    LOG_FILE="$LOG_DIR/$FILE.log"
    ;;
esac

# Check if file exists
if [ ! -f "$LOG_FILE" ]; then
  echo "Error: Log file not found: $LOG_FILE"
  exit 1
fi

# Filter by level
case $LEVEL in
  error)
    echo "Viewing errors from $LOG_FILE (Ctrl+C to exit)..."
    tail -f "$LOG_FILE" | grep --line-buffered '"level":"error"'
    ;;
  warn)
    echo "Viewing warnings from $LOG_FILE (Ctrl+C to exit)..."
    tail -f "$LOG_FILE" | grep --line-buffered '"level":"warn"'
    ;;
  info)
    echo "Viewing info from $LOG_FILE (Ctrl+C to exit)..."
    tail -f "$LOG_FILE" | grep --line-buffered '"level":"info"'
    ;;
  debug)
    echo "Viewing debug from $LOG_FILE (Ctrl+C to exit)..."
    tail -f "$LOG_FILE" | grep --line-buffered '"level":"debug"'
    ;;
  *)
    echo "Viewing all logs from $LOG_FILE (Ctrl+C to exit)..."
    tail -f "$LOG_FILE"
    ;;
esac

