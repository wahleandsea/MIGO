// 用真正的网页程序 + 真正的服务器规则，把“微信登录 → 叫车 → 接单 → 完成 → 评价”从头到尾走一遍。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryRepository } = require('./memory-repository.js');
const { startTestServer } = require('./helpers.js');
const { openApp, createStorage } = require('./bundle-runner.js');

const uid = () => Math.random().toString(16).slice(2, 8);
const ADMIN_KEY = 'demo-admin';
const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';

// 在浏览器存储里模拟“后台审核通过”（等价于后台审核台点“通过”）。
function approveLocalDriver(storage) {
  const state = JSON.parse(storage.getItem('milan-ride-demo-state-v1'));
  const driver = state.profile.driver;
  driver.docs = { ...(driver.docs || {}), status: 'approved', reviewedAt: new Date().toISOString(), rejectReason: '' };
  driver.italianLicenseVerified = true;
  driver.chinaIdVerified = true;
  // 同步写回该微信身份的档案，保证换微信登录后旧账号状态不丢
  const openid = storage.getItem('milano-ride-wechat-openid');
  if (openid && state.driverProfiles) state.driverProfiles[openid] = driver;
  storage.setItem('milan-ride-demo-state-v1', JSON.stringify(state));
}

// 从浏览器存储里取出登录令牌，用来查账号 / 走后台接口。
function tokenOf(storage) {
  const entry = Object.entries(storage.data).find(([key]) => key.startsWith('milano-ride-token'));
  return entry ? entry[1] : null;
}

