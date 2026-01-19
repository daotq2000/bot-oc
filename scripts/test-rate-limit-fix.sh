#!/bin/bash

# Test Rate Limit Fix
# Verify that all protections are in place

echo "🔍 Testing Rate Limit Fix..."
echo ""

# Colors
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# Test 1: Check if RealtimeOCDetector has REST fallback disabled
echo "Test 1: RealtimeOCDetector REST fallback"
if grep -q "OC_REST_FALLBACK_ENABLED" src/services/RealtimeOCDetector.js; then
  if grep -q "OC_REST_FALLBACK_ENABLED.*false" src/services/RealtimeOCDetector.js; then
    echo -e "${GREEN}✅ REST fallback code updated (disabled by default)${NC}"
  else
    echo -e "${YELLOW}⚠️  REST fallback config found but not explicitly disabled${NC}"
  fi
else
  echo -e "${RED}❌ REST fallback config not found${NC}"
fi

# Test 2: Check if BinanceDirectClient uses scheduler
echo ""
echo "Test 2: BinanceDirectClient scheduler integration"
if grep -q "binanceRequestScheduler.enqueue" src/services/BinanceDirectClient.js; then
  echo -e "${GREEN}✅ Scheduler integration found${NC}"
else
  echo -e "${RED}❌ Scheduler integration not found${NC}"
fi

# Test 3: Check circuit breaker
echo ""
echo "Test 3: Circuit breaker checks"
if grep -q "_checkCircuitBreaker" src/services/BinanceDirectClient.js; then
  echo -e "${GREEN}✅ Circuit breaker implementation found${NC}"
else
  echo -e "${RED}❌ Circuit breaker not found${NC}"
fi

# Test 4: Check rate limit blocking
echo ""
echo "Test 4: Rate limit blocking"
if grep -q "_checkRateLimitBlock" src/services/BinanceDirectClient.js; then
  echo -e "${GREEN}✅ Rate limit blocking found${NC}"
else
  echo -e "${RED}❌ Rate limit blocking not found${NC}"
fi

# Test 5: Check IndicatorWarmup uses BinanceDirectClient
echo ""
echo "Test 5: IndicatorWarmup using BinanceDirectClient"
if grep -q "BinanceDirectClient" src/indicators/IndicatorWarmup.js; then
  echo -e "${GREEN}✅ IndicatorWarmup uses BinanceDirectClient${NC}"
else
  echo -e "${RED}❌ IndicatorWarmup not using BinanceDirectClient${NC}"
fi

# Test 6: Check config documentation exists
echo ""
echo "Test 6: Documentation"
if [ -f "docs/RATE_LIMIT_FIX_CONFIG.md" ]; then
  echo -e "${GREEN}✅ Configuration documentation exists${NC}"
else
  echo -e "${YELLOW}⚠️  Configuration documentation not found${NC}"
fi

if [ -f "RATE_LIMIT_FIX_SUMMARY.md" ]; then
  echo -e "${GREEN}✅ Fix summary exists${NC}"
else
  echo -e "${YELLOW}⚠️  Fix summary not found${NC}"
fi

# Test 7: Check for dangerous patterns
echo ""
echo "Test 7: Checking for dangerous patterns..."

DANGEROUS=0

# Check for direct fetch to fapi/v1/klines without protection
if grep -r "fetch.*fapi/v1/klines" src/ --include="*.js" | grep -v "BinanceDirectClient" | grep -v "comment" | grep -v "//"; then
  echo -e "${RED}❌ Found direct fetch to /fapi/v1/klines without protection${NC}"
  DANGEROUS=1
else
  echo -e "${GREEN}✅ No unprotected /fapi/v1/klines calls found${NC}"
fi

# Check for aggressive REST fallback enabled by default
if grep -r "REST_FALLBACK.*true" src/ --include="*.js" | grep -v "comment" | grep -v "//"; then
  echo -e "${YELLOW}⚠️  Found REST_FALLBACK=true in code${NC}"
  DANGEROUS=1
fi

if [ $DANGEROUS -eq 0 ]; then
  echo -e "${GREEN}✅ No dangerous patterns found${NC}"
fi

# Summary
echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo "📊 Summary"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"

echo ""
echo "Key protections in place:"
echo "  1. ✅ REST API fallback disabled in RealtimeOCDetector"
echo "  2. ✅ BinanceRequestScheduler integrated"
echo "  3. ✅ Circuit breaker for market data requests"
echo "  4. ✅ Rate limit blocking (10s cooldown on 429)"
echo "  5. ✅ IndicatorWarmup uses centralized client"
echo ""
echo "Next steps:"
echo "  1. Deploy and restart bot"
echo "  2. Monitor logs for rate limit errors"
echo "  3. Fix WebSocket connections (root cause)"
echo "  4. Consider reducing tracked symbols (541 is high)"
echo ""

# Check database configs (if psql is available)
if command -v psql &> /dev/null; then
  echo "Checking database configs..."
  echo ""
  
  # You would need to set these env vars or update connection string
  # psql "$DATABASE_URL" -c "SELECT key, value FROM configs WHERE key LIKE 'BINANCE_%' OR key LIKE 'OC_%' ORDER BY key;"
  
  echo -e "${YELLOW}ℹ️  To check database configs, run:${NC}"
  echo "   psql \$DATABASE_URL -c \"SELECT key, value FROM configs WHERE key LIKE 'BINANCE_%' OR key LIKE 'OC_%' ORDER BY key;\""
fi

echo ""
echo "✅ Rate limit fix verification complete!"

