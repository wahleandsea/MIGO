// 用官方 mongodb 驱动直连标准 URI（不走 DoH 直连 IP），验证是否同样被拒
require('dotenv').config();
const { MongoClient } = require('mongodb');

async function main() {
  const uri = process.env.MONGO_URI;
  console.log('URI 主机:', uri.replace(/\/\/[^@]+@/, '//***@'));
  const client = new MongoClient(uri, {
    serverSelectionTimeoutMS: 15000,
    connectTimeoutMS: 15000,
    tls: true
  });
  const t = Date.now();
  try {
    await client.connect();
    await client.db(process.env.MONGO_DB).command({ ping: 1 });
    console.log(`官方驱动直连成功 (${Date.now() - t}ms)`);
  } catch (e) {
    console.log(`官方驱动直连失败 (${Date.now() - t}ms): ${e.message}`);
  } finally {
    await client.close().catch(() => {});
  }
}
main();
