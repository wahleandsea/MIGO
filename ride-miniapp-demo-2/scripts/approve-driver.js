/**
 * 批准司机账号：新注册的司机默认“待审核”，不能接单。
 * 用法：npm.cmd run approve-driver -- 司机邮箱@example.com
 */
require('dotenv').config();

const { configured, closePool } = require('../database.js');
const repository = require('../repository.js');

async function main() {
  const email = process.argv[2];
  if (!email) throw new Error('请提供司机邮箱，例如：npm.cmd run approve-driver -- driver@example.com');
  if (!configured()) throw new Error('未配置 DATABASE_URL。请先复制 .env.example 为 .env 并填写 Aiven 密码。');
  const found = await repository.approveDriver(email);
  if (!found) throw new Error(`没有找到司机账号：${email}（请确认邮箱拼写，并且是在司机端注册的）`);
  console.log(`已批准司机：${email}`);
}

main()
  .catch((error) => { console.error(`操作失败：${error.message}`); process.exitCode = 1; })
  .finally(() => closePool());
