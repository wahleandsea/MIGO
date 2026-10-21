require('dotenv').config();
const fs = require('fs');
const dbSelect = require('../database-select.js');
const log = [];
(async () => {
  if (dbSelect.useMongo()) {
    const { db } = require('../mongo-database.js');
    const t = Date.now();
    const database = await db();
    const stats = await database.stats();
    log.push('OK ' + (Date.now() - t) + 'ms db=' + database.databaseName + ' collections=' + stats.collections);
  } else {
    log.push('NOT MONGO MODE');
  }
  fs.writeFileSync('C:/Users/zonly/Desktop/ride-miniapp-demo-5/diag-out.txt', log.join('\n'), 'utf8');
})().catch((e) => {
  fs.writeFileSync('C:/Users/zonly/Desktop/ride-miniapp-demo-5/diag-out.txt', 'FAIL: ' + e.message.split('\n')[0], 'utf8');
});
