/* 自动生成：运行 npm.cmd run build 可重新生成。 */
window.MILANO_RIDE_APP_ROLE = 'driver';
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
      car: 'Mercedes Vito · IT 786 MR',
      phone: '+39 333 820 4681',
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
 * 数据访问层。两种模式：
 * - remote（远程）：通过 http://localhost:5173 运行，并且数据库已配置。所有数据来自服务器，需要登录；
 *   服务器会拒绝不合规则的操作（比如订单已被别的司机接走），这些错误会原样提示给用户，不会悄悄改用本地数据。
 * - local（本机演示）：双击 index.html 或数据库未配置。数据只保存在浏览器 localStorage，不需要登录。
 */
const ROLE = window.MILANO_RIDE_APP_ROLE === 'driver' ? 'driver' : 'passenger';
const TOKEN_KEY = `milano-ride-token-${ROLE}`;
const LOCAL_DRIVER_ID = 'local-driver';
const LOCAL_DRIVER_DEFAULTS = { car: 'Mercedes Vito · IT 786 MR', phone: '+39 333 820 4681' };
const LOCAL_REASSIGNED_DRIVER = { id: 'local-driver-2', name: 'Luca Bianchi', car: 'Volkswagen Touran · IT 462 LB', rating: 4.88, phone: '+39 345 612 2094' };

let mode = 'local';

const wait = (milliseconds = 180) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const newId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
const nowIso = () => new Date().toISOString();

class ApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 需要（重新）登录。 */
class AuthRequiredError extends ApiError {}

// ---------- 模式与登录状态 ----------

function apiMode() {
  return mode;
}

/** 启动时调用一次：判断是连接服务器数据库，还是使用本机演示数据。 */
async function initApi() {
  if (window.location.protocol === 'file:') { mode = 'local'; return mode; }
  try {
    const response = await fetch('/api/health');
    const health = response.ok ? await response.json() : null;
    mode = health?.database === true ? 'remote' : 'local';
  } catch {
    mode = 'local';
  }
  return mode;
}

