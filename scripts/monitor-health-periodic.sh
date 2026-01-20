#!/bin/bash

# Periodic Health Check Script
# Usage: ./scripts/monitor-health-periodic.sh [port] [interval_minutes] [output_file]

PORT=${1:-3000}
INTERVAL_MINUTES=${2:-5}  # Default 5 minutes
OUTPUT_FILE=${3:-"logs/health-monitor.log"}
HEALTH_URL="http://localhost:${PORT}/health/detailed"

echo "🔍 Starting Periodic Health Monitor..."
echo "Port: ${PORT}"
echo "Interval: ${INTERVAL_MINUTES} minutes"
echo "Output: ${OUTPUT_FILE}"
echo "Press Ctrl+C to stop"
echo ""

# Create output directory if needed
mkdir -p "$(dirname "$OUTPUT_FILE")"

# Function to log health check
log_health() {
  local timestamp=$(date '+%Y-%m-%d %H:%M:%S')
  local response=$(curl -s -w "\n%{http_code}" "${HEALTH_URL}" 2>/dev/null)
  local http_code=$(echo "$response" | tail -n1)
  local body=$(echo "$response" | sed '$d')
  
  if [ "$http_code" = "200" ]; then
    if command -v jq &> /dev/null; then
      local status=$(echo "$body" | jq -r '.status')
      local ws_oc=$(echo "$body" | jq '.modules.webSocketOC')
      local ws_mgr=$(echo "$body" | jq '.modules.webSocketManager')
      
      local ticks_received=$(echo "$ws_oc" | jq -r '.stats.ticksReceived // 0')
      local ticks_processed=$(echo "$ws_oc" | jq -r '.stats.ticksProcessed // 0')
      local matches_found=$(echo "$ws_oc" | jq -r '.stats.matchesFound // 0')
      local queue_size=$(echo "$ws_oc" | jq -r '.queueSize // 0')
      local time_since_tick=$(echo "$ws_oc" | jq -r '.stats.timeSinceLastTick // "null"')
      local ws_connected=$(echo "$ws_mgr" | jq -r '.connections // 0')
      local total_streams=$(echo "$ws_mgr" | jq -r '.totalStreams // 0')
      
      # Format time_since_tick
      local time_since_tick_str="never"
      if [ "$time_since_tick" != "null" ] && [ "$time_since_tick" != "0" ]; then
        time_since_tick_str="$((time_since_tick / 1000))s"
      fi
      
      echo "[${timestamp}] Status=${status} | Ticks: received=${ticks_received} processed=${ticks_processed} matches=${matches_found} | Queue: ${queue_size} | WS: ${ws_connected} connections, ${total_streams} streams | LastTick: ${time_since_tick_str}" >> "$OUTPUT_FILE"
      
      # Check for issues and log warnings
      if [ "$time_since_tick" != "null" ] && [ "$time_since_tick" != "0" ] && [ "$time_since_tick" -gt 60000 ]; then
        echo "[${timestamp}] ⚠️  WARNING: No ticks received for $((time_since_tick / 1000))s (>60s)" >> "$OUTPUT_FILE"
      fi
      
      if [ "$queue_size" -gt 1000 ]; then
        echo "[${timestamp}] ⚠️  WARNING: Processing queue size is ${queue_size} (>1000)" >> "$OUTPUT_FILE"
      fi
      
      if [ "$ws_connected" -eq 0 ]; then
        echo "[${timestamp}] ⚠️  WARNING: No WebSocket connections active" >> "$OUTPUT_FILE"
      fi
      
      echo "[${timestamp}] ✅ Health check OK"
    else
      echo "[${timestamp}] ✅ Health check OK (HTTP ${http_code})" >> "$OUTPUT_FILE"
    fi
  else
    echo "[${timestamp}] ❌ Health check failed (HTTP ${http_code})" >> "$OUTPUT_FILE"
    echo "[${timestamp}] ❌ Health check failed (HTTP ${http_code})"
  fi
}

# Main loop
while true; do
  log_health
  sleep $((INTERVAL_MINUTES * 60))
done

