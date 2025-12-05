#!/usr/bin/env bash

# Portable restart script for bot-oc
# - Auto-detects project directory (no hardcoded paths)
# - Works with PM2 if available, otherwise falls back to nohup
# - Clears logs and restarts the app
#
# Usage:
#   ./restart_bot.sh
#
# Optional env vars:
#   BOT_NAME=bot-oc PORT=3000 TP_UPDATE_THRESHOLD_TICKS=1

set -euo pipefail

BOT_NAME="${BOT_NAME:-bot-oc}"
PORT="${PORT:-3000}"

# Resolve project directory to the directory of this script
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" &>/dev/null && pwd)"
PROJECT_DIR="${SCRIPT_DIR}"
LOG_DIR="${PROJECT_DIR}/logs"
APP_ENTRY="${PROJECT_DIR}/src/app.js"
PID_FILE="${PROJECT_DIR}/run.pid"

# Load .env if present (export all variables)
if [[ -f "${PROJECT_DIR}/.env" ]]; then
  set -a
  # shellcheck disable=SC1090
  source "${PROJECT_DIR}/.env"
  set +a
fi

printf "\n🔄 Force Restart Bot Service (%s)\n" "$BOT_NAME"
echo   "==============================\n"

# Helper: check command
has_cmd() { command -v "$1" >/dev/null 2>&1; }

# Step 1: Stop and delete PM2 process (if pm2 exists)
echo "📌 Step 1: Stopping existing process..."
if has_cmd pm2; then
  if pm2 list | grep -q "${BOT_NAME}"; then
    pm2 delete "${BOT_NAME}" 2>/dev/null || pm2 stop "${BOT_NAME}" 2>/dev/null || true
    echo "✅ PM2 process stopped/deleted"
  else
    echo "ℹ️  No PM2 process found"
  fi
else
  echo "ℹ️  PM2 not found; will use nohup fallback"
fi

# Step 2: Kill any remaining node processes for this repo
echo "\n📌 Step 2: Killing remaining processes..."
cd "${PROJECT_DIR}"

# Kill processes running app.js within this project
PIDS=$(ps aux | grep "[n]ode.*${APP_ENTRY}" | awk '{print $2}' || true)
if [[ -n "${PIDS}" ]]; then
  echo "Found app.js processes: ${PIDS}"
  for PID in ${PIDS}; do
    if [[ -n "${PID}" && "${PID}" != "$$" ]]; then
      echo "  Killing PID: ${PID}"
      kill -9 "${PID}" 2>/dev/null || true
    fi
  done
  echo "✅ All app.js processes killed"
fi

# If a PID file exists from nohup mode, try to kill it
if [[ -f "${PID_FILE}" ]]; then
  OLD_PID=$(cat "${PID_FILE}" || true)
  if [[ -n "${OLD_PID}" && -e "/proc/${OLD_PID}" ]]; then
    echo "Found previous nohup PID: ${OLD_PID}; killing..."
    kill -9 "${OLD_PID}" 2>/dev/null || true
  fi
  rm -f "${PID_FILE}" || true
fi

# Also kill any process on PORT (best-effort)
if has_cmd lsof; then
  PORT_PID=$(lsof -ti:"${PORT}" 2>/dev/null || true)
  if [[ -n "${PORT_PID}" ]]; then
    echo "Found process on port ${PORT}: ${PORT_PID}"
    kill -9 "${PORT_PID}" 2>/dev/null || true
    echo "✅ Port ${PORT} process killed"
  fi
fi

sleep 1

# Step 3: Clear logs
echo "\n📌 Step 3: Clearing logs..."
mkdir -p "${LOG_DIR}"
: > "${LOG_DIR}/combined.log" || true
: > "${LOG_DIR}/error.log" || true
if has_cmd pm2; then
  pm2 flush "${BOT_NAME}" 2>/dev/null || true
fi
echo "✅ Logs ready at ${LOG_DIR}"

# Step 4: Start bot
echo "\n📌 Step 4: Starting bot..."
cd "${PROJECT_DIR}"

# Ensure Node exists
if ! has_cmd node; then
  echo "❌ Node.js is not installed or not in PATH. Please install Node.js (>= 18) first."
  echo "   Ubuntu: curl -fsSL https://deb.nodesource.com/setup_18.x | sudo -E bash - && sudo apt-get install -y nodejs"
  exit 1
fi

# Export any runtime overrides here
export TP_UPDATE_THRESHOLD_TICKS="${TP_UPDATE_THRESHOLD_TICKS:-1}"

if has_cmd pm2; then
  pm2 start "${APP_ENTRY}" --name "${BOT_NAME}" --update-env
  pm2 save || true
  START_METHOD="pm2"
else
  nohup node "${APP_ENTRY}" >>"${LOG_DIR}/combined.log" 2>>"${LOG_DIR}/error.log" &
  echo $! > "${PID_FILE}"
  START_METHOD="nohup"
fi

echo "✅ Bot started using ${START_METHOD}"

# Step 5: Show status
echo "\n📌 Step 5: Bot Status"
echo "=============================="
if has_cmd pm2; then
  pm2 status "${BOT_NAME}" || true
  echo "\n📋 Recent logs (last 20 lines):"
  pm2 logs "${BOT_NAME}" --lines 20 --nostream || true
else
  if [[ -f "${PID_FILE}" ]]; then
    CUR_PID=$(cat "${PID_FILE}")
    echo "Started PID: ${CUR_PID} (nohup)"
    echo "\n📋 Recent logs (last 20 lines):"
    tail -n 20 "${LOG_DIR}/combined.log" || true
    tail -n 20 "${LOG_DIR}/error.log" || true
  else
    echo "⚠️  Could not find PID file; check logs in ${LOG_DIR}"
  fi
fi

echo "\n✅ Restart completed."
echo "Useful commands:"
echo "  ./restart_bot.sh                    - Restart"
echo "  tail -f ${LOG_DIR}/combined.log      - Follow stdout logs"
echo "  tail -f ${LOG_DIR}/error.log         - Follow error logs"
echo "  pm2 status (if installed)            - PM2 status"
