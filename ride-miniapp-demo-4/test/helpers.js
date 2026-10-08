const { createApp } = require('../server.js');
const { loadPricing } = require('../pricing-loader.js');

/** 可以“快进”的时钟：用来测试 24 小时评价期、每月重置取消次数等。 */
function makeClock() {
  let offset = 0;
  return {
    get now() { return new Date(Date.now() + offset); },
    advance(ms) { offset += ms; },
    reset() { offset = 0; }
  };
}

/** 在随机空闲端口上启动一个测试用服务器。 */
// 测试会在同一个地址上注册很多账号，所以默认放宽“注册次数”限制；限流本身在 limits.test.js 里单独测试。
async function startTestServer(repository, { clock = makeClock(), config = {} } = {}) {
  config = { driverAutoApprove: false, registerLimit: 100_000, ...config };
  const server = createApp({ repository, pricing: loadPricing(), clock: () => clock.now, config });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    server, clock,
    baseUrl: `http://127.0.0.1:${server.address().port}`,
    close: () => new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); })
  };
}

module.exports = { makeClock, startTestServer };
