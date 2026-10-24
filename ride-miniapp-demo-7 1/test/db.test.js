// 真实数据库测试：只有运行 npm.cmd run test:db 时才会执行，平时的 npm.cmd test 会跳过。
// 它验证 repository.js 里的 SQL 和内存版遵守完全相同的规则（抢单只有一个成功、状态不能乱跳等）。
const { describe, it } = require('node:test');

if (process.env.RUN_DB_TESTS !== '1') {
  describe('接口规则（真实 PostgreSQL）', () => {
    it('已跳过：运行 npm.cmd run test:db 才会连接数据库', { skip: true }, () => {});
  });
} else {
  try { require('dotenv').config(); } catch { /* 没装 dotenv 时依赖系统环境变量 */ }
  const { configured, query, closePool } = require('../database.js');
  const repository = require('../repository.js');
  const { startTestServer } = require('./helpers.js');
  const { defineApiScenarios } = require('./scenarios.js');

  const TEST_EMAIL = '%@migo-test.invalid';
  const IDS = '(SELECT id FROM users WHERE email LIKE $1)';

  async function cleanup() {
    // 按依赖顺序删除测试数据；只会碰邮箱以 @migo-test.invalid 结尾的测试账号及其订单。
    await query(`DELETE FROM ratings WHERE user_id IN ${IDS}`, [TEST_EMAIL]);
    await query(`DELETE FROM complaints WHERE user_id IN ${IDS}`, [TEST_EMAIL]);
    await query(`DELETE FROM lost_items WHERE user_id IN ${IDS}`, [TEST_EMAIL]);
    await query(`DELETE FROM orders WHERE passenger_id IN ${IDS} OR driver_id IN ${IDS}`, [TEST_EMAIL]);
    await query('DELETE FROM users WHERE email LIKE $1', [TEST_EMAIL]);
  }

  defineApiScenarios('接口规则（真实 PostgreSQL）', async () => {
    if (!configured()) throw new Error('未配置 DATABASE_URL：请先按 README 配置 .env，并运行 npm.cmd run db:migrate');
    await cleanup();
    const running = await startTestServer(repository);
    return {
      ...running,
      approve: (email) => repository.approveDriver(email),
      close: async () => { await running.close(); await cleanup(); await closePool(); }
    };
  });
}
