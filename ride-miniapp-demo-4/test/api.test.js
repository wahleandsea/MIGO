// 用“内存版数据库”把服务器接口的所有规则完整跑一遍（不需要真正的数据库）。
const { createMemoryRepository } = require('./memory-repository.js');
const { startTestServer } = require('./helpers.js');
const { defineApiScenarios } = require('./scenarios.js');

defineApiScenarios('接口规则（内存数据库）', async () => {
  const repository = createMemoryRepository();
  const running = await startTestServer(repository);
  return { ...running, approve: (email) => repository.approveDriver(email) };
});
