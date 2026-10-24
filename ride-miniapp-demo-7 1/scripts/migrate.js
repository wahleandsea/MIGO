require('dotenv').config();

const fs = require('node:fs');
const path = require('node:path');
const { configured, query, closePool } = require('../database.js');

async function main() {
  if (!configured()) {
    throw new Error('未配置 DATABASE_URL。请先复制 .env.example 为 .env 并填写 Aiven 密码。');
  }
  const sql = fs.readFileSync(path.join(__dirname, '..', 'db', 'schema.sql'), 'utf8');
  await query(sql);
  console.log('数据库表结构创建完成。');
}

main()
  .catch((error) => { console.error(`迁移失败：${error.message}`); process.exitCode = 1; })
  .finally(() => closePool());
