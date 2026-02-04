'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    /**
     * Add use_software_sl column to positions table.
     * 
     * This flag indicates whether the position should use software-based
     * stop loss monitoring instead of exchange-level SL orders.
     * 
     * Set to TRUE when:
     * - Exchange doesn't support conditional orders (e.g., Binance Testnet with -4120)
     * - Exchange SL order fails and cannot be retried
     * 
     * When TRUE, PositionMonitor will use SoftwareStopLossService to:
     * - Monitor price via WebSocket
     * - Trigger MARKET close when price hits SL level
     */
    const tableDesc = await queryInterface.describeTable('positions');
    
    if (!tableDesc.use_software_sl) {
      await queryInterface.addColumn('positions', 'use_software_sl', {
        type: Sequelize.BOOLEAN,
        allowNull: false,
        defaultValue: false,
        comment: 'Use software-based SL monitoring instead of exchange SL order'
      });
      console.log('✅ Added use_software_sl column to positions table');
    } else {
      console.log('ℹ️ Column use_software_sl already exists, skipping');
    }
  },

  async down(queryInterface, Sequelize) {
    const tableDesc = await queryInterface.describeTable('positions');
    
    if (tableDesc.use_software_sl) {
      await queryInterface.removeColumn('positions', 'use_software_sl');
      console.log('✅ Removed use_software_sl column from positions table');
    }
  }
};
