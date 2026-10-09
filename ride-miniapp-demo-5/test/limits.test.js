const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepository } = require('./memory-repository.js');
const { startTestServer } = require('./helpers.js');

describe('注册限流', () => {
  it('同一个地址短时间内注册太多次会被暂时拒绝', async () => {
    const running = await startTestServer(createMemoryRepository(), { config: { registerLimit: 3 } });
    try {
      const statuses = [];
      for (let i = 0; i < 5; i += 1) {
        const response = await fetch(`${running.baseUrl}/api/auth/register`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ role: 'passenger', email: `u${i}-${Date.now()}@migo-test.invalid`, password: 'password-123', name: '测试' })
        });
        statuses.push(response.status);
      }
      assert.deepEqual(statuses, [201, 201, 201, 429, 429]);
    } finally {
      await running.close();
    }
  });
});