function getToken() {
  try { return window.localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

function setToken(token) {
  try {
    if (token) window.localStorage.setItem(TOKEN_KEY, token);
    else window.localStorage.removeItem(TOKEN_KEY);
  } catch { /* 浏览器禁用了存储：本次登录仍然有效，刷新后需要重新登录 */ }
}

/** 本机演示模式不需要登录；远程模式需要有登录令牌。 */
function hasSession() {
  return mode !== 'remote' || Boolean(getToken());
}

async function call(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const token = getToken();
  if (auth && token) headers.Authorization = `Bearer ${token}`;
  let response;
  try {
    response = await fetch(path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch {
    throw new ApiError('无法连接服务器，请确认网络后重试', 0, 'NETWORK');
  }
  let payload = null;
  try { payload = await response.json(); } catch { /* 返回内容不是 JSON */ }
  if (response.ok) return payload;
  const message = payload?.message || '操作失败，请稍后重试';
  if (response.status === 401 && auth) {
    setToken(null);
    throw new AuthRequiredError(message, 401, payload?.error);
  }
  throw new ApiError(message, response.status, payload?.error);
}

async function loginAccount({ email, password }) {
  const result = await call('/api/auth/login', { method: 'POST', body: { email, password, role: ROLE }, auth: false });
  setToken(result.token);
  return result.user;
}

async function registerAccount(fields) {
  const result = await call('/api/auth/register', { method: 'POST', body: { ...fields, role: ROLE }, auth: false });
  setToken(result.token);
  return result.user;
}

async function logoutAccount() {
  try { await call('/api/auth/logout', { method: 'POST' }); } catch { /* 即使服务器没回应，也要清掉本机的登录状态 */ }
  setToken(null);
}

// ---------- 本机演示模式的辅助函数 ----------

function localState() {
  const state = getState();
  const profile = state.profile[ROLE];
  return {
    ...state,
    dataSource: 'local',
    me: { id: ROLE === 'driver' ? LOCAL_DRIVER_ID : 'local-passenger', role: ROLE, name: profile.name, email: profile.email || '', approved: true }
  };
}

function patchLocalOrder(orderId, patch) {
  let result;
  updateState((state) => ({
    ...state,
    orders: state.orders.map((order) => {
      if (order.id !== orderId) return order;
      result = { ...order, ...patch, updatedAt: nowIso() };
      return result;
    })
  }));
  return result;
}

// ---------- 数据读写 ----------

async function getAppState() {
  if (mode !== 'remote') return localState();
  return { ...(await call('/api/state')), dataSource: 'postgresql' };
}

/** request 发给服务器（服务器自己算价格）；localOrder 只在本机演示模式下使用。 */
async function createOrder(request, localOrder) {
  if (mode === 'remote') return call('/api/orders', { method: 'POST', body: request });
  await wait(260);
  const order = {
    id: newId('ord'), createdAt: nowIso(), status: 'matching', driver: null, driverId: null, deviationAlert: false,
    passengerName: getState().profile.passenger.name, ...localOrder
  };
  updateState((state) => ({ ...state, orders: [order, ...state.orders] }));
  return order;
}

async function cancelOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/cancel`, { method: 'POST' });
  await wait();
  let result;
  updateState((state) => {
    const order = state.orders.find((item) => item.id === orderId);
    const feeRate = state.cancellationCount >= 3 ? 0.05 : 0;
    result = { ...order, status: 'cancelled', cancellationFee: Math.round(order.fare * feeRate * 100) / 100, updatedAt: nowIso() };
    return { ...state, cancellationCount: state.cancellationCount + 1, orders: state.orders.map((item) => (item.id === orderId ? result : item)) };
  });
  return result;
}

async function acceptOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/accept`, { method: 'POST' });
  await wait();
  const profile = getState().profile.driver;
  return patchLocalOrder(orderId, {
    status: 'accepted', driverId: LOCAL_DRIVER_ID,
    driver: { name: profile.name, car: profile.car || LOCAL_DRIVER_DEFAULTS.car, rating: profile.rating, phone: profile.phone || LOCAL_DRIVER_DEFAULTS.phone }
  });
}

async function declineOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/decline`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'matching', driverRejected: true, assignmentNote: '当前司机拒绝，系统重新分配中' });
}

/** 仅本机演示：司机拒单后，模拟另一位司机接单。 */
async function simulateLocalReassign(orderId) {
  if (mode === 'remote') return undefined;
  const order = getState().orders.find((item) => item.id === orderId);
  if (order?.status !== 'matching') return order;
  return patchLocalOrder(orderId, { status: 'accepted', driverId: LOCAL_REASSIGNED_DRIVER.id, driver: LOCAL_REASSIGNED_DRIVER });
}

async function startTrip(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/start`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'in_progress', startedAt: nowIso() });
}

async function completeTrip(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/complete`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'completed', completedAt: nowIso() });
}

/** kind: 'safe'（我安全）或 'emergency'（通知紧急联系人）。 */
async function setSafety(orderId, kind) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/safety`, { method: 'POST', body: { kind } });
  await wait();
  return patchLocalOrder(orderId, kind === 'safe'
    ? { deviationAlert: false, passengerConfirmedSafeAt: nowIso() }
    : { deviationAlert: true, emergencyNotifiedAt: nowIso() });
}

async function submitRating(payload) {
  if (mode === 'remote') return call('/api/ratings', { method: 'POST', body: payload });
  await wait();
  const rating = { id: newId('rating'), createdAt: nowIso(), ...payload };
  updateState((state) => ({ ...state, ratings: [rating, ...state.ratings] }));
  return rating;
}

async function createComplaint(payload) {
  if (mode === 'remote') return call('/api/complaints', { method: 'POST', body: payload });
  await wait();
  const complaint = { id: newId('complaint'), createdAt: nowIso(), status: 'received', ...payload };
  updateState((state) => ({ ...state, complaints: [complaint, ...state.complaints] }));
  return complaint;
}

async function createLostItem(payload) {
  if (mode === 'remote') return call('/api/lost-items', { method: 'POST', body: payload });
  return { id: newId('lost'), createdAt: nowIso(), status: 'open', ...payload };
}

