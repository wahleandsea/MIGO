/* 自动生成：运行 npm.cmd run build 可重新生成。 */
window.MILANO_RIDE_APP_ROLE = 'passenger';
(async () => {
/**
 * 统一计价规则。
 * 需求中的样例：20 km = €50、30 km = €60、40 km = €70、50 km = €80。
 * 这里使用连续的分段计算，便于之后直接替换为后端报价引擎。
 */
const PRICING = {
  shortTripRate: 3.5,
  airport: {
    mxp: { label: 'Malpensa · MXP', price: 80 },
    linate: { label: 'Linate · LIN', price: 50 }
  },
  charter: {
    halfDayHours: 4,
    fullDayHours: 8,
    overtimeHourly: 30,
    // TODO: PRICING 确认半日包/全日包基础价格后填写。
    halfDayBase: null,
    fullDayBase: null
  }
};

function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

function estimateFare(distanceKm, multiplier = 1) {
  const km = Math.max(0, Number(distanceKm) || 0);
  let fare;
  if (km <= 10) {
    fare = km * PRICING.shortTripRate;
  } else if (km <= 20) {
    fare = 35 + (km - 10) * 1.5;
  } else if (km <= 50) {
    fare = 50 + (km - 20);
  } else {
    // 思维导图“50 km 以上 1.6–1.8 欧/km”，示例取中位数 €1.7/km。
    fare = 80 + (km - 50) * 1.7;
  }
  return roundMoney(fare * multiplier);
}

function makeRouteOptions(distanceKm) {
  const base = Math.max(2, Number(distanceKm) || 12);
  return [
    {
      id: 'balanced',
      label: '推荐路线',
      note: '路况更稳定',
      distanceKm: roundMoney(base),
      minutes: Math.round(base * 3.2 + 4),
      multiplier: 1
    },
    {
      id: 'fast',
      label: '最快路线',
      note: '可能经过拥堵路段',
      distanceKm: roundMoney(base * 1.08),
      minutes: Math.round(base * 2.7 + 3),
      multiplier: 1.08
    },
    {
      id: 'economy',
      label: '省钱路线',
      note: '时间稍长',
      distanceKm: roundMoney(base * 0.92),
      minutes: Math.round(base * 3.8 + 5),
      multiplier: 0.91
    }
  ].map((route) => ({ ...route, fare: estimateFare(route.distanceKm, route.multiplier) }));
}

function cancellationFee(cancelledCount) {
  // 每月前三次免费，从第四次开始收订单金额的 5%。
  return cancelledCount >= 3 ? 0.05 : 0;
}

function formatEuro(value) {
  if (value === null || value === undefined) return '待配置';
  return `€${Number(value).toFixed(2)}`;
}


const KEY = 'milan-ride-demo-state-v1';

const defaultState = {
  profile: {
    passenger: { name: '陈小满', email: 'xiaoman@example.com', verified: false },
    driver: {
      name: 'Marco Rossi',
      rating: 4.92,
      creditScore: 98,
      italianLicenseVerified: true,
      chinaIdVerified: true,
      online: true
    }
  },
  orders: [],
  ratings: [],
  complaints: [],
  cancellationCount: 0,
  lastResetAt: new Date().toISOString()
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getState() {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (!saved) return clone(defaultState);
    return { ...clone(defaultState), ...JSON.parse(saved) };
  } catch {
    return clone(defaultState);
  }
}

function saveState(nextState) {
  window.localStorage.setItem(KEY, JSON.stringify(nextState));
  return nextState;
}

function updateState(updater) {
  const current = getState();
  const next = updater(current) || current;
  return saveState(next);
}

function resetDemoData() {
  window.localStorage.removeItem(KEY);
  return getState();
}


/**
 * 数据访问层：通过 http://localhost:5173 运行时会优先调用 PostgreSQL 后端。
 * 双击 index.html 或数据库未配置时，会自动降级到 localStorage 演示模式。
 */
const wait = (milliseconds = 180) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const newId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;

function localState() {
  return { ...getState(), dataSource: 'local' };
}

async function request(path, options = {}) {
  // file:/// 直接打开时没有可用的 /api，浏览器会抛错并回退到本地演示模式。
  if (window.location.protocol === 'file:') return null;
  try {
    const response = await fetch(path, {
      headers: { 'Content-Type': 'application/json', ...(options.headers || {}) },
      ...options
    });
    if (!response.ok) return null;
    return response.json();
  } catch {
    return null;
  }
}

async function getAppState() {
  const state = await request('/api/state');
  return state ? { ...state, dataSource: 'postgresql' } : localState();
}

async function createOrder(payload) {
  const remote = await request('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  await wait(260);
  const order = { id: newId('ord'), createdAt: new Date().toISOString(), status: 'matching', driver: null, deviationAlert: false, ...payload };
  updateState((state) => ({ ...state, orders: [order, ...state.orders] }));
  return order;
}

async function updateOrder(orderId, patch) {
  const remote = await request(`/api/orders/${encodeURIComponent(orderId)}`, { method: 'PATCH', body: JSON.stringify(patch) });
  if (remote) return remote;
  await wait();
  let result;
  updateState((state) => {
    const orders = state.orders.map((order) => {
      if (order.id !== orderId) return order;
      result = { ...order, ...patch, updatedAt: new Date().toISOString() };
      return result;
    });
    return { ...state, orders };
  });
  return result;
}

async function cancelOrder(orderId) {
  const remote = await request(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
  if (remote) return remote;
  await wait();
  let result;
  updateState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    const feeRate = state.cancellationCount >= 3 ? 0.05 : 0;
    result = { ...order, status: 'cancelled', cancellationFee: Math.round(order.fare * feeRate * 100) / 100, updatedAt: new Date().toISOString() };
    return { ...state, cancellationCount: state.cancellationCount + 1, orders: state.orders.map((item) => item.id === orderId ? result : item) };
  });
  return result;
}

async function submitRating(payload) {
  const remote = await request('/api/ratings', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  await wait();
  const rating = { id: newId('rating'), createdAt: new Date().toISOString(), ...payload };
  updateState((state) => ({ ...state, ratings: [rating, ...state.ratings] }));
  return rating;
}

async function createComplaint(payload) {
  const remote = await request('/api/complaints', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  await wait();
  const complaint = { id: newId('complaint'), createdAt: new Date().toISOString(), status: 'received', ...payload };
  updateState((state) => ({ ...state, complaints: [complaint, ...state.complaints] }));
  return complaint;
}

async function createLostItem(payload) {
  const remote = await request('/api/lost-items', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  return { id: newId('lost'), createdAt: new Date().toISOString(), status: 'open', ...payload };
}

async function updateProfile(role, patch) {
  const remote = await request(`/api/profiles/${role}`, { method: 'PATCH', body: JSON.stringify(patch) });
  if (remote) return remote;
  updateState((state) => ({ ...state, profile: { ...state.profile, [role]: { ...state.profile[role], ...patch } } }));
  return getState().profile[role];
}

async function resetLocalDemoData() {
  resetDemoData();
  return localState();
}


const app = document.querySelector('#app');
// 每个小程序入口在构建时写入自己的角色；源码默认是乘客端。
const APP_ROLE = window.MILANO_RIDE_APP_ROLE === 'driver' ? 'driver' : 'passenger';
const ASSIGNED_DRIVER = {
  name: 'Marco Rossi',
  car: 'Mercedes Vito · IT 786 MR',
  rating: 4.92,
  phone: '+39 333 820 4681'
};
const REASSIGNED_DRIVER = {
  name: 'Luca Bianchi',
  car: 'Volkswagen Touran · IT 462 LB',
  rating: 4.88,
  phone: '+39 345 612 2094'
};

let data;
let ui = {
  role: APP_ROLE,
  screen: APP_ROLE === 'driver' ? 'driver-home' : 'home',
  bookingType: 'now',
  charterKind: 'mxp',
  pickup: 'Milano Centrale',
  destination: 'Duomo di Milano',
  distanceKm: 12.4,
  selectedRoute: 'balanced',
  paymentMethod: 'alipay',
  scheduledAt: '',
  modal: null,
  toast: ''
};

const escapeHTML = (value = '') => String(value)
  .replaceAll('&', '&amp;')
  .replaceAll('<', '&lt;')
  .replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;')
  .replaceAll("'", '&#039;');

const formatDate = (dateValue) => {
  if (!dateValue) return '现在出发';
  const date = new Date(dateValue);
  if (Number.isNaN(date.getTime())) return dateValue;
  return new Intl.DateTimeFormat('zh-CN', {
    month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
  }).format(date);
};

const formatDateTime = (dateValue) => new Intl.DateTimeFormat('zh-CN', {
  month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false
}).format(new Date(dateValue));

const statusMeta = {
  matching: ['正在匹配', 'amber'],
  waiting_driver: ['等待司机接单', 'amber'],
  accepted: ['司机已接单', 'blue'],
  in_progress: ['行程进行中', 'blue'],
  completed: ['已完成', 'green'],
  cancelled: ['已取消', 'gray']
};

function getRoutes() {
  return makeRouteOptions(ui.distanceKm);
}

function selectedRoute() {
  return getRoutes().find((route) => route.id === ui.selectedRoute) || getRoutes()[0];
}

function activePassengerOrder() {
  return data.orders.find((order) => ['matching', 'waiting_driver', 'accepted', 'in_progress'].includes(order.status));
}

function serviceEligibleOrder() {
  return data.orders.find((order) => order.status === 'completed');
}

function showToast(message) {
  ui.toast = message;
  render();
  window.clearTimeout(showToast.timeout);
  showToast.timeout = window.setTimeout(() => {
    ui.toast = '';
    render();
  }, 2600);
}

async function refresh() {
  data = await getAppState();
}

function pageShell(content) {
  const roleLabel = APP_ROLE === 'passenger' ? '乘客小程序' : '司机小程序';
  return `
    <main class="phone-shell">
      <div class="status-bar"><span>9:41</span><span>● ● ●  ▰</span></div>
      <header class="app-header">
        <div>
          <p class="eyebrow">MILANO RIDE · 练手版</p>
          <h1>${roleLabel}</h1>
        </div>
        <span class="role-switch locked-role">独立应用</span>
      </header>
      <section class="page-content">${content}</section>
      ${APP_ROLE === 'passenger' ? passengerNav() : driverNav()}
      ${ui.modal ? renderModal() : ''}
      ${ui.toast ? `<div class="toast">${escapeHTML(ui.toast)}</div>` : ''}
    </main>`;
}

function passengerNav() {
  const tabs = [
    ['home', '⌂', '叫车'],
    ['orders', '▣', '订单'],
    ['services', '◌', '服务'],
    ['profile', '☺', '我的']
  ];
  return `<nav class="bottom-nav">${tabs.map(([screen, icon, label]) => `
    <button class="nav-item ${ui.screen === screen ? 'active' : ''}" data-action="nav" data-screen="${screen}">
      <span>${icon}</span>${label}
    </button>`).join('')}</nav>`;
}

function driverNav() {
  const tabs = [
    ['driver-home', '⌂', '接单'],
    ['driver-orders', '▣', '订单'],
    ['driver-profile', '☺', '我的']
  ];
  return `<nav class="bottom-nav">${tabs.map(([screen, icon, label]) => `
    <button class="nav-item ${ui.screen === screen ? 'active' : ''}" data-action="nav" data-screen="${screen}">
      <span>${icon}</span>${label}
    </button>`).join('')}</nav>`;
}

function renderHome() {
  return `
    <section class="hero-map">
      <div class="map-grid"></div><span class="map-road road-a"></span><span class="map-road road-b"></span>
      <span class="map-pin pin-a">●</span><span class="map-pin pin-b">◆</span>
      <div class="location-pill">⌖ Milano · 已模拟定位</div>
      <div class="safety-mini">🛡️ 行程全程守护</div>
    </section>
    ${activePassengerOrder() ? renderActiveOrder(activePassengerOrder()) : ''}
    <section class="booking-card">
      <div class="segmented">
        ${[['now', '即时'], ['scheduled', '预约'], ['charter', '包车']].map(([type, label]) => `
          <button data-action="booking-type" data-type="${type}" class="${ui.bookingType === type ? 'selected' : ''}">${label}</button>`).join('')}
      </div>
      ${ui.bookingType === 'charter' ? renderCharterForm() : renderRideForm()}
    </section>
    <section class="notice-card"><span>🛡️</span><p>上车后会展示司机与乘客的真实姓名及安全注意事项。建议优先坐后排，避免坐副驾驶。</p></section>`;
}

function renderRideForm() {
  const routes = getRoutes();
  const route = selectedRoute();
  return `
    <div class="place-inputs">
      <label><span class="dot origin"></span><input data-field="pickup" value="${escapeHTML(ui.pickup)}" aria-label="上车点" /></label>
      <i></i>
      <label><span class="dot destination"></span><input data-field="destination" value="${escapeHTML(ui.destination)}" aria-label="目的地" /></label>
    </div>
    <div class="distance-row"><span>预计距离</span><strong>${Number(ui.distanceKm).toFixed(1)} km</strong></div>
    <input class="range" type="range" min="2" max="90" step="0.5" value="${ui.distanceKm}" data-field="distanceKm" aria-label="预计距离" />
    ${ui.bookingType === 'scheduled' ? `<label class="schedule-field">出发时间<input type="datetime-local" data-field="scheduledAt" value="${ui.scheduledAt}" /></label>` : ''}
    <div class="section-label"><span>Waze 风格路线模拟</span><small>每条路线报价不同</small></div>
    <div class="route-list">${routes.map((item) => `
      <button class="route-option ${item.id === route.id ? 'selected' : ''}" data-action="select-route" data-route="${item.id}">
        <span class="route-radio"></span><span class="route-name"><b>${item.label}</b><small>${item.note} · ${item.distanceKm} km · 约 ${item.minutes} 分钟</small></span><strong>${formatEuro(item.fare)}</strong>
      </button>`).join('')}</div>
    <div class="vehicle-note"><span>🚙</span><span><b>5 座舒适车型</b><small>更多座位规格待完善</small></span></div>
    ${renderPaymentOptions()}
    <button class="primary-button" data-action="book-ride">${ui.bookingType === 'scheduled' ? '提交预约订单' : '呼叫附近司机'} <span>${formatEuro(route.fare)}</span></button>
    <p class="hint">10 km 内 €3.5/km；20 / 30 / 40 / 50 km 阶梯计价。实际地图接入后以服务端报价为准。</p>`;
}

function renderPaymentOptions() {
  return `<div class="section-label payment-title"><span>平台支付</span><small>付款后由司机自行提现（模拟）</small></div>
    <div class="payment-options">
      <button class="${ui.paymentMethod === 'alipay' ? 'selected' : ''}" data-action="payment-method" data-payment="alipay">支付宝<span>实时汇率模拟</span></button>
      <button class="${ui.paymentMethod === 'wechat' ? 'selected' : ''}" data-action="payment-method" data-payment="wechat">微信支付<span>平台托管模拟</span></button>
    </div>`;
}

function renderCharterForm() {
  const choices = [
    ['mxp', '机场接送 · MXP', '一口价 €80'],
    ['linate', '机场接送 · LIN', '一口价 €50'],
    ['half-day', '半日包 · 4 小时', `基础价待配置；超时 €${PRICING.charter.overtimeHourly}/小时`],
    ['full-day', '全日包 · 8 小时', `基础价待配置；超时 €${PRICING.charter.overtimeHourly}/小时`]
  ];
  const preset = PRICING.airport[ui.charterKind];
  const pending = !preset;
  return `
    <p class="form-title">选择包车服务</p>
    <div class="charter-list">${choices.map(([id, name, detail]) => `
      <button class="charter-option ${ui.charterKind === id ? 'selected' : ''}" data-action="charter-kind" data-kind="${id}">
        <span class="route-radio"></span><span><b>${name}</b><small>${detail}</small></span>
      </button>`).join('')}</div>
    <label class="schedule-field">出发时间<input type="datetime-local" data-field="scheduledAt" value="${ui.scheduledAt}" /></label>
    ${renderPaymentOptions()}
    <button class="primary-button" data-action="book-charter">提交包车需求 <span>${pending ? '待报价' : formatEuro(preset.price)}</span></button>
    <p class="hint">半日/全日的基础价格在需求里尚未指定，已在 <code>src/pricing.js</code> 留出配置位置。</p>`;
}

function renderActiveOrder(order) {
  const [statusLabel, color] = statusMeta[order.status];
  const driverText = order.driver ? `${order.driver.name} · ${order.driver.car}` : '平台正在分配距离你较近的在线司机';
  return `
    <section class="active-order accent-${color}">
      <div><span class="status-chip ${color}">${statusLabel}</span><button class="link-button" data-action="order-detail" data-id="${order.id}">查看详情 ›</button></div>
      <h2>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h2>
      <p>${driverText}</p>
      <div class="active-actions">
        ${order.status === 'in_progress' ? `<button data-action="open-deviation" data-id="${order.id}">模拟偏航预警</button>` : ''}
        ${['matching', 'waiting_driver', 'accepted'].includes(order.status) ? `<button data-action="cancel-order" data-id="${order.id}" class="danger-soft">取消订单</button>` : ''}
        <strong>${order.pricePending ? '待报价' : formatEuro(order.fare)}</strong>
      </div>
    </section>`;
}

function renderOrders() {
  const orders = data.orders;
  return `
    <section class="screen-title"><div><p class="eyebrow">TRIPS</p><h2>我的订单</h2></div><button class="small-button" data-action="nav" data-screen="home">去叫车</button></section>
    ${orders.length ? `<div class="order-list">${orders.map(renderOrderCard).join('')}</div>` : renderEmpty('还没有订单', '从一次即时叫车开始练习完整流程。', '去叫车')}`;
}

function renderOrderCard(order) {
  const [statusLabel, color] = statusMeta[order.status];
  return `<button class="order-card" data-action="order-detail" data-id="${order.id}">
    <div><span class="status-chip ${color}">${statusLabel}</span><time>${formatDate(order.createdAt)}</time></div>
    <h3>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h3>
    <p>${order.serviceLabel || (order.type === 'scheduled' ? '预约快车' : '即时快车')} · ${order.distanceKm ? `${order.distanceKm} km` : '包车服务'}</p>
    <strong>${order.pricePending ? '待报价' : formatEuro(order.fare)}</strong>
  </button>`;
}

function renderServices() {
  const completed = serviceEligibleOrder();
  return `
    <section class="screen-title"><div><p class="eyebrow">SUPPORT</p><h2>服务与客服</h2></div></section>
    <section class="service-hero"><span>24</span><div><b>小时内回应</b><p>提交邮件后，客服会在 24 小时内回复。</p></div></section>
    <div class="service-list">
      <button data-action="open-rating" ${completed ? '' : 'disabled'}><span>★</span><div><b>评价司机</b><small>行程结束后 24 小时内可评分</small></div><em>${completed ? '›' : '暂无已完成订单'}</em></button>
      <button data-action="open-complaint" ${completed ? '' : 'disabled'}><span>!</span><div><b>投诉与反馈</b><small>行程结束后 7 天内可提交</small></div><em>${completed ? '›' : '暂无已完成订单'}</em></button>
      <button data-action="open-lost" ${completed ? '' : 'disabled'}><span>⌁</span><div><b>失物招领</b><small>订单保留 1 个月，可联系司机协商</small></div><em>${completed ? '›' : '暂无已完成订单'}</em></button>
      <button data-action="email-support"><span>✉</span><div><b>邮件联系客服</b><small>support@milanride.demo（练习用）</small></div><em>›</em></button>
    </div>
    ${completed ? '' : `<section class="practice-tip"><b>练习提示</b><p>先在乘客端创建订单，再切到司机端接单、开始和完成行程，即可体验评价、投诉与失物招领。</p></section>`}`;
}

function renderProfile() {
  const person = data.profile.passenger;
  const databaseConnected = data.dataSource === 'postgresql';
  return `
    <section class="profile-card"><div class="avatar">陈</div><div><h2>${person.name}</h2><p>${person.email}</p></div><button class="small-button" data-action="verify-passenger">${person.verified ? '已认证' : '模拟认证'}</button></section>
    <div class="profile-menu">
      <div><span>▧</span><b>身份与支付方式</b><em>${person.verified ? '已完成（模拟）' : '可选认证'}</em></div>
      <div><span>☏</span><b>紧急联系人</b><em>待设置</em></div>
      <div><span>◉</span><b>隐私与行程安全</b><em>›</em></div>
    </div>
    <section class="data-note"><b>${databaseConnected ? 'PostgreSQL 数据库已连接' : '本机演示数据'}</b><p>${databaseConnected ? '订单、评价与投诉会保存到 Aiven PostgreSQL。' : '订单、评价和投诉当前只保存在此浏览器；启动数据库版服务器后会自动切换。'}</p>${databaseConnected ? '' : '<button data-action="reset-data">清空演示数据</button>'}</section>`;
}

function renderDriverHome() {
  const candidates = data.orders.filter((order) => ['matching', 'waiting_driver'].includes(order.status));
  const active = data.orders.find((order) => order.driver?.name === ASSIGNED_DRIVER.name && ['accepted', 'in_progress'].includes(order.status));
  return `
    <section class="driver-summary"><div><p class="eyebrow">DRIVER CENTER</p><h2>你好，${data.profile.driver.name}</h2><p>信誉分 ${data.profile.driver.creditScore} · 评分 ${data.profile.driver.rating}</p></div><label class="switch"><input type="checkbox" data-field="driverOnline" ${data.profile.driver.online ? 'checked' : ''}><span></span>接单中</label></section>
    <section class="verification-card"><span>✓</span><div><b>司机认证已通过（模拟）</b><p>意大利驾照、中国身份证 · 仅作练手展示</p></div></section>
    ${active ? renderDriverActive(active) : `
      <section class="screen-title compact"><div><p class="eyebrow">NEW REQUESTS</p><h2>可接订单</h2></div><span class="count-pill">${candidates.length}</span></section>
      ${data.profile.driver.online ? (candidates.length ? `<div class="driver-order-list">${candidates.map(renderDriverCandidate).join('')}</div>` : renderEmpty('暂时没有新订单', '在乘客端发起一次叫车，订单会出现在这里。', '切到乘客端')) : `<section class="offline-card">你当前处于离线状态，打开接单开关后可查看订单。</section>`}`}
  `;
}

function renderDriverCandidate(order) {
  return `<article class="driver-order-card">
    <div><span class="status-chip amber">新订单</span><time>${formatDate(order.createdAt)}</time></div>
    <h3>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h3>
    <p>${order.distanceKm || '包车'} km · ${order.routeLabel || order.serviceLabel} · 乘客 ${escapeHTML(data.profile.passenger.name)}</p>
    <strong>${order.pricePending ? '待报价' : formatEuro(order.fare)}</strong>
    <div class="driver-actions"><button class="outline-button" data-action="driver-reject" data-id="${order.id}">拒绝</button><button class="primary-button compact-button" data-action="driver-accept" data-id="${order.id}">接单</button></div>
  </article>`;
}

function renderDriverActive(order) {
  return `<section class="driver-active">
    <span class="status-chip blue">${order.status === 'in_progress' ? '行程进行中' : '已接单'}</span>
    <h2>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h2>
    <p>乘客：${data.profile.passenger.name} · 请向乘客展示真实姓名与安全注意事项。</p>
    <div class="driver-active-footer"><strong>${order.pricePending ? '待报价' : formatEuro(order.fare)}</strong>
      ${order.status === 'accepted' ? `<button class="primary-button compact-button" data-action="start-trip" data-id="${order.id}">开始行程</button>` : `<button class="primary-button compact-button" data-action="complete-trip" data-id="${order.id}">完成行程</button>`}
    </div>
  </section>`;
}

function renderDriverOrders() {
  const orders = data.orders.filter((order) => order.driver?.name === ASSIGNED_DRIVER.name || order.driver?.name === REASSIGNED_DRIVER.name);
  return `<section class="screen-title"><div><p class="eyebrow">HISTORY</p><h2>我的行程单</h2></div></section>${orders.length ? `<div class="order-list">${orders.map(renderOrderCard).join('')}</div>` : renderEmpty('尚无接单记录', '接单后的订单会显示在这里。', '去接单')}`;
}

function renderDriverProfile() {
  const driver = data.profile.driver;
  const databaseConnected = data.dataSource === 'postgresql';
  return `<section class="profile-card"><div class="avatar driver-avatar">M</div><div><h2>${driver.name}</h2><p>评分 ${driver.rating} · 信誉分 ${driver.creditScore}</p></div></section>
    <div class="profile-menu"><div><span>✓</span><b>意大利驾照</b><em>已认证（模拟）</em></div><div><span>✓</span><b>中国身份证</b><em>已认证（模拟）</em></div><div><span>▧</span><b>收款账户</b><em>待接入数据库</em></div></div>
    <section class="data-note"><b>${databaseConnected ? '数据已保存到 PostgreSQL' : '取消规则提醒'}</b><p>${databaseConnected ? '当前司机资料与订单状态会保存到 Aiven PostgreSQL。' : '司机接单后取消会影响信誉分和评分。本练手版本只做界面提示，不会修改真实信用数据。'}</p></section>`;
}

function renderDriverActiveScreen() {
  if (ui.screen === 'driver-orders') return renderDriverOrders();
  if (ui.screen === 'driver-profile') return renderDriverProfile();
  return renderDriverHome();
}

function renderEmpty(title, description, actionLabel) {
  if (actionLabel.includes('乘客')) {
    return `<section class="empty-state"><div>⌁</div><h3>${title}</h3><p>${description}</p><small>请在独立的乘客小程序中创建订单。</small></section>`;
  }
  const action = actionLabel.includes('乘客') ? 'switch-role' : 'nav';
  const target = actionLabel === '去叫车' ? 'home' : actionLabel === '去接单' ? 'driver-home' : '';
  return `<section class="empty-state"><div>⌁</div><h3>${title}</h3><p>${description}</p><button class="outline-button" data-action="${action}" ${target ? `data-screen="${target}"` : ''}>${actionLabel}</button></section>`;
}

function renderModal() {
  const modal = ui.modal;
  let body = '';
  if (modal.type === 'order') body = orderDetailModal(data.orders.find((order) => order.id === modal.orderId));
  if (modal.type === 'rating') body = ratingModal(serviceEligibleOrder());
  if (modal.type === 'complaint') body = complaintModal(serviceEligibleOrder());
  if (modal.type === 'lost') body = lostModal(serviceEligibleOrder());
  if (modal.type === 'deviation') body = deviationModal(data.orders.find((order) => order.id === modal.orderId));
  return `<div class="modal-backdrop" data-action="close-modal"><section class="modal" role="dialog" aria-modal="true" data-stop>
    <button class="modal-close" data-action="close-modal">×</button>${body}</section></div>`;
}

function orderDetailModal(order) {
  if (!order) return '<h2>订单不存在</h2>';
  const [statusLabel, color] = statusMeta[order.status];
  const driver = order.driver;
  return `<p class="eyebrow">ORDER DETAIL</p><h2>${order.serviceLabel || '快车订单'}</h2>
    <span class="status-chip ${color}">${statusLabel}</span>
    <div class="timeline"><div><b>上车点</b><p>${escapeHTML(order.pickup)}</p></div><div><b>目的地</b><p>${escapeHTML(order.destination)}</p></div></div>
    <div class="detail-grid"><span>订单时间</span><b>${formatDateTime(order.createdAt)}</b><span>路线</span><b>${escapeHTML(order.routeLabel || '包车待确认')}</b><span>支付方式</span><b>${order.paymentMethod === 'wechat' ? '微信支付（模拟）' : '支付宝（模拟）'}</b><span>费用</span><b>${order.pricePending ? '待报价' : formatEuro(order.fare)}</b></div>
    ${driver ? `<section class="driver-contact"><div class="avatar driver-avatar">${driver.name.slice(0, 1)}</div><div><b>${driver.name}</b><p>${driver.car} · ★ ${driver.rating}</p></div><a href="tel:${driver.phone}">联系司机</a></section>` : '<p class="modal-note">平台正在为你匹配距离较近的在线司机。</p>'}
    ${order.status === 'completed' ? `<button class="primary-button full" data-action="open-rating">去评价司机</button>` : ''}`;
}

function ratingModal(order) {
  return `<p class="eyebrow">RATE YOUR TRIP</p><h2>给本次行程评分</h2><p class="modal-note">可在完成后 24 小时内评价，评价会影响司机评分和信誉分。</p>
    <form data-form="rating"><input type="hidden" name="orderId" value="${order?.id || ''}"><div class="stars"><input type="radio" id="s5" name="score" value="5" checked><label for="s5">★</label><input type="radio" id="s4" name="score" value="4"><label for="s4">★</label><input type="radio" id="s3" name="score" value="3"><label for="s3">★</label><input type="radio" id="s2" name="score" value="2"><label for="s2">★</label><input type="radio" id="s1" name="score" value="1"><label for="s1">★</label></div><textarea name="comment" placeholder="分享你的乘车感受（选填）"></textarea><button class="primary-button full" type="submit">提交评价</button></form>`;
}

function complaintModal(order) {
  return `<p class="eyebrow">REPORT A PROBLEM</p><h2>投诉与反馈</h2><p class="modal-note">仅支持行程结束后 7 天内提交。本版本会在浏览器本地记录。</p>
    <form data-form="complaint"><input type="hidden" name="orderId" value="${order?.id || ''}"><label class="form-stack">问题类型<select name="reason"><option>司机不当行为</option><option>路线问题</option><option>费用问题</option><option>其他问题</option></select></label><textarea name="description" required placeholder="请描述遇到的问题"></textarea><button class="primary-button full" type="submit">提交投诉</button></form>`;
}

function lostModal(order) {
  const driver = order?.driver || ASSIGNED_DRIVER;
  return `<p class="eyebrow">LOST & FOUND</p><h2>失物招领</h2><p class="modal-note">订单记录将保留一个月。你可以先联系司机，协商领取方式。</p>
    <div class="driver-contact"><div class="avatar driver-avatar">${driver.name.slice(0, 1)}</div><div><b>${driver.name}</b><p>${driver.car}</p></div><a href="tel:${driver.phone}">联系司机</a></div>
    <form data-form="lost"><input type="hidden" name="orderId" value="${order?.id || ''}"><textarea name="description" required placeholder="描述遗失物品，例如：黑色雨伞"></textarea><button class="outline-button full" type="submit">记录失物信息（本地）</button></form>`;
}

function deviationModal(order) {
  return `<p class="eyebrow">ROUTE SAFETY</p><h2>检测到路线偏离</h2><div class="warning-icon">!</div><p class="modal-note">车辆偏离规划路线超过阈值。请在 5 分钟内确认是否安全；若未确认且司机未校准路线，系统将通知紧急联系人并发送位置。</p>
    <div class="countdown">04:59 <small>模拟倒计时</small></div><button class="primary-button full" data-action="confirm-safe" data-id="${order?.id || ''}">我安全，继续行程</button><button class="outline-button full" data-action="notify-emergency" data-id="${order?.id || ''}">模拟通知紧急联系人</button>`;
}

function render() {
  if (!data) return;
  let content;
  if (APP_ROLE === 'driver') content = renderDriverActiveScreen();
  else if (ui.screen === 'orders') content = renderOrders();
  else if (ui.screen === 'services') content = renderServices();
  else if (ui.screen === 'profile') content = renderProfile();
  else content = renderHome();
  app.innerHTML = pageShell(content);
}

async function bookRide() {
  const route = selectedRoute();
  const order = await createOrder({
    type: ui.bookingType,
    serviceLabel: ui.bookingType === 'scheduled' ? '预约快车' : '即时快车',
    pickup: ui.pickup || '未填写上车点',
    destination: ui.destination || '未填写目的地',
    scheduledAt: ui.bookingType === 'scheduled' ? ui.scheduledAt : null,
    distanceKm: route.distanceKm,
    routeId: route.id,
    routeLabel: route.label,
    routeMinutes: route.minutes,
    fare: route.fare,
    paymentMethod: ui.paymentMethod,
    pricePending: false
  });
  await refresh();
  showToast('订单已创建，正在向附近在线司机派单');
  window.setTimeout(async () => {
    const current = data?.orders.find((item) => item.id === order.id);
    if (current?.status === 'matching') {
      await updateOrder(order.id, { status: 'waiting_driver', assignmentNote: '已发送给附近在线司机' });
      await refresh();
      render();
    }
  }, 1200);
}

async function bookCharter() {
  const airport = PRICING.airport[ui.charterKind];
  const title = airport ? `${airport.label} 机场接送` : ui.charterKind === 'half-day' ? '半日包车（4小时）' : '全日包车（8小时）';
  await createOrder({
    type: 'charter', serviceLabel: title, pickup: '待与司机确认上车点', destination: airport ? airport.label : '包车行程待确认',
    scheduledAt: ui.scheduledAt || null, distanceKm: null, routeLabel: '包车服务', fare: airport?.price ?? 0,
    pricePending: !airport, charterKind: ui.charterKind, paymentMethod: ui.paymentMethod
  });
  await refresh();
  showToast(airport ? '机场接送订单已创建，正在派单' : '包车需求已提交，基础价待配置');
}

async function handleAction(action, element) {
  const id = element.dataset.id;
  if (action === 'nav') { ui.screen = element.dataset.screen; render(); return; }
  if (action === 'switch-role') return;
  if (action === 'booking-type') { ui.bookingType = element.dataset.type; render(); return; }
  if (action === 'charter-kind') { ui.charterKind = element.dataset.kind; render(); return; }
  if (action === 'payment-method') { ui.paymentMethod = element.dataset.payment; render(); return; }
  if (action === 'select-route') { ui.selectedRoute = element.dataset.route; render(); return; }
  if (action === 'book-ride') { await bookRide(); return; }
  if (action === 'book-charter') { await bookCharter(); return; }
  if (action === 'order-detail') { ui.modal = { type: 'order', orderId: id }; render(); return; }
  if (action === 'close-modal') { ui.modal = null; render(); return; }
  if (action === 'cancel-order') {
    const fee = cancellationFee(data.cancellationCount);
    const order = await cancelOrder(id); await refresh();
    showToast(fee ? `订单已取消，已收取 ${formatEuro(order.cancellationFee)} 取消费` : `订单已取消（本月还可免费取消 ${Math.max(0, 3 - data.cancellationCount)} 次）`);
    return;
  }
  if (action === 'driver-accept') {
    await updateOrder(id, { status: 'accepted', driver: ASSIGNED_DRIVER }); await refresh(); showToast('已接单，乘客端已收到司机信息'); return;
  }
  if (action === 'driver-reject') {
    await updateOrder(id, { status: 'matching', driverRejected: true, assignmentNote: '当前司机拒绝，系统重新分配中' }); await refresh(); showToast('已拒绝，平台正在重新分配；真实业务会影响信誉度');
    window.setTimeout(async () => { const current = data?.orders.find((item) => item.id === id); if (current?.status === 'matching') { await updateOrder(id, { status: 'accepted', driver: REASSIGNED_DRIVER }); await refresh(); render(); } }, 1300);
    return;
  }
  if (action === 'start-trip') { await updateOrder(id, { status: 'in_progress', startedAt: new Date().toISOString() }); await refresh(); showToast('行程已开始，安全守护已开启'); return; }
  if (action === 'complete-trip') { await updateOrder(id, { status: 'completed', completedAt: new Date().toISOString() }); await refresh(); showToast('行程已完成，乘客可在 24 小时内评价'); return; }
  if (action === 'open-rating') { ui.modal = { type: 'rating' }; render(); return; }
  if (action === 'open-complaint') { ui.modal = { type: 'complaint' }; render(); return; }
  if (action === 'open-lost') { ui.modal = { type: 'lost' }; render(); return; }
  if (action === 'email-support') { window.location.href = 'mailto:support@milanride.demo?subject=Milano%20Ride%20客服咨询'; return; }
  if (action === 'open-deviation') { ui.modal = { type: 'deviation', orderId: id }; render(); return; }
  if (action === 'confirm-safe') { await updateOrder(id, { deviationAlert: false, passengerConfirmedSafeAt: new Date().toISOString() }); ui.modal = null; await refresh(); showToast('已确认安全，行程继续'); return; }
  if (action === 'notify-emergency') { await updateOrder(id, { deviationAlert: true, emergencyNotifiedAt: new Date().toISOString() }); ui.modal = null; await refresh(); showToast('已模拟通知紧急联系人并发送位置'); return; }
  if (action === 'verify-passenger') {
    await updateProfile('passenger', { verified: true });
    await refresh();
    showToast('身份认证状态已更新（模拟）'); return;
  }
  if (action === 'reset-data') { await resetLocalDemoData(); await refresh(); ui.screen = 'home'; showToast('演示数据已清空'); return; }
}

app.addEventListener('click', async (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  if (button.dataset.stop !== undefined) return;
  if (button.dataset.action === 'close-modal' && event.target.closest('[data-stop]')) return;
  await handleAction(button.dataset.action, button);
});

app.addEventListener('input', (event) => {
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'distanceKm') { ui.distanceKm = Number(event.target.value); render(); return; }
  if (field === 'pickup' || field === 'destination' || field === 'scheduledAt') ui[field] = event.target.value;
});

app.addEventListener('change', async (event) => {
  if (event.target.dataset.field === 'driverOnline') {
    await updateProfile('driver', { online: event.target.checked });
    await refresh();
    render();
  }
});

app.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const fields = new FormData(form);
  if (form.dataset.form === 'rating') {
    await submitRating({ orderId: fields.get('orderId'), score: Number(fields.get('score')), comment: fields.get('comment') });
    ui.modal = null; await refresh(); showToast('感谢你的评价，已保存到本地演示数据');
  }
  if (form.dataset.form === 'complaint') {
    await createComplaint({ orderId: fields.get('orderId'), reason: fields.get('reason'), description: fields.get('description') });
    ui.modal = null; await refresh(); showToast('投诉已提交，客服将在 24 小时内回复（模拟）');
  }
  if (form.dataset.form === 'lost') {
    await createLostItem({ orderId: fields.get('orderId'), description: fields.get('description') });
    ui.modal = null; await refresh(); showToast(`已记录失物：${fields.get('description')}`);
  }
});

await refresh();
render();

})().catch((error) => {
  console.error(error);
  document.querySelector('#app').innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>页面没有启动</h1><p>请刷新后重试。错误信息已输出到浏览器开发者工具。</p></main>';
});
