require('dotenv').config();

const dbSelect = require('../database-select.js');

async function main() {
  if (dbSelect.useMongo()) {
    const { db } = require('../mongo-database.js');
    const database = await db();
    const stats = await database.stats();
    console.log('MongoDB Atlas 连接成功：', {
      database: database.databaseName,
      collections: stats.collections,
      dataSize: `${Math.round(stats.dataSize / 1024 / 1024)} MB`
    });
    return;
  }
  if (!dbSelect.configured()) throw new Error('未配置 MONGO_URI 或 DATABASE_URL。请检查 .env。');
  const { query } = require('../database.js');
  const result = await query('SELECT current_database() AS database, current_user AS user, NOW() AS connected_at');
  console.log('PostgreSQL 连接成功：', result.rows[0]);
}

main()
  .catch((error) => { console.error(`连接失败：${error.message}`); process.exitCode = 1; })
  .finally(() => dbSelect.close());
