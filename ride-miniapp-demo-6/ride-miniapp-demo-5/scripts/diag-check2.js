require('dotenv').config();
const fs = require('fs');
const out = 'C:/Users/zonly/Desktop/ride-miniapp-demo-5/diag-out.txt';
(async () => {
  const { db, closeClient } = require('../mongo-database.js');
  const t = Date.now();
  const database = await db();
  const stats = await database.stats();
  fs.writeFileSync(out, `OK ${Date.now() - t}ms db=${database.databaseName} collections=${stats.collections} size=${Math.round(stats.dataSize / 1024 / 1024)}MB`, 'utf8');
  await closeClient();
  console.log('DONE');
})().catch((e) => {
  fs.writeFileSync(out, 'FAIL: ' + (e.message || e).split('\n')[0], 'utf8');
  console.log('DONE');
});
