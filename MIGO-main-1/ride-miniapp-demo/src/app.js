import { PRICING, formatEuro, makeRouteOptions } from './pricing.js';
import {
  ApiError,
  AuthRequiredError,
  acceptOrder,
  apiMode,
  cancelOrder,
  completeTrip,
  createComplaint,
  createLostItem,
  createOrder,
  declineOrder,
  getAppState,
  hasSession,
  initApi,
  loginAccount,
  logoutAccount,
  registerAccount,
  resetLocalDemoData,
  setSafety,
  simulateLocalReassign,
  startTrip,
  submitRating,
  updateProfile
} from './services/api.js';

const app = document.querySelector('#app');
// 每个小程序入口在构建时写入自己的角色；源码默认是乘客端。
const APP_ROLE = window.MILANO_RIDE_APP_ROLE === 'driver' ? 'driver' : 'passenger';

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
  toast: '',
  authMode: 'login',
  authError: '',
  authForm: {}
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
  if (Number.isNaN(date.getTime())) return escapeHTML(dateValue);
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

// 状态值来自 API，可能是未知值：必须有兜底，并且文字要转义。
const statusOf = (order) => Object.prototype.hasOwnProperty.call(statusMeta, order?.status)
  ? statusMeta[order.status]
  : [escapeHTML(order?.status ?? '未知状态'), 'gray'];

// 司机头像首字（按字符而不是 UTF-16 单元截取）。
const initialOf = (person) => escapeHTML(Array.from(String(person?.name || '?'))[0]);

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

// 司机自己的订单（司机接单后，订单里会带有这位司机的账号 ID）。
function mine(order) {
  return Boolean(order.driverId) && order.driverId === data?.me?.id;
}

