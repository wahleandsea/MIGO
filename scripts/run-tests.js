/**
 * 运行测试（不需要额外安装任何东西）。
 *   npm.cmd test          运行全部本地测试（不碰数据库）
 *   npm.cmd run test:db   连接你 .env 里的 Aiven 数据库，真实跑一遍接口规则
 *                         （会创建一些 @migo-test.invalid 的测试账号，结束后自动删除）
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const dbMode = process.argv.includes('--db');
const dir = path.join(__dirname, '..', 'test');
const files = fs.readdirSync(dir)
  .filter((name) => name.endsWith('.test.js'))
  .filter((name) => (dbMode ? name === 'db.test.js' : name !== 'db.test.js'))
  .map((name) => path.join(dir, name));

const result = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
  stdio: 'inherit',
  env: { ...process.env, ...(dbMode ? { RUN_DB_TESTS: '1' } : {}) }
});
process.exitCode = result.status ?? 1;
