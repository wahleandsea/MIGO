// 往名字、车型、地址等字段里塞恶意 HTML，渲染每一个界面，确认全部被当成普通文字显示。
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const { openApp, createStorage } = require('./bundle-runner.js');

const EL = '<b id=PWN>';        // 元素注入：如果它原样出现在页面里，说明有 XSS 漏洞
const ATTR = '" data-pwn="1';   // 属性注入
const evilDriver = { name: EL, car: EL, rating: EL, phone: ATTR };

const order = (over) => ({
  id: 'ord_ok', status: 'completed', createdAt: new Date().toISOString(), pickup: EL, destination: EL,
  serviceLabel: EL, routeLabel: EL, distanceKm: EL, fare: 10, paymentMethod: 'alipay', passengerName: EL, driver: evilDriver, driverId: null, ...over
});

function seed(variant) {
  const orders = [
    order({ id: ATTR + 'done' }),
    order({ id: ATTR + 'prog', status: 'in_progress', driverId: 'local-driver' }),
    order({ id: ATTR + 'matching', status: 'matching', driver: null }),
    order({ id: ATTR + 'acc', status: 'accepted' })
  ];
  if (variant === 'driver-active') orders.push(order({ id: ATTR + 'mine', status: 'accepted', driverId: 'local-driver' }));
  if (variant === 'unknown-status') orders.push(order({ id: 'weird', status: EL + 'weird' }));
  return {
    profile: {
      passenger: { name: EL, email: EL, verified: false },
      driver: { name: EL, rating: EL, creditScore: EL, online: true, car: EL, phone: ATTR }
    },
    orders: variant === 'driver-candidates' ? orders.filter((item) => item.driverId !== 'local-driver') : orders,
    ratings: [], complaints: [], cancellationCount: 0, lastResetAt: new Date().toISOString()
  };
}

async function visit(role, variant, steps) {
  const storage = createStorage({ 'milan-ride-demo-state-v1': JSON.stringify(seed(variant)) });
  const app = await openApp(role, { storage });
  const pages = [['首页', app.html()]];
  for (const [label, dataset] of steps) {
    await app.click(dataset);
    pages.push([label, app.html()]);
  }
  app.close();
  return pages;
}

function assertSafe(pages) {
  for (const [label, html] of pages) {
    assert.equal(html.includes(EL), false, `${label}：出现了未转义的 HTML 元素`);
    assert.equal(html.includes(ATTR), false, `${label}：出现了未转义的属性注入`);
    assert.notEqual(html.length, 0, `${label}：页面为空（渲染出错）`);
  }
}

describe('恶意数据不会变成可执行的页面内容', () => {
  it('乘客端所有界面与弹窗', async () => {
    assertSafe(await visit('passenger', 'base', [
      ['订单页', { action: 'nav', screen: 'orders' }], ['服务页', { action: 'nav', screen: 'services' }],
      ['我的', { action: 'nav', screen: 'profile' }], ['叫车', { action: 'nav', screen: 'home' }],
      ['已完成订单详情', { action: 'order-detail', id: ATTR + 'done' }], ['已接单订单详情', { action: 'order-detail', id: ATTR + 'acc' }],
      ['评价弹窗', { action: 'open-rating' }], ['投诉弹窗', { action: 'open-complaint' }],
      ['失物弹窗', { action: 'open-lost' }], ['偏航弹窗', { action: 'open-deviation', id: ATTR + 'prog' }]
    ]));
  });

  it('司机端（有进行中的行程）', async () => {
    assertSafe(await visit('driver', 'driver-active', [
      ['订单页', { action: 'nav', screen: 'driver-orders' }], ['我的', { action: 'nav', screen: 'driver-profile' }],
      ['接单页', { action: 'nav', screen: 'driver-home' }], ['订单详情', { action: 'order-detail', id: ATTR + 'mine' }]
    ]));
  });

  it('司机端（新订单列表）', async () => {
    assertSafe(await visit('driver', 'driver-candidates', [['接单页', { action: 'nav', screen: 'driver-home' }]]));
  });

  it('未知的订单状态不会让页面崩溃', async () => {
    assertSafe(await visit('passenger', 'unknown-status', [['订单页', { action: 'nav', screen: 'orders' }]]));
  });
});
