const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const rules = require('../rules.js');
const auth = require('../auth.js');
const { loadPricing } = require('../pricing-loader.js');

describe('订单状态流转表', () => {
  it('只允许设计好的流转', () => {
    const { TRANSITIONS } = rules;
    assert.deepEqual(TRANSITIONS.cancel.from, ['matching', 'waiting_driver', 'accepted']);
    assert.deepEqual(TRANSITIONS.accept.from, ['matching', 'waiting_driver']);
    assert.deepEqual(TRANSITIONS.start.from, ['accepted']);
    assert.deepEqual(TRANSITIONS.complete.from, ['in_progress']);
    for (const rule of Object.values(TRANSITIONS)) assert.ok(rules.ALL_STATUSES.includes(rule.to));
    // 已完成、已取消的订单不能再变
    for (const rule of Object.values(TRANSITIONS)) assert.equal(rule.from.some((s) => ['completed', 'cancelled'].includes(s)), false);
  });
});

describe('自然月（罗马时区）', () => {
  it('按罗马时间划分月份', () => {
    assert.equal(rules.periodOf(new Date('2026-09-20T12:00:00Z')), '2026-09');
    assert.equal(rules.periodOf(new Date('2026-09-30T22:30:00Z')), '2026-10'); // 罗马已是 10 月 1 日
    assert.equal(rules.periodOf(new Date('2026-12-31T23:30:00Z')), '2027-01');
  });
});

describe('计价与取消费', () => {
  const pricing = loadPricing();
  it('分段计价与需求样例一致', () => {
    assert.deepEqual([20, 30, 40, 50].map((km) => pricing.estimateFare(km)), [50, 60, 70, 80]);
    assert.equal(pricing.estimateFare(10), 35);
    assert.equal(pricing.estimateFare(60), 97);
  });
  it('取消费：前 3 次免费，之后 5%', () => {
    assert.deepEqual([0, 1, 2, 3, 9].map((n) => pricing.cancellationFee(n)), [0, 0, 0, 0.05, 0.05]);
  });
});

describe('生成订单', () => {
  const pricing = loadPricing();
  const user = { id: 'u1', name: '小满', role: 'passenger' };
  const now = new Date('2026-09-20T10:00:00Z');
  it('服务器决定价格和状态', () => {
    const request = rules.validateOrderRequest({ type: 'now', pickup: ' A ', destination: 'B', distanceKm: 20, routeId: 'balanced', paymentMethod: 'wechat', fare: 1 }, now);
    const order = rules.buildOrder({ request, user, pricing, now, id: 'ord_1' });
    assert.equal(order.fare, 50);
    assert.equal(order.pickup, 'A');
    assert.equal(order.status, 'matching');
  });
  it('司机接单前看不到乘客姓名，乘客看不到司机内部 ID', () => {
    const order = { id: 'o', passengerName: '小满', driverId: 'd1', driver: { name: 'M' } };
    assert.equal('passengerName' in rules.presentOrder(order, { role: 'driver', id: 'd2' }), false);
    assert.equal(rules.presentOrder(order, { role: 'driver', id: 'd1' }).passengerName, '小满');
    assert.equal('driverId' in rules.presentOrder(order, { role: 'passenger', id: 'p' }), false);
  });
  it('控制字符会被清掉，超长内容会被拒绝', () => {
    const request = rules.validateOrderRequest({ type: 'now', pickup: 'A\u0000\u0007B', destination: 'C', distanceKm: 5, routeId: 'fast', paymentMethod: 'alipay' }, now);
    assert.equal(request.pickup, 'AB');
    assert.throws(() => rules.validateComplaint({ orderId: 'o', reason: '路线问题', description: 'x'.repeat(1001) }), /不能超过/);
  });
});

describe('密码与令牌', () => {
  it('密码加密后可以校验，且每次加密结果不同', async () => {
    const a = await auth.hashPassword('correct horse');
    const b = await auth.hashPassword('correct horse');
    assert.notEqual(a, b);
    assert.equal(a.includes('correct horse'), false);
    assert.equal(await auth.verifyPassword('correct horse', a), true);
    assert.equal(await auth.verifyPassword('wrong horse', a), false);
    assert.equal(await auth.verifyPassword('x', 'garbage'), false);
    assert.equal(await auth.verifyPassword('x', undefined), false);
  });
  it('令牌是随机的，并且只保存哈希', () => {
    const one = auth.newToken();
    const two = auth.newToken();
    assert.notEqual(one.token, two.token);
    assert.equal(auth.hashToken(one.token), one.tokenHash);
    assert.notEqual(one.tokenHash, one.token);
    assert.equal(auth.readBearerToken({ headers: { authorization: `Bearer ${one.token}` } }), one.token);
    assert.equal(auth.readBearerToken({ headers: { authorization: 'Bearer short' } }), null);
    assert.equal(auth.readBearerToken({ headers: {} }), null);
  });
  it('限流：失败次数到上限后被拦截，窗口过后恢复', () => {
    let time = 0;
    const limiter = auth.createLimiter({ max: 3, windowMs: 1000, now: () => time });
    for (let i = 0; i < 3; i += 1) { assert.equal(limiter.blocked('k'), false); limiter.fail('k'); }
    assert.equal(limiter.blocked('k'), true);
    assert.equal(limiter.blocked('other'), false);
    time = 1001;
    assert.equal(limiter.blocked('k'), false);
    limiter.fail('k'); limiter.reset('k');
    assert.equal(limiter.blocked('k'), false);
  });
});