const wx = async (app) => { await app.click({ action: 'wechat-auth' }); await app.click({ action: 'wechat-login' }); };

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
  const browser = createStorage(); // 同一个浏览器：乘客端和司机端共用 localStorage，但各自的登录令牌互不相同

  it('未登录时只看到微信登录页，没有底部导航', async () => {
    const app = await open('passenger', browser);
    assert.match(app.html(), /微信一键登录/);
    assert.match(app.html(), /仅支持微信授权登录/);
    assert.doesNotMatch(app.html(), /data-screen="home"/);
    assert.doesNotMatch(app.html(), /呼叫附近司机/);
  });

  it('乘客：微信授权登录后进入首页，叫车价格由服务器算出', async () => {
    const app = await open('passenger', browser);
    await app.click({ action: 'wechat-auth' });
    assert.match(app.html(), /同意并登录/);
    await app.click({ action: 'wechat-login' });
    assert.match(app.html(), /呼叫附近司机/);
    assert.match(app.html(), /微信身份 · 微信好友/); // 主页显示当前微信身份
    assert.match(app.html(), /退出登录/); // 主页可直接退出换微信
    app.type('pickup', 'Stazione Centrale');
    app.type('destination', 'Navigli');
    await app.click({ action: 'book-ride' });
    assert.match(app.html(), /正在匹配/);
    assert.match(app.html(), /€38\.60/); // 默认 12.4 公里、推荐路线
    assert.match(app.html(), /Stazione Centrale/);
    // 取消本单，避免残留订单影响后续用例
    const cancelId = app.idOf('cancel-order');
    assert.ok(cancelId, '下单后应显示取消按钮');
    await app.click({ action: 'cancel-order', id: cancelId });
    assert.match(app.html(), /订单已取消/);
  });

  it('司机端：微信登录后必须提交意大利驾照+中国身份证，后台审核通过才能上线接单', async () => {
    const pax = await open('passenger', browser);
    await wx(pax);
    pax.type('pickup', 'Stazione Centrale');
    pax.type('destination', 'Navigli');
    await pax.click({ action: 'book-ride' });
    assert.match(pax.html(), /正在匹配/);

    // 司机：微信登录 → 新司机自动进入认证页
    const driver = await open('driver', createStorage());
    assert.match(driver.html(), /司机端登录/);
    await wx(driver);
    assert.match(driver.html(), /司机认证/);
    assert.match(driver.html(), /意大利驾照/);
    assert.match(driver.html(), /中国身份证/);
    assert.doesNotMatch(driver.html(), /Stazione Centrale/); // 未通过审核看不到订单

    // 未上传照片不能提交认证
    await driver.submit('driver-verify', {
      name: 'Marco', phone: '+39 333 111 2222', car: 'Fiat Panda · AB123CD',
      licenseNumber: 'ITMIL1234567', licenseExpiry: '2030-06', chinaId: '110101199001011234'
    });
    assert.match(driver.html(), /请上传意大利驾照照片和中国身份证照片/);

    // 提交认证资料（含驾照/身份证照片）→ 进入“资料审核中”
    await driver.submit('driver-verify', {
      name: 'Marco', phone: '+39 333 111 2222', car: 'Fiat Panda · AB123CD',
      licenseNumber: 'ITMIL1234567', licenseExpiry: '2030-06', chinaId: '110101199001011234',
      licensePhoto: PHOTO, chinaIdPhoto: PHOTO
    });
    assert.match(driver.html(), /资料审核中/);
    assert.doesNotMatch(driver.html(), /Stazione Centrale/);

    // 后台审核通过（管理员接口）
    const state = await (await fetch(`${running.baseUrl}/api/state`, { headers: { Authorization: `Bearer ${tokenOf(driver.storage)}` } })).json();
    const review = await fetch(`${running.baseUrl}/api/admin/drivers/${state.me.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
      body: JSON.stringify({ action: 'approve' })
    });
    assert.equal(review.status, 200);

    // 刷新页面（重新打开）：已通过审核，上线后能看到并接下订单
    const approved = await open('driver', driver.storage);
    assert.match(approved.html(), /司机账号已通过审核/);
    assert.match(approved.html(), /退出登录/); // 司机主页也能直接退出换微信
    await approved.toggle('driverOnline', true);
    assert.match(approved.html(), /Stazione Centrale/);
    assert.match(approved.html(), /接单后可见/); // 接单前看不到乘客姓名
    assert.doesNotMatch(approved.html(), /乘客：微信好友/);

    await approved.click({ action: 'driver-accept', id: approved.idOf('driver-accept') });
    assert.match(approved.html(), /到达上车点/);
    assert.match(approved.html(), /乘客：微信好友/);
    await approved.click({ action: 'driver-arrived', id: approved.idOf('driver-arrived') });
    assert.match(approved.html(), /客人已上车/);
    await approved.click({ action: 'driver-board', id: approved.idOf('driver-board') });
    assert.match(approved.html(), /开始行程/);
    await approved.click({ action: 'start-trip', id: approved.idOf('start-trip') });
    assert.match(approved.html(), /完成行程/);
    await approved.click({ action: 'complete-trip', id: approved.idOf('complete-trip') });
    assert.doesNotMatch(approved.html(), /完成行程/);
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

    // 两个司机都走微信登录 + 认证 + 后台通过
    async function approvedDriver() {
      const driver = await open('driver', createStorage());
      await wx(driver);
      await driver.submit('driver-verify', {
        name: 'Luca', phone: '+39 333 999 0000', car: 'VW Touran · ZZ999ZZ',
        licenseNumber: 'ITMIL7654321', licenseExpiry: '2031-12', chinaId: '110101199002022345',
        licensePhoto: PHOTO, chinaIdPhoto: PHOTO
      });
      const state = await (await fetch(`${running.baseUrl}/api/state`, { headers: { Authorization: `Bearer ${tokenOf(driver.storage)}` } })).json();
      await fetch(`${running.baseUrl}/api/admin/drivers/${state.me.id}/review`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'X-Admin-Key': ADMIN_KEY },
        body: JSON.stringify({ action: 'approve' })
      });
      const approved = await open('driver', driver.storage);
      await approved.toggle('driverOnline', true);
      return approved;
    }
    const slow = await approvedDriver();
    const orderId = slow.idOf('driver-accept');
    assert.ok(orderId, 'Luca 应该能看到新订单');

    const fast = await approvedDriver();
    await fast.click({ action: 'driver-accept', id: fast.idOf('driver-accept') });
    assert.match(fast.html(), /到达上车点/);

    await slow.click({ action: 'driver-accept', id: orderId }); // Luca 的页面还停留在旧状态
    assert.match(slow.html(), /已经被其他司机接走/);
    assert.equal(slow.idOf('driver-accept'), null); // 页面已刷新，订单不再出现
  });

  it('同一个微信不能在乘客端和司机端同时使用；退出登录后回到微信登录页', async () => {
    const wrong = await open('driver', browser); // browser 里该微信已是乘客账号
    await wrong.click({ action: 'wechat-auth' });
    await wrong.click({ action: 'wechat-login' });
    assert.match(wrong.html(), /这个微信已注册为乘客账号/);

    const pax = await open('passenger', browser);
    await pax.click({ action: 'nav', screen: 'profile' });
    assert.match(pax.html(), /MongoDB 数据库已连接/);
    await pax.click({ action: 'logout' });
    assert.match(pax.html(), /微信一键登录/);
    assert.equal(browser.getItem('milano-ride-token-passenger'), null);
    const reopened = await open('passenger', browser);
    assert.match(reopened.html(), /微信一键登录/);
  });

  it('登录过期（令牌被服务器作废）时，操作会回到登录页而不是报错卡住', async () => {
    const pax = await open('passenger', createStorage());
    await wx(pax);
    assert.match(pax.html(), /呼叫附近司机/);
    const token = tokenOf(pax.storage);
    await fetch(`${running.baseUrl}/api/auth/logout`, { method: 'POST', headers: { Authorization: `Bearer ${token}` } }); // 在别处退出了
    await pax.click({ action: 'book-ride' });
    assert.match(pax.html(), /登录已过期，请重新登录/);
  });

  it('退出后重新微信登录：不同微信是不同账号（服务器按 openid 区分）', async () => {
    const browser = createStorage();
    const meId = async (app) => {
      const state = await (await fetch(`${running.baseUrl}/api/state`, { headers: { Authorization: `Bearer ${tokenOf(app.storage)}` } })).json();
      return state.me.id;
    };
    const first = await open('driver', browser);
    await wx(first);
    assert.match(first.html(), /司机认证/);
    const id1 = await meId(first);

    // 退出登录（清掉微信身份）
    await first.click({ action: 'nav', screen: 'driver-profile' });
    await first.click({ action: 'logout' });
    assert.match(first.html(), /微信一键登录/);
    assert.equal(browser.getItem('milano-ride-wechat-openid'), null, '退出后微信身份应被清除');

    // 重新登录 = 新微信 = 新司机账号
    const second = await open('driver', browser);
    await wx(second);
    assert.match(second.html(), /司机认证/);
    const id2 = await meId(second);
    assert.notEqual(id2, id1, '不同微信登录应是不同账号');
    assert.equal(second.idOf('driver-accept'), null); // 新账号未认证，看不到订单
  });
});

describe('本机演示模式（双击打开，不连数据库）仍然可用', () => {
  it('乘客必须先微信授权登录才能叫车；司机需提交认证并经后台审核后才能接单', async () => {
    const browser = createStorage();
    const pax = await openApp('passenger', { storage: browser });
    assert.match(pax.html(), /微信一键登录/); // 未登录只看到微信登录页
    assert.doesNotMatch(pax.html(), /呼叫附近司机/);
    await pax.click({ action: 'wechat-auth' });
    await pax.click({ action: 'wechat-login' });
    assert.match(pax.html(), /呼叫附近司机/);
    assert.match(pax.html(), /退出登录/); // 本机演示主页也有退出入口
    await pax.click({ action: 'book-ride' });
    assert.match(pax.html(), /正在匹配/);

    const driver = await openApp('driver', { storage: browser });
    assert.match(driver.html(), /微信一键登录/); // 司机也要先微信登录
    await driver.click({ action: 'wechat-auth' });
    await driver.click({ action: 'wechat-login' });
    assert.match(driver.html(), /司机认证/); // 首次登录进入认证表单
    assert.doesNotMatch(driver.html(), /信誉分/); // 审核通过前不显示信誉分/评分/名字
    await driver.submit('driver-verify', {
      name: 'Marco', phone: '+39 333 820 4681', car: 'Mercedes Vito · IT 786 MR',
      licenseNumber: 'ITMIL1234567', licenseExpiry: '2030-06', chinaId: '110101199001011234',
      licensePhoto: PHOTO, chinaIdPhoto: PHOTO
    });
    assert.match(driver.html(), /资料审核中/);
    assert.doesNotMatch(driver.html(), /Marco/); // 待审核状态仍不显示名字

    approveLocalDriver(browser); // 后台审核台（本机模式）通过
    const approved = await openApp('driver', { storage: browser });
    assert.match(approved.html(), /司机账号已通过审核/);
    assert.match(approved.html(), /你好，Marco/); // 审核通过后才显示姓名
    assert.match(approved.html(), /信誉分/); // 以及信誉分与评分
    await approved.toggle('driverOnline', true);
    await approved.click({ action: 'driver-accept', id: approved.idOf('driver-accept') });
    assert.match(approved.html(), /到达上车点/);
    await approved.click({ action: 'driver-arrived', id: approved.idOf('driver-arrived') });
    assert.match(approved.html(), /客人已上车/);
    await approved.click({ action: 'driver-board', id: approved.idOf('driver-board') });
    assert.match(approved.html(), /开始行程/);
    await approved.click({ action: 'start-trip', id: approved.idOf('start-trip') });
    await approved.click({ action: 'complete-trip', id: approved.idOf('complete-trip') });

    // 后台“暂停使用”→ 司机端提示“使用权限已暂停”，接单开关禁用
    const accountState = () => JSON.parse(browser.getItem('milan-ride-demo-state-v1'));
    const setAccount = (accountStatus) => {
      const state = accountState();
      state.profile.driver.accountStatus = accountStatus;
      state.profile.driver.online = false; // 暂停/关闭同时强制下线
      const openid = browser.getItem('milano-ride-wechat-openid');
      if (openid && state.driverProfiles) state.driverProfiles[openid] = state.profile.driver;
      browser.setItem('milan-ride-demo-state-v1', JSON.stringify(state));
    };
    setAccount('suspended');
    const suspendedDriver = await openApp('driver', { storage: browser });
    assert.match(suspendedDriver.html(), /使用权限已暂停/);
    assert.doesNotMatch(suspendedDriver.html(), /你好，Marco/);
    assert.match(suspendedDriver.html(), /data-field="driverOnline"[^>]*disabled/);

    // 后台“强制关闭”（不符合平台规定）→ 司机端提示关闭原因，姓名/信誉分不再展示
    setAccount('closed');
    const closedDriver = await openApp('driver', { storage: browser });
    assert.match(closedDriver.html(), /账号已被关闭/);
    assert.match(closedDriver.html(), /不符合平台规定/);
    assert.doesNotMatch(closedDriver.html(), /你好，Marco/);
    assert.match(closedDriver.html(), /data-field="driverOnline"[^>]*disabled/);

    const reopened = await openApp('passenger', { storage: browser });
    await reopened.click({ action: 'nav', screen: 'orders' });
    assert.match(reopened.html(), /已完成/);
    // 退出登录回到微信登录页
    await reopened.click({ action: 'nav', screen: 'profile' });
    await reopened.click({ action: 'logout' });
    assert.match(reopened.html(), /微信一键登录/);
    [pax, driver, approved, suspendedDriver, closedDriver, reopened].forEach((app) => app.close());
  });

  it('退出后重新微信登录：不同微信是不同账号；后台保留每位司机的独立档案', async () => {
    const browser = createStorage();
    // 第一个微信：登录 → 提交认证 → 后台通过
    const first = await openApp('driver', { storage: browser });
    await first.click({ action: 'wechat-auth' });
    await first.click({ action: 'wechat-login' });
    await first.submit('driver-verify', {
      name: 'Marco', phone: '+39 333 820 4681', car: 'Mercedes Vito · IT 786 MR',
      licenseNumber: 'ITMIL1234567', licenseExpiry: '2030-06', chinaId: '110101199001011234',
      licensePhoto: PHOTO, chinaIdPhoto: PHOTO
    });
    assert.match(first.html(), /资料审核中/);
    approveLocalDriver(browser);
    const approved = await openApp('driver', { storage: browser });
    assert.match(approved.html(), /你好，Marco/);
    const firstOpenid = browser.getItem('milano-ride-wechat-openid');
    assert.ok(firstOpenid);

    // 退出：清除微信身份
    await approved.click({ action: 'logout' });
    assert.match(approved.html(), /微信一键登录/);
    assert.equal(browser.getItem('milano-ride-wechat-openid'), null, '退出后微信身份应被清除');

    // 第二个微信：重新登录 → 全新司机（未认证），不是 Marco
    const second = await openApp('driver', { storage: browser });
    await second.click({ action: 'wechat-auth' });
    await second.click({ action: 'wechat-login' });
    assert.match(second.html(), /司机认证/); // 新身份首次登录进入认证表单
    assert.doesNotMatch(second.html(), /Marco/); // 不是旧账号（表单预填的是新微信身份）
    assert.match(second.html(), /微信司机·/); // 新司机有独立的微信身份名
    const secondOpenid = browser.getItem('milano-ride-wechat-openid');
    assert.ok(secondOpenid);
    assert.notEqual(secondOpenid, firstOpenid, '重新登录应是新的微信身份');

    // 后台档案：两位司机都还在（第一个已通过、第二个未认证），互不覆盖
    const state = JSON.parse(browser.getItem('milan-ride-demo-state-v1'));
    const profiles = state.driverProfiles || {};
    assert.ok(profiles[firstOpenid], '第一个微信的司机档案应保留');
    assert.equal(profiles[firstOpenid].docs.status, 'approved');
    assert.ok(profiles[secondOpenid], '第二个微信的司机档案应已建立');
    assert.equal(profiles[secondOpenid].docs.status, 'none');

    [first, approved, second].forEach((app) => app.close());
  });
});
