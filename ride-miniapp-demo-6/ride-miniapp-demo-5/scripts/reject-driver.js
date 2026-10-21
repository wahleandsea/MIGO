/**
 * 拒绝司机账号（后台审核用）：把待审核司机标记为“已拒绝”并记录原因。
 * 用法：npm.cmd run reject-driver -- 司机邮箱@example.com "拒绝原因"
 * 数据存储自动选择：配了 MONGO_URI 用 MongoDB Atlas，否则用 PostgreSQL（DATABASE_URL）。
 */
require('dotenv').config();

const dbSelect = require('../database-select.js');

async function main() {
  const email = String(process.argv[2] || '').trim().toLowerCase();
  const reason = String(process.argv[3] || '').trim() || '资料审核未通过';
  if (!email) throw new Error('请提供司机邮箱，例如：npm.cmd run reject-driver -- driver@example.com "证件不清晰"');
  if (!dbSelect.configured()) throw new Error('未配置 MONGO_URI 或 DATABASE_URL。请先复制 .env.example 为 .env 并填写数据库连接串。');
  const repository = dbSelect.repository();
  const drivers = await repository.listDrivers('pending');
  const found = drivers.find((driver) => String(driver.email || '').toLowerCase() === email);
  if (!found) throw new Error(`没有找到待审核司机：${email}（请确认邮箱拼写，并且司机已提交认证资料）`);
  await repository.reviewDriver(found.id, { action: 'reject', reason, reviewedAt: new Date() });
  console.log(`已拒绝司机：${email}（原因：${reason}）`);
}

main()
  .catch((error) => { console.error(`操作失败：${error.message}`); process.exitCode = 1; })
  .finally(() => dbSelect.close());
