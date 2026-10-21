require('dotenv').config();
const fs = require('fs');
const log = [];
log.push('URI len=' + (process.env.MONGO_URI || '').length);
const { MongoClient } = require('mongodb');
const c = new MongoClient(process.env.MONGO_URI, { serverSelectionTimeoutMS: 15000, connectTimeoutMS: 15000 });
const t = Date.now();
c.connect().then(() => {
  log.push('CONNECT OK ' + (Date.now() - t) + 'ms');
  return c.close();
}).catch((e) => {
  log.push('CONNECT FAIL ' + (Date.now() - t) + 'ms: ' + e.message.split('\n')[0]);
}).finally(() => {
  fs.writeFileSync('diag-out.txt', log.join('\n'), 'utf8');
  console.log('done');
});
