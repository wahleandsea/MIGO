// 用真正的网页程序 + 真正的服务器规则，把“注册 → 叫车 → 接单 → 完成 → 评价”从头到尾走一遍。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepository } = require('./memory-repository.js');
const { startTestServer } = require('./helpers.js');
const { openApp, createStorage } = require('./bundle-runner.js');

const uid = () => Math.random().toString(16).slice(2, 8);

describe('网页与服务器联调（已连接数据库）', () => {
  let running;
  let repository;
  const opened = [];
  before(async () => {
    repository = createMemoryRepository();
    running = await startTestServer(repository);
  });
  after(async () => { opened.forEach((app) => app.close()); await running.close(); });

  const open = async (role, storage) => { const app = await openApp(role, { baseUrl: running.baseUrl, storage }); opened.push(app); return app; };
  const passengerAccount = { email: `pax-${uid()}@migo-test.invalid`, password: 'password-123' };
  const driverAccount = { email: `drv-${uid()}@migo-test.invalid`, password: 'password-123' };
  const browser = createStorage(); // 同一个浏览器：乘客端和司机端共用 localStorage，但各自的登录令牌互不相同

  it('未登录时只看到登录页，没有底部导航', async () => {
    const app = await open('passenger', browser);
    assert.match(app.html(), /登录乘客账号/);
    assert.doesNotMatch(app.html(), /data-screen="home"/);
    assert.doesNotMatch(app.html(), /呼叫附近司机/);
  });

  it('注册出错时显示服务器给出的原因，并保留已填写的邮箱', async () => {
    const app = await open('passenger', browser);
    await app.click({ action: 'auth-mode', mode: 'register' });
    assert.match(app.html(), /注册乘客账号/);
    await app.submit('register', { name: '小满', email: passengerAccount.email, password: '123' });
    assert.match(app.html(), /密码至少需要 8 位/);
    assert.ok(app.html().includes(passengerAccount.email));
  });

  it('注册成功后进入首页，叫车的价格由服务器算出', async () => {
    const app = await open('passenger', browser);
    await app.click({ action: 'auth-mode', mode: 'register' });
    await app.submit('register', { name: '小满', ...passengerAccount });
    assert.match(app.html(), /呼叫附近司机/);
    app.type('pickup', 'Stazione Centrale');
    app.type('destination', 'Navigli');
    await app.click({ action: 'book-ride' });
    assert.match(app.html(), /正在匹配/);
    assert.match(app.html(), /€38\.60/); // 默认 12.4 公里、推荐路线
    assert.match(app.html(), /Stazione Centrale/);
  });

  it('司机端：注册后待审核，审核通过并上线后能看到并接下订单', async () => {
    const app = await open('driver', createStorage());
    assert.match(app.html(), /登录司机账号/);
    await app.click({ action: 'auth-mode', mode: 'register' });
    assert.match(app.html(), /车辆信息/);
    await app.submit('register', { name: 'Marco', ...driverAccount, phone: '+39 333 111 2222', car: 'Fiat Panda · AB123CD' });
    assert.match(app.html(), /正在审核中/);
    assert.doesNotMatch(app.html(), /Stazione Centrale/);

    await repository.approveDriver(driverAccount.email);
    await app.toggle('driverOnline', true);
    assert.match(app.html(), /司机账号已通过审核/);
    assert.match(app.html(), /Stazione Centrale/);
    assert.match(app.html(), /接单后可见/); // 接单前看不到乘客姓名
    assert.doesNotMatch(app.html(), /小满/);

    await app.click({ action: 'driver-accept', id: app.idOf('driver-accept') });
    assert.match(app.html(), /开始行程/);
    assert.match(app.html(), /乘客：小满/);
    await app.click({ action: 'start-trip', id: app.idOf('start-trip') });
    assert.match(app.html(), /完成行程/);
    await app.click({ action: 'complete-trip', id: app.idOf('complete-trip') });
    assert.doesNotMatch(app.html(), /完成行程/);
  });

  it('乘客重新打开页面：登录状态保留；看到已完成的订单并评价', async () => {
    const app = await open('passenger', browser); // 相当于刷新页面
    assert.match(app.html(), /呼叫附近司机/);
    await app.click({ action: 'nav', screen: 'orders' });
    assert.match(app.html(), /已完成/);
    await app.click({ action: 'nav', screen: 'services' });
    await app.click({ action: 'open-rating' });
    const orderId = /name="orderId" value="([^"]+)"/.exec(app.html())[1];
    await app.submit('rating', { orderId, score: '5', comment: '很好' });
    assert.match(app.html(), /感谢你的评价/);
    assert.doesNotMatch(app.html(), /本地演示数据/);
    await app.submit('rating', { orderId, score: '5', comment: '再评一次' });
    assert.match(app.html(), /已经评价过了/); // 服务器拒绝，页面显示原因
  });

  it('两位司机抢同一单：后到的司机看到提示，列表自动更新', async () => {
    const pax = await open('passenger', browser);
    await pax.click({ action: 'nav', screen: 'home' });
    pax.type('pickup', 'Porta Romana');
    pax.type('destination', 'Linate');
    await pax.click({ action: 'book-ride' });

    const second = { email: `drv2-${uid()}@migo-test.invalid`, password: 'password-123' };
    const slow = await open('driver', createStorage());
    await slow.click({ action: 'auth-mode', mode: 'register' });
    await slow.submit('register', { name: 'Luca', ...second, phone: '+39 333 999 0000', car: 'VW Touran · ZZ999ZZ' });
    await repository.approveDriver(second.email);
    await slow.toggle('driverOnline', true);
    const orderId = slow.idOf('driver-accept');
    assert.ok(orderId, 'Luca 应该能看到新订单');

    const fast = await open('driver', createStorage());
    await fast.submit('login', { ...driverAccount });
    await fast.click({ action: 'driver-accept', id: fast.idOf('driver-accept') });
    assert.match(fast.html(), /开始行程/);

    await slow.click({ action: 'driver-accept', id: orderId }); // Luca 的页面还停留在旧状态
    assert.match(slow.html(), /已经被其他司机接走/);
    assert.equal(slow.idOf('driver-accept'), null); // 页面已刷新，订单不再出现
  });

  it('用错误的端登录会有明确提示；退出登录后回到登录页', async () => {
    const wrong = await open('driver', createStorage());
    await wrong.submit('login', { ...passengerAccount });
    assert.match(wrong.html(), /这个账号是乘客账号，请在乘客端登录/);
    await wrong.submit('login', { email: driverAccount.email, password: 'bad-password' });
    assert.match(wrong.html(), /邮箱或密码不正确/);

    const pax = await open('passenger', browser);
    await pax.click({ action: 'nav', screen: 'profile' });
    assert.match(pax.html(), /PostgreSQL 数据库已连接/);
    await pax.click({ action: 'logout' });
    assert.match(pax.html(), /登录乘客账号/);
    assert.equal(browser.getItem('milano-ride-token-passenger'), null);
    const reopened = await open('passenger', browser);
    assert.match(reopened.html(), /登录乘客账号/);
  });

  it('登录过期（令牌被服务器作废）时，操作会回到登录页而不是报错卡住', async () => {
    const pax = await open('passenger', createStorage());
    await pax.click({ action: 'auth-mode', mode: 'register' });
    await pax.submit('register', { name: '过期测试', email: `exp-${uid()}@migo-test.invalid`, password: 'password-123' });
    assert.match(pax.html(), /呼叫附近司机/);
    const [token] = Object.entries(pax.storage.data).find(([key]) => key.startsWith('milano-ride-token')).slice(1);
    await fetch(`${running.baseUrl}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); // 在别处退出了
    await pax.click({ action: 'book-ride' });
    assert.match(pax.html(), /登录已过期，请重新登录/);
  });
});

describe('本机演示模式（双击打开，不连数据库）仍然可用', () => {
  it('不需要登录；乘客下单，司机接单、完成', async () => {
    const browser = createStorage();
    const pax = await openApp('passenger', { storage: browser });
    assert.match(pax.html(), /呼叫附近司机/);
    assert.doesNotMatch(pax.html(), /登录乘客账号/);
    await pax.click({ action: 'book-ride' });
    assert.match(pax.html(), /正在匹配/);

    const driver = await openApp('driver', { storage: browser });
    assert.match(driver.html(), /Milano Centrale/);
    await driver.click({ action: 'driver-accept', id: driver.idOf('driver-accept') });
    assert.match(driver.html(), /开始行程/);
    await driver.click({ action: 'start-trip', id: driver.idOf('start-trip') });
    await driver.click({ action: 'complete-trip', id: driver.idOf('complete-trip') });

    const reopened = await openApp('passenger', { storage: browser });
    await reopened.click({ action: 'nav', screen: 'orders' });
    assert.match(reopened.html(), /已完成/);
    [pax, driver, reopened].forEach((app) => app.close());
  });
});
