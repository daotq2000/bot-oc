import pool from '../config/database.js';

export class AppConfig {
  static async findAll() {
    const [rows] = await pool.execute('SELECT config_key, config_value FROM app_configs');
    return rows;
  }

  static async get(key) {
    const [rows] = await pool.execute('SELECT config_value FROM app_configs WHERE config_key = ?', [key]);
    return rows[0]?.config_value ?? null;
  }

  static async set(key, value, description = null) {
    const val = value === undefined || value === null ? null : String(value);
    await pool.execute(
      `INSERT INTO app_configs (config_key, config_value, description)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE config_value = VALUES(config_value), description = COALESCE(VALUES(description), description)`,
      [key, val, description]
    );
  }
}
