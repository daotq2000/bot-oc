import { AppConfig } from '../src/models/AppConfig.js';
import { configService } from '../src/services/ConfigService.js';
import logger from '../src/utils/logger.js';

async function updateMexcEndpointToCo() {
  try {
    console.log('\n' + '='.repeat(80));
    console.log('CẬP NHẬT MEXC ENDPOINT SANG .CO');
    console.log('='.repeat(80) + '\n');

    // Load configs
    await configService.loadAll();

    // Check current config
    const currentWsUrl = configService.getString('MEXC_FUTURES_WS_URL', '');
    const currentRestBase = configService.getString('MEXC_FUTURES_REST_BASE', '');
    
    console.log('📋 Cấu hình hiện tại:');
    console.log(`   MEXC_FUTURES_WS_URL: ${currentWsUrl || '(chưa có)'}`);
    console.log(`   MEXC_FUTURES_REST_BASE: ${currentRestBase || '(chưa có)'}`);
    console.log('');

    // Update to .co
    console.log('📝 Đang cập nhật sang endpoint .co...');
    
    await AppConfig.set('MEXC_FUTURES_WS_URL', 'wss://contract.mexc.co/edge', 'MEXC Futures WebSocket endpoint (using .co domain for better connectivity)');
    await AppConfig.set('MEXC_FUTURES_REST_BASE', 'https://contract.mexc.co', 'MEXC Futures REST base URL (using .co domain for better connectivity)');
    
    // Reload configs
    await configService.loadAll();
    
    // Verify
    const newWsUrl = configService.getString('MEXC_FUTURES_WS_URL', '');
    const newRestBase = configService.getString('MEXC_FUTURES_REST_BASE', '');
    
    console.log('✅ Đã cập nhật thành công!');
    console.log('');
    console.log('📋 Cấu hình mới:');
    console.log(`   MEXC_FUTURES_WS_URL: ${newWsUrl}`);
    console.log(`   MEXC_FUTURES_REST_BASE: ${newRestBase}`);
    console.log('');
    
    if (newWsUrl.includes('.co') && newRestBase.includes('.co')) {
      console.log('✅ Endpoint đã được cập nhật sang .co domain!');
      console.log('');
      console.log('📌 Lưu ý:');
      console.log('   - Cần restart ứng dụng để áp dụng thay đổi');
      console.log('   - MEXC WebSocket sẽ ưu tiên sử dụng endpoint .co');
      console.log('   - Nếu .co không kết nối được, sẽ tự động fallback sang .com');
    } else {
      console.log('⚠️  Có vấn đề khi cập nhật, vui lòng kiểm tra lại');
    }
    
    console.log('='.repeat(80) + '\n');

  } catch (error) {
    console.error('❌ Lỗi khi cập nhật:', error);
    logger.error('Error updating MEXC endpoint:', error);
    process.exit(1);
  }
}

// Run update
updateMexcEndpointToCo()
  .then(() => {
    process.exit(0);
  })
  .catch((error) => {
    console.error('Fatal error:', error);
    process.exit(1);
  });

