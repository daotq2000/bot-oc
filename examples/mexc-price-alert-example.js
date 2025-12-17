/**
 * MEXC Price Alert Examples
 * 
 * Các ví dụ về cách sử dụng MEXC price alert API
 */

const API_BASE_URL = 'http://localhost:3000/api';

// ============================================
// 1. CREATE PRICE ALERT
// ============================================

async function createMexcPriceAlert() {
  console.log('📍 Creating MEXC price alert...');
  
  const alertConfig = {
    exchange: 'mexc',
    symbols: ['BTC/USDT', 'ETH/USDT', 'SOL/USDT'],
    intervals: ['1m', '5m'],
    threshold: 2.5,  // Alert when price changes by 2.5%
    telegram_chat_id: '123456789',  // Your Telegram chat ID
    is_active: true
  };

  try {
    const response = await fetch(`${API_BASE_URL}/price-alerts`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(alertConfig)
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Alert created successfully!');
      console.log('Alert ID:', data.data.id);
      console.log('Config:', data.data);
      return data.data.id;
    } else {
      console.error('❌ Failed to create alert:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================
// 2. GET ALL PRICE ALERTS
// ============================================

async function getAllPriceAlerts() {
  console.log('📍 Fetching all price alerts...');
  
  try {
    const response = await fetch(`${API_BASE_URL}/price-alerts`);
    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Alerts retrieved successfully!');
      console.log(`Total alerts: ${data.data.length}`);
      data.data.forEach(alert => {
        console.log(`\n  ID: ${alert.id}`);
        console.log(`  Exchange: ${alert.exchange}`);
        console.log(`  Symbols: ${alert.symbols.join(', ')}`);
        console.log(`  Threshold: ${alert.threshold}%`);
        console.log(`  Active: ${alert.is_active}`);
      });
    } else {
      console.error('❌ Failed to fetch alerts:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================
// 3. GET MEXC PRICE ALERTS ONLY
// ============================================

async function getMexcPriceAlerts() {
  console.log('📍 Fetching MEXC price alerts...');
  
  try {
    const response = await fetch(`${API_BASE_URL}/price-alerts?exchange=mexc`);
    const data = await response.json();
    
    if (data.success) {
      console.log('✅ MEXC alerts retrieved successfully!');
      console.log(`Total MEXC alerts: ${data.data.length}`);
      data.data.forEach(alert => {
        console.log(`\n  ID: ${alert.id}`);
        console.log(`  Symbols: ${alert.symbols.join(', ')}`);
        console.log(`  Threshold: ${alert.threshold}%`);
      });
    } else {
      console.error('❌ Failed to fetch alerts:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================
// 4. GET ALERT BY ID
// ============================================

async function getPriceAlertById(alertId) {
  console.log(`📍 Fetching alert ${alertId}...`);
  
  try {
    const response = await fetch(`${API_BASE_URL}/price-alerts/${alertId}`);
    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Alert retrieved successfully!');
      console.log('Alert details:', JSON.stringify(data.data, null, 2));
    } else {
      console.error('❌ Failed to fetch alert:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================
// 5. UPDATE PRICE ALERT
// ============================================

async function updatePriceAlert(alertId) {
  console.log(`[object Object]d}...`);
  
  const updateData = {
    symbols: ['BTC/USDT', 'ETH/USDT', 'XRP/USDT', 'ADA/USDT'],
    threshold: 3.0,  // Increase threshold to 3%
    is_active: true
  };

  try {
    const response = await fetch(`${API_BASE_URL}/price-alerts/${alertId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateData)
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Alert updated successfully!');
      console.log('Updated config:', data.data);
    } else {
      console.error('❌ Failed to update alert:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================
// 6. DISABLE PRICE ALERT
// ============================================

async function disablePriceAlert(alertId) {
  console.log(`📍 Disabling alert ${alertId}...`);
  
  const updateData = {
    is_active: false
  };

  try {
    const response = await fetch(`${API_BASE_URL}/price-alerts/${alertId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(updateData)
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Alert disabled successfully!');
    } else {
      console.error('❌ Failed to disable alert:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================
// 7. DELETE PRICE ALERT
// ============================================

async function deletePriceAlert(alertId) {
  console.log(`📍 Deleting alert ${alertId}...`);
  
  try {
    const response = await fetch(`${API_BASE_URL}/price-alerts/${alertId}`, {
      method: 'DELETE'
    });

    const data = await response.json();
    
    if (data.success) {
      console.log('✅ Alert deleted successfully!');
    } else {
      console.error('❌ Failed to delete alert:', data.error);
    }
  } catch (error) {
    console.error('❌ Error:', error.message);
  }
}

// ============================================
// 8. ADVANCED: CREATE MULTIPLE ALERTS
// ============================================

async function createMultipleAlerts() {
  console.log('📍 Creating multiple MEXC price alerts...');
  
  const alerts = [
    {
      name: 'Major Coins Alert',
      config: {
        exchange: 'mexc',
        symbols: ['BTC/USDT', 'ETH/USDT'],
        intervals: ['1m', '5m'],
        threshold: 2.0,
        telegram_chat_id: '123456789',
        is_active: true
      }
    },
    {
      name: 'Altcoins Alert',
      config: {
        exchange: 'mexc',
        symbols: ['SOL/USDT', 'XRP/USDT', 'ADA/USDT'],
        intervals: ['5m', '1h'],
        threshold: 3.0,
        telegram_chat_id: '123456789',
        is_active: true
      }
    },
    {
      name: 'Low Cap Alert',
      config: {
        exchange: 'mexc',
        symbols: ['DOGE/USDT', 'SHIB/USDT'],
        intervals: ['1h'],
        threshold: 5.0,
        telegram_chat_id: '123456789',
        is_active: true
      }
    }
  ];

  for (const alert of alerts) {
    try {
      const response = await fetch(`${API_BASE_URL}/price-alerts`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(alert.config)
      });

      const data = await response.json();
      
      if (data.success) {
        console.log(`✅ ${alert.name} created (ID: ${data.data.id})`);
      } else {
        console.error(`❌ ${alert.name} failed:`, data.error);
      }
    } catch (error) {
      console.error(`❌ ${alert.name} error:`, error.message);
    }
  }
}

// ============================================
// 9. MONITOR ALERTS IN REAL-TIME
// ============================================

async function monitorAlertsRealTime() {
  console.log('📍 Starting real-time alert monitoring...');
  console.log('Press Ctrl+C to stop\n');
  
  const checkInterval = 10000; // Check every 10 seconds
  
  setInterval(async () => {
    try {
      const response = await fetch(`${API_BASE_URL}/price-alerts?exchange=mexc`);
      const data = await response.json();
      
      if (data.success && data.data.length > 0) {
        console.log(`[${new Date().toLocaleTimeString()}] Found ${data.data.length} active MEXC alerts`);
        data.data.forEach(alert => {
          if (alert.is_active) {
            console.log(`  • Alert ${alert.id}: ${alert.symbols.length} symbols, ${alert.threshold}% threshold`);
          }
        });
      }
    } catch (error) {
      console.error('Error monitoring alerts:', error.message);
    }
  }, checkInterval);
}

// ============================================
// MAIN: Run examples
// ============================================

async function main() {
  console.log('🚀 MEXC Price Alert Examples\n');
  console.log('Choose an example to run:\n');
  console.log('1. Create price alert');
  console.log('2. Get all alerts');
  console.log('3. Get MEXC alerts only');
  console.log('4. Get alert by ID');
  console.log('5. Update alert');
  console.log('6. Disable alert');
  console.log('7. Delete alert');
  console.log('8. Create multiple alerts');
  console.log('9. Monitor alerts in real-time');
  console.log('\nUsage: node mexc-price-alert-example.js <number>\n');

  const example = process.argv[2];

  switch (example) {
    case '1':
      await createMexcPriceAlert();
      break;
    case '2':
      await getAllPriceAlerts();
      break;
    case '3':
      await getMexcPriceAlerts();
      break;
    case '4':
      const alertId = process.argv[3] || 1;
      await getPriceAlertById(alertId);
      break;
    case '5':
      const updateId = process.argv[3] || 1;
      await updatePriceAlert(updateId);
      break;
    case '6':
      const disableId = process.argv[3] || 1;
      await disablePriceAlert(disableId);
      break;
    case '7':
      const deleteId = process.argv[3] || 1;
      await deletePriceAlert(deleteId);
      break;
    case '8':
      await createMultipleAlerts();
      break;
    case '9':
      await monitorAlertsRealTime();
      break;
    default:
      console.log('❌ Invalid example number');
      console.log('Usage: node mexc-price-alert-example.js <1-9>');
  }
}

// Run if executed directly
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch(console.error);
}

export {
  createMexcPriceAlert,
  getAllPriceAlerts,
  getMexcPriceAlerts,
  getPriceAlertById,
  updatePriceAlert,
  disablePriceAlert,
  deletePriceAlert,
  createMultipleAlerts,
  monitorAlertsRealTime
};