/** 远程模式下资料属于当前登录的账号，role 参数只用于本机演示模式。 */
async function updateProfile(role, patch) {
  if (mode === 'remote') return call('/api/profile', { method: 'PATCH', body: patch });
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

// 上车点默认是“当前位置”（地图跟随定位、输入框显示坐标），目的地为示例地址。
// 两者都淡色显示：点击输入框自动清空，留空失焦后恢复。
const DEFAULT_ORIGIN = '当前位置';
const DEFAULT_DESTINATION = 'Via Padova, 1, Milano';

let data;
let ui = {
  role: APP_ROLE,
  screen: APP_ROLE === 'driver' ? 'driver-home' : 'home',
  bookingType: 'now',
  charterKind: 'mxp',
  pickup: DEFAULT_ORIGIN,
  destination: DEFAULT_DESTINATION,
  currentLocation: null,
  currentAddress: '',
  calculating: false,
  locating: false,
  locationUnavailable: false,
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

// ── Waze 集成 ──────────────────────────────────────────────
// 官方能力：Live Map 嵌入 iframe（展示地图与实时路况）+ Deep Link（https://waze.com/ul 打开 Waze 导航）。
// Waze 不提供公开的路线/距离/ETA 计算 API，真实路线距离仍需另接路线计算服务（见 README）。
const MILAN_CENTER = { lat: 45.4642, lon: 9.19 };

function wazeEmbedUrl(lat = MILAN_CENTER.lat, lon = MILAN_CENTER.lon, zoom = 12, pin = 1) {
  return `https://embed.waze.com/it/iframe?zoom=${zoom}&lat=${lat}&lon=${lon}&pin=${pin}`;
}

function wazeNavUrl(address) {
  const q = encodeURIComponent(String(address || '').trim());
  return `https://waze.com/ul?q=${q}&navigate=yes&vehicle_type=taxi&utm_source=milan-ride-demo`;
}

function wazeLink(label, address, dataLink, className = '') {
  return `<a href="${escapeHTML(wazeNavUrl(address))}" target="_blank" rel="noopener"${dataLink ? ` data-link="${dataLink}"` : ''}${className ? ` class="${className}"` : ''}>${label}</a>`;
}

// “当前位置”显示文案：定位并反查地址后显示“当前位置 · 街道地址”（不再显示坐标）；地址未知时只显示文字。
function defaultPickupLabel() {
  if (!ui.currentLocation) return DEFAULT_ORIGIN;
  return ui.currentAddress ? `${DEFAULT_ORIGIN} · ${ui.currentAddress}` : DEFAULT_ORIGIN;
}

function defaultLabel(field) {
  return field === 'pickup' ? defaultPickupLabel() : DEFAULT_DESTINATION;
}

// 上车点仍是默认“当前位置”时，地图跟随定位并放大显示；输入过地址则回到米兰市中心。
function currentMapCenter() {
  if (ui.pickup === defaultPickupLabel() && ui.currentLocation) {
    return { lat: ui.currentLocation.lat, lon: ui.currentLocation.lon, zoom: 15 };
  }
  return { ...MILAN_CENTER, zoom: 12 };
}

// 地图上的定位状态标签：定位中 / 已定位 / 定位不可用 / 常规米兰视图。
function mapPillText() {
  if (ui.locationUnavailable) return '⌖ 未获取到定位 · 米兰概览';
  if (ui.locating) return '⌖ 定位中…';
  if (ui.currentLocation && ui.pickup === defaultPickupLabel()) return '⌖ 当前位置 · Waze 实时路况';
  return '⌖ Milano · Waze 实时路况';
}

// ── 地理编码与真实路线距离 ──────────────────────────────────
// 反向地理编码（坐标→米兰地址）与正向地理编码（地址→坐标）用 OpenStreetMap Nominatim，失败时用 Photon 兜底；
// 驾车距离用 OSRM 公共路由服务。全部免费、无需密钥；任何一步失败都会自动降级，不影响演示。
async function fetchJson(url, timeoutMs = 7000) {
  if (typeof fetch !== 'function') return null;
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetch(url, controller ? { signal: controller.signal } : undefined);
    if (!response.ok) return null;
    return await response.json();
  } catch {
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// 地址 → 坐标（正向地理编码）。
async function geocodeAddress(address) {
  const query = String(address || '').trim();
  if (!query) return null;
  const main = await fetchJson(`https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(query)}&limit=1&accept-language=it`);
  if (main?.length && Number(main[0].lat)) return { lat: Number(main[0].lat), lon: Number(main[0].lon) };
  const backup = await fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(query)}&limit=1`);
  const coords = backup?.features?.[0]?.geometry?.coordinates;
  if (coords?.length >= 2) return { lat: coords[1], lon: coords[0] };
  return null;
}

// 坐标 → 简短街道地址（反向地理编码）。
async function reverseGeocode(lat, lon) {
  const main = await fetchJson(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lon}&zoom=18&accept-language=it`);
  if (main?.address) {
    const a = main.address;
    const street = a.road || a.pedestrian || a.footway || a.living_street || a.square || '';
    const city = a.city || a.town || a.village || a.municipality || a.suburb || '';
    const streetPart = [street, a.house_number].filter(Boolean).join(' ');
    if (streetPart) return city ? `${streetPart}, ${city}` : streetPart;
  }
  const backup = await fetchJson(`https://photon.komoot.io/reverse?lon=${lon}&lat=${lat}`);
  const props = backup?.features?.[0]?.properties;
  if (props) {
    const street = props.street || props.name || '';
    const city = props.city || props.county || props.state || '';
    const streetPart = [street, props.housenumber].filter(Boolean).join(' ');
    if (streetPart) return city ? `${streetPart}, ${city}` : streetPart;
  }
  return null;
}

// 两点间的直线距离（公里，Haversine）——驾车距离获取失败时的兜底。
function haversineKm(a, b) {
  const rad = (deg) => (deg * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(h));
}

// 真实驾车距离（公里）：OSRM 公共路由服务，失败返回 null。
async function drivingKm(origin, destination) {
  const url = `https://router.project-osrm.org/route/v1/driving/${origin.lon},${origin.lat};${destination.lon},${destination.lat}?overview=false`;
  const data = await fetchJson(url);
  const meters = data?.routes?.[0]?.distance;
  return typeof meters === 'number' && meters > 0 ? meters / 1000 : null;
}

function debounce(fn, ms) {
  let timer;
  return (...args) => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => fn(...args), ms);
  };
}

