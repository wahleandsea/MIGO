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
    async function http(method, path, { token, body, raw } = {}) {
      const headers = {};
      if (body !== undefined || raw !== undefined) headers['Content-Type'] = 'application/json';
      if (token) headers.Authorization = `Bearer ${token}`;
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
        const huge = await http('POST', '/api/orders', { token: passenger.token, raw: JSON.stringify({ pickup: 'a'.repeat(100_000) }) });
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
        for (const action of ['accept', 'decline', 'start', 'complete']) {
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

        // 不能跳步骤：接单后不能直接完成
        assert.equal((await post(`/api/orders/${order.id}/complete`, driver.token)).status, 409);
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
