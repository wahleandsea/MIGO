/** PostgreSQL 连接层。密码和证书路径只从 .env 读取，绝不写进前端代码。 */
const fs = require('node:fs');
const path = require('node:path');
let pool;

function configured() {
  return Boolean(process.env.DATABASE_URL && !process.env.DATABASE_URL.includes('REPLACE_WITH_'));
}

function getPool() {
  if (!configured()) {
    const error = new Error('DATABASE_NOT_CONFIGURED');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
  if (pool) return pool;
  // 延迟加载：未安装依赖时，项目仍可作为本机演示版启动；连接数据库前需 npm install。
  const { Pool } = require('pg');

  const caPath = process.env.PG_SSL_CA_PATH;
  const ssl = {
    // Aiven 连接必须启用 TLS；有 CA 时会严格校验证书。
    rejectUnauthorized: process.env.PG_SSL_REJECT_UNAUTHORIZED !== 'false'
  };
  if (caPath) ssl.ca = fs.readFileSync(path.resolve(__dirname, caPath), 'utf8');

  pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl,
    max: Number(process.env.DB_POOL_MAX || 5),
    idleTimeoutMillis: 10_000,
    connectionTimeoutMillis: 10_000
  });
  return pool;
}

async function query(text, values) {
  return getPool().query(text, values);
}

async function transaction(work) {
  const client = await getPool().connect();
  try {
    await client.query('BEGIN');
    const result = await work(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

async function closePool() {
  if (pool) await pool.end();
  pool = undefined;
}

module.exports = { configured, getPool, query, transaction, closePool };