// 路线实时计算的序号：只采纳最后一次输入的结果，防止旧请求覆盖新输入。
let routeCalcSeq = 0;

// 把当前“从/到”解析成坐标（“当前位置”用定位坐标，其余地址做正向地理编码）。
async function resolveRouteInputs() {
  const pickup = String(ui.pickup || '').trim();
  const destination = String(ui.destination || '').trim();
  if (!pickup || !destination || destination === DEFAULT_DESTINATION) return null;
  let origin = ui.pickup === defaultPickupLabel() ? ui.currentLocation : await geocodeAddress(pickup);
  const destPoint = await geocodeAddress(destination);
  if (!origin) origin = { ...MILAN_CENTER }; // 兜底：起点未知时按米兰市中心估算
  if (!origin || !destPoint) return null;
  return { origin, destination: destPoint };
}

// 按真实距离重算三条路线（防抖调用）。测试环境没有 navigator，直接跳过网络计算。
async function recalculateRoutes() {
  if (typeof navigator === 'undefined') {
    ui.calculating = false;
    syncRouteSection();
    return;
  }
  const seq = ++routeCalcSeq;
  const inputs = await resolveRouteInputs();
  if (seq !== routeCalcSeq) return; // 输入已变化，丢弃过期结果
  if (!inputs) {
    ui.calculating = false;
    syncRouteSection();
    return;
  }
  let km = await drivingKm(inputs.origin, inputs.destination);
  if (km == null) km = haversineKm(inputs.origin, inputs.destination);
  if (seq !== routeCalcSeq) return;
  ui.distanceKm = Math.max(0.5, Math.round(km * 10) / 10);
  ui.calculating = false;
  syncRouteSection();
}

const scheduleRouteCalc = debounce(() => { recalculateRoutes(); }, 800);

