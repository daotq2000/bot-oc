#!/bin/bash
# Script to remove concurrency management system

echo "╔══════════════════════════════════════════════════════════════════════════════╗"
echo "║           REMOVING CONCURRENCY MANAGEMENT SYSTEM                             ║"
echo "╚══════════════════════════════════════════════════════════════════════════════╝"
echo ""

# Backup files
echo "📦 Creating backups..."
mkdir -p backups/concurrency_removal_$(date +%Y%m%d_%H%M%S)
cp src/services/OrderService.js backups/concurrency_removal_$(date +%Y%m%d_%H%M%S)/
cp src/jobs/EntryOrderMonitor.js backups/concurrency_removal_$(date +%Y%m%d_%H%M%S)/
cp src/jobs/PositionSync.js backups/concurrency_removal_$(date +%Y%m%d_%H%M%S)/
cp src/workers/StrategiesWorker.js backups/concurrency_removal_$(date +%Y%m%d_%H%M%S)/
echo "✅ Backups created"
echo ""

# Comment out concurrency logic in remaining files
echo "🔧 Commenting out concurrency logic..."

# EntryOrderMonitor.js
sed -i 's/const canAccept = await concurrencyManager\.canAcceptNewPosition/\/\/ const canAccept = await concurrencyManager.canAcceptNewPosition/g' src/jobs/EntryOrderMonitor.js
sed -i 's/if (!canAccept)/if (false) \/\/ canAccept check disabled/g' src/jobs/EntryOrderMonitor.js
sed -i 's/reservationToken = await concurrencyManager\.reserveSlot/\/\/ reservationToken = await concurrencyManager.reserveSlot/g' src/jobs/EntryOrderMonitor.js
sed -i 's/await concurrencyManager\.finalizeReservation/\/\/ await concurrencyManager.finalizeReservation/g' src/jobs/EntryOrderMonitor.js

# PositionSync.js  
sed -i 's/const canAccept = await concurrencyManager\.canAcceptNewPosition/\/\/ const canAccept = await concurrencyManager.canAcceptNewPosition/g' src/jobs/PositionSync.js
sed -i 's/reservationToken = await concurrencyManager\.reserveSlot/\/\/ reservationToken = await concurrencyManager.reserveSlot/g' src/jobs/PositionSync.js
sed -i 's/await concurrencyManager\.finalizeReservation/\/\/ await concurrencyManager.finalizeReservation/g' src/jobs/PositionSync.js

# StrategiesWorker.js
sed -i 's/concurrencyManager\.initializeBot/\/\/ concurrencyManager.initializeBot/g' src/workers/StrategiesWorker.js

echo "✅ Code commented out"
echo ""

echo "📝 Summary:"
echo "  - OrderService.js: ✅ Cleaned"
echo "  - EntryOrderMonitor.js: ✅ Commented out"
echo "  - PositionSync.js: ✅ Commented out"
echo "  - StrategiesWorker.js: ✅ Commented out"
echo ""

echo "⚠️  Next steps (manual):"
echo "  1. Test bot: pm2 restart bot-oc"
echo "  2. Monitor for errors"
echo "  3. If OK, drop table: node scripts/drop_concurrency_table.js"
echo ""
echo "✅ Concurrency removal preparation complete"

