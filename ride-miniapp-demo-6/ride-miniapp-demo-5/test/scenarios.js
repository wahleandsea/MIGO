/**
 * 服务器接口的完整测试场景。同一套场景会在两种“数据库”上各跑一遍：
 * - 内存版（test/api.test.js）：随时可以跑，不需要数据库；
 * - 真实 PostgreSQL（npm.cmd run test:db）：验证 SQL 也遵守同样的规则。
 */
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const { loadPricing } = require('../pricing-loader.js');

const pricing = loadPricing();
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const uid = () => Math.random().toString(16).slice(2, 10);

function defineApiScenarios(label, createEnvironment) {
  describe(label, () => {
    let env;
    before(async () => { env = await createEnvironment(); });
    after(async () => { await env.close(); });

    // ---------- 小工具 ----------
    async function http(method, path, { token, body, raw, adminKey } = {}) {
      const headers = {};
      if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
      if (adminKey) headers['X-Admin-Key'] = adminKey;
      const response = await fetch(env.baseUrl + path, { method, headers, body: raw ?? (body === undefined ? undefined : JSON.stringify(body)) });
      let json = null;
      try { json = await response.json(); } catch { /* 没有 JSON 内容 */ }
      return { status: response.status, body: json };
    }
    const post = (path, token, body) => http('POST', path, { token, body });

    async function signUp(role, extra = {}) {
      const email = `${role}-${uid()}@migo-test.invalid`;
      const payload = { role, email, password: 'password-123', name: role === 'driver' ? 'Marco 测试' : '小满 测试', ...extra };
      if (role === 'driver') Object.assign(payload, { phone: '+39 333 000 1111', car: 'Fiat Panda · TEST', ...extra });
      const result = await post('/api/auth/register', null, payload);
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return { email, token: result.body.token, id: result.body.user.id, user: result.body.user };
    }
    async function onlineDriver() {
      const driver = await signUp('driver');
      await env.approve(driver.email);
      const result = await http('PATCH', '/api/profile', { token: driver.token, body: { online: true } });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return driver;
    }
    const ride = (over = {}) => ({ type: 'now', pickup: 'Milano Centrale', destination: 'Duomo di Milano', distanceKm: 20, routeId: 'balanced', paymentMethod: 'alipay', ...over });
    async function book(passenger, over) {
      const result = await post('/api/orders', passenger.token, ride(over));
      assert.equal(result.status, 201, JSON.stringify(result.body));
      return result.body;
    }
    async function state(who) {
      const result = await http('GET', '/api/state', { token: who.token });
      assert.equal(result.status, 200, JSON.stringify(result.body));
      return result.body;
    }
    async function finishedTrip(passenger, driver) {
      const order = await book(passenger);
      assert.equal((await post(`/api/orders/${order.id}/accept`, driver.token)).status, 200);
      assert.equal((await post(`/api/orders/${order.id}/arrive`, driver.token)).status, 200);
      assert.equal((await post(`/api/orders/${order.id}/board`, driver.token)).status, 200);
      assert.equal((await post(`/api/orders/${order.id}/start`, driver.token)).status, 200);
      const done = await post(`/api/orders/${order.id}/complete`, driver.token);
      assert.equal(done.status, 200);
      return done.body;
    }

    // ---------- 账号与登录 ----------
    describe('账号与登录', () => {
      it('注册成功会返回令牌，且不泄露密码信息', async () => {
        const passenger = await signUp('passenger');
        assert.ok(passenger.token.length >= 40);
        assert.equal(passenger.user.role, 'passenger');
        assert.equal(passenger.user.approved, true);
        assert.equal(JSON.stringify(passenger.user).includes('assword'), false);
      });

      it('邮箱不能重复注册（不区分大小写）', async () => {
        const first = await signUp('passenger');
        const again = await post('/api/auth/register', null, { role: 'passenger', email: first.email.toUpperCase(), password: 'password-123', name: 'x' });
        assert.equal(again.status, 409);
        assert.equal(again.body.error, 'EMAIL_TAKEN');
      });

      it('注册信息不合格会被拒绝', async () => {
        const base = { role: 'passenger', email: `a-${uid()}@migo-test.invalid`, password: 'password-123', name: '测试' };
        for (const bad of [
          { password: 'short' }, { email: 'not-an-email' }, { name: '   ' }, { role: 'admin' },
          { role: 'driver' }, { role: 'driver', phone: '+39 333 000 1111' }, { role: 'driver', phone: 'abc', car: 'Fiat' }
        ]) {
          const result = await post('/api/auth/register', null, { ...base, ...bad });
          assert.equal(result.status, 400, JSON.stringify(bad));
        }
      });

      it('登录：密码错误、邮箱不存在都返回同样的提示', async () => {
        const passenger = await signUp('passenger');
        const wrongPassword = await post('/api/auth/login', null, { email: passenger.email, password: 'wrong-password', role: 'passenger' });
        const unknownEmail = await post('/api/auth/login', null, { email: `nobody-${uid()}@migo-test.invalid`, password: 'password-123', role: 'passenger' });
        assert.equal(wrongPassword.status, 401);
        assert.equal(unknownEmail.status, 401);
        assert.equal(wrongPassword.body.message, unknownEmail.body.message);
      });

      it('登录成功；账号类型和登录的端不一致会被拒绝', async () => {
        const passenger = await signUp('passenger');
        const ok = await post('/api/auth/login', null, { email: passenger.email.toUpperCase(), password: 'password-123', role: 'passenger' });
        assert.equal(ok.status, 200);
        assert.ok(ok.body.token);
        const wrongApp = await post('/api/auth/login', null, { email: passenger.email, password: 'password-123', role: 'driver' });
        assert.equal(wrongApp.status, 403);
        assert.equal(wrongApp.body.error, 'WRONG_APP');
      });

      it('退出登录后令牌立即失效；没有令牌或令牌是假的都不能访问', async () => {
        const passenger = await signUp('passenger');
        assert.equal((await http('GET', '/api/state', { token: passenger.token })).status, 200);
        assert.equal((await post('/api/auth/logout', passenger.token)).status, 200);
        assert.equal((await http('GET', '/api/state', { token: passenger.token })).status, 401);
        assert.equal((await http('GET', '/api/state')).status, 401);
        assert.equal((await http('GET', '/api/state', { token: 'x'.repeat(43) })).status, 401);
        assert.equal((await post('/api/orders', null, ride())).status, 401);
      });

      it('连续输错密码会被暂时锁定', async () => {
        const passenger = await signUp('passenger');
        let last;
        for (let i = 0; i < 9; i += 1) last = await post('/api/auth/login', null, { email: passenger.email, password: `wrong-${i}-password`, role: 'passenger' });
        assert.equal(last.status, 429);
        // 锁定期间即使密码正确也不能登录
        assert.equal((await post('/api/auth/login', null, { email: passenger.email, password: 'password-123', role: 'passenger' })).status, 429);
      });
    });

    // ---------- 司机审核 ----------
    describe('司机审核', () => {
      it('未审核的司机不能上线、不能接单、看不到订单；审核后可以', async () => {
        const passenger = await signUp('passenger');
        const order = await book(passenger);
        const driver = await signUp('driver');
        assert.equal(driver.user.approved, false);

        assert.equal((await http('PATCH', '/api/profile', { token: driver.token, body: { online: true } })).status, 403);
        assert.equal((await post(`/api/orders/${order.id}/accept`, driver.token)).status, 403);
        assert.deepEqual((await state(driver)).orders, []);

        await env.approve(driver.email);
        assert.equal((await http('PATCH', '/api/profile', { token: driver.token, body: { online: true } })).status, 200);
        assert.ok((await state(driver)).orders.some((item) => item.id === order.id));
      });

      it('司机离线时看不到新订单，也不能接单', async () => {
        const passenger = await signUp('passenger');
        const order = await book(passenger);
        const driver = await onlineDriver();
        assert.ok((await state(driver)).orders.some((item) => item.id === order.id));
        await http('PATCH', '/api/profile', { token: driver.token, body: { online: false } });
        assert.deepEqual((await state(driver)).orders.filter((item) => item.id === order.id), []);
        assert.equal((await post(`/api/orders/${order.id}/accept`, driver.token)).status, 409);
      });

      it('司机微信登录：首次创建待审核司机；提交认证资料；后台可审核通过/拒绝', async () => {
        const code = `code-${uid()}`;
        const wxLogin = (role) => post('/api/auth/wechat', null, { code, role });
        const first = await wxLogin('driver');
        assert.equal(first.status, 200, JSON.stringify(first.body));
        assert.equal(first.body.user.role, 'driver');
        assert.equal(first.body.user.approved, false);
        assert.equal(first.body.user.docs.status, 'none');

        // 同一微信在乘客端登录会提示已注册为司机，不能换端
        const wrongApp = await wxLogin('passenger');
        assert.equal(wrongApp.status, 403);
        assert.equal(wrongApp.body.error, 'WRONG_APP');

        const token = first.body.token;
        // 未提交资料不能上线
        assert.equal((await http('PATCH', '/api/profile', { token, body: { online: true } })).status, 403);

        // 提交认证资料（意大利驾照 + 中国身份证 + 两张证件照片）
        const PHOTO = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
        const application = {
          phone: '+39 333 111 2222', car: 'Fiat Panda · AB123CD',
          italianLicense: { number: 'ITMIL1234567', expiry: '2030-06', photo: PHOTO },
          chinaId: { number: '110101199001011234', photo: PHOTO }
        };
        const submitted = await post('/api/driver/application', token, application);
        assert.equal(submitted.status, 200, JSON.stringify(submitted.body));
        assert.equal(submitted.body.docs.status, 'pending');
        assert.equal(submitted.body.docs.italianLicense.number, 'ITMIL1234567');
        assert.ok(submitted.body.docs.italianLicense.photo.startsWith('data:image/png;base64,'), '驾照照片应保存到 docs');
        assert.ok(submitted.body.docs.chinaId.photo.startsWith('data:image/png;base64,'), '身份证照片应保存到 docs');
        assert.equal(submitted.body.approved, false);
        assert.equal((await http('PATCH', '/api/profile', { token, body: { online: true } })).status, 403);

        // 非法资料被拒绝（含缺照片 / 照片不是图片 / 照片超长）
        for (const bad of [
          { phone: 'abc' }, { car: 'x' },
          { italianLicense: { number: 'x', expiry: '2030-06' } },
          { italianLicense: { number: 'ITMIL1', expiry: 'bad' } },
          { chinaId: { number: '123' } },
          { italianLicense: { number: 'ITMIL1234567', expiry: '2030-06', photo: 'not-a-photo' } },
          { italianLicense: { number: 'ITMIL1234567', expiry: '2030-06', photo: 'data:text/html;base64,PHNjcmlwdD4=' } },
          { italianLicense: { number: 'ITMIL1234567', expiry: '2030-06', photo: undefined }, chinaId: { number: '110101199001011234', photo: PHOTO } }
        ]) {
          const rejected = await post('/api/driver/application', token, { ...application, ...bad });
          assert.equal(rejected.status, 400, JSON.stringify(bad));
        }

        // 后台：没有密钥 401；有密钥能看到待审核司机
        assert.equal((await http('GET', '/api/admin/drivers?status=pending')).status, 401);
        const list = await http('GET', '/api/admin/drivers?status=pending', { adminKey: 'demo-admin' });
        assert.equal(list.status, 200, JSON.stringify(list.body));
        assert.ok(list.body.drivers.some((d) => d.id === first.body.user.id));

        // 后台拒绝（带原因）→ 司机仍不能上线
        const rejected = await post(`/api/admin/drivers/${first.body.user.id}/review`, null, { action: 'reject', reason: '驾照照片不清晰' });
        assert.equal(rejected.status, 401); // 不带密钥
        const rejectOk = await http('POST', `/api/admin/drivers/${first.body.user.id}/review`, { adminKey: 'demo-admin', body: { action: 'reject', reason: '驾照照片不清晰' } });
        assert.equal(rejectOk.status, 200, JSON.stringify(rejectOk.body));
        assert.equal(rejectOk.body.docs.status, 'rejected');
        assert.equal(rejectOk.body.docs.rejectReason, '驾照照片不清晰');
        assert.equal(rejectOk.body.approved, false);

        // 司机重新提交 → 回到待审核，旧拒绝原因被清除
        const resubmit = await post('/api/driver/application', token, { ...application, car: 'Fiat Panda · NEW999' });
        assert.equal(resubmit.status, 200);
        assert.equal(resubmit.body.docs.status, 'pending');
        assert.equal(resubmit.body.docs.rejectReason, '');

        // 后台通过 → 司机可以上线
        const approveOk = await http('POST', `/api/admin/drivers/${first.body.user.id}/review`, { adminKey: 'demo-admin', body: { action: 'approve' } });
        assert.equal(approveOk.status, 200);
        assert.equal(approveOk.body.approved, true);
        assert.equal(approveOk.body.docs.status, 'approved');
        assert.equal(approveOk.body.italianLicenseVerified, true);
        assert.equal((await http('PATCH', '/api/profile', { token, body: { online: true } })).status, 200);

        // 审核列表按状态过滤
        const approvedList = await http('GET', '/api/admin/drivers?status=approved', { adminKey: 'demo-admin' });
        assert.ok(approvedList.body.drivers.some((d) => d.id === first.body.user.id));
      });

      it('后台可暂停/强制关闭已通过司机（司机端提示不符合平台规定），恢复后可再上线', async () => {
        const wxLogin = (role) => post('/api/auth/wechat', null, { code: `code-${uid()}`, role });
        const login = await wxLogin('driver');
        assert.equal(login.status, 200, JSON.stringify(login.body));
        const token = login.body.token;
        const driverId = login.body.user.id;
        // 认证（含照片）→ 后台通过
        const application = {
          phone: '+39 333 444 5555', car: 'BMW 520d · BC 999 XX',
          italianLicense: { number: 'ITMIL8899001', expiry: '2032-01', photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' },
          chinaId: { number: '110101199303034321', photo: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==' }
        };
        assert.equal((await post('/api/driver/application', token, application)).status, 200);
        const approveOk = await http('POST', `/api/admin/drivers/${driverId}/review`, { adminKey: 'demo-admin', body: { action: 'approve' } });
        assert.equal(approveOk.status, 200);
        assert.equal((await http('PATCH', '/api/profile', { token, body: { online: true } })).status, 200);

        // 账号管理接口需要密钥；非法操作被拒
        assert.equal((await http('POST', `/api/admin/drivers/${driverId}/account`, { body: { action: 'suspend' } })).status, 401);
        assert.equal((await http('POST', `/api/admin/drivers/${driverId}/account`, { adminKey: 'demo-admin', body: { action: 'ban' } })).status, 400);

        // 暂停使用 → 强制下线，司机再上线被拒（提示“使用权限已暂停”）
        const suspend = await http('POST', `/api/admin/drivers/${driverId}/account`, { adminKey: 'demo-admin', body: { action: 'suspend' } });
        assert.equal(suspend.status, 200, JSON.stringify(suspend.body));
        assert.equal(suspend.body.accountStatus, 'suspended');
        assert.equal(suspend.body.online, false);
        const suspendedOnline = await http('PATCH', '/api/profile', { token, body: { online: true } });
        assert.equal(suspendedOnline.status, 403);
        assert.equal(suspendedOnline.body.error, 'ACCOUNT_SUSPENDED');
        assert.match(suspendedOnline.body.message, /使用权限已暂停/);

        // 强制关闭（不符合平台规定）→ 仍不能上线
        const close = await http('POST', `/api/admin/drivers/${driverId}/account`, { adminKey: 'demo-admin', body: { action: 'close' } });
        assert.equal(close.status, 200);
        assert.equal(close.body.accountStatus, 'closed');
        const closedOnline = await http('PATCH', '/api/profile', { token, body: { online: true } });
        assert.equal(closedOnline.status, 403);
        assert.equal(closedOnline.body.error, 'ACCOUNT_CLOSED');
        assert.match(closedOnline.body.message, /不符合平台规定/);

        // 恢复使用 → 可再次上线
        const restore = await http('POST', `/api/admin/drivers/${driverId}/account`, { adminKey: 'demo-admin', body: { action: 'restore' } });
        assert.equal(restore.status, 200);
        assert.equal(restore.body.accountStatus, 'active');
        assert.equal((await http('PATCH', '/api/profile', { token, body: { online: true } })).status, 200);
      });
    });

    // ---------- 邀请码返现 ----------
    describe('邀请码返现', () => {
      it('每个新账号自动分配唯一 8 位邀请码，初始余额为 0', async () => {
        const alice = await signUp('passenger');
        const bob = await signUp('passenger');
        assert.match(alice.user.inviteCode, /^[A-Z0-9]{8}$/);
        assert.match(bob.user.inviteCode, /^[A-Z0-9]{8}$/);
        assert.notEqual(alice.user.inviteCode, bob.user.inviteCode);
        assert.equal(alice.user.balanceCents, 0);
        assert.equal(alice.user.invitedBy, '');
        // state 的 me 同样带邀请码信息
        const s = await state(alice);
        assert.equal(s.me.inviteCode, alice.user.inviteCode);
        assert.equal(s.me.balanceCents, 0);
      });

      it('输入别人的邀请码 → 绑定推荐关系 + 得 5 欧返现（余额 500 欧分）', async () => {
        const inviter = await signUp('passenger');
        const newbie = await signUp('passenger');
        const applied = await post('/api/invite/apply', newbie.token, { code: inviter.user.inviteCode });
        assert.equal(applied.status, 200, JSON.stringify(applied.body));
        assert.equal(applied.body.balanceCents, 500);
        assert.equal(applied.body.invitedBy, inviter.user.id);
        // 邀请人没有任何变动（本次只给被邀请人返现）
        const inviterState = await state(inviter);
        assert.equal(inviterState.me.balanceCents, 0);
      });

      it('拒绝：自己的邀请码 / 不存在的邀请码 / 格式错误 / 重复绑定', async () => {
        const alice = await signUp('passenger');
        const bob = await signUp('passenger');
        const self = await post('/api/invite/apply', alice.token, { code: alice.user.inviteCode });
        assert.equal(self.status, 400);
        assert.equal(self.body.error, 'SELF_INVITE');
        const missing = await post('/api/invite/apply', bob.token, { code: 'ZZZZZZZZ' });
        assert.equal(missing.status, 404);
        assert.equal(missing.body.error, 'INVITE_NOT_FOUND');
        for (const bad of ['short', '1234567', '']) {
          const r = await post('/api/invite/apply', bob.token, { code: bad });
          assert.equal(r.status, 400, bad);
        }
        const ok = await post('/api/invite/apply', bob.token, { code: alice.user.inviteCode });
        assert.equal(ok.status, 200);
        const again = await post('/api/invite/apply', bob.token, { code: alice.user.inviteCode });
        assert.equal(again.status, 409);
        assert.equal(again.body.error, 'ALREADY_INVITED');
      });

      it('司机账号不能输入邀请码（乘客功能）', async () => {
        const passenger = await signUp('passenger');
        const driver = await signUp('driver');
        const r = await post('/api/invite/apply', driver.token, { code: passenger.user.inviteCode });
        assert.equal(r.status, 403);
      });

      it('余额可抵扣车费：下单实付 = 车费 - 余额；取消订单退回余额', async () => {
        const inviter = await signUp('passenger');
        const newbie = await signUp('passenger');
        assert.equal((await post('/api/invite/apply', newbie.token, { code: inviter.user.inviteCode })).status, 200);
        // 20km balanced 车费 50 欧；余额 5 欧 → 抵扣 5 欧，实付 45 欧
        const order = await book(newbie);
        assert.equal(order.fare, 50);
        assert.equal(order.discountCents, 500);
        assert.equal(order.payableCents, 4500);
        assert.equal((await state(newbie)).me.balanceCents, 0);
        // 取消订单 → 5 欧退回余额
        assert.equal((await post(`/api/orders/${order.id}/cancel`, newbie.token)).status, 200);
        assert.equal((await state(newbie)).me.balanceCents, 500);
      });

      it('余额不够时按余额抵扣；价格未定的包车订单不抵扣', async () => {
        const inviter = await signUp('passenger');
        const newbie = await signUp('passenger');
        await post('/api/invite/apply', newbie.token, { code: inviter.user.inviteCode });
        // 机场包车 80 欧 > 余额 5 欧：全额抵扣余额，实付 75 欧
        const charter = await book(newbie, { type: 'charter', charterKind: 'mxp', pickup: undefined, destination: undefined, distanceKm: undefined, routeId: undefined });
        assert.equal(charter.fare, 80);
        assert.equal(charter.discountCents, 500);
        assert.equal(charter.payableCents, 7500);
        assert.equal((await state(newbie)).me.balanceCents, 0);
        // 待报价包车不抵扣
        const half = await book(newbie, { type: 'charter', charterKind: 'half-day' });
        assert.equal(half.pricePending, true);
        assert.equal(half.discountCents, 0);
      });
    });

    // ---------- 价格 ----------
    describe('价格由服务器计算', () => {
      it('网页传来的价格、状态、司机信息一律忽略', async () => {
        const passenger = await signUp('passenger');
        const order = await book(passenger, { fare: 0.01, status: 'completed', driver: { name: '假司机' }, driverId: 'x', passengerName: '别人', id: 'ord_fixed' });
        assert.equal(order.fare, 50);
        assert.equal(order.status, 'matching');
        assert.equal(order.driver, null);
        assert.notEqual(order.id, 'ord_fixed');
        assert.equal(order.passengerName, '小满 测试');
      });

      it('各条路线的价格与 src/pricing.js 一致', async () => {
        const passenger = await signUp('passenger');
        for (const route of pricing.makeRouteOptions(20)) {
          const order = await book(passenger, { routeId: route.id });
          assert.equal(order.fare, route.fare, route.id);
          assert.equal(order.distanceKm, route.distanceKm, route.id);
          await post(`/api/orders/${order.id}/cancel`, passenger.token);
        }
        assert.equal(pricing.estimateFare(20), 50);
        assert.equal(pricing.estimateFare(50), 80);
      });

      it('带真实路线数据下单：按各路线真实距离计价，几何/时长入库', async () => {
        const passenger = await signUp('passenger');
        const routeDistances = { balanced: 8.8, fast: 9.5, economy: 8.1 };
        const polyline = 'irynHytpI@dA~@kBt@uA`@o@t@}@'; // 示例 polyline6（足够长通过校验）
        const order = await book(passenger, { routeId: 'fast', routeDistances, routePolyline: polyline, routeMinutes: 18 });
        assert.equal(order.distanceKm, 9.5); // 所选路线的真实距离
        assert.equal(order.fare, pricing.routeFare('fast', 9.5));
        assert.equal(order.routeMinutes, 18);
        assert.equal(order.routePolyline, polyline);
        assert.equal(pricing.routeFare('balanced', 8.8), pricing.estimateFare(8.8, 1));
        assert.equal(pricing.routeFare('economy', 8.1), pricing.estimateFare(8.1, 0.91));
      });

      it('机场包车是一口价；半日/全日包车待报价', async () => {
        const passenger = await signUp('passenger');
        const mxp = await book(passenger, { type: 'charter', charterKind: 'mxp', pickup: undefined, destination: undefined, distanceKm: undefined, routeId: undefined });
        assert.equal(mxp.fare, 80);
        assert.equal(mxp.pricePending, false);
        assert.equal(mxp.destination, 'Malpensa · MXP');
        const half = await book(passenger, { type: 'charter', charterKind: 'half-day' });
        assert.equal(half.fare, 0);
        assert.equal(half.pricePending, true);
      });
    });

    // ---------- 输入校验 ----------
    describe('下单时的输入校验', () => {
      it('不合格的订单一律 400', async () => {
        const passenger = await signUp('passenger');
        const past = new Date(env.clock.now.getTime() - HOUR).toISOString();
        const tooFar = new Date(env.clock.now.getTime() + 100 * DAY).toISOString();
        const future = new Date(env.clock.now.getTime() + 2 * DAY).toISOString();
        const cases = [
          { pickup: '' }, { pickup: '   ' }, { pickup: undefined }, { destination: undefined }, { pickup: 'x'.repeat(201) },
          { distanceKm: 0.5 }, { distanceKm: 999 }, { distanceKm: '12' }, { distanceKm: null },
          { routeId: 'teleport' }, { paymentMethod: 'cash' }, { type: 'weird' },
          { pickupLat: 91 }, { pickupLat: -91 }, { pickupLon: 181 }, { pickupLat: 'x' },
          { routeDistances: 'x' }, { routeDistances: [] }, { routeDistances: { balanced: 0.5 } },
          { routeDistances: { balanced: 999 } }, { routeDistances: { fast: 'x' } },
          { routePolyline: 'xx' }, { routePolyline: 'x'.repeat(30_001) }, { routePolyline: 123 },
          { routeMinutes: 0 }, { routeMinutes: 601 }, { routeMinutes: '18' },
          { type: 'scheduled' }, { type: 'scheduled', scheduledAt: past }, { type: 'scheduled', scheduledAt: tooFar },
          { type: 'scheduled', scheduledAt: '2099-01-01T10:00' }, { type: 'scheduled', scheduledAt: 'tomorrow' },
          { type: 'charter', charterKind: 'submarine' }, { type: 'charter' }
        ];
        for (const bad of cases) {
          const result = await post('/api/orders', passenger.token, ride(bad));
          assert.equal(result.status, 400, JSON.stringify(bad));
        }
        assert.deepEqual((await state(passenger)).orders, []);
        const scheduled = await book(passenger, { type: 'scheduled', scheduledAt: future });
        assert.equal(scheduled.scheduledAt, future);
        assert.equal(scheduled.serviceLabel, '预约快车');

        const withCoords = await book(passenger, { pickupLat: 45.4785, pickupLon: 9.1234 });
        assert.equal(withCoords.pickupLat, 45.4785);
        assert.equal(withCoords.pickupLon, 9.1234);
        const noCoords = await book(passenger);
        assert.equal(noCoords.pickupLat, null);
      });

      it('每位乘客最多同时有 5 个未结束的订单', async () => {
        const passenger = await signUp('passenger');
        for (let i = 0; i < 5; i += 1) await book(passenger);
        const sixth = await post('/api/orders', passenger.token, ride());
        assert.equal(sixth.status, 409);
        assert.equal(sixth.body.error, 'TOO_MANY_OPEN_ORDERS');
      });

      it('请求体格式错误：无效 JSON、不是对象、太大', async () => {
        const passenger = await signUp('passenger');
        const invalid = await http('POST', '/api/orders', { token: passenger.token, raw: '{bad' });
        assert.equal(invalid.status, 400);
        assert.equal(invalid.body.error, 'INVALID_JSON');
        assert.equal((await http('POST', '/api/orders', { token: passenger.token, raw: '[1,2]' })).status, 400);
        assert.equal((await http('POST', '/api/orders', { token: passenger.token, raw: '123' })).status, 400);
        const huge = await http('POST', '/api/orders', { token: passenger.token, raw: JSON.stringify({ pickup: 'a'.repeat(10_500_000) }) });
        assert.equal(huge.status, 413);
      });
    });

    // ---------- 权限 ----------
    describe('权限：谁只能做什么', () => {
      it('司机不能下单，乘客不能接单/开始/完成', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const order = await book(passenger);
        assert.equal((await post('/api/orders', driver.token, ride())).status, 403);
        for (const action of ['accept', 'decline', 'arrive', 'board', 'start', 'complete']) {
          assert.equal((await post(`/api/orders/${order.id}/${action}`, passenger.token)).status, 403, action);
        }
        for (const action of ['cancel', 'safety']) {
          assert.equal((await post(`/api/orders/${order.id}/${action}`, driver.token, { kind: 'safe' })).status, 403, action);
        }
        assert.equal((await post('/api/ratings', driver.token, { orderId: order.id, score: 5 })).status, 403);
      });

      it('乘客只能看到、取消自己的订单', async () => {
        const alice = await signUp('passenger');
        const bob = await signUp('passenger');
        const order = await book(alice);
        assert.deepEqual((await state(bob)).orders, []);
        assert.equal((await post(`/api/orders/${order.id}/cancel`, bob.token)).status, 404);
        assert.equal((await post(`/api/orders/${order.id}/safety`, bob.token, { kind: 'safe' })).status, 404);
        assert.equal((await state(alice)).orders.length, 1);
        assert.equal((await post(`/api/orders/${order.id}/cancel`, alice.token)).status, 200);
      });

      it('不能评价、投诉别人的订单', async () => {
        const alice = await signUp('passenger');
        const bob = await signUp('passenger');
        const driver = await onlineDriver();
        const trip = await finishedTrip(alice, driver);
        assert.equal((await post('/api/ratings', bob.token, { orderId: trip.id, score: 1 })).status, 404);
        assert.equal((await post('/api/complaints', bob.token, { orderId: trip.id, reason: '路线问题', description: 'x' })).status, 404);
        assert.equal((await post('/api/lost-items', bob.token, { orderId: trip.id, description: 'x' })).status, 404);
      });

      it('司机不能操作别的司机的行程；旧的“任意修改订单”接口已经不存在', async () => {
        const passenger = await signUp('passenger');
        const first = await onlineDriver();
        const second = await onlineDriver();
        const order = await book(passenger);
        assert.equal((await post(`/api/orders/${order.id}/accept`, first.token)).status, 200);
        assert.equal((await post(`/api/orders/${order.id}/start`, second.token)).status, 404);
        assert.equal((await post(`/api/orders/${order.id}/complete`, second.token)).status, 404);
        const patch = await http('PATCH', `/api/orders/${order.id}`, { token: passenger.token, body: { fare: 0, status: 'completed' } });
        assert.equal(patch.status, 404);
        assert.equal((await state(passenger)).orders[0].fare, 50);
      });

      it('个人资料只能改允许的字段', async () => {
        const passenger = await signUp('passenger');
        for (const body of [{ role: 'driver' }, { approved: true }, { email: 'x@y.zz' }, { creditScore: 999 }, { online: true }]) {
          assert.equal((await http('PATCH', '/api/profile', { token: passenger.token, body })).status, 400, JSON.stringify(body));
        }
        const ok = await http('PATCH', '/api/profile', { token: passenger.token, body: { verified: true, name: '新名字' } });
        assert.equal(ok.status, 200);
        assert.equal(ok.body.verified, true);
        assert.equal((await state(passenger)).profile.passenger.name, '新名字');

        const driver = await signUp('driver');
        for (const body of [{ approved: true }, { rating: 5 }, { creditScore: 999 }, { verified: true }]) {
          assert.equal((await http('PATCH', '/api/profile', { token: driver.token, body })).status, 400, JSON.stringify(body));
        }
      });
    });

    // ---------- 订单流程 ----------
    describe('订单流程', () => {
      it('叫车 → 接单 → 开始 → 完成，双方看到的信息各不相同', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const order = await book(passenger);

        // 接单前：司机能看到订单，但看不到乘客姓名
        const before = (await state(driver)).orders.find((item) => item.id === order.id);
        assert.ok(before);
        assert.equal('passengerName' in before, false);

        const accepted = await post(`/api/orders/${order.id}/accept`, driver.token);
        assert.equal(accepted.status, 200);
        assert.equal(accepted.body.status, 'accepted');
        assert.equal(accepted.body.passengerName, '小满 测试'); // 接单后司机才能看到乘客姓名

        const seenByPassenger = (await state(passenger)).orders[0];
        assert.equal(seenByPassenger.status, 'accepted');
        assert.equal(seenByPassenger.driver.name, 'Marco 测试');
        assert.equal(seenByPassenger.driver.car, 'Fiat Panda · TEST');
        assert.equal('driverId' in seenByPassenger, false);

        // 不能跳步骤：接单后不能直接完成，也不能直接开始行程；必须先“到达”→再“客人已上车”
        assert.equal((await post(`/api/orders/${order.id}/complete`, driver.token)).status, 409);
        assert.equal((await post(`/api/orders/${order.id}/start`, driver.token)).status, 409);
        const arrived = await post(`/api/orders/${order.id}/arrive`, driver.token);
        assert.equal(arrived.status, 200);
        assert.equal(arrived.body.status, 'arrived');
        assert.equal((await post(`/api/orders/${order.id}/arrive`, driver.token)).status, 409); // 不能重复到达
        const boarded = await post(`/api/orders/${order.id}/board`, driver.token);
        assert.equal(boarded.status, 200);
        assert.equal(boarded.body.status, 'onboard');
        assert.equal((await post(`/api/orders/${order.id}/start`, driver.token)).status, 200);
        assert.equal((await post(`/api/orders/${order.id}/start`, driver.token)).status, 409);

        // 行程中：乘客可以确认安全 / 模拟通知紧急联系人，但不能取消
        assert.equal((await post(`/api/orders/${order.id}/cancel`, passenger.token)).status, 409);
        const emergency = await post(`/api/orders/${order.id}/safety`, passenger.token, { kind: 'emergency' });
        assert.equal(emergency.body.deviationAlert, true);
        const safe = await post(`/api/orders/${order.id}/safety`, passenger.token, { kind: 'safe' });
        assert.equal(safe.body.deviationAlert, false);
        assert.equal((await post(`/api/orders/${order.id}/safety`, passenger.token, { kind: 'nope' })).status, 400);

        const done = await post(`/api/orders/${order.id}/complete`, driver.token);
        assert.equal(done.body.status, 'completed');
        assert.ok(done.body.completedAt);
        // 结束后一切状态操作都不能再做
        for (const action of ['start', 'complete', 'accept']) assert.equal((await post(`/api/orders/${order.id}/${action}`, driver.token)).status, 409, action);
        assert.equal((await post(`/api/orders/${order.id}/cancel`, passenger.token)).status, 409);
        assert.equal((await post(`/api/orders/${order.id}/safety`, passenger.token, { kind: 'safe' })).status, 409);
      });

      it('接单时可带司机预计到达分钟数（双端可见）；非法值被拒绝', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const order = await book(passenger);
        assert.equal((await post(`/api/orders/${order.id}/accept`, driver.token, { etaMinutes: 0 })).status, 400);
        assert.equal((await post(`/api/orders/${order.id}/accept`, driver.token, { etaMinutes: 121 })).status, 400);
        assert.equal((await post(`/api/orders/${order.id}/accept`, driver.token, { etaMinutes: 'x' })).status, 400);
        const accepted = await post(`/api/orders/${order.id}/accept`, driver.token, { etaMinutes: 8 });
        assert.equal(accepted.status, 200);
        assert.equal(accepted.body.etaMinutes, 8);
        assert.equal((await state(passenger)).orders[0].etaMinutes, 8); // 乘客端也能看到
        assert.equal((await state(driver)).orders[0].etaMinutes, 8);    // 司机端也能看到
      });

      it('两位司机同时抢同一单：只有一位成功', async () => {
        const passenger = await signUp('passenger');
        const drivers = [await onlineDriver(), await onlineDriver(), await onlineDriver()];
        const order = await book(passenger);
        const results = await Promise.all(drivers.map((driver) => post(`/api/orders/${order.id}/accept`, driver.token)));
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409, 409]);
        const winner = drivers[results.findIndex((r) => r.status === 200)];
        assert.equal((await state(passenger)).orders[0].driver.name, winner.user.name);
        // 输的司机的列表里，这个订单消失了
        for (const [index, driver] of drivers.entries()) {
          const visible = (await state(driver)).orders.some((item) => item.id === order.id);
          assert.equal(visible, results[index].status === 200);
        }
      });

      it('同一位司机同时点两次接单（两个不同订单）：只有一次成功', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const a = await book(passenger);
        const b = await book(passenger);
        const results = await Promise.all([a, b].map((order) => post(`/api/orders/${order.id}/accept`, driver.token)));
        assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
        assert.equal(results.find((r) => r.status === 409).body.error, 'ACTIVE_TRIP_EXISTS');
      });

      it('拒绝订单：只对这位司机隐藏，其他司机仍能接', async () => {
        const passenger = await signUp('passenger');
        const first = await onlineDriver();
        const second = await onlineDriver();
        const order = await book(passenger);
        assert.equal((await post(`/api/orders/${order.id}/decline`, first.token)).status, 200);
        assert.equal((await state(first)).orders.some((item) => item.id === order.id), false);
        assert.equal((await state(second)).orders.some((item) => item.id === order.id), true);
        assert.equal((await state(passenger)).orders[0].status, 'matching');
        assert.equal((await post(`/api/orders/${order.id}/accept`, second.token)).status, 200);
        assert.equal((await post(`/api/orders/${order.id}/decline`, first.token)).status, 409);
      });

      it('不存在的订单返回 404', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        assert.equal((await post('/api/orders/ord_missing/cancel', passenger.token)).status, 404);
        assert.equal((await post('/api/orders/ord_missing/accept', driver.token)).status, 404);
        assert.equal((await post('/api/orders/ord_missing/start', driver.token)).status, 404);
      });
    });

    // ---------- 取消 ----------
    describe('取消订单与取消费', () => {
      it('每月前 3 次免费，第 4 次收 5%，下个月重新计算；取消后不能再取消', async () => {
        const passenger = await signUp('passenger');
        const fees = [];
        for (let i = 0; i < 4; i += 1) {
          const order = await book(passenger);
          const cancelled = await post(`/api/orders/${order.id}/cancel`, passenger.token);
          assert.equal(cancelled.status, 200);
          assert.equal(cancelled.body.status, 'cancelled');
          fees.push(cancelled.body.cancellationFee);
          if (i === 0) assert.equal((await post(`/api/orders/${order.id}/cancel`, passenger.token)).status, 409);
        }
        assert.deepEqual(fees, [0, 0, 0, 2.5]);
        assert.equal((await state(passenger)).cancellationCount, 4);

        env.clock.advance(32 * DAY); // 一定跨过了月份
        assert.equal((await state(passenger)).cancellationCount, 0);
        const order = await book(passenger);
        assert.equal((await post(`/api/orders/${order.id}/cancel`, passenger.token)).body.cancellationFee, 0);
        assert.equal((await state(passenger)).cancellationCount, 1);
        env.clock.reset();
      });

      it('司机接单后，乘客仍可取消；司机随即可以接新单', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const order = await book(passenger);
        await post(`/api/orders/${order.id}/accept`, driver.token);
        assert.equal((await post(`/api/orders/${order.id}/cancel`, passenger.token)).status, 200);
        const next = await book(passenger);
        assert.equal((await post(`/api/orders/${next.id}/accept`, driver.token)).status, 200);
      });
    });

    // ---------- 评价 / 投诉 / 失物 ----------
    describe('评价、投诉、失物招领', () => {
      it('只有已完成的订单可以评价；同一订单只能评价一次', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const pending = await book(passenger);
        assert.equal((await post('/api/ratings', passenger.token, { orderId: pending.id, score: 5 })).status, 409);
        await post(`/api/orders/${pending.id}/cancel`, passenger.token);

        const trip = await finishedTrip(passenger, driver);
        for (const score of [0, 6, 4.5, '5', null]) {
          assert.equal((await post('/api/ratings', passenger.token, { orderId: trip.id, score })).status, 400, String(score));
        }
        const rated = await post('/api/ratings', passenger.token, { orderId: trip.id, score: 5, comment: '很好' });
        assert.equal(rated.status, 201);
        const again = await post('/api/ratings', passenger.token, { orderId: trip.id, score: 1 });
        assert.equal(again.status, 409);
        assert.equal(again.body.error, 'ALREADY_RATED');
        assert.equal((await state(passenger)).ratings.length, 1);
      });

      it('评价 24 小时、投诉 7 天、失物 1 个月的时限', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const forRating = await finishedTrip(passenger, driver);
        const forComplaint = await finishedTrip(passenger, driver);
        const complaint = { reason: '路线问题', description: '绕路了' };

        env.clock.advance(25 * HOUR);
        assert.equal((await post('/api/ratings', passenger.token, { orderId: forRating.id, score: 5 })).body.error, 'WINDOW_CLOSED');
        assert.equal((await post('/api/complaints', passenger.token, { orderId: forComplaint.id, ...complaint })).status, 201);

        env.clock.advance(7 * DAY);
        assert.equal((await post('/api/complaints', passenger.token, { orderId: forComplaint.id, ...complaint })).status, 409);
        assert.equal((await post('/api/lost-items', passenger.token, { orderId: forComplaint.id, description: '黑色雨伞' })).status, 201);

        env.clock.advance(30 * DAY);
        assert.equal((await post('/api/lost-items', passenger.token, { orderId: forComplaint.id, description: '黑色雨伞' })).status, 409);
        env.clock.reset();
      });

      it('投诉类型和内容需要合法', async () => {
        const passenger = await signUp('passenger');
        const driver = await onlineDriver();
        const trip = await finishedTrip(passenger, driver);
        assert.equal((await post('/api/complaints', passenger.token, { orderId: trip.id, reason: '随便写', description: 'x' })).status, 400);
        assert.equal((await post('/api/complaints', passenger.token, { orderId: trip.id, reason: '费用问题', description: '' })).status, 400);
        assert.equal((await post('/api/lost-items', passenger.token, { orderId: trip.id, description: '' })).status, 400);
        const ok = await post('/api/complaints', passenger.token, { orderId: trip.id, reason: '费用问题', description: '多收了钱' });
        assert.equal(ok.status, 201);
        assert.equal((await state(passenger)).complaints.length, 1);
      });
    });
  });
}

module.exports = { defineApiScenarios };
