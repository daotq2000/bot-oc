#!/bin/bash

# Monitor bot signals and orders
# Usage: ./monitor_signals.sh

LOG_FILE="/tmp/bot-oc-backend.log"

echo "🔍 Monitoring Bot Signals and Orders..."
echo "=========================================="
echo ""

# Function to format log line
format_log() {
    local line="$1"
    local timestamp=$(echo "$line" | grep -oP '\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}' | head -1)
    local level=$(echo "$line" | grep -oP '\[(info|error|warn|debug)\]' | head -1)
    local message=$(echo "$line" | sed 's/.*\[\(info\|error\|warn\|debug\)\]: //')
    
    case "$level" in
        *info*)
            echo "✅ [$timestamp] $message"
            ;;
        *error*)
            echo "❌ [$timestamp] $message"
            ;;
        *warn*)
            echo "⚠️  [$timestamp] $message"
            ;;
        *)
            echo "ℹ️  [$timestamp] $message"
            ;;
    esac
}

# Monitor for signals and orders
tail -f "$LOG_FILE" 2>/dev/null | while read line; do
    # Check for signal detection
    if echo "$line" | grep -qE "Signal detected|Signal.*OC.*[1-9]\.[0-9]+%|OC.*-[1-9]\.[0-9]+%"; then
        format_log "$line"
    fi
    
    # Check for order execution
    if echo "$line" | grep -qE "Position opened|Order created|executeSignal|Failed to execute"; then
        format_log "$line"
    fi
    
    # Check for high OC values (potential signals)
    if echo "$line" | grep -qE "OC.*[1-9]\.[0-9]+%|OC.*-[1-9]\.[0-9]+%"; then
        format_log "$line"
    fi
done

