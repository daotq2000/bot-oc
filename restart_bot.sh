#!/bin/bash

# Script to force restart bot service
# Clears logs, kills existing processes, and restarts with new PID

set -e  # Exit on error

BOT_NAME="bot-oc"
PROJECT_DIR="/home/daotran2/Documents/Github/bot-oc"
LOG_DIR="${PROJECT_DIR}/logs"

echo "🔄 Force Restart Bot Service"
echo "=============================="
echo ""

# Step 1: Stop and delete PM2 process
echo "📌 Step 1: Stopping PM2 process..."
if pm2 list | grep -q "$BOT_NAME"; then
    pm2 delete "$BOT_NAME" 2>/dev/null || pm2 stop "$BOT_NAME" 2>/dev/null || true
    echo "✅ PM2 process stopped/deleted"
else
    echo "ℹ️  No PM2 process found"
fi

# Step 2: Kill any remaining node processes for this bot
echo ""
echo "📌 Step 2: Killing remaining processes..."
cd "$PROJECT_DIR"

# Find and kill processes running app.js
PIDS=$(ps aux | grep "[n]ode.*app.js" | grep "$PROJECT_DIR" | awk '{print $2}' || true)

if [ -n "$PIDS" ]; then
    echo "Found app.js processes: $PIDS"
    for PID in $PIDS; do
        if [ -n "$PID" ] && [ "$PID" != "$$" ]; then
            echo "  Killing PID: $PID"
            kill -9 "$PID" 2>/dev/null || true
        fi
    done
    echo "✅ All app.js processes killed"
fi

# Also kill any processes using port 3000 (if bot runs on this port)
PORT_PID=$(lsof -ti:3000 2>/dev/null || true)
if [ -n "$PORT_PID" ]; then
    echo "Found process on port 3000: $PORT_PID"
    kill -9 "$PORT_PID" 2>/dev/null || true
    echo "✅ Port 3000 process killed"
fi

# Wait a moment for processes to fully terminate
sleep 2

# Step 3: Clear logs
echo ""
echo "📌 Step 3: Clearing logs..."

# Clear PM2 logs
if command -v pm2 &> /dev/null; then
    pm2 flush "$BOT_NAME" 2>/dev/null || true
    echo "✅ PM2 logs cleared"
fi

# Clear project logs
if [ -d "$LOG_DIR" ]; then
    > "$LOG_DIR/combined.log" 2>/dev/null || true
    > "$LOG_DIR/error.log" 2>/dev/null || true
    echo "✅ Project logs cleared"
else
    echo "ℹ️  Log directory not found, creating..."
    mkdir -p "$LOG_DIR"
    touch "$LOG_DIR/combined.log"
    touch "$LOG_DIR/error.log"
    echo "✅ Log directory created"
fi

# Step 4: Restart bot
echo ""
echo "📌 Step 4: Starting bot with PM2..."
cd "$PROJECT_DIR"

# Export runtime environment overrides
export TP_UPDATE_THRESHOLD_TICKS=1

# Start bot with updated env
pm2 start src/app.js --name "$BOT_NAME"

# Save PM2 configuration
pm2 save

# Wait a moment for bot to start
sleep 3

# Step 5: Show status
echo ""
echo "📌 Step 5: Bot Status"
echo "=============================="
pm2 status "$BOT_NAME"

echo ""
echo "📋 Recent logs (last 10 lines):"
echo "=============================="
pm2 logs "$BOT_NAME" --lines 10 --nostream

echo ""
echo "✅ Bot restarted successfully!"
echo ""
echo "Useful commands:"
echo "  pm2 logs $BOT_NAME          - View logs"
echo "  pm2 status                  - Check status"
echo "  pm2 restart $BOT_NAME      - Restart bot"
echo "  pm2 stop $BOT_NAME          - Stop bot"

