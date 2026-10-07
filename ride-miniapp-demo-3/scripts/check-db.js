require('dotenv').config();

const { configured, query, closePool } = require('../database.js');

async function main() {
  if (!configured()) throw new Error('未配置 DATABASE_URL。请检查 .env。');
  const result = await query('SELECT current_database() AS database, current_user AS user, NOW() AS connected_at');
  console.log('PostgreSQL 连接成功：', result.rows[0]);
}

main()
  .catch((error) => { console.error(`连接失败：${error.message}`); process.exitCode = 1; })
  .finally(() => closePool());
