import mysql from 'mysql2/promise';
import dotenv from 'dotenv';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// 数据库配置
const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306'),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'bot_oc',
  multipleStatements: true
};

async function runMigration(migrationFile) {
  let connection = null;
  
  try {
    console.log(`正在连接数据库...`);
    console.log(`  主机: ${dbConfig.host}:${dbConfig.port}`);
    console.log(`  数据库: ${dbConfig.database}`);
    console.log(`  用户: ${dbConfig.user}\n`);
    
    connection = await mysql.createConnection(dbConfig);
    console.log('✅ 数据库连接成功！\n');
    
    // 先检查列是否已存在
    console.log('正在检查列是否已存在...');
    try {
      const [existingColumns] = await connection.query('SHOW COLUMNS FROM bots LIKE "default_leverage"');
      
      if (existingColumns.length > 0) {
        const col = existingColumns[0];
        console.log('✅ 列已存在！default_leverage 列已在 bots 表中：');
        console.log(`   列名: ${col.Field}`);
        console.log(`   类型: ${col.Type}`);
        console.log(`   可空: ${col.Null}`);
        console.log(`   默认值: ${col.Default || 'NULL'}`);
        console.log(`   注释: ${col.Comment || '(无)'}\n`);
        console.log('Migration 已执行过，跳过执行。');
        return;
      }
    } catch (checkError) {
      console.log('检查列时出错，继续执行 migration...');
      console.log(`   错误: ${checkError.message}\n`);
    }
    
    // 读取 migration 文件
    const migrationPath = path.join(__dirname, '..', 'database', migrationFile);
    console.log(`正在读取 migration 文件: ${migrationPath}`);
    
    if (!fs.existsSync(migrationPath)) {
      throw new Error(`Migration 文件不存在: ${migrationPath}`);
    }
    
    const sql = fs.readFileSync(migrationPath, 'utf8');
    console.log('✅ Migration 文件读取成功！\n');
    
    // 执行 migration（移除 USE 语句，使用连接时指定的数据库）
    console.log('正在执行 migration...');
    // 移除 SQL 中的 USE 语句，因为连接时已经指定了数据库
    const cleanSql = sql.replace(/USE\s+\w+\s*;/gi, '').trim();
    await connection.query(cleanSql);
    console.log('✅ Migration 执行成功！\n');
    
    // 验证列是否已添加
    console.log('正在验证 migration 结果...');
    const [columns] = await connection.query(
      `SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE, COLUMN_DEFAULT, COLUMN_COMMENT 
       FROM information_schema.COLUMNS 
       WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'bots' AND COLUMN_NAME = 'default_leverage'`
    );
    
    if (columns.length > 0) {
      const col = columns[0];
      console.log('✅ 验证成功！default_leverage 列已添加到 bots 表：');
      console.log(`   列名: ${col.COLUMN_NAME}`);
      console.log(`   类型: ${col.COLUMN_TYPE}`);
      console.log(`   可空: ${col.IS_NULLABLE}`);
      console.log(`   默认值: ${col.COLUMN_DEFAULT || 'NULL'}`);
      console.log(`   注释: ${col.COLUMN_COMMENT || '(无)'}`);
    } else {
      console.log('⚠️  警告：无法验证列是否已添加');
    }
    
  } catch (error) {
    console.error('\n❌ Migration 执行失败:');
    console.error(error.message);
    if (error.sql) {
      console.error('SQL:', error.sql);
    }
    process.exit(1);
  } finally {
    if (connection) {
      await connection.end();
      console.log('\n数据库连接已关闭');
    }
  }
}

// 运行 migration
const migrationFile = process.argv[2] || 'migration_add_default_leverage.sql';
runMigration(migrationFile)
  .then(() => {
    console.log('\n✅ Migration 完成！');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ Migration 失败:', error.message);
    process.exit(1);
  });

