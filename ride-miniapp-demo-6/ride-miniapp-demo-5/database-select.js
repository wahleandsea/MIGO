/** 统一选择数据存储：配了 MONGO_URI 就用 MongoDB Atlas，否则退回 PostgreSQL（DATABASE_URL），都没配则本机演示模式。 */
const mongoConfig = require('./mongo-database.js');
const pgConfig = require('./database.js');

function useMongo() {
  return mongoConfig.configured();
}

function repository() {
  return useMongo() ? require('./mongo-repository.js') : require('./repository.js');
}

/** 有任一数据库可用则返回 true（页面 health 据此决定是否要求登录）。 */
function configured() {
  return useMongo() || pgConfig.configured();
}

async function close() {
  if (useMongo()) await mongoConfig.closeClient();
  else await pgConfig.closePool();
}

module.exports = { useMongo, repository, configured, close };
