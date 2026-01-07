import mysql from 'mysql2/promise';

// 源数据库配置
const sourceConfig = {
  host: 'localhost',
  port: 3333,
  user: 'username',
  password: 'password',
  database: 'bot_oc_xuoi',
  multipleStatements: true
};

// 目标数据库配置（Docker）
const destConfig = {
  host: 'localhost',
  port: 3306,
  user: 'root',
  password: 'rootpassword',
  database: 'bot_oc_xuoi',
  multipleStatements: true
};

// 获取所有表名
async function getTables(connection, databaseName) {
  // 先切换到指定数据库
  await connection.query(`USE \`${databaseName}\``);
  
  // 使用 SHOW TABLES 命令，更简单可靠
  const [tables] = await connection.query('SHOW TABLES');
  
  // SHOW TABLES 返回的字段名格式为 `Tables_in_<database_name>`
  const tableKey = `Tables_in_${databaseName}`;
  
  // 提取表名
  const tableNames = tables.map(row => {
    // 尝试不同的可能字段名
    return row[tableKey] || row.table_name || row.TABLE_NAME || Object.values(row)[0];
  }).filter(name => name && name !== 'undefined'); // 过滤掉空值和undefined
  
  return tableNames;
}

// 禁用外键检查
async function disableForeignKeyChecks(connection) {
  await connection.query('SET FOREIGN_KEY_CHECKS = 0');
}

// 启用外键检查
async function enableForeignKeyChecks(connection) {
  await connection.query('SET FOREIGN_KEY_CHECKS = 1');
}

// 清理目标数据库的所有数据
async function cleanupDestination(destConn) {
  console.log('开始清理目标数据库...');
  
  await disableForeignKeyChecks(destConn);
  
  const tables = await getTables(destConn, destConfig.database);
  
  if (tables.length === 0) {
    console.log('  目标数据库中没有找到表，跳过清理\n');
    await enableForeignKeyChecks(destConn);
    return;
  }
  
  for (const table of tables) {
    if (!table || table === 'undefined') {
      console.log(`  跳过无效表名: ${table}`);
      continue;
    }
    console.log(`  清理表: ${table}`);
    await destConn.query(`TRUNCATE TABLE \`${table}\``);
  }
  
  await enableForeignKeyChecks(destConn);
  
  console.log('目标数据库清理完成！\n');
}

// 同步单个表的数据
async function syncTable(sourceConn, destConn, tableName) {
  console.log(`同步表: ${tableName}`);
  
  // 从源数据库读取数据
  const [rows] = await sourceConn.query(`SELECT * FROM \`${tableName}\``);
  
  if (rows.length === 0) {
    console.log(`  表 ${tableName} 为空，跳过\n`);
    return;
  }
  
  // 获取表结构以确定列名
  const [columns] = await sourceConn.query(
    `SELECT COLUMN_NAME 
     FROM information_schema.COLUMNS 
     WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? 
     ORDER BY ORDINAL_POSITION`,
    [sourceConfig.database, tableName]
  );
  
  const columnNames = columns.map(col => col.COLUMN_NAME);
  const placeholders = columnNames.map(() => '?').join(', ');
  const columnsStr = columnNames.map(col => `\`${col}\``).join(', ');
  
  // 禁用外键检查以便插入数据
  await disableForeignKeyChecks(destConn);
  
  // 分批插入，每批1000条
  const batchSize = 1000;
  for (let i = 0; i < rows.length; i += batchSize) {
    const batch = rows.slice(i, i + batchSize);
    
    // 构建批量插入查询
    const valuesPlaceholders = batch.map(() => `(${placeholders})`).join(', ');
    const insertQuery = `INSERT INTO \`${tableName}\` (${columnsStr}) VALUES ${valuesPlaceholders}`;
    
    // 展平所有值到一个数组中
    const values = batch.flatMap(row => 
      columnNames.map(col => row[col])
    );
    
    await destConn.query(insertQuery, values);
  }
  
  await enableForeignKeyChecks(destConn);
  
  console.log(`  已同步 ${rows.length} 条记录\n`);
}

// 重置自增ID（可选，如果需要保持ID一致）
async function resetAutoIncrement(destConn, tableName) {
  try {
    const [result] = await destConn.query(
      `SELECT MAX(id) as max_id FROM \`${tableName}\``
    );
    if (result[0] && result[0].max_id) {
      await destConn.query(
        `ALTER TABLE \`${tableName}\` AUTO_INCREMENT = ${result[0].max_id + 1}`
      );
    }
  } catch (error) {
    // 如果表没有id列或auto_increment，忽略错误
  }
}

// 主函数
async function syncDatabase() {
  let sourceConn = null;
  let destConn = null;
  
  try {
    console.log('正在连接源数据库...');
    sourceConn = await mysql.createConnection(sourceConfig);
    console.log('源数据库连接成功！\n');
    
    console.log('正在连接目标数据库...');
    destConn = await mysql.createConnection(destConfig);
    console.log('目标数据库连接成功！\n');
    
    // 获取所有表
    const tables = await getTables(sourceConn, sourceConfig.database);
    
    if (tables.length === 0) {
      throw new Error('源数据库中没有找到任何表！');
    }
    
    console.log(`找到 ${tables.length} 个表: ${tables.join(', ')}\n`);
    
    // 清理目标数据库
    await cleanupDestination(destConn);
    
    // 同步每个表
    console.log('开始同步数据...\n');
    for (const table of tables) {
      await syncTable(sourceConn, destConn, table);
      // 重置自增ID（可选）
      await resetAutoIncrement(destConn, table);
    }
    
    console.log('数据库同步完成！');
    
  } catch (error) {
    console.error('同步过程中发生错误:', error);
    throw error;
  } finally {
    if (sourceConn) {
      await sourceConn.end();
      console.log('源数据库连接已关闭');
    }
    if (destConn) {
      await destConn.end();
      console.log('目标数据库连接已关闭');
    }
  }
}

// 运行同步
syncDatabase()
  .then(() => {
    console.log('\n✅ 同步成功完成！');
    process.exit(0);
  })
  .catch((error) => {
    console.error('\n❌ 同步失败:', error.message);
    process.exit(1);
  });

