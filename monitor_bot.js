/**
 * Monitor bot logs for volatility alerts and auto trade signals
 */

import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const LOG_FILE = path.join(process.cwd(), 'logs', 'app.log');
const VOLATILITY_THRESHOLD = 2.0; // 2%

console.log('🔍 Bot Monitor - Watching for volatility alerts and auto trade signals\n');
console.log(`📊 Monitoring threshold: > ${VOLATILITY_THRESHOLD}% volatility\n`);

// Track alerts
const alerts = [];
const trades = [];

// Function to parse log line
function parseLogLine(line) {
  if (!line) return null;

  // Check for volatility alerts
  if (line.includes('volatility') || line.includes('PriceAlert') || line.includes('alert')) {
    // Try to extract volatility percentage
    const volatilityMatch = line.match(/(\d+\.?\d*)%/);
    if (volatilityMatch) {
      const volatility = parseFloat(volatilityMatch[1]);
      if (volatility > VOLATILITY_THRESHOLD) {
        return { type: 'volatility', volatility, line };
      }
    }
    return { type: 'alert', line };
  }

  // Check for OC signals
  if (line.includes('OC') || line.includes('signal') || line.includes('SignalScanner')) {
    return { type: 'signal', line };
  }

  // Check for trades
  if (line.includes('order') || line.includes('trade') || line.includes('position')) {
    return { type: 'trade', line };
  }

  return null;
}

// Monitor log file
function monitorLogs() {
  if (!fs.existsSync(LOG_FILE)) {
    console.log(`⚠️  Log file not found: ${LOG_FILE}`);
    console.log('📝 Monitoring console output instead...\n');
    return;
  }

  console.log(`📄 Monitoring log file: ${LOG_FILE}\n`);

  // Read existing logs
  try {
    const existingLogs = fs.readFileSync(LOG_FILE, 'utf8');
    const lines = existingLogs.split('\n').slice(-100); // Last 100 lines
    
    lines.forEach(line => {
      const parsed = parseLogLine(line);
      if (parsed) {
        handleLogEvent(parsed);
      }
    });
  } catch (error) {
    console.error('Error reading log file:', error.message);
  }

  // Watch for new logs
  const tail = spawn('tail', ['-f', LOG_FILE]);
  
  tail.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    lines.forEach(line => {
      if (line.trim()) {
        const parsed = parseLogLine(line);
        if (parsed) {
          handleLogEvent(parsed);
        }
      }
    });
  });

  tail.stderr.on('data', (data) => {
    console.error(`Log monitor error: ${data}`);
  });

  tail.on('close', (code) => {
    console.log(`\n❌ Log monitor stopped (code: ${code})`);
  });
}

function handleLogEvent(event) {
  const timestamp = new Date().toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });

  if (event.type === 'volatility') {
    alerts.push(event);
    console.log(`\n🚨 [${timestamp}] VOLATILITY ALERT DETECTED!`);
    console.log(`   📈 Volatility: ${event.volatility.toFixed(2)}%`);
    console.log(`   📝 Log: ${event.line.substring(0, 150)}...`);
    console.log(`   ✅ Threshold exceeded: ${event.volatility.toFixed(2)}% > ${VOLATILITY_THRESHOLD}%\n`);
  } else if (event.type === 'alert') {
    console.log(`\n📢 [${timestamp}] Alert: ${event.line.substring(0, 100)}...`);
  } else if (event.type === 'signal') {
    console.log(`\n🎯 [${timestamp}] OC Signal detected: ${event.line.substring(0, 150)}...`);
  } else if (event.type === 'trade') {
    trades.push(event);
    console.log(`\n💰 [${timestamp}] Trade event: ${event.line.substring(0, 150)}...`);
  }
}

// Start monitoring
console.log('⏳ Starting monitor...\n');
monitorLogs();

// Summary every 60 seconds
setInterval(() => {
  console.log(`\n📊 Summary (last 60s):`);
  console.log(`   🚨 Volatility alerts: ${alerts.length}`);
  console.log(`   💰 Trade events: ${trades.length}`);
  console.log(`   ⏰ Time: ${new Date().toLocaleTimeString()}\n`);
}, 60000);

// Keep process alive
process.on('SIGINT', () => {
  console.log('\n\n📊 Final Summary:');
  console.log(`   🚨 Total volatility alerts: ${alerts.length}`);
  console.log(`   💰 Total trade events: ${trades.length}`);
  console.log('\n👋 Monitor stopped');
  process.exit(0);
});