// 获取浏览器定位并校准：优先高精度（GPS/Wi-Fi）且不使用缓存，失败或超时后降级重试一次普通精度。
// 注意：定位 API 只在 localhost / HTTPS 下可用；file:// 双击打开时 Chrome 会禁用定位，此时明确提示而不是静默降级。
function requestCurrentLocation() {
  if (typeof navigator === 'undefined' || !navigator.geolocation) {
    ui.locationUnavailable = true;
    render();
    return;
  }
  ui.locating = true;
  render();
  const apply = (position) => {
    ui.locating = false;
    ui.locationUnavailable = false;
    ui.currentLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
    if (ui.pickup === DEFAULT_ORIGIN) ui.pickup = defaultPickupLabel();
    render();
    // 坐标 → 地址：成功后输入框显示“当前位置 · 街道地址”，不再显示坐标。
    reverseGeocode(ui.currentLocation.lat, ui.currentLocation.lon).then((address) => {
      ui.currentAddress = address || '';
      if (ui.pickup === defaultPickupLabel() || ui.pickup === DEFAULT_ORIGIN) ui.pickup = defaultPickupLabel();
      render();
      if (isPlacesReady()) scheduleRouteCalc();
    });
  };
  const giveUp = () => {
    ui.locating = false;
    ui.locationUnavailable = true;
    render();
  };
  const tryCoarse = () => {
    navigator.geolocation.getCurrentPosition(apply, giveUp, { enableHighAccuracy: false, timeout: 8000, maximumAge: 0 });
  };
  navigator.geolocation.getCurrentPosition(apply, (error) => {
    if (error && error.code === error.PERMISSION_DENIED) { giveUp(); return; }
    tryCoarse();
  }, { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 });
}

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
  const center = currentMapCenter();
  return `
    <section class="hero-map">
      <iframe class="waze-frame" src="${wazeEmbedUrl(center.lat, center.lon, center.zoom)}" title="Waze 实时地图 · 米兰" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
      <div class="location-pill">${mapPillText()}</div>
      <button class="locate-btn" data-action="recalibrate" ${ui.locating ? 'disabled' : ''} aria-label="重新定位当前位置">⌖</button>
      ${ui.locationUnavailable ? '<p class="loc-hint">未获取到实时位置：请允许浏览器定位，并通过 localhost/HTTPS 打开本页</p>' : ''}
      <div class="safety-mini">🛡️ 行程全程守护</div>
    </section>
    ${activePassengerOrder() ? renderActiveOrder(activePassengerOrder()) : ''}
    <section class="booking-card">
      <div class="segmented">
        ${[['now', '即时'], ['charter', '包车']].map(([type, label]) => `
          <button data-action="booking-type" data-type="${type}" class="${ui.bookingType === type ? 'selected' : ''}">${label}</button>`).join('')}
      </div>
      ${ui.bookingType === 'charter' ? renderCharterForm() : renderRideForm()}
    </section>
    <section class="notice-card"><span>🛡️</span><p>上车后会展示司机与乘客的真实姓名及安全注意事项。建议优先坐后排，避免坐副驾驶。</p></section>`;
}

// “到”填好真实地址即视为路线就绪：上车点默认是“当前位置”（用户无需再输入），因此不再排除默认起点。
function isPlacesReady() {
  const pickup = String(ui.pickup || '').trim();
  const destination = String(ui.destination || '').trim();
  return Boolean(pickup) && Boolean(destination) && destination !== DEFAULT_DESTINATION;
}

function routeSectionHtml() {
  const routes = getRoutes();
  const route = selectedRoute();
  return `<div class="section-label"><span>推荐路线</span><small>每条路线报价不同</small></div>
    <div class="route-list">${routes.map((item) => `
      <button class="route-option ${item.id === route.id ? 'selected' : ''}" data-action="select-route" data-route="${item.id}">
        <span class="route-radio"></span><span class="route-name"><b>${item.label}</b><small>${item.note} · ${item.distanceKm} km · 约 ${item.minutes} 分钟</small></span><strong>${formatEuro(item.fare)}</strong>
      </button>`).join('')}</div>`;
}

function routeCalculatingHtml() {
  return '<div class="route-calculating">正在按真实距离计算路线与报价…</div>';
}

// 地址输入变化时，只局部更新路线区域和按钮价格，避免整页重绘导致输入框失焦。
function syncRouteSection() {
  if (typeof app.querySelector !== 'function') return;
  const section = app.querySelector('.route-section');
  if (!section) return;
  const ready = isPlacesReady();
  const html = !ready ? '' : ui.calculating ? routeCalculatingHtml() : routeSectionHtml();
  if (section.innerHTML !== html) section.innerHTML = html;
  const price = app.querySelector('[data-action="book-ride"] span');
  if (price) price.textContent = !ready ? '待估价' : ui.calculating ? '计算中…' : formatEuro(selectedRoute().fare);
}

