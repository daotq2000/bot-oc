#!/bin/bash

# Monitor OC Scanning và Health Check Script
# Usage: ./scripts/monitor-oc-scan.sh [port] [interval_seconds]

PORT=${1:-3000}
INTERVAL=${2:-60}  # Default 60 seconds
LOG_FILE="logs/combined.log"
HEALTH_URL="http://localhost:${PORT}/health/detailed"

echo "🔍 Starting OC Scan Monitor..."
echo "Port: ${PORT}"
echo "Interval: ${INTERVAL}s"
echo "Press Ctrl+C to stop"
echo ""

# Function to check health endpoint
check_health() {
  local response=$(curl -s -w "\n%{http_code}" "${HEALTH_URL}" 2>/dev/null)
  local http_code=$(echo "$response" | tail -n1)
  local body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    if command -v jq &> /dev/null; then
      local status=$(echo "$body" | jq -r '.status')
      local ws_oc=$(echo "$body" | jq '.modules.webSocketOC')
      local ws_mgr=$(echo "$body" | jq '.modules.webSocketManager')
      
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo "📊 Health Status: ${status}"
      echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
      echo ""
      echo "🔌 WebSocket OC Consumer:"
      echo "$ws_oc" | jq -r '
        "  Running: \(.isRunning)",
        "  Ticks Received: \(.stats.ticksReceived)",
        "  Ticks Processed: \(.stats.ticksProcessed)",
        "  Matches Found: \(.stats.matchesFound)",
        "  Queue Size: \(.queueSize)",
        "  Time Since Last Tick: \(if .stats.timeSinceLastTick == null then "never" else (.stats.timeSinceLastTick / 1000 | floor | tostring + "s") end)",
        "  Time Since Last Processed: \(if .stats.timeSinceLastProcessed == null then "never" else (.stats.timeSinceLastProcessed / 1000 | floor | tostring + "s") end)",
        "  Avg Processing Time: \(.stats.avgProcessingTime | floor)ms"
      '
      echo ""
      echo "📡 WebSocket Manager:"
      echo "$ws_mgr" | jq -r '
        "  Connections: \(.connections)/\(.totalConnections)",
        "  Total Streams: \(.totalStreams)",
        "  Tick Queue: \(.tickQueue.size)/\(.tickQueue.maxSize)",
        "  Reconnect Queue: \(.reconnectQueue.size)/\(.reconnectQueue.maxSize)",
        "  Messages Received: \(.messageStats.totalReceived)",
        "  Messages Processed: \(.messageStats.totalProcessed)"
      '
      echo ""
      
      # Check for issues
      local time_since_tick=$(echo "$ws_oc" | jq -r '.stats.timeSinceLastTick // 0')
      local queue_size=$(echo "$ws_oc" | jq -r '.queueSize // 0')
      local ws_connected=$(echo "$ws_mgr" | jq -r '.connections // 0')
      
      if [ "$time_since_tick" != "null" ] && [ "$time_since_tick" -gt 60000 ]; then
        echo "⚠️  WARNING: No ticks received for $((time_since_tick / 1000))s (>60s)"
      fi
      
      if [ "$queue_size" -gt 1000 ]; then
        echo "⚠️  WARNING: Processing queue size is ${queue_size} (>1000)"
      fi
      
      if [ "$ws_connected" -eq 0 ]; then
        echo "⚠️  WARNING: No WebSocket connections active"
      fi
      
      echo ""
    else
      echo "✅ Health check successful (HTTP ${http_code})"
      echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
    fi
  else
    echo "❌ Health check failed (HTTP ${http_code})"
    echo "$body"
  fi
}

# Function to check OC Scan Stats from logs
check_logs() {
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "📋 Recent OC Scan Stats from logs:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  if [ -f "$LOG_FILE" ]; then
    local stats=$(tail -1000 "$LOG_FILE" | grep "OC Scan Stats" | tail -3)
    if [ -n "$stats" ]; then
      echo "$stats" | sed 's/.*OC Scan Stats |/  /'
    else
      echo "  No OC Scan Stats found in recent logs (bot may need restart)"
    fi
  else
    echo "  Log file not found: $LOG_FILE"
  fi
  
  echo ""
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  echo "⚠️  Recent Warnings/Errors:"
  echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
  
  if [ -f "$LOG_FILE" ]; then
    local warnings=$(tail -500 "$LOG_FILE" | grep -E "(WARNING|ERROR|⚠️|❌)" | tail -5)
    if [ -n "$warnings" ]; then
      echo "$warnings" | sed 's/.*"message":"\(.*\)".*/  \1/'
    else
      echo "  No recent warnings"
    fi
  fi
  
  echo ""
}

# Main loop
while true; do
  clear
  echo "🕐 $(date '+%Y-%m-%d %H:%M:%S')"
  echo ""
  
  check_health
  check_logs
  
  echo "Next check in ${INTERVAL}s... (Press Ctrl+C to stop)"
  sleep "$INTERVAL"
done

