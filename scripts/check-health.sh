#!/bin/bash

# Health check script for bot-oc
# Usage: ./scripts/check-health.sh [port]

PORT=${1:-3000}
URL="http://localhost:${PORT}/health/detailed"

echo "🔍 Checking bot health at ${URL}..."
echo ""

response=$(curl -s -w "\n%{http_code}" "${URL}")
http_code=$(echo "$response" | tail -n1)
body=$(echo "$response" | sed '$d')

if [ "$http_code" != "200" ]; then
  echo "❌ Health check failed (HTTP ${http_code})"
  echo "$body"
  exit 1
fi

# Parse JSON response (requires jq)
if command -v jq &> /dev/null; then
  echo "📊 Bot Health Status:"
  echo "===================="
  echo ""
  
  status=$(echo "$body" | jq -r '.status')
  uptime=$(echo "$body" | jq -r '.uptime')
  memory_used=$(echo "$body" | jq -r '.memory.used')
  memory_total=$(echo "$body" | jq -r '.memory.total')
  
  echo "Status: ${status}"
  echo "Uptime: ${uptime}s"
  echo "Memory: ${memory_used}MB / ${memory_total}MB"
  echo ""
  
  echo "📡 WebSocket OC Consumer:"
  ws_oc=$(echo "$body" | jq '.modules.webSocketOC')
  echo "$ws_oc" | jq '.'
  echo ""
  
  echo "🔌 WebSocket Manager:"
  ws_mgr=$(echo "$body" | jq '.modules.webSocketManager')
  echo "$ws_mgr" | jq '.'
  echo ""
  
  echo "📢 Price Alert Worker:"
  pa_worker=$(echo "$body" | jq '.modules.priceAlertWorker')
  echo "$pa_worker" | jq '.'
  echo ""
  
  echo "🔄 Position Sync:"
  pos_sync=$(echo "$body" | jq '.modules.positionSync')
  echo "$pos_sync" | jq '.'
  echo ""
  
  # Check for issues
  time_since_tick=$(echo "$body" | jq -r '.modules.webSocketOC.timeSinceLastTick // 0')
  if [ "$time_since_tick" != "null" ] && [ "$time_since_tick" -gt 60000 ]; then
    echo "⚠️  WARNING: No ticks received for ${time_since_tick}ms (>60s)"
  fi
  
  queue_size=$(echo "$body" | jq -r '.modules.webSocketOC.queueSize // 0')
  if [ "$queue_size" -gt 1000 ]; then
    echo "⚠️  WARNING: Processing queue size is ${queue_size} (>1000)"
  fi
  
  ws_connected=$(echo "$body" | jq -r '.modules.webSocketManager.connections // 0')
  if [ "$ws_connected" -eq 0 ]; then
    echo "⚠️  WARNING: No WebSocket connections active"
  fi
  
else
  echo "✅ Health check successful (HTTP ${http_code})"
  echo "$body" | python3 -m json.tool 2>/dev/null || echo "$body"
fi