// 页面里的 datetime-local 输入框没有时区；转换成带时区的标准时间再发给服务器。
function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// 预约订单显示“出发时间”，其他订单显示下单时间。
function orderTime(order) {
  const when = order.scheduledAt ? `出发 ${formatDate(order.scheduledAt)}` : formatDate(order.createdAt);
  return `<time>${when}</time>`;
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

function homeScreen() {
  return APP_ROLE === 'driver' ? 'driver-home' : 'home';
}

function showAuth(message = '') {
  data = null;
  ui.modal = null;
  ui.screen = 'auth';
  ui.authError = message;
  render();
}

// 所有会访问服务器的操作都用它包一层：登录过期就回到登录页；被服务器拒绝就提示原因，并刷新成最新状态。
async function guarded(work) {
  try {
    return await work();
  } catch (error) {
    if (error instanceof AuthRequiredError) { showAuth('登录已过期，请重新登录'); return undefined; }
    console.error(error);
    const message = error instanceof ApiError ? error.message : '操作失败，请稍后重试';
    try {
      await refresh();
    } catch (refreshError) {
      if (refreshError instanceof AuthRequiredError) { showAuth('登录已过期，请重新登录'); return undefined; }
    }
    showToast(message);
    return undefined;
  }
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
      ${ui.screen === 'auth' ? '' : (APP_ROLE === 'passenger' ? passengerNav() : driverNav())}
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

function renderAuth() {
  const isRegister = ui.authMode === 'register';
  const isDriver = APP_ROLE === 'driver';
  const roleName = isDriver ? '司机' : '乘客';
  const saved = ui.authForm || {};
  return `
    <section class="auth-card">
      <p class="eyebrow">${isRegister ? 'CREATE ACCOUNT' : 'WELCOME'}</p>
      <h2>${isRegister ? `注册${roleName}账号` : `登录${roleName}账号`}</h2>
      <form data-form="${isRegister ? 'register' : 'login'}">
        ${isRegister ? `<label class="form-stack">姓名<input name="name" value="${escapeHTML(saved.name || '')}" required maxlength="50" autocomplete="name" /></label>` : ''}
        <label class="form-stack">邮箱<input name="email" type="email" value="${escapeHTML(saved.email || '')}" required maxlength="254" autocomplete="email" /></label>
        <label class="form-stack">密码${isRegister ? '（至少 8 位）' : ''}<input name="password" type="password" required minlength="${isRegister ? 8 : 1}" maxlength="128" autocomplete="${isRegister ? 'new-password' : 'current-password'}" /></label>
        ${isRegister && isDriver ? `
          <label class="form-stack">手机号<input name="phone" value="${escapeHTML(saved.phone || '')}" required maxlength="30" autocomplete="tel" /></label>
          <label class="form-stack">车辆信息（车型 · 车牌）<input name="car" value="${escapeHTML(saved.car || '')}" required maxlength="80" placeholder="例如：Mercedes Vito · IT 786 MR" /></label>` : ''}
        ${ui.authError ? `<p class="form-error">${escapeHTML(ui.authError)}</p>` : ''}
        <button class="primary-button full" type="submit">${isRegister ? '注册并登录' : '登录'}</button>
      </form>
      <button class="link-button" data-action="auth-mode" data-mode="${isRegister ? 'login' : 'register'}">${isRegister ? '已有账号？去登录' : '没有账号？去注册'}</button>
      ${isRegister && isDriver ? '<p class="hint">司机账号注册后需要审核通过，才能上线接单。</p>' : ''}
    </section>`;
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
    ${ui.bookingType === 'scheduled' ? `<label class="schedule-field">出发时间<input type="datetime-local" data-field="scheduledAt" value="${escapeHTML(ui.scheduledAt)}" /></label>` : ''}
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
    <label class="schedule-field">出发时间<input type="datetime-local" data-field="scheduledAt" value="${escapeHTML(ui.scheduledAt)}" /></label>
    ${renderPaymentOptions()}
    <button class="primary-button" data-action="book-charter">提交包车需求 <span>${pending ? '待报价' : formatEuro(preset.price)}</span></button>
    <p class="hint">半日/全日的基础价格在需求里尚未指定，已在 <code>src/pricing.js</code> 留出配置位置。</p>`;
}

function renderActiveOrder(order) {
  const [statusLabel, color] = statusOf(order);
  const driverText = order.driver ? `${escapeHTML(order.driver.name)} · ${escapeHTML(order.driver.car)}` : '平台正在分配距离你较近的在线司机';
  return `
    <section class="active-order accent-${color}">
      <div><span class="status-chip ${color}">${statusLabel}</span><button class="link-button" data-action="order-detail" data-id="${escapeHTML(order.id)}">查看详情 ›</button></div>
      <h2>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h2>
      <p>${driverText}</p>
      <div class="active-actions">
        ${order.status === 'in_progress' ? `<button data-action="open-deviation" data-id="${escapeHTML(order.id)}">模拟偏航预警</button>` : ''}
        ${['matching', 'waiting_driver', 'accepted'].includes(order.status) ? `<button data-action="cancel-order" data-id="${escapeHTML(order.id)}" class="danger-soft">取消订单</button>` : ''}
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
  const [statusLabel, color] = statusOf(order);
  return `<button class="order-card" data-action="order-detail" data-id="${escapeHTML(order.id)}">
    <div><span class="status-chip ${color}">${statusLabel}</span>${orderTime(order)}</div>
    <h3>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h3>
    <p>${escapeHTML(order.serviceLabel || (order.type === 'scheduled' ? '预约快车' : '即时快车'))} · ${order.distanceKm ? `${escapeHTML(order.distanceKm)} km` : '包车服务'}</p>
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
    <section class="profile-card"><div class="avatar">${initialOf(person)}</div><div><h2>${escapeHTML(person.name)}</h2><p>${escapeHTML(person.email)}</p></div><button class="small-button" data-action="verify-passenger">${person.verified ? '已认证' : '模拟认证'}</button></section>
    <div class="profile-menu">
      <div><span>▧</span><b>身份与支付方式</b><em>${person.verified ? '已完成（模拟）' : '可选认证'}</em></div>
      <div><span>☏</span><b>紧急联系人</b><em>待设置</em></div>
      <div><span>◉</span><b>隐私与行程安全</b><em>›</em></div>
    </div>
    <section class="data-note"><b>${databaseConnected ? 'PostgreSQL 数据库已连接' : '本机演示数据'}</b><p>${databaseConnected ? '订单、评价与投诉会保存到 Aiven PostgreSQL。' : '订单、评价和投诉当前只保存在此浏览器；启动数据库版服务器后会自动切换。'}</p>${databaseConnected ? '<button data-action="logout">退出登录</button>' : '<button data-action="reset-data">清空演示数据</button>'}</section>`;
}

function renderDriverHome() {
  const candidates = data.orders.filter((order) => ['matching', 'waiting_driver'].includes(order.status) && !mine(order));
  const active = data.orders.find((order) => mine(order) && ['accepted', 'in_progress'].includes(order.status));
  const approved = data.me?.approved !== false;
  return `
    <section class="driver-summary"><div><p class="eyebrow">DRIVER CENTER</p><h2>你好，${escapeHTML(data.profile.driver.name)}</h2><p>信誉分 ${escapeHTML(data.profile.driver.creditScore)} · 评分 ${escapeHTML(data.profile.driver.rating)}</p></div><label class="switch"><input type="checkbox" data-field="driverOnline" ${data.profile.driver.online ? 'checked' : ''} ${approved ? '' : 'disabled'}><span></span>接单中</label></section>
    ${approved
      ? '<section class="verification-card"><span>✓</span><div><b>司机账号已通过审核</b><p>可以打开“接单中”开关开始接单</p></div></section>'
      : '<section class="offline-card">你的司机账号正在审核中。审核通过后，才能上线和接单。</section>'}
    ${active ? renderDriverActive(active) : `
      <section class="screen-title compact"><div><p class="eyebrow">NEW REQUESTS</p><h2>可接订单</h2></div><span class="count-pill">${candidates.length}</span></section>
      ${!approved ? '' : data.profile.driver.online ? (candidates.length ? `<div class="driver-order-list">${candidates.map(renderDriverCandidate).join('')}</div>` : renderEmpty('暂时没有新订单', '在乘客端发起一次叫车，订单会出现在这里。', '切到乘客端')) : `<section class="offline-card">你当前处于离线状态，打开接单开关后可查看订单。</section>`}`}
  `;
}

function renderDriverCandidate(order) {
  return `<article class="driver-order-card">
    <div><span class="status-chip amber">新订单</span>${orderTime(order)}</div>
    <h3>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h3>
    <p>${escapeHTML(order.distanceKm || '包车')} km · ${escapeHTML(order.routeLabel || order.serviceLabel)} · 乘客 ${escapeHTML(order.passengerName || '接单后可见')}</p>
    <strong>${order.pricePending ? '待报价' : formatEuro(order.fare)}</strong>
    <div class="driver-actions"><button class="outline-button" data-action="driver-reject" data-id="${escapeHTML(order.id)}">拒绝</button><button class="primary-button compact-button" data-action="driver-accept" data-id="${escapeHTML(order.id)}">接单</button></div>
  </article>`;
}

function renderDriverActive(order) {
  return `<section class="driver-active">
    <span class="status-chip blue">${order.status === 'in_progress' ? '行程进行中' : '已接单'}</span>
    <h2>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h2>
    <p>乘客：${escapeHTML(order.passengerName || '未知')} · 请向乘客展示真实姓名与安全注意事项。</p>
    <div class="driver-active-footer"><strong>${order.pricePending ? '待报价' : formatEuro(order.fare)}</strong>
      ${order.status === 'accepted' ? `<button class="primary-button compact-button" data-action="start-trip" data-id="${escapeHTML(order.id)}">开始行程</button>` : `<button class="primary-button compact-button" data-action="complete-trip" data-id="${escapeHTML(order.id)}">完成行程</button>`}
    </div>
  </section>`;
}

function renderDriverOrders() {
  const orders = data.orders.filter(mine);
  return `<section class="screen-title"><div><p class="eyebrow">HISTORY</p><h2>我的行程单</h2></div></section>${orders.length ? `<div class="order-list">${orders.map(renderOrderCard).join('')}</div>` : renderEmpty('尚无接单记录', '接单后的订单会显示在这里。', '去接单')}`;
}

function renderDriverProfile() {
  const driver = data.profile.driver;
  const databaseConnected = data.dataSource === 'postgresql';
  return `<section class="profile-card"><div class="avatar driver-avatar">${initialOf(driver)}</div><div><h2>${escapeHTML(driver.name)}</h2><p>评分 ${escapeHTML(driver.rating)} · 信誉分 ${escapeHTML(driver.creditScore)}</p></div></section>
    <div class="profile-menu"><div><span>✓</span><b>意大利驾照</b><em>已认证（模拟）</em></div><div><span>✓</span><b>中国身份证</b><em>已认证（模拟）</em></div><div><span>▧</span><b>收款账户</b><em>待接入数据库</em></div></div>
    <section class="data-note"><b>${databaseConnected ? '数据已保存到 PostgreSQL' : '取消规则提醒'}</b><p>${databaseConnected ? '当前司机资料与订单状态会保存到 Aiven PostgreSQL。' : '司机接单后取消会影响信誉分和评分。本练手版本只做界面提示，不会修改真实信用数据。'}</p>${databaseConnected ? '<button data-action="logout">退出登录</button>' : ''}</section>`;
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
  const [statusLabel, color] = statusOf(order);
  const driver = order.driver;
  return `<p class="eyebrow">ORDER DETAIL</p><h2>${escapeHTML(order.serviceLabel || '快车订单')}</h2>
    <span class="status-chip ${color}">${statusLabel}</span>
    <div class="timeline"><div><b>上车点</b><p>${escapeHTML(order.pickup)}</p></div><div><b>目的地</b><p>${escapeHTML(order.destination)}</p></div></div>
    <div class="detail-grid"><span>订单时间</span><b>${formatDateTime(order.createdAt)}</b>${order.scheduledAt ? `<span>出发时间</span><b>${formatDateTime(order.scheduledAt)}</b>` : ''}<span>路线</span><b>${escapeHTML(order.routeLabel || '包车待确认')}</b><span>支付方式</span><b>${order.paymentMethod === 'wechat' ? '微信支付（模拟）' : '支付宝（模拟）'}</b><span>费用</span><b>${order.pricePending ? '待报价' : formatEuro(order.fare)}</b></div>
    ${driver ? `<section class="driver-contact"><div class="avatar driver-avatar">${initialOf(driver)}</div><div><b>${escapeHTML(driver.name)}</b><p>${escapeHTML(driver.car)} · ★ ${escapeHTML(driver.rating)}</p></div><a href="tel:${escapeHTML(driver.phone)}">联系司机</a></section>` : '<p class="modal-note">平台正在为你匹配距离较近的在线司机。</p>'}
    ${order.status === 'completed' ? `<button class="primary-button full" data-action="open-rating">去评价司机</button>` : ''}`;
}

function ratingModal(order) {
  return `<p class="eyebrow">RATE YOUR TRIP</p><h2>给本次行程评分</h2><p class="modal-note">可在完成后 24 小时内评价，评价会影响司机评分和信誉分。</p>
    <form data-form="rating"><input type="hidden" name="orderId" value="${escapeHTML(order?.id || '')}"><div class="stars"><input type="radio" id="s5" name="score" value="5" checked><label for="s5">★</label><input type="radio" id="s4" name="score" value="4"><label for="s4">★</label><input type="radio" id="s3" name="score" value="3"><label for="s3">★</label><input type="radio" id="s2" name="score" value="2"><label for="s2">★</label><input type="radio" id="s1" name="score" value="1"><label for="s1">★</label></div><textarea name="comment" placeholder="分享你的乘车感受（选填）"></textarea><button class="primary-button full" type="submit">提交评价</button></form>`;
}

function complaintModal(order) {
  return `<p class="eyebrow">REPORT A PROBLEM</p><h2>投诉与反馈</h2><p class="modal-note">仅支持行程结束后 7 天内提交。${data.dataSource === 'postgresql' ? '' : '本版本会在浏览器本地记录。'}</p>
    <form data-form="complaint"><input type="hidden" name="orderId" value="${escapeHTML(order?.id || '')}"><label class="form-stack">问题类型<select name="reason"><option>司机不当行为</option><option>路线问题</option><option>费用问题</option><option>其他问题</option></select></label><textarea name="description" required placeholder="请描述遇到的问题"></textarea><button class="primary-button full" type="submit">提交投诉</button></form>`;
}

function lostModal(order) {
  const driver = order?.driver || { name: '司机', car: '', phone: '' };
  return `<p class="eyebrow">LOST & FOUND</p><h2>失物招领</h2><p class="modal-note">订单记录将保留一个月。你可以先联系司机，协商领取方式。</p>
    <div class="driver-contact"><div class="avatar driver-avatar">${initialOf(driver)}</div><div><b>${escapeHTML(driver.name)}</b><p>${escapeHTML(driver.car)}</p></div><a href="tel:${escapeHTML(driver.phone)}">联系司机</a></div>
    <form data-form="lost"><input type="hidden" name="orderId" value="${escapeHTML(order?.id || '')}"><textarea name="description" required placeholder="描述遗失物品，例如：黑色雨伞"></textarea><button class="outline-button full" type="submit">记录失物信息${data.dataSource === 'postgresql' ? '' : '（本地）'}</button></form>`;
}

function deviationModal(order) {
  return `<p class="eyebrow">ROUTE SAFETY</p><h2>检测到路线偏离</h2><div class="warning-icon">!</div><p class="modal-note">车辆偏离规划路线超过阈值。请在 5 分钟内确认是否安全；若未确认且司机未校准路线，系统将通知紧急联系人并发送位置。</p>
    <div class="countdown">04:59 <small>模拟倒计时</small></div><button class="primary-button full" data-action="confirm-safe" data-id="${escapeHTML(order?.id || '')}">我安全，继续行程</button><button class="outline-button full" data-action="notify-emergency" data-id="${escapeHTML(order?.id || '')}">模拟通知紧急联系人</button>`;
}

function render() {
  if (ui.screen === 'auth') { app.innerHTML = pageShell(renderAuth()); return; }
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
  if (!ui.pickup.trim()) { showToast('请填写上车点'); return; }
  if (!ui.destination.trim()) { showToast('请填写目的地'); return; }
  const scheduledAt = ui.bookingType === 'scheduled' ? toIsoOrNull(ui.scheduledAt) : null;
  if (ui.bookingType === 'scheduled' && !scheduledAt) { showToast('请选择出发时间'); return; }
  const route = selectedRoute();
  // 第一个参数是发给服务器的“用户的选择”（价格由服务器计算）；第二个参数只在本机演示模式使用。
  await createOrder({
    type: ui.bookingType, pickup: ui.pickup.trim(), destination: ui.destination.trim(), distanceKm: Number(ui.distanceKm),
    routeId: route.id, scheduledAt, paymentMethod: ui.paymentMethod
  }, {
    type: ui.bookingType,
    serviceLabel: ui.bookingType === 'scheduled' ? '预约快车' : '即时快车',
    pickup: ui.pickup.trim(),
    destination: ui.destination.trim(),
    scheduledAt,
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
}

async function bookCharter() {
  const airport = PRICING.airport[ui.charterKind];
  const title = airport ? `${airport.label} 机场接送` : ui.charterKind === 'half-day' ? '半日包车（4小时）' : '全日包车（8小时）';
  const scheduledAt = toIsoOrNull(ui.scheduledAt);
  if (ui.scheduledAt && !scheduledAt) { showToast('出发时间格式不正确'); return; }
  await createOrder({
    type: 'charter', charterKind: ui.charterKind, scheduledAt, paymentMethod: ui.paymentMethod
  }, {
    type: 'charter', serviceLabel: title, pickup: '待与司机确认上车点', destination: airport ? airport.label : '包车行程待确认',
    scheduledAt, distanceKm: null, routeLabel: '包车服务', fare: airport?.price ?? 0,
    pricePending: !airport, charterKind: ui.charterKind, paymentMethod: ui.paymentMethod
  });
  await refresh();
  showToast(airport ? '机场接送订单已创建，正在派单' : '包车需求已提交，基础价待配置');
}

async function submitAuth(kind, fields) {
  const text = (name) => String(fields.get(name) || '').trim();
  const form = { email: text('email'), name: text('name'), phone: text('phone'), car: text('car') };
  const password = String(fields.get('password') || '');
  ui.authForm = form; // 出错时保留已填内容（密码除外）
  try {
    if (kind === 'register') await registerAccount({ ...form, password });
    else await loginAccount({ email: form.email, password });
    ui.authForm = {};
    ui.authError = '';
    ui.screen = homeScreen();
    await refresh();
    render();
  } catch (error) {
    if (!(error instanceof ApiError)) console.error(error);
    ui.authError = error instanceof ApiError ? error.message : '操作失败，请稍后重试';
    render();
  }
}

async function handleAction(action, element) {
  const id = element.dataset.id;
  if (action === 'nav') { ui.screen = element.dataset.screen; render(); return; }
  if (action === 'switch-role') return;
  if (action === 'auth-mode') { ui.authMode = element.dataset.mode === 'register' ? 'register' : 'login'; ui.authError = ''; render(); return; }
  if (action === 'logout') { await logoutAccount(); ui.authMode = 'login'; ui.authForm = {}; showAuth(); return; }
  if (action === 'booking-type') { ui.bookingType = element.dataset.type; render(); return; }
  if (action === 'charter-kind') { ui.charterKind = element.dataset.kind; render(); return; }
  if (action === 'payment-method') { ui.paymentMethod = element.dataset.payment; render(); return; }
  if (action === 'select-route') { ui.selectedRoute = element.dataset.route; render(); return; }
  if (action === 'book-ride') { await bookRide(); return; }
  if (action === 'book-charter') { await bookCharter(); return; }
  if (action === 'order-detail') { ui.modal = { type: 'order', orderId: id }; render(); return; }
  if (action === 'close-modal') { ui.modal = null; render(); return; }
  if (action === 'cancel-order') {
    const order = await cancelOrder(id); await refresh();
    showToast(order.cancellationFee > 0 ? `订单已取消，已收取 ${formatEuro(order.cancellationFee)} 取消费` : `订单已取消（本月还可免费取消 ${Math.max(0, 3 - data.cancellationCount)} 次）`);
    return;
  }
  if (action === 'driver-accept') {
    await acceptOrder(id); await refresh(); showToast('已接单，乘客端已收到司机信息'); return;
  }
  if (action === 'driver-reject') {
    await declineOrder(id); await refresh(); showToast('已拒绝，平台正在重新分配；真实业务会影响信誉度');
    // 仅本机演示：模拟另一位司机接单（连接数据库时由真实的其他司机接单）。
    if (apiMode() !== 'remote') window.setTimeout(() => guarded(async () => { await simulateLocalReassign(id); await refresh(); render(); }), 1300);
    return;
  }
  if (action === 'start-trip') { await startTrip(id); await refresh(); showToast('行程已开始，安全守护已开启'); return; }
  if (action === 'complete-trip') { await completeTrip(id); await refresh(); showToast('行程已完成，乘客可在 24 小时内评价'); return; }
  if (action === 'open-rating') { ui.modal = { type: 'rating' }; render(); return; }
  if (action === 'open-complaint') { ui.modal = { type: 'complaint' }; render(); return; }
  if (action === 'open-lost') { ui.modal = { type: 'lost' }; render(); return; }
  if (action === 'email-support') { window.location.href = 'mailto:support@milanride.demo?subject=Milano%20Ride%20客服咨询'; return; }
  if (action === 'open-deviation') { ui.modal = { type: 'deviation', orderId: id }; render(); return; }
  if (action === 'confirm-safe') { await setSafety(id, 'safe'); ui.modal = null; await refresh(); showToast('已确认安全，行程继续'); return; }
  if (action === 'notify-emergency') { await setSafety(id, 'emergency'); ui.modal = null; await refresh(); showToast('已模拟通知紧急联系人并发送位置'); return; }
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
  await guarded(() => handleAction(button.dataset.action, button));
});

app.addEventListener('input', (event) => {
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'distanceKm') { ui.distanceKm = Number(event.target.value); render(); return; }
  if (field === 'pickup' || field === 'destination' || field === 'scheduledAt') ui[field] = event.target.value;
});

app.addEventListener('change', async (event) => {
  if (event.target.dataset.field === 'driverOnline') {
    await guarded(async () => {
      await updateProfile('driver', { online: event.target.checked });
      await refresh();
      render();
    });
  }
});

app.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const fields = new FormData(form);
  const kind = form.dataset.form;
  if (kind === 'login' || kind === 'register') { await submitAuth(kind, fields); return; }
  await guarded(async () => {
    if (kind === 'rating') {
      await submitRating({ orderId: fields.get('orderId'), score: Number(fields.get('score')), comment: fields.get('comment') });
      ui.modal = null; await refresh(); showToast(data.dataSource === 'postgresql' ? '感谢你的评价' : '感谢你的评价，已保存到本地演示数据');
    }
    if (kind === 'complaint') {
      await createComplaint({ orderId: fields.get('orderId'), reason: fields.get('reason'), description: fields.get('description') });
      ui.modal = null; await refresh(); showToast('投诉已提交，客服将在 24 小时内回复（模拟）');
    }
    if (kind === 'lost') {
      await createLostItem({ orderId: fields.get('orderId'), description: fields.get('description') });
      ui.modal = null; await refresh(); showToast(`已记录失物：${fields.get('description')}`);
    }
  });
});

await initApi();
if (apiMode() === 'remote' && !hasSession()) {
  showAuth();
} else {
  await guarded(async () => { await refresh(); render(); });
}
if (!data && ui.screen !== 'auth') {
  app.innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>暂时无法连接服务器</h1><p>请确认已运行 npm.cmd run dev，然后刷新页面。</p></main>';
}
