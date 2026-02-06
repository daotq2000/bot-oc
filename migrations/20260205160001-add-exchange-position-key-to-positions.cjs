'use strict';

/** @type {import('sequelize-cli').Migration} */
module.exports = {
  async up(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.addColumn('positions', 'exchange_position_key', {
        type: Sequelize.STRING(255),
        allowNull: true,
        defaultValue: null,
        comment: 'Stable key for DB<->exchange reconciliation: exchange_botId_symbol_positionSide',
      }, { transaction });

      await queryInterface.addIndex('positions', ['exchange_position_key'], {
        unique: true,
        name: 'uniq_exchange_position_key',
        transaction,
      });

      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  },

  async down(queryInterface, Sequelize) {
    const transaction = await queryInterface.sequelize.transaction();
    try {
      await queryInterface.removeIndex('positions', 'uniq_exchange_position_key', { transaction });
      await queryInterface.removeColumn('positions', 'exchange_position_key', { transaction });
      await transaction.commit();
    } catch (err) {
      await transaction.rollback();
      throw err;
    }
  }
};