// 上车点在“当前位置”和真实地址之间切换时，局部更新地图中心与标签（不整页重绘）。
function syncMap() {
  if (typeof app.querySelector !== 'function') return;
  const frame = app.querySelector('.waze-frame');
  if (!frame) return;
  const center = currentMapCenter();
  const src = wazeEmbedUrl(center.lat, center.lon, center.zoom);
  if (frame.src !== src) frame.src = src;
  const pill = app.querySelector('.location-pill');
  if (pill) {
    const text = mapPillText();
    if (pill.textContent !== text) pill.textContent = text;
  }
}

function renderRideForm() {
  const route = selectedRoute();
  const placesReady = isPlacesReady();
  return `
    <div class="place-inputs">
      <label><span class="place-mark origin">从</span><input data-field="pickup" class="${ui.pickup === defaultPickupLabel() ? 'place-hint' : ''}" value="${escapeHTML(ui.pickup)}" aria-label="上车点" /></label>
      <i></i>
      <label><span class="place-mark destination">到</span><input data-field="destination" class="${ui.destination === DEFAULT_DESTINATION ? 'place-hint' : ''}" value="${escapeHTML(ui.destination)}" aria-label="目的地" /></label>
    </div>
    <div class="route-section">${!placesReady ? '' : ui.calculating ? routeCalculatingHtml() : routeSectionHtml()}</div>
    <button class="primary-button" data-action="book-ride">呼叫附近司机 <span>${!placesReady ? '待估价' : ui.calculating ? '计算中…' : formatEuro(route.fare)}</span></button>
    <p class="hint">10 km 内 €3.5/km；20 / 30 / 40 / 50 km 阶梯计价。路线按真实驾车距离实时计算（OSRM 路由服务；离线时按直线距离估算）。</p>`;
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
    <div class="driver-map">
      <iframe class="waze-frame" src="${wazeEmbedUrl(MILAN_CENTER.lat, MILAN_CENTER.lon, 13, 0)}" title="Waze 实时地图 · 行程" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe>
      <div class="location-pill">⌖ 行程地图 · Waze 实时路况</div>
      <a class="map-open-link" href="${escapeHTML(wazeNavUrl(order.destination))}" target="_blank" rel="noopener">在 Waze 中打开地图 ›</a>
    </div>
    <div class="waze-links driver">
      ${wazeLink('⌖ 用 Waze 导航到上车点', order.pickup)}
      ${wazeLink('🚩 用 Waze 导航到目的地', order.destination)}
    </div>
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
    ${wazeLink('在 Waze 中查看路线 ›', order.destination, '', 'waze-modal-link')}
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
  if (action === 'recalibrate') { requestCurrentLocation(); return; }
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
  if (field === 'pickup' || field === 'destination') {
    ui[field] = event.target.value;
    if (event.target.classList) event.target.classList.toggle('place-hint', event.target.value === defaultLabel(field));
    if (isPlacesReady()) ui.calculating = true;
    syncRouteSection();
    syncMap();
    scheduleRouteCalc();
    return;
  }
  if (field === 'scheduledAt') ui[field] = event.target.value;
});

// 示例地址淡色提示：点击输入框自动清空；留空失焦后恢复示例地址。
app.addEventListener('focusin', (event) => {
  const field = event.target.dataset?.field;
  if (field !== 'pickup' && field !== 'destination') return;
  if (ui[field] === defaultLabel(field)) {
    event.target.value = '';
    ui[field] = '';
    if (event.target.classList) event.target.classList.remove('place-hint');
    if (isPlacesReady()) ui.calculating = true;
    syncRouteSection();
    syncMap();
    scheduleRouteCalc();
  }
});

app.addEventListener('focusout', (event) => {
  const field = event.target.dataset?.field;
  if (field !== 'pickup' && field !== 'destination') return;
  const value = String(event.target.value || '').trim();
  if (!value) {
    event.target.value = defaultLabel(field);
    ui[field] = defaultLabel(field);
    if (event.target.classList) event.target.classList.add('place-hint');
    if (isPlacesReady()) ui.calculating = true;
    syncRouteSection();
    syncMap();
    scheduleRouteCalc();
  }
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
if (ui.screen !== 'auth') requestCurrentLocation();
if (!data && ui.screen !== 'auth') {
  app.innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>暂时无法连接服务器</h1><p>请确认已运行 npm.cmd run dev，然后刷新页面。</p></main>';
}

})().catch((error) => {
  console.error(error);
  document.querySelector('#app').innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>页面没有启动</h1><p>请刷新后重试。错误信息已输出到浏览器开发者工具。</p></main>';
});
