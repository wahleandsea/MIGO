/* 自动生成：运行 npm.cmd run build 可重新生成。 */
window.MILANO_RIDE_APP_ROLE = 'passenger';
window.MILANO_RIDE_BUILD = '2026/10/20 16:15:22';
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
      id: 'economy',
      label: '经济路线',
      note: '距离最短 · 价格最省',
      distanceKm: roundMoney(base * 0.92),
      minutes: Math.round(base * 2.7 + 3),
      multiplier: 0.91
    },
    {
      id: 'balanced',
      label: '推荐路线',
      note: '时间与价格均衡 · 路况稳定',
      distanceKm: roundMoney(base),
      minutes: Math.round(base * 3.2 + 4),
      multiplier: 1
    },
    {
      id: 'fast',
      label: '畅行路线',
      note: '路程较长 · 道路更畅通',
      distanceKm: roundMoney(base * 1.08),
      minutes: Math.round(base * 3.8 + 5),
      multiplier: 1.08
    }
  ].map((route) => ({ ...route, fare: estimateFare(route.distanceKm, route.multiplier) }));
}

// 每条路线的价格系数（与 makeRouteOptions 一致）。真实路线按各自距离计价时用。
const ROUTE_MULTIPLIERS = { balanced: 1, fast: 1.08, economy: 0.91 };

function routeFare(routeId, distanceKm) {
  return estimateFare(distanceKm, ROUTE_MULTIPLIERS[routeId] ?? 1);
}

function cancellationFee(cancelledCount) {
  // 每月前三次免费，从第四次开始收订单金额的 5%。
  return cancelledCount >= 3 ? 0.05 : 0;
}

// 平台抽成比例：乘客支付的车费中，平台抽 20%，其余归司机。
const PLATFORM_FEE_RATE = 0.2;

// 把乘客支付的车费拆成“平台抽成”和“司机实际所得”。
function splitFare(fare) {
  const total = Number(fare) || 0;
  const platformFee = roundMoney(total * PLATFORM_FEE_RATE);
  return { platformFee, driverEarnings: roundMoney(total - platformFee) };
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
      accountStatus: 'active', // active 正常 / suspended 暂停使用 / closed 强制关闭（不符合平台规定）
      italianLicenseVerified: false,
      chinaIdVerified: false,
      online: false,
      // 司机认证资料与审核流转（与服务器 docs 同构）：none → pending → approved / rejected
      docs: {
        status: 'none', submittedAt: null, reviewedAt: null, rejectReason: '',
        italianLicense: null, chinaId: null
      }
    }
  },
  orders: [],
  ratings: [],
  complaints: [],
  cancellationCount: 0,
  lastResetAt: new Date().toISOString(),
  // 按微信 openid 隔离的司机资料：不同微信登录 = 不同司机账号（本地演示模拟真实微信 OAuth）。
  // profile.driver 始终是“当前登录微信身份”的司机资料快照，driverProfiles[openid] 保存每个微信身份的独立档案。
  driverProfiles: {},
  currentOpenid: ''
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function getState() {
  try {
    const saved = window.localStorage.getItem(KEY);
    const state = { ...clone(defaultState), ...(saved ? JSON.parse(saved) : {}) };
    state.driverProfiles = state.driverProfiles || {};
    state.currentOpenid = state.currentOpenid || '';
    // 迁移旧版本数据：老结构只有 profile.driver，把已提交认证的司机存进 __legacy__ 槽位，后台列表不丢。
    if (Object.keys(state.driverProfiles).length === 0
      && state.profile?.driver?.docs?.status
      && state.profile.driver.docs.status !== 'none') {
      state.driverProfiles.__legacy__ = state.profile.driver;
    }
    return state;
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
  // 当前微信身份的资料变更自动写回它自己的档案，保证换微信登录时互不干扰。
  if (next.currentOpenid && next.profile?.driver) {
    next.driverProfiles = { ...(next.driverProfiles || {}), [next.currentOpenid]: next.profile.driver };
  }
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

/** 无论本机演示还是远程模式，都必须先微信授权登录才能使用服务。 */
function hasSession() {
  return Boolean(getToken());
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

// 微信一键登录：远程模式发给服务器换取会话；本机演示模式直接进入演示账号。
// 同一浏览器记住同一个微信身份（openid），刷新/换端登录不会变成“新用户”，贴近真实微信 OAuth。
// 退出登录会清除微信身份：重新登录就是“另一个微信”，本地演示下会得到不同的司机账号。
async function wechatLogin(role = 'passenger') {
  const WECHAT_KEY = 'milano-ride-wechat-openid';
  let code = null;
  try { code = window.localStorage.getItem(WECHAT_KEY); } catch { /* 存储不可用则每次都是新身份 */ }
  if (!code) {
    code = `mock_${Date.now()}_${Math.random().toString(16).slice(2, 10)}`;
    try { window.localStorage.setItem(WECHAT_KEY, code); } catch { /* 忽略 */ }
  }
  if (mode === 'remote') {
    const result = await call('/api/auth/wechat', { method: 'POST', body: { code, role }, auth: false });
    setToken(result.token);
    return result.user;
  }
  // 本地模式：按 openid 取该微信身份的司机档案；没有则创建全新司机（未认证）。
  const state = getState();
  let driver = (state.driverProfiles || {})[code];
  if (!driver) {
    driver = {
      name: `微信司机·${String(code).slice(-4).toUpperCase()}`,
      car: 'Mercedes Vito · IT 786 MR',
      phone: '',
      rating: 5,
      creditScore: 100,
      accountStatus: 'active',
      italianLicenseVerified: false,
      chinaIdVerified: false,
      online: false,
      docs: { status: 'none', submittedAt: null, reviewedAt: null, rejectReason: '', italianLicense: null, chinaId: null }
    };
  }
  updateState((next) => ({ ...next, currentOpenid: code, profile: { ...next.profile, driver } }));
  // 本地模式：记录登录态（演示用令牌），让“未登录必须先进微信授权页”的规则在本机演示下同样成立。
  setToken('local-wechat');
  const docsStatus = driver.docs?.status || (driver.italianLicenseVerified ? 'approved' : 'none');
  return role === 'driver'
    ? { id: 'local-driver', role: 'driver', name: driver.name, approved: docsStatus === 'approved', docs: driver.docs || {} }
    : { id: 'local-wechat', role: 'passenger', name: '微信好友', wechat: true };
}

/** 司机提交认证资料（意大利驾照 + 中国身份证），提交后进入后台待审核。 */
async function submitDriverApplication(fields) {
  if (mode === 'remote') return call('/api/driver/application', { method: 'POST', body: fields });
  await wait();
  const now = new Date().toISOString();
  updateState((state) => ({
    ...state,
    profile: {
      ...state.profile,
      driver: {
        ...state.profile.driver,
        name: (fields.name || '').trim() || state.profile.driver.name,
        phone: fields.phone, car: fields.car,
        italianLicenseVerified: false, chinaIdVerified: false,
        docs: {
          status: 'pending', submittedAt: now, reviewedAt: null, rejectReason: '',
          italianLicense: { number: fields.italianLicense.number, expiry: fields.italianLicense.expiry, photo: fields.italianLicense.photo },
          chinaId: { number: fields.chinaId.number, photo: fields.chinaId.photo }
        }
      }
    }
  }));
  const driver = getState().profile.driver;
  return { id: 'local-driver', role: 'driver', name: driver.name, approved: false, docs: driver.docs };
}

async function registerAccount(fields) {
  const result = await call('/api/auth/register', { method: 'POST', body: { ...fields, role: ROLE }, auth: false });
  setToken(result.token);
  return result.user;
}

async function logoutAccount() {
  // 清除微信身份：退出后重新登录将被当作“另一个微信”（不同 openid → 不同账号）。
  try { window.localStorage.removeItem('milano-ride-wechat-openid'); } catch { /* 忽略 */ }
  updateState((state) => ({ ...state, currentOpenid: '' }));
  if (mode !== 'remote') { setToken(null); return; } // 本机演示模式没有服务器会话，直接清掉本地登录态
  try { await call('/api/auth/logout', { method: 'POST' }); } catch { /* 即使服务器没回应，也要清掉本机的登录状态 */ }
  setToken(null);
}

// ---------- 本机演示模式的辅助函数 ----------

function localState() {
  const state = getState();
  const profile = state.profile[ROLE];
  const driverDocs = state.profile.driver.docs?.status || (state.profile.driver.italianLicenseVerified ? 'approved' : 'none');
  // 本机演示：乘客也有自己的邀请码与余额（演示值），页面展示与远程模式一致。
  const inviteCode = ROLE === 'passenger'
    ? (state.profile.passenger?.inviteCode || 'DEMO' + String(Date.now()).slice(-5).toUpperCase())
    : '';
  return {
    ...state,
    dataSource: 'local',
    me: {
      id: ROLE === 'driver' ? LOCAL_DRIVER_ID : 'local-passenger',
      role: ROLE,
      name: profile.name,
      email: profile.email || '',
      approved: ROLE === 'driver' ? driverDocs === 'approved' : true,
      inviteCode,
      invitedBy: state.profile.passenger?.invitedBy || '',
      balanceCents: Number(state.profile.passenger?.balanceCents) || 0,
      ...(ROLE === 'driver' ? { docs: state.profile.driver.docs || {} } : {})
    }
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
  return { ...(await call('/api/state')), dataSource: 'database' };
}

/** request 发给服务器（服务器自己算价格）；localOrder 只在本机演示模式下使用。 */
async function createOrder(request, localOrder) {
  if (mode === 'remote') return call('/api/orders', { method: 'POST', body: request });
  await wait(260);
  const fee = splitFare(Number(localOrder?.fare) || 0);
  const order = {
    id: newId('ord'), createdAt: nowIso(), status: 'matching', driver: null, driverId: null, deviationAlert: false,
    passengerName: getState().profile.passenger.name,
    platformFee: fee.platformFee, driverEarnings: fee.driverEarnings,
    ...localOrder
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

async function acceptOrder(orderId, etaMinutes) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/accept`, { method: 'POST', body: { etaMinutes } });
  await wait();
  const profile = getState().profile.driver;
  return patchLocalOrder(orderId, {
    status: 'accepted', driverId: LOCAL_DRIVER_ID,
    ...(Number.isInteger(etaMinutes) ? { etaMinutes } : {}),
    driver: { name: profile.name, car: profile.car || LOCAL_DRIVER_DEFAULTS.car, rating: profile.rating, phone: profile.phone || LOCAL_DRIVER_DEFAULTS.phone }
  });
}

/** 司机到达上车点。 */
async function arriveOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/arrive`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'arrived', arrivedAt: nowIso() });
}

/** 客人已上车。 */
async function boardOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/board`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'onboard', boardedAt: nowIso() });
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

/** 输入邀请码：绑定推荐关系 + 被邀请人得 5 欧返现（余额，可抵扣车费）。仅乘客端使用。 */
async function applyInvite(code) {
  if (mode === 'remote') return call('/api/invite/apply', { method: 'POST', body: { code } });
  // 本机演示：模拟绑定（演示任意 8 位邀请码都可用），返现 5 欧余额。
  await wait();
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(normalized)) throw new ApiError('邀请码需要是 8 位字母或数字', 400, 'INVITE_CODE_INVALID');
  const passenger = getState().profile.passenger || {};
  if (passenger.invitedBy) throw new ApiError('你已经绑定过邀请码，不能重复使用', 409, 'ALREADY_INVITED');
  if (passenger.inviteCode === normalized) throw new ApiError('不能使用自己的邀请码', 400, 'SELF_INVITE');
  updateState((state) => ({
    ...state,
    profile: {
      ...state.profile,
      passenger: { ...state.profile.passenger, invitedBy: 'demo-inviter', balanceCents: (Number(state.profile.passenger?.balanceCents) || 0) + 500 }
    }
  }));
  return { ok: true, balanceCents: Number(getState().profile.passenger?.balanceCents) || 0 };
}

/** 远程模式下资料属于当前登录的账号，role 参数只用于本机演示模式。 */
async function updateProfile(role, patch) {
  if (mode === 'remote') return call('/api/profile', { method: 'PATCH', body: patch });
  // 本机演示：与服务器规则保持一致——上线接单要求审核通过，且账号未被暂停/强制关闭。
  if (role === 'driver' && patch.online === true) {
    const driver = getState().profile.driver || {};
    const docsStatus = driver.docs?.status || (driver.italianLicenseVerified ? 'approved' : 'none');
    if (docsStatus !== 'approved') throw new ApiError('账号还没有通过审核，暂时不能上线接单', 403, 'NOT_APPROVED');
    if (driver.accountStatus === 'closed') throw new ApiError('账号已被关闭：不符合平台规定', 403, 'ACCOUNT_CLOSED');
    if (driver.accountStatus === 'suspended') throw new ApiError('使用权限已暂停，请联系平台', 403, 'ACCOUNT_SUSPENDED');
  }
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
  pickupPoint: null, // 上车点已解析坐标：地址建议点选时直接保存，避免把带分隔符的显示文本二次解析失败
  destinationPoint: null, // 目的地已解析坐标（同上）
  currentLocation: null,
  currentAddress: '',
  pickupDistanceKm: null, // 司机位置 → 上车点的实际驾车距离（公里）
  calculating: false,
  locating: false,
  locationUnavailable: false,
  distanceKm: 12.4,
  routes: null, // 三条真实路线（OSRM）：[{ id, label, note, distanceKm, minutes, fare, polyline }]
  wazeHint: null, // 已把导航交给 Waze 时的页面提示：{ to, minutes }
  selectedRoute: 'balanced',
  paymentMethod: 'alipay',
  scheduledAt: '',
  modal: null,
  toast: '',
  authMode: 'login',
  authError: '',
  authForm: {},
  wechatAuth: false,        // 正在显示微信模拟授权卡片
  driverPhotos: {},          // 司机认证照片（已读成 data URL 的驾照/身份证照片）：{ licensePhoto, chinaIdPhoto }
  suggest: { pickup: [], destination: [] }, // 地址自动补全建议
  suggestSeq: 0
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
  arrived: ['司机已到达', 'blue'],
  onboard: ['已上车，准备出发', 'blue'],
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

// ── 地图（Leaflet + OpenStreetMap）────────────────────────────
// 基础地图用 OSM 标准瓦片：无第三方 cookie 弹窗（Waze iframe 在欧盟会一直弹同意框），
// 并且可以在上面精确画出 OSRM 返回的真实路线。Waze 仍保留为“一键开始导航”的深链。
const MILAN_CENTER = { lat: 45.4642, lon: 9.19 };

function browserCanMap() {
  return typeof window !== 'undefined' && typeof document !== 'undefined' && typeof L !== 'undefined';
}

let liveMap = null;

function teardownLiveMap() {
  if (!liveMap) return;
  try { liveMap.map.remove(); } catch { /* 容器已随重绘销毁 */ }
  liveMap = null;
}

// polyline6 字符串 → Leaflet 需要的 [[lat, lon], ...]
function polylineLatLngs(polyline) {
  if (!polyline) return [];
  try { return decodePolyline6(polyline).map((p) => [p.lat, p.lon]); } catch { return []; }
}

function addOsmTiles(map) {
  // 用 Esri WorldStreetMap 光栅瓦片：免费、无需 API key、长期稳定。
  // 之前试过 OSM 官方瓦片（封 demo 流量 403）、CARTO（已必须 API key）、OpenFreeMap（矢量瓦片，Leaflet 不能直接用）。
  L.tileLayer('https://server.arcgisonline.com/ArcGIS/rest/services/World_Street_Map/MapServer/tile/{z}/{y}/{x}', {
    maxZoom: 19,
    attribution: 'Tiles © Esri — © OpenStreetMap contributors'
  }).addTo(map);
}

// 每次整页重绘后调用：重建地图实例，并按当前路线重画图层。
function syncLiveMap() {
  if (!browserCanMap()) return;
  const host = document.querySelector('#map-host') || document.querySelector('#driver-map-host') || document.querySelector('#driver-live-map');
  teardownLiveMap();
  if (!host) return;
  const map = L.map(host, { zoomControl: false, attributionControl: true });
  addOsmTiles(map);
  liveMap = { map };

  if (host.id === 'map-host') {
    const ready = ui.routes && ui.routes.length && !ui.calculating;
    if (ready) {
      const chosen = selectedRoute();
      const bounds = [];
      for (const route of ui.routes) {
        const pts = polylineLatLngs(route.polyline);
        if (!pts.length) continue;
        const isChosen = route.id === chosen.id;
        L.polyline(pts, { color: isChosen ? '#1b5cf3' : '#a9c1ee', weight: isChosen ? 6 : 3, opacity: isChosen ? 0.95 : 0.55 }).addTo(map);
        bounds.push(...pts);
      }
      if (bounds.length) map.fitBounds(bounds, { padding: [30, 30] });
      else { const c = currentMapCenter(); map.setView([c.lat, c.lon], c.zoom); }
    } else {
      const c = currentMapCenter();
      map.setView([c.lat, c.lon], c.zoom);
    }
    if (ui.currentLocation) {
      L.circleMarker([ui.currentLocation.lat, ui.currentLocation.lon], { radius: 7, color: '#1b5cf3', fillColor: '#1b5cf3', fillOpacity: 1 }).addTo(map);
    }
  } else if (host.id === 'driver-live-map') {
    // 司机主页：实时显示司机当前位置（蓝色标记）
    const c = ui.currentLocation || MILAN_CENTER;
    map.setView([c.lat, c.lon], ui.currentLocation ? 15 : 13);
    if (ui.currentLocation) {
      L.circleMarker([ui.currentLocation.lat, ui.currentLocation.lon], { radius: 9, color: '#1b5cf3', fillColor: '#1b5cf3', fillOpacity: 0.9 }).addTo(map);
    }
  } else {
    // 行程中：画接单路线 + 上车点（绿）终点（红）+ 司机实时位置（蓝）
    const order = data && data.orders.find((o) => mine(o) && ['accepted', 'arrived', 'onboard', 'in_progress'].includes(o.status));
    const pts = order ? polylineLatLngs(order.routePolyline) : [];
    if (pts.length) {
      L.polyline(pts, { color: '#1b5cf3', weight: 6, opacity: 0.95 }).addTo(map);
      L.circleMarker(pts[0], { radius: 7, color: '#22b573', fillColor: '#22b573', fillOpacity: 1 }).addTo(map);
      L.circleMarker(pts[pts.length - 1], { radius: 7, color: '#ff674a', fillColor: '#ff674a', fillOpacity: 1 }).addTo(map);
      map.fitBounds(pts, { padding: [26, 26] });
    } else {
      map.setView([MILAN_CENTER.lat, MILAN_CENTER.lon], 13);
    }
    if (ui.currentLocation) {
      L.circleMarker([ui.currentLocation.lat, ui.currentLocation.lon], { radius: 9, color: '#1b5cf3', fillColor: '#1b5cf3', fillOpacity: 0.9 }).addTo(map);
    }
  }
  window.setTimeout(() => { try { map.invalidateSize(); } catch { /* 已销毁 */ } }, 60);
}

// Waze 深链：有坐标时用 ll 坐标（Waze 自动反查出地址填入输入框并开始导航，网页/应用都可靠）；
// 没有坐标时退回文字地址（应用端可用）。
function wazeNavUrl(address, lat, lon) {
  const target = (lat != null && lon != null)
    ? `to=${encodeURIComponent(`ll.${lat},${lon}`)}`
    : `q=${encodeURIComponent(String(address || '').trim())}`;
  return `https://waze.com/ul?navigate=yes&vehicle_type=taxi&utm_source=milan-ride-demo&${target}`;
}

// 从→到 双地址深链：from/to 既可以是 ll.坐标，也可以是文字地址；from 为空时不传，Waze 从当前 GPS 出发。
// navigate=yes 自动开始导航。
function wazeRouteUrl(from, to) {
  const fromPart = String(from || '').trim() ? `&from=${encodeURIComponent(String(from).trim())}` : '';
  return `https://waze.com/ul?navigate=yes&vehicle_type=taxi&utm_source=milan-ride-demo&to=${encodeURIComponent(String(to || '').trim())}${fromPart}`;
}

function wazeLink(label, address, dataLink, className = '', lat, lon) {
  return `<a href="${escapeHTML(wazeNavUrl(address, lat, lon))}" target="_blank" rel="noopener"${dataLink ? ` data-link="${dataLink}"` : ''}${className ? ` class="${className}"` : ''}>${label}</a>`;
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

// 司机端行程地图：Waze 实时地图（导航提示在 Waze 应用/网页里看）。
function driverMapCenter() {
  return { ...MILAN_CENTER, zoom: 13 };
}

// 地图上的定位状态标签：定位中 / 已定位 / 定位不可用 / 常规米兰视图。
function mapPillText() {
  // 路线算好时优先显示路线信息（Waze 地图此时已按线路取景），让“提示”跟实际状态一致。
  if (ui.routes && ui.routes.length && !ui.calculating) {
    const route = selectedRoute();
    return `🚀 路线已就绪 · ${route.distanceKm} km · 约 ${route.minutes} 分钟`;
  }
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

// ── 地址自动补全（输入时给出街道 + 城市 + CAP 建议）────────────
function formatSuggestLabel(item) {
  const a = item.address || {};
  const street = [a.road || a.pedestrian || a.cycleway || a.neighbourhood || '', a.house_number || ''].filter(Boolean).join(' ');
  const city = a.city || a.town || a.village || a.municipality || a.county || '';
  const fallback = String(item.display_name || '').split(',').slice(0, 2).join(',');
  return [street || fallback, city, a.postcode].filter(Boolean).join(' · ');
}

async function suggestAddresses(field) {
  if (typeof navigator === 'undefined') return; // 测试环境跳过网络请求
  const q = String(ui[field] || '').trim();
  if (!q || q === defaultLabel(field)) { ui.suggest[field] = []; renderSuggest(field); return; }
  renderSuggestSearching(field);
  const seq = ++ui.suggestSeq;
  // 主源 Nominatim；失败时用 Photon（专为自动补全设计）兜底。
  let list = await fetchJson(
    `https://nominatim.openstreetmap.org/search?format=jsonv2&q=${encodeURIComponent(q)}&limit=5&countrycodes=it&addressdetails=1&accept-language=it`
  );
  if (seq !== ui.suggestSeq) return;
  if (!Array.isArray(list) || !list.length) {
    const photon = await fetchJson(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&limit=5`);
    if (seq !== ui.suggestSeq) return;
    list = (photon?.features || []).map((f) => {
      const p = f.properties || {};
      const ll = f.geometry?.coordinates || [];
      return {
        lat: ll[1], lon: ll[0],
        display_name: [p.street ? `${p.street} ${p.housenumber || ''}`.trim() : p.name, p.city || p.county, p.postcode].filter(Boolean).join(', '),
        address: p
      };
    });
  }
  ui.suggest[field] = Array.isArray(list)
    ? list.map((item) => ({ label: formatSuggestLabel(item), lat: Number(item.lat), lon: Number(item.lon) }))
        .filter((s) => s.label && Number.isFinite(s.lat))
    : [];
  renderSuggest(field);
}

function renderSuggestSearching(field) {
  if (typeof app.querySelector !== 'function') return;
  const box = app.querySelector(`[data-suggest-for="${field}"]`);
  if (box) box.innerHTML = '<div class="suggest-searching">正在搜索地址…</div>';
}

// 只局部更新下拉框，避免整页重绘打断输入。
function renderSuggest(field) {
  if (typeof app.querySelector !== 'function') return;
  const box = app.querySelector(`[data-suggest-for="${field}"]`);
  if (!box) return;
  const items = ui.suggest[field] || [];
  box.innerHTML = items.length
    ? `<div class="suggest-dropdown">${items.map((item, index) => `
        <button type="button" class="suggest-item" data-action="pick-suggest" data-field="${field}" data-index="${index}">${escapeHTML(item.label)}</button>`).join('')}</div>`
    : '';
}

const scheduleSuggest = debounce((field) => { suggestAddresses(field); }, 350);

// 两点间的直线距离（公里，Haversine）——驾车距离获取失败时的兜底。
function haversineKm(a, b) {  const rad = (deg) => (deg * Math.PI) / 180;
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

// 司机位置 → 上车点的实际驾车距离（实时刷新，10 秒节流避免频繁请求路由服务）。
// 司机真实定位离上车点足够远时显示真实距离；否则（同机演示、两端定位重合）用“附近司机”模拟位置，保证演示出合理的接驾距离。
let lastPickupDistCalc = 0;
async function refreshPickupDistance() {
  const order = data && data.orders.find((o) => mine(o) && ['accepted', 'arrived'].includes(o.status));
  if (!order) return;
  const dest = (Number.isFinite(order.pickupLat) && Number.isFinite(order.pickupLon))
    ? { lat: order.pickupLat, lon: order.pickupLon }
    : null;
  if (!dest) return;
  let from = ui.currentLocation;
  if (!from || haversineKm(from, dest) < 1.2) from = simulatedDriverPoint(dest, order.id || '');
  const now = Date.now();
  if (now - lastPickupDistCalc < 10000) return;
  lastPickupDistCalc = now;
  const km = await drivingKm(from, dest);
  if (Number.isFinite(km)) {
    ui.pickupDistanceKm = Math.round(km * 10) / 10;
    render();
  }
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

// 把当前“从/到”解析成坐标：地址建议点选过时直接用其坐标，否则做正向地理编码；
// “当前位置”用定位坐标；起点兜底按米兰市中心估算。
async function resolveRouteInputs() {
  const pickup = String(ui.pickup || '').trim();
  const destination = String(ui.destination || '').trim();
  if (!pickup || !destination || destination === DEFAULT_DESTINATION) return null;
  let origin = ui.pickup === defaultPickupLabel() ? ui.currentLocation : (ui.pickupPoint || await geocodeAddress(pickup));
  const destPoint = ui.destinationPoint || await geocodeAddress(destination);
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
    ui.routes = null;
    syncRouteSection();
    syncMap();
    return;
  }
  const routeSet = await fetchRouteSet(inputs.origin, inputs.destination);
  if (seq !== routeCalcSeq) return;
  if (routeSet && routeSet.length) {
    ui.routes = buildRealRoutes(routeSet);
    ui.distanceKm = ui.routes.find((r) => r.id === ui.selectedRoute)?.distanceKm ?? ui.routes[0].distanceKm;
  } else {
    // OSRM 不可用时：直线距离估算兜底，地图上不画线（无法诚实画出假路线）。
    const km = haversineKm(inputs.origin, inputs.destination);
    ui.distanceKm = Math.max(0.5, Math.round(km * 10) / 10);
    ui.routes = null;
  }
  ui.calculating = false;
  syncRouteSection();
  syncMap(); // 地图中心随路线包围盒适配，并重绘路线
}

const scheduleRouteCalc = debounce(() => { recalculateRoutes(); }, 800);

// ── 司机到达时间（ETA）──────────────────────────────────────
// 接单后按“司机位置 → 上车点”的真实驾车时间估算到达分钟数：
// - 司机端有真实定位且距离上车点足够远时，用真实位置；
// - 否则（两端常在同一台电脑、定位重合），用距上车点 2.5–4.5 km 的“附近司机”模拟位置，保证演示出合理的到达时间；
// - 测试环境（无 navigator）不发任何网络请求，直接返回 null。
function simulatedDriverPoint(pickupPoint, seed) {
  let hash = 0;
  for (const ch of String(seed || '')) hash = (hash * 31 + ch.charCodeAt(0)) >>> 0;
  const bearing = ((hash % 360) * Math.PI) / 180;
  const distanceKm = 2.5 + (hash % 21) / 10; // 2.5–4.5 km
  const dLat = (distanceKm / 111.32) * Math.cos(bearing);
  const dLon = (distanceKm / (111.32 * Math.cos((pickupPoint.lat * Math.PI) / 180))) * Math.sin(bearing);
  return { lat: pickupPoint.lat + dLat, lon: pickupPoint.lon + dLon };
}

async function estimateEtaMinutes(order) {
  if (typeof navigator === 'undefined') return null; // 测试环境跳过
  let pickupPoint = order?.pickupLat && order?.pickupLon
    ? { lat: Number(order.pickupLat), lon: Number(order.pickupLon) }
    : await geocodeAddress(String(order?.pickup || '').replace(/^当前位置\s*·?\s*/, ''));
  if (!pickupPoint) return null;
  let driverPoint = ui.currentLocation;
  if (!driverPoint || haversineKm(driverPoint, pickupPoint) < 1.2) {
    driverPoint = simulatedDriverPoint(pickupPoint, order?.id || '');
  }
  const km = await drivingKm(driverPoint, pickupPoint);
  const minutes = km != null
    ? Math.max(1, Math.round((km / 32) * 60))                                  // 城市道路按 ~32 km/h 折算
    : Math.max(2, Math.round((haversineKm(driverPoint, pickupPoint) / 24) * 60));
  // 服务器只接受 1–120 分钟：异常坐标（如模拟定位异常）算出的超长 ETA 钳制到 120，非法值返回 null 让服务器缺省。
  return Number.isFinite(minutes) && minutes >= 1 ? Math.min(120, Math.round(minutes)) : null;
}

// 下单时带上车点坐标（供司机端计算到达时间）；测试环境或地理编码失败时为 null。
async function pickupPointForBooking() {
  if (typeof navigator === 'undefined') return null;
  if (ui.pickup === defaultPickupLabel() && ui.currentLocation) return ui.currentLocation;
  return ui.pickupPoint || await geocodeAddress(ui.pickup);
}

// ── 地图路线图层（在 Waze 地图上叠加真实路线）────────────────
// Waze Live Map 与标准 Web Mercator 瓦片一致：给定 iframe 中心 (lat,lon) 与 zoom，
// 即可把任意坐标投影到容器像素，在 Waze 地图上画出 OSRM 返回的真实路线。

// polyline6 编码/解码（精度 1e-6，OSRM geometries=polyline6 用的就是它）。
function decodePolyline6(str) {
  const points = [];
  let index = 0, lat = 0, lon = 0;
  while (index < str.length) {
    let result = 1, shift = 0, b;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lat += (result & 1) ? ~(result >> 1) : (result >> 1);
    result = 1; shift = 0;
    do { b = str.charCodeAt(index++) - 63 - 1; result += b << shift; shift += 5; } while (b >= 0x1f);
    lon += (result & 1) ? ~(result >> 1) : (result >> 1);
    points.push({ lat: lat / 1e6, lon: lon / 1e6 });
  }
  return points;
}

function encodePolyline6(points) {
  const enc = (value) => {
    let v = value < 0 ? ~(value << 1) : (value << 1);
    let out = '';
    while (v >= 0x20) { out += String.fromCharCode((0x20 | (v & 0x1f)) + 63); v >>= 5; }
    return out + String.fromCharCode(v + 63);
  };
  let str = '', pLat = 0, pLon = 0;
  for (const p of points) {
    const lat = Math.round(p.lat * 1e6), lon = Math.round(p.lon * 1e6);
    str += enc(lat - pLat) + enc(lon - pLon);
    pLat = lat; pLon = lon;
  }
  return str;
}

// 抽稀：路线点太多时每隔若干点取一个（始终保留首尾），控制订单体积与绘制开销。
function decimate(points, max = 120) {
  if (points.length <= max) return points;
  const step = Math.ceil(points.length / max);
  const out = [];
  for (let i = 0; i < points.length; i += step) out.push(points[i]);
  if (out[out.length - 1] !== points[points.length - 1]) out.push(points[points.length - 1]);
  return out;
}

// 三条真实驾车路线获取（替代 Waze 路线 API——Waze 官方不开放路线数据，这里用开放路由服务 OSRM 的真实路网数据）。
// 策略：① 主请求要 3 条备选并去重；② 真正不同的路线不足 3 条时，用途经点（via point）让 OSRM 绕行生成不同的真实路线补齐；
// ③ 全部失败时返回空数组，由调用方走直线估算兜底（不显示假路线）。

// 单次 OSRM 请求：不带途经点时要 3 条备选，带途经点时只要 1 条（经过该点的绕行路线）。
async function osrmRoute(origin, destination, via) {
  const coords = [origin, ...(via ? [via] : []), destination].map((p) => `${p.lon},${p.lat}`).join(';');
  const url = `https://router.project-osrm.org/route/v1/driving/${coords}?alternatives=${via ? 0 : 3}&overview=full&geometries=polyline6&steps=false`;
  const data = await fetchJson(url);
  const routes = data?.routes;
  if (!Array.isArray(routes) || !routes.length) return [];
  return routes
    .map((item) => ({
      distanceKm: item.distance ? Math.max(0.5, Math.round((item.distance / 1000) * 10) / 10) : null,
      seconds: item.duration || 0,
      geometry: item.geometry || ''
    }))
    .filter((item) => item.distanceKm && item.geometry);
}

// 两条路线是否“实质相同”：用 polyline 上 6 个采样点 + 时长档位做去重键。
function routeKey(route) {
  const pts = decodePolyline6(route.geometry);
  const n = pts.length;
  if (!n) return '';
  const step = Math.max(1, Math.floor(n / 6));
  const samples = [];
  for (let i = 0; i < n; i += step) samples.push(`${pts[i].lat.toFixed(4)},${pts[i].lon.toFixed(4)}`);
  const last = `${pts[n - 1].lat.toFixed(4)},${pts[n - 1].lon.toFixed(4)}`;
  if (samples[samples.length - 1] !== last) samples.push(last);
  return `${samples.join('|')}~${Math.round(route.seconds / 30)}`;
}

function dedupeRoutes(routes) {
  const seen = new Set();
  const out = [];
  for (const route of routes) {
    const key = routeKey(route);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(route);
  }
  return out;
}

// 生成途经点候选：起终点连线的 1/3、2/3 处，各向两侧偏移约 1.7–3.3 km，产生不同的绕行路线。
function viaCandidates(origin, destination) {
  const out = [];
  for (const fraction of [0.33, 0.66]) {
    const lat = origin.lat + (destination.lat - origin.lat) * fraction;
    const lon = origin.lon + (destination.lon - origin.lon) * fraction;
    for (const offset of [-0.015, 0.015, -0.03, 0.03]) {
      out.push({ lat: lat + offset, lon });
      out.push({ lat, lon: lon + offset * 1.6 }); // 米兰纬度处经度 1.6 倍约等于同等地面距离
    }
  }
  return out;
}

async function fetchRouteSet(origin, destination) {
  let routes = dedupeRoutes(await osrmRoute(origin, destination));
  let requests = 1;
  for (const via of viaCandidates(origin, destination)) {
    if (routes.length >= 3 || requests >= 4) break; // 最多 4 次请求，避免拖慢输入体验
    requests += 1;
    const extra = dedupeRoutes(await osrmRoute(origin, destination, via));
    for (const route of extra) {
      if (routes.length >= 3) break;
      const key = routeKey(route);
      if (!routes.some((existing) => routeKey(existing) === key)) routes.push(route);
    }
  }
  return routes.slice(0, 3);
}

// 三条路线按“价格”语义命名（计价 = 真实距离 × 系数，距离越长价格越高）：
// 经济路线 = 距离最短（价格最省）、推荐路线 = 距离居中（时间与价格均衡）、畅行路线 = 距离最长（道路更畅通、价格最高）。
// 内部 id（balanced/fast/economy）保持不变，兼容已存订单与服务器校验；仅对外名称/说明按价格语义调整。
// 注意：Waze 不开放实时拥堵数据，这里“路况稳定 / 道路畅通”为基于路线的启发式标注；备选不足时缺的线路复用另一条的几何（列表仍显示三条不同价格）。
const ROUTE_SPECS = [
  { id: 'economy', label: '经济路线', note: '距离最短 · 价格最省', multiplier: 0.91 },
  { id: 'balanced', label: '推荐路线', note: '时间与价格均衡 · 路况稳定', multiplier: 1 },
  { id: 'fast', label: '畅行路线', note: '路程较长 · 道路更畅通', multiplier: 1.08 }
];

// 把 OSRM 返回的真实路线映射成三条报价线路：经济=距离最短（价格最低）、畅行=距离最长（价格最高）、推荐=剩余那条（时间与价格均衡）。
// 按距离排序而非耗时：因为计价按距离，按距离分配才能保证“经济最便宜、畅行最贵”与名称一致。
// 备选不足 3 条时，缺的线路复用最长那条的几何（列表仍显示三条不同价格）。
function buildRealRoutes(routeSet) {
  if (!routeSet || !routeSet.length) return null;
  const byDistance = [...routeSet].sort((a, b) => a.distanceKm - b.distanceKm);
  const assignment = { economy: byDistance[0], balanced: byDistance[1] || byDistance[0], fast: byDistance[byDistance.length - 1] };
  return ROUTE_SPECS.map((spec) => {
    const real = assignment[spec.id];
    const points = decimate(decodePolyline6(real.geometry));
    const minutes = Math.max(1, Math.round(real.seconds / 60));
    return {
      ...spec,
      distanceKm: real.distanceKm,
      minutes,
      polyline: encodePolyline6(points),
      fare: estimateFare(real.distanceKm, spec.multiplier)
    };
  });
}

// 双端轮询同步：本机演示模式两端共享 localStorage，远程模式共享服务器数据。
// 每 2 秒拉一次最新状态，内容变化且没有正在输入时才重绘，避免打断用户。
let lastSyncKey = '';
async function pollOnce() {
  try {
    const snapshot = await getAppState();
    const key = JSON.stringify(snapshot.orders) + JSON.stringify(snapshot.profile);
    if (key === lastSyncKey) return;
    if (ui.screen === 'auth' || ui.modal) return;
    const active = typeof document !== 'undefined' ? document.activeElement : null;
    if (active && typeof active.matches === 'function' && active.matches('input,textarea,select')) return; // 输入中不重绘
    data = snapshot;
    lastSyncKey = key;
    render();
  } catch { /* 单次轮询失败保持现状，下一轮再试 */ }
}

function startPolling() {
  const poll = async () => {
    await pollOnce();
    window.setTimeout(poll, 2000);
  };
  window.setTimeout(poll, 2000);
}

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
    refreshPickupDistance();
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

// 司机端实时定位：watchPosition 持续上报，位置变化 → render → 地图蓝点实时移动。
let locationWatcher = null;
function startDriverLocationWatch() {
  if (APP_ROLE !== 'driver' || typeof navigator === 'undefined' || !navigator.geolocation || locationWatcher !== null) return;
  const apply = (position) => {
    ui.currentLocation = { lat: position.coords.latitude, lon: position.coords.longitude };
    ui.locationUnavailable = false;
    render();
    refreshPickupDistance();
    reverseGeocode(ui.currentLocation.lat, ui.currentLocation.lon).then((address) => {
      if (!address) return;
      ui.currentAddress = address;
      render();
    });
  };
  try {
    locationWatcher = navigator.geolocation.watchPosition(apply, () => { /* 定位失败保持现状 */ }, { enableHighAccuracy: true, maximumAge: 5000, timeout: 30000 });
  } catch { locationWatcher = null; }
}

function getRoutes() {
  return ui.routes && ui.routes.length ? ui.routes : makeRouteOptions(ui.distanceKm);
}

function selectedRoute() {
  return getRoutes().find((route) => route.id === ui.selectedRoute) || getRoutes()[0];
}

function activePassengerOrder() {
  return data.orders.find((order) => ['matching', 'waiting_driver', 'accepted', 'arrived', 'onboard', 'in_progress'].includes(order.status));
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
  // 极简版：去掉手机状态栏与顶部标题栏（MILANO RIDE·练手版 / XX小程序 / 独立应用），页面直接从地图开始。
  // 底部构建时间戳用于快速识别页面是否为最新构建（老标签页会显示旧的构建时间）。
  const buildStamp = typeof window !== 'undefined' && window.MILANO_RIDE_BUILD ? ` · 构建 ${window.MILANO_RIDE_BUILD}` : '';
  return `
    <main class="phone-shell">
      <section class="page-content">${content}</section>
      ${ui.screen === 'auth' ? '' : (APP_ROLE === 'passenger' ? passengerNav() : driverNav())}
      <div class="build-stamp">Milano Ride Demo 5 v5.0.1${buildStamp}</div>
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
  const isDriver = APP_ROLE === 'driver';
  const roleName = isDriver ? '司机' : '乘客';
  if (ui.wechatAuth) {
    return `
      <section class="auth-card wechat-auth">
        <p class="eyebrow">WECHAT LOGIN</p>
        <h2>微信授权登录</h2>
        <div class="wechat-avatar">微</div>
        <p class="modal-note">微信好友（练手模拟）将获得${roleName}端登录权限${isDriver ? '；首次登录需提交司机认证资料，审核通过后才能接单' : ''}</p>
        ${ui.authError ? `<p class="form-error">${escapeHTML(ui.authError)}</p>` : ''}
        <button class="primary-button wechat-button full" data-action="wechat-login">同意并登录</button>
        <button class="link-button" data-action="wechat-cancel">取消</button>
      </section>`;
  }
  return `
    <section class="auth-card">
      <p class="eyebrow">WELCOME</p>
      <h2>${roleName}端登录</h2>
      <p class="modal-note">本小程序仅支持微信授权登录（练手模拟）。${isDriver ? '司机登录后需提交意大利驾照与中国身份证，经后台审核通过才能接单。' : ''}</p>
      <button class="primary-button wechat-button full" data-action="wechat-auth">💬 微信一键登录</button>
      ${ui.authError ? `<p class="form-error">${escapeHTML(ui.authError)}</p>` : ''}
      <p class="hint">真实环境将拉起微信 App 完成 OAuth 授权；本演示在页面内模拟授权过程。</p>
    </section>`;
}

function renderHome() {
  const person = data.profile.passenger || {};
  return `
    <section class="session-bar"><span>微信身份 · ${escapeHTML(person.name || '微信好友')}</span><button class="small-button" data-action="logout">退出登录</button></section>
    <section class="hero-map">
      <div class="map-host" id="map-host"></div>
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
  const hint = ui.wazeHint
    ? `<div class="waze-hint"><span>🧭 Waze 导航已自动开始：</span><b>${escapeHTML(ui.wazeHint.to)}</b><small>预计 ${ui.wazeHint.minutes} 分钟</small><button data-action="waze-start">重新打开 Waze ›</button></div>`
    : '';
  return `<div class="section-label"><span>选择路线</span><small>每条路线报价不同</small></div>
    ${hint}
    <div class="route-list">${routes.map((item) => `
      <button class="route-option ${item.id === route.id ? 'selected' : ''}" data-action="select-route" data-route="${item.id}">
        <span class="route-radio"></span><span class="route-name"><b>${item.label}</b><small>${item.note} · ${item.distanceKm} km · 约 ${item.minutes} 分钟</small></span><strong>${formatEuro(item.fare)}</strong>
      </button>`).join('')}</div>
    <button class="waze-start-button" data-action="waze-start">🚀 在 Waze 中自动开始导航</button>`;
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

// 上车点在“当前位置”和真实地址之间切换时，局部刷新地图与顶部状态提示（不整页重绘）。
function syncMap() {
  if (typeof app.querySelector !== 'function') return;
  const pill = app.querySelector('.location-pill');
  if (pill) {
    const text = mapPillText();
    if (pill.textContent !== text) pill.textContent = text;
  }
  if (browserCanMap() && typeof requestAnimationFrame === 'function') requestAnimationFrame(syncLiveMap);
}

function renderRideForm() {
  const route = selectedRoute();
  const placesReady = isPlacesReady();
  return `
    <div class="place-inputs">
      <label><span class="place-mark origin">从</span><input data-field="pickup" autocomplete="off" class="${ui.pickup === defaultPickupLabel() ? 'place-hint' : ''}" value="${escapeHTML(ui.pickup)}" aria-label="上车点" /><span class="suggest" data-suggest-for="pickup"></span></label>
      <i></i>
      <label><span class="place-mark destination">到</span><input data-field="destination" autocomplete="off" class="${ui.destination === DEFAULT_DESTINATION ? 'place-hint' : ''}" value="${escapeHTML(ui.destination)}" aria-label="目的地" /><span class="suggest" data-suggest-for="destination"></span></label>
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

// 乘客端“司机过来的时间”文案：已接单显示预计分钟数；司机到达/上车后给出下一步提示。
function passengerArrivalText(order) {
  if (order.status === 'accepted' && order.etaMinutes) return `🚗 司机约 ${order.etaMinutes} 分钟后到达`;
  if (order.status === 'arrived') return '🚗 司机已到达上车点，请及时上车';
  if (order.status === 'onboard') return '🚗 已上车，司机准备出发';
  return '';
}

function renderActiveOrder(order) {
  const [statusLabel, color] = statusOf(order);
  const driverText = order.driver ? `${escapeHTML(order.driver.name)} · ${escapeHTML(order.driver.car)}` : '平台正在分配距离你较近的在线司机';
  const arrivalText = passengerArrivalText(order);
  return `
    <section class="active-order accent-${color}">
      <div><span class="status-chip ${color}">${statusLabel}</span><button class="link-button" data-action="order-detail" data-id="${escapeHTML(order.id)}">查看详情 ›</button></div>
      <h2>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h2>
      <p>${driverText}</p>
      ${arrivalText ? `<p class="eta-line">${arrivalText}</p>` : ''}
      <div class="active-actions">
        ${order.status === 'in_progress' ? `<button data-action="open-deviation" data-id="${escapeHTML(order.id)}">模拟偏航预警</button>` : ''}
        ${['matching', 'waiting_driver', 'accepted', 'arrived'].includes(order.status) ? `<button data-action="cancel-order" data-id="${escapeHTML(order.id)}" class="danger-soft">取消订单</button>` : ''}
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
    <strong>${APP_ROLE === 'driver' ? `司机可得 ${Number.isFinite(order.driverEarnings) && !order.pricePending ? formatEuro(order.driverEarnings) : '待报价'}` : (order.pricePending ? '待报价' : (order.discountCents > 0 ? `实付 ${formatEuro(order.payableCents / 100)} <small class="card-discount">已抵扣 ${formatEuro(order.discountCents / 100)}</small>` : formatEuro(order.fare)))}</strong>
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
      <button data-action="email-support"><span>✉</span><div><b>邮件联系客服</b><small>migogo@outlook.it</small></div><em>›</em></button>
    </div>
    ${completed ? '' : `<section class="practice-tip"><b>练习提示</b><p>先在乘客端创建订单，再切到司机端接单、开始和完成行程，即可体验评价、投诉与失物招领。</p></section>`}`;
}

function renderProfile() {
  const person = data.profile.passenger;
  const databaseConnected = data.dataSource === 'database';
  const inviteCode = data.me?.inviteCode || '';
  const invitedBy = data.me?.invitedBy || '';
  const balanceCents = Number(data.me?.balanceCents) || 0;
  return `
    <section class="profile-card"><div class="avatar">${initialOf(person)}</div><div><h2>${escapeHTML(person.name)}</h2><p>${escapeHTML(person.email)}</p></div><button class="small-button" data-action="verify-passenger">${person.verified ? '已认证' : '模拟认证'}</button></section>
    <div class="wallet-card"><div><span>账户余额</span><b>${formatEuro(balanceCents / 100)}</b><small>可抵扣车费</small></div><button class="small-button" data-action="open-invite">${invitedBy ? '邀请好友' : '输入邀请码'}</button></div>
    <section class="invite-card">
      <div><p class="eyebrow">INVITE & EARN</p><h3>邀请好友，各得 5 欧</h3><p>好友注册后输入你的邀请码，TA 的账户将获得 5 欧返现（可抵扣车费）。</p></div>
      <div class="invite-code-row"><code class="invite-code">${escapeHTML(inviteCode || '—')}</code><button class="small-button" data-action="copy-invite" ${inviteCode ? '' : 'disabled'}>复制</button></div>
      ${invitedBy ? '<p class="invite-bound">✅ 已输入邀请码 · 5 欧返现已到账</p>' : '<p class="invite-hint">还没有输入邀请码？好友邀请你即可获得 5 欧余额。</p>'}
    </section>
    <div class="profile-menu">
      <div><span>▧</span><b>身份与支付方式</b><em>${person.verified ? '已完成（模拟）' : '可选认证'}</em></div>
      <div><span>☏</span><b>紧急联系人</b><em>待设置</em></div>
      <div><span>◉</span><b>隐私与行程安全</b><em>›</em></div>
    </div>
    <section class="data-note"><b>${databaseConnected ? 'MongoDB 数据库已连接' : '本机演示数据'}</b><p>${databaseConnected ? '订单、评价与投诉会保存到 MongoDB Atlas。' : '订单、评价和投诉当前只保存在此浏览器；启动数据库版服务器后会自动切换。'}</p><button data-action="logout">退出登录</button>${databaseConnected ? '' : '<button data-action="reset-data">清空演示数据</button>'}</section>`;
}

// 司机端的微信身份标识（openid 后缀），不展示真实姓名（审核通过前姓名保密）。
function wechatLabel() {
  const email = String(data?.me?.email || '');
  const openid = data?.currentOpenid || (email.startsWith('wx_') ? email.slice(3).split('@')[0] : '');
  return openid ? `微信司机·${String(openid).slice(-4).toUpperCase()}` : '微信司机';
}

function renderDriverHome() {
  const candidates = data.orders.filter((order) => ['matching', 'waiting_driver'].includes(order.status) && !mine(order));
  const active = data.orders.find((order) => mine(order) && ['accepted', 'arrived', 'onboard', 'in_progress'].includes(order.status));
  const docs = data.profile.driver.docs || {};
  const docsStatus = docs.status || (data.profile.driver.italianLicenseVerified ? 'approved' : 'none');
  const verified = docsStatus === 'approved';
  const accountStatus = data.profile.driver.accountStatus || 'active'; // active / suspended 暂停 / closed 强制关闭
  const accountBlocked = accountStatus !== 'active';
  const verifyCard = verified && !accountBlocked
    ? '<section class="verification-card"><span>✓</span><div><b>司机账号已通过审核</b><p>可以打开“接单中”开关开始接单</p></div></section>'
    : verified && accountStatus === 'closed'
      ? '<section class="offline-card"><b>账号已被关闭 · 不符合平台规定</b><p>你的账号因不符合平台规定已被后台强制关闭，无法继续使用接单服务。</p></section>'
      : verified && accountStatus === 'suspended'
        ? '<section class="offline-card"><b>使用权限已暂停</b><p>你的接单权限已被平台暂停，恢复后可继续接单。</p></section>'
        : docsStatus === 'pending'
          ? '<section class="offline-card"><b>资料审核中</b><p>你的意大利驾照与中国身份证资料已提交后台，审核通过后才能上线接单。</p></section>'
          : docsStatus === 'rejected'
            ? `<section class="offline-card"><b>审核未通过</b><p>${escapeHTML(docs.rejectReason || '资料不符合要求')}</p><button class="primary-button compact-button" data-action="nav" data-screen="driver-verify">重新提交资料</button></section>`
            : '<section class="offline-card"><b>完成司机认证后才能接单</b><p>请提交意大利驾照与中国身份证，后台审核通过后即可上线。</p><button class="primary-button compact-button" data-action="nav" data-screen="driver-verify">去提交资料</button></section>';
  // 审核通过前不显示司机姓名、信誉分与评分；通过后才展示真实身份。账号被暂停/强制关闭时只显示状态提示。
  const identityLine = verified && accountStatus === 'active'
    ? `<h2>你好，${escapeHTML(data.profile.driver.name)}</h2><p>信誉分 ${escapeHTML(data.profile.driver.creditScore)} · 评分 ${escapeHTML(data.profile.driver.rating)}</p>`
    : verified && accountStatus === 'closed'
      ? '<h2>账号已被关闭</h2><p>不符合平台规定</p>'
      : verified && accountStatus === 'suspended'
        ? '<h2>使用权限已暂停</h2><p>恢复后可继续接单</p>'
        : `<h2>${docsStatus === 'pending' ? '资料审核中' : docsStatus === 'rejected' ? '审核未通过' : '司机未认证'}</h2><p>审核通过后显示姓名、信誉分与评分</p>`;
  return `
    <section class="session-bar"><span>微信身份 · ${escapeHTML(wechatLabel())}</span><button class="small-button" data-action="logout">退出登录</button></section>
    <section class="driver-summary"><div><p class="eyebrow">DRIVER CENTER</p>${identityLine}</div><label class="switch"><input type="checkbox" data-field="driverOnline" ${data.profile.driver.online ? 'checked' : ''} ${verified && !accountBlocked ? '' : 'disabled'}><span></span>接单中</label></section>
    <section class="driver-live-card">
      <div class="driver-live-head"><b>📍 我的实时位置</b><span>${escapeHTML(ui.currentAddress || (ui.currentLocation ? '已定位，正在反查地址…' : ui.locationUnavailable ? '定位不可用：请通过 localhost 或 HTTPS 打开' : '正在定位…'))}</span></div>
      <div class="map-host" id="driver-live-map"></div>
    </section>
    ${verifyCard}
    ${active ? renderDriverActive(active) : `
      <section class="screen-title compact"><div><p class="eyebrow">NEW REQUESTS</p><h2>可接订单</h2></div><span class="count-pill">${candidates.length}</span></section>
      ${!verified ? '' : data.profile.driver.online ? (candidates.length ? `<div class="driver-order-list">${candidates.map(renderDriverCandidate).join('')}</div>` : renderEmpty('暂时没有新订单', '在乘客端发起一次叫车，订单会出现在这里。', '切到乘客端')) : `<section class="offline-card"><b>你当前处于离线状态</b><p>打开“接单中”开关后即可查看附近可接订单。</p><button class="primary-button compact-button" data-action="driver-go-online">打开接单中</button></section>`}`}
  `;
}

function renderDriverCandidate(order) {
  return `<article class="driver-order-card">
    <div><span class="status-chip amber">新订单</span>${orderTime(order)}</div>
    <h3>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h3>
    <p>${escapeHTML(order.distanceKm || '包车')} km · ${escapeHTML(order.routeLabel || order.serviceLabel)} · 乘客 ${escapeHTML(order.passengerName || '接单后可见')}</p>
    <strong>司机可得 ${Number.isFinite(order.driverEarnings) && !order.pricePending ? formatEuro(order.driverEarnings) : '待报价'}</strong>
    <div class="driver-actions"><button class="outline-button" data-action="driver-reject" data-id="${escapeHTML(order.id)}">拒绝</button><button class="primary-button compact-button" data-action="driver-accept" data-id="${escapeHTML(order.id)}">接单</button></div>
  </article>`;
}

function renderDriverActive(order) {
  const [statusLabel, color] = statusOf(order);
  const driverStepText = order.status === 'accepted' && order.etaMinutes
    ? `预计 ${order.etaMinutes} 分钟后到达上车点`
    : order.status === 'arrived' ? '已到达上车点，等待乘客上车'
      : order.status === 'onboard' ? '乘客已上车，可以开始行程' : '';
  const actionButton = order.status === 'accepted'
    ? `<button class="primary-button compact-button" data-action="driver-arrived" data-id="${escapeHTML(order.id)}">到达上车点</button>`
    : order.status === 'arrived'
      ? `<button class="primary-button compact-button" data-action="driver-board" data-id="${escapeHTML(order.id)}">客人已上车</button>`
      : order.status === 'onboard'
        ? `<button class="primary-button compact-button" data-action="start-trip" data-id="${escapeHTML(order.id)}">开始行程</button>`
        : `<button class="primary-button compact-button" data-action="complete-trip" data-id="${escapeHTML(order.id)}">完成行程</button>`;
  const earnings = Number.isFinite(order.driverEarnings)
    ? `<p class="earnings-line"><b>你得 ${formatEuro(order.driverEarnings)}</b></p>`
    : '';
  return `<section class="driver-active">
    <span class="status-chip ${color}">${statusLabel}</span>
    <h2>${escapeHTML(order.pickup)} <span>→</span> ${escapeHTML(order.destination)}</h2>
    <p class="pickup-line">📍 上车点：${escapeHTML(order.pickup)}</p>
    ${(order.status === 'accepted' || order.status === 'arrived') && Number.isFinite(ui.pickupDistanceKm)
      ? `<p class="pickup-line">🚗 距上车点 ${ui.pickupDistanceKm} km（实际驾车距离）</p>` : ''}
    <p>乘客：${escapeHTML(order.passengerName || '未知')} · 请向乘客展示真实姓名与安全注意事项。</p>
    ${driverStepText ? `<p class="eta-line">${driverStepText}</p>` : ''}
    <div class="driver-map">
      <div class="map-host" id="driver-map-host"></div>
      <a class="map-open-link" href="${escapeHTML(wazeNavUrl(order.destination))}" target="_blank" rel="noopener">在 Waze 导航 ›</a>
    </div>
    <div class="waze-links driver">
      ${wazeLink('⌖ 导航到上车点（Waze）', order.pickup, '', '', order.pickupLat, order.pickupLon)}
      ${wazeLink('🚩 导航到目的地（Waze）', order.destination)}
    </div>
    ${earnings}
    <div class="driver-active-footer"><strong>司机可得 ${Number.isFinite(order.driverEarnings) && !order.pricePending ? formatEuro(order.driverEarnings) : '待报价'}</strong>${actionButton}</div>
  </section>`;
}

function renderDriverOrders() {
  const orders = data.orders.filter(mine);
  return `<section class="screen-title"><div><p class="eyebrow">HISTORY</p><h2>我的行程单</h2></div></section>${orders.length ? `<div class="order-list">${orders.map(renderOrderCard).join('')}</div>` : renderEmpty('尚无接单记录', '接单后的订单会显示在这里。', '去接单')}`;
}

function renderDriverProfile() {
  const driver = data.profile.driver;
  const databaseConnected = data.dataSource === 'database';
  const docs = driver.docs || {};
  const docsStatus = docs.status || (driver.italianLicenseVerified ? 'approved' : 'none');
  const verified = docsStatus === 'approved';
  const docBadge = (label) => verified
    ? `<div><span>✓</span><b>${label}</b><em>已认证</em></div>`
    : docsStatus === 'pending'
      ? `<div><span>◌</span><b>${label}</b><em>审核中</em></div>`
      : docsStatus === 'rejected'
        ? `<div><span>✕</span><b>${label}</b><em>未通过</em></div>`
        : `<div><span>·</span><b>${label}</b><em>未提交</em></div>`;
  const verifyAction = verified
    ? ''
    : `<div class="profile-menu" data-action="nav" data-screen="driver-verify"><div><span>▧</span><b>司机认证资料</b><em>${docsStatus === 'pending' ? '审核中' : docsStatus === 'rejected' ? `未通过：${escapeHTML(docs.rejectReason || '资料不符合要求')}` : '去提交'} ›</em></div></div>`;
  // 审核通过前不显示姓名、评分与信誉分；通过后才展示真实身份。账号被暂停/强制关闭时只显示状态提示。
  const accountStatus = driver.accountStatus || 'active';
  const identityLine = verified && accountStatus === 'active'
    ? `<h2>${escapeHTML(driver.name)}</h2><p>评分 ${escapeHTML(driver.rating)} · 信誉分 ${escapeHTML(driver.creditScore)}</p>`
    : verified && accountStatus === 'closed'
      ? '<h2>账号已被关闭</h2><p>不符合平台规定</p>'
      : verified && accountStatus === 'suspended'
        ? '<h2>使用权限已暂停</h2><p>恢复后可继续接单</p>'
        : `<h2>${docsStatus === 'pending' ? '资料审核中' : docsStatus === 'rejected' ? '审核未通过' : '司机未认证'}</h2><p>审核通过后显示姓名、信誉分与评分</p>`;
  const avatarText = verified && accountStatus === 'active' ? initialOf(driver) : '?';
  return `<section class="profile-card"><div class="avatar driver-avatar">${avatarText}</div><div>${identityLine}</div></section>
    <div class="profile-menu">${docBadge('意大利驾照')}${docBadge('中国身份证')}<div><span>▧</span><b>收款账户</b><em>待接入</em></div></div>
    ${verifyAction}
    <section class="data-note"><b>${databaseConnected ? '数据已保存到 MongoDB' : '取消规则提醒'}</b><p>${databaseConnected ? '当前司机资料与订单状态会保存到 MongoDB Atlas。' : '司机接单后取消会影响信誉分和评分。本练手版本只做界面提示，不会修改真实信用数据。'}</p>${databaseConnected ? '<button data-action="logout">退出登录</button>' : '<button data-action="logout">退出登录</button>'}</section>`;
}

function renderDriverVerify() {
  const driver = data?.profile?.driver || {};
  const docs = driver.docs || {};
  const license = docs.italianLicense || {};
  const chinaId = docs.chinaId || {};
  return `
    <section class="screen-title"><div><p class="eyebrow">DRIVER VERIFY</p><h2>司机认证</h2></div><button class="small-button" data-action="nav" data-screen="driver-home">返回</button></section>
    <section class="booking-card">
      <p class="modal-note">提交意大利驾照与中国身份证，经后台审核通过后才能接单。本演示为练手模拟，不会上传真实证件。</p>
      <form data-form="driver-verify">
        <label class="form-stack">姓名<input name="name" value="${escapeHTML(driver.name || '')}" required maxlength="50" /></label>
        <label class="form-stack">手机号<input name="phone" value="${escapeHTML(driver.phone || '')}" required maxlength="30" placeholder="例如：+39 333 820 4681" /></label>
        <label class="form-stack">车辆信息（车型 · 车牌）<input name="car" value="${escapeHTML(driver.car || '')}" required maxlength="80" placeholder="例如：Mercedes Vito · IT 786 MR" /></label>
        <h3 class="verify-heading">🇮🇹 意大利驾照</h3>
        <label class="form-stack">驾照号码<input name="licenseNumber" value="${escapeHTML(license.number || '')}" required maxlength="30" placeholder="例如：ITMIL1234567" /></label>
        <label class="form-stack">有效期（YYYY-MM）<input name="licenseExpiry" value="${escapeHTML(license.expiry || '')}" required maxlength="10" placeholder="例如：2030-06" /></label>
        <label class="photo-upload"><span>📷 上传驾照照片</span><input type="file" accept="image/png,image/jpeg,image/webp" data-field="licensePhoto" />${ui.driverPhotos?.licensePhoto ? `<img class="photo-preview" src="${escapeHTML(ui.driverPhotos.licensePhoto)}" alt="驾照照片预览" />` : ''}</label>
        <h3 class="verify-heading">🇨🇳 中国身份证</h3>
        <label class="form-stack">身份证号码<input name="chinaId" value="${escapeHTML(chinaId.number || '')}" required maxlength="18" placeholder="18 位身份证号" /></label>
        <label class="photo-upload"><span>📷 上传身份证照片</span><input type="file" accept="image/png,image/jpeg,image/webp" data-field="chinaIdPhoto" />${ui.driverPhotos?.chinaIdPhoto ? `<img class="photo-preview" src="${escapeHTML(ui.driverPhotos.chinaIdPhoto)}" alt="身份证照片预览" />` : ''}</label>
        ${ui.authError ? `<p class="form-error">${escapeHTML(ui.authError)}</p>` : ''}
        <button class="primary-button full" type="submit">提交审核</button>
      </form>
    </section>`;
}

function renderDriverActiveScreen() {
  if (ui.screen === 'driver-orders') return renderDriverOrders();
  if (ui.screen === 'driver-profile') return renderDriverProfile();
  if (ui.screen === 'driver-verify') return renderDriverVerify();
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
  if (modal.type === 'invite') body = inviteModal();
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
    <div class="detail-grid"><span>订单时间</span><b>${formatDateTime(order.createdAt)}</b>${order.scheduledAt ? `<span>出发时间</span><b>${formatDateTime(order.scheduledAt)}</b>` : ''}<span>路线</span><b>${escapeHTML(order.routeLabel || '包车待确认')}</b><span>支付方式</span><b>${order.paymentMethod === 'wechat' ? '微信支付（模拟）' : '支付宝（模拟）'}</b>${APP_ROLE === 'driver' ? `<span>司机可得</span><b>${Number.isFinite(order.driverEarnings) ? formatEuro(order.driverEarnings) : (order.pricePending ? '待报价' : '—')}</b>` : `<span>费用</span><b>${order.pricePending ? '待报价' : formatEuro(order.fare)}</b>${order.discountCents > 0 ? `<span>余额抵扣</span><b class="discount-ok">- ${formatEuro(order.discountCents / 100)}</b><span>实付</span><b>${formatEuro(order.payableCents / 100)}</b>` : ''}`}${order.status === 'completed' ? `<span>支付状态</span><b class="paid-ok">已扣款</b>` : ''}</div>
    ${driver ? `<section class="driver-contact"><div class="avatar driver-avatar">${initialOf(driver)}</div><div><b>${escapeHTML(driver.name)}</b><p>${escapeHTML(driver.car)} · ★ ${escapeHTML(driver.rating)}</p></div><a href="tel:${escapeHTML(driver.phone)}">联系司机</a></section>` : '<p class="modal-note">平台正在为你匹配距离较近的在线司机。</p>'}
    ${order.status === 'completed' ? `<button class="primary-button full" data-action="open-rating">去评价司机</button>` : ''}`;
}

function ratingModal(order) {
  return `<p class="eyebrow">RATE YOUR TRIP</p><h2>给本次行程评分</h2><p class="modal-note">可在完成后 24 小时内评价，评价会影响司机评分和信誉分。</p>
    <form data-form="rating"><input type="hidden" name="orderId" value="${escapeHTML(order?.id || '')}"><div class="stars"><input type="radio" id="s5" name="score" value="5" checked><label for="s5">★</label><input type="radio" id="s4" name="score" value="4"><label for="s4">★</label><input type="radio" id="s3" name="score" value="3"><label for="s3">★</label><input type="radio" id="s2" name="score" value="2"><label for="s2">★</label><input type="radio" id="s1" name="score" value="1"><label for="s1">★</label></div><textarea name="comment" placeholder="分享你的乘车感受（选填）"></textarea><button class="primary-button full" type="submit">提交评价</button></form>`;
}

function complaintModal(order) {
  return `<p class="eyebrow">REPORT A PROBLEM</p><h2>投诉与反馈</h2><p class="modal-note">仅支持行程结束后 7 天内提交。${data.dataSource === 'database' ? '' : '本版本会在浏览器本地记录。'}</p>
    <form data-form="complaint"><input type="hidden" name="orderId" value="${escapeHTML(order?.id || '')}"><label class="form-stack">问题类型<select name="reason"><option>司机不当行为</option><option>路线问题</option><option>费用问题</option><option>其他问题</option></select></label><textarea name="description" required placeholder="请描述遇到的问题"></textarea><button class="primary-button full" type="submit">提交投诉</button></form>`;
}

function lostModal(order) {
  const driver = order?.driver || { name: '司机', car: '', phone: '' };
  return `<p class="eyebrow">LOST & FOUND</p><h2>失物招领</h2><p class="modal-note">订单记录将保留一个月。你可以先联系司机，协商领取方式。</p>
    <div class="driver-contact"><div class="avatar driver-avatar">${initialOf(driver)}</div><div><b>${escapeHTML(driver.name)}</b><p>${escapeHTML(driver.car)}</p></div><a href="tel:${escapeHTML(driver.phone)}">联系司机</a></div>
    <form data-form="lost"><input type="hidden" name="orderId" value="${escapeHTML(order?.id || '')}"><textarea name="description" required placeholder="描述遗失物品，例如：黑色雨伞"></textarea><button class="outline-button full" type="submit">记录失物信息${data.dataSource === 'database' ? '' : '（本地）'}</button></form>`;
}

function deviationModal(order) {
  return `<p class="eyebrow">ROUTE SAFETY</p><h2>检测到路线偏离</h2><div class="warning-icon">!</div><p class="modal-note">车辆偏离规划路线超过阈值。请在 5 分钟内确认是否安全；若未确认且司机未校准路线，系统将通知紧急联系人并发送位置。</p>
    <div class="countdown">04:59 <small>模拟倒计时</small></div><button class="primary-button full" data-action="confirm-safe" data-id="${escapeHTML(order?.id || '')}">我安全，继续行程</button><button class="outline-button full" data-action="notify-emergency" data-id="${escapeHTML(order?.id || '')}">模拟通知紧急联系人</button>`;
}

/** 输入邀请码弹窗：新用户微信登录后首次提示，也可从“我的”页主动打开。 */
function inviteModal() {
  const alreadyBound = Boolean(data.me?.invitedBy);
  return `<p class="eyebrow">INVITE & EARN</p><h2>${alreadyBound ? '邀请好友，各得 5 欧' : '输入邀请码，得 5 欧返现'}</h2>
    <p class="modal-note">${alreadyBound ? '分享你的邀请码给好友：' : '好友邀请你使用米兰打车，输入 TA 的 8 位邀请码后，你的账户将获得 5 欧余额，可直接抵扣车费。'}</p>
    ${alreadyBound ? '' : `<form data-form="invite"><input class="invite-input" name="code" maxlength="8" placeholder="例如 M3XK9Q2A" autocomplete="off" autocapitalize="characters" /><button class="primary-button full" type="submit">领取 5 欧返现</button><button class="outline-button full" type="button" data-action="close-modal">暂不领取</button></form>`}`;
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
  if (browserCanMap() && typeof requestAnimationFrame === 'function') requestAnimationFrame(syncLiveMap);
}

async function bookRide() {
  if (!ui.pickup.trim()) { showToast('请填写上车点'); return; }
  if (!ui.destination.trim()) { showToast('请填写目的地'); return; }
  const scheduledAt = ui.bookingType === 'scheduled' ? toIsoOrNull(ui.scheduledAt) : null;
  if (ui.bookingType === 'scheduled' && !scheduledAt) { showToast('请选择出发时间'); return; }
  const route = selectedRoute();
  const originPoint = await pickupPointForBooking();
  // 三条路线的真实距离（OSRM 实测），服务器按各自距离计价，并存储所选路线几何供司机端画线。
  const routeDistances = {};
  for (const item of getRoutes()) routeDistances[item.id] = item.distanceKm;
  // 第一个参数是发给服务器的“用户的选择”（价格由服务器计算）；第二个参数只在本机演示模式使用。
  await createOrder({
    type: ui.bookingType, pickup: ui.pickup.trim(), destination: ui.destination.trim(), distanceKm: Number(route.distanceKm),
    routeId: route.id, routeDistances, routePolyline: route.polyline || null, routeMinutes: route.minutes,
    scheduledAt, paymentMethod: ui.paymentMethod,
    pickupLat: originPoint?.lat ?? null, pickupLon: originPoint?.lon ?? null
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
    routePolyline: route.polyline || null,
    paymentMethod: ui.paymentMethod,
    pricePending: false,
    pickupLat: originPoint?.lat ?? null,
    pickupLon: originPoint?.lon ?? null
  });
  await refresh();
  const justCreated = data.orders[0];
  if (justCreated?.discountCents > 0) {
    showToast(`订单已创建，余额抵扣 ${formatEuro(justCreated.discountCents / 100)}，实付 ${formatEuro(justCreated.payableCents / 100)}`);
  } else {
    showToast('订单已创建，正在向附近在线司机派单');
  }
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
  const justCreated = data.orders[0];
  if (justCreated?.discountCents > 0) {
    showToast(`机场接送订单已创建，余额抵扣 ${formatEuro(justCreated.discountCents / 100)}，实付 ${formatEuro(justCreated.payableCents / 100)}`);
  } else {
    showToast(airport ? '机场接送订单已创建，正在派单' : '包车需求已提交，基础价待配置');
  }
}

async function submitAuth(kind, fields) {
  const text = (name) => String(fields.get(name) || '').trim();
  if (kind === 'driver-verify') {
    // 照片来自文件选择（data URL），测试环境没有 FileReader 时直接取表单字段。
    const licensePhoto = ui.driverPhotos?.licensePhoto || fields.get('licensePhoto') || null;
    const chinaIdPhoto = ui.driverPhotos?.chinaIdPhoto || fields.get('chinaIdPhoto') || null;
    if (!licensePhoto || !chinaIdPhoto) {
      ui.authError = '请上传意大利驾照照片和中国身份证照片';
      render();
      return;
    }
    const payload = {
      name: text('name'),
      phone: text('phone'),
      car: text('car'),
      italianLicense: { number: text('licenseNumber'), expiry: text('licenseExpiry'), photo: licensePhoto },
      chinaId: { number: text('chinaId'), photo: chinaIdPhoto }
    };
    try {
      await submitDriverApplication(payload);
      ui.authError = '';
      ui.screen = homeScreen();
      await refresh();
      render();
      showToast('资料已提交，等待后台审核');
    } catch (error) {
      if (!(error instanceof ApiError)) console.error(error);
      ui.authError = error instanceof ApiError ? error.message : '提交失败，请稍后重试';
      render();
    }
    return;
  }
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
  // 离线提示里的“打开接单中”按钮：等价于拨动接单开关（切换在线状态后刷新订单）。
  if (action === 'driver-go-online') {
    await guarded(async () => {
      await updateProfile('driver', { online: true });
      await refresh();
      render();
      showToast('已打开接单中，正在为你查找附近订单');
    });
    return;
  }
  if (action === 'auth-mode') { ui.authMode = element.dataset.mode === 'register' ? 'register' : 'login'; ui.authError = ''; render(); return; }
  if (action === 'wechat-auth') { ui.wechatAuth = true; ui.authError = ''; render(); return; }
  if (action === 'wechat-cancel') { ui.wechatAuth = false; ui.authError = ''; render(); return; }
  if (action === 'wechat-login') {
    try {
      const user = await wechatLogin(APP_ROLE);
      ui.wechatAuth = false;
      ui.authError = '';
      if (APP_ROLE === 'driver' && user?.docs?.status === 'none') {
        // 新司机：先提交认证资料（意大利驾照 + 中国身份证），审核通过后才能接单。
        ui.screen = 'driver-verify';
        await refresh();
        render();
        showToast('请先提交司机认证资料');
      } else {
        ui.screen = homeScreen();
        await refresh();
        render();
        showToast('微信登录成功（练手模拟）');
        // 新乘客首次登录：提示输入好友邀请码（可跳过）；已绑定过或该账号已提示过不再打扰（提示标记按账号区分，换微信登录会重新提示）。
        if (APP_ROLE === 'passenger' && !data.me?.invitedBy) {
          const promptKey = `milano-ride-invite-prompted-${data.me?.email || 'anon'}`;
          let prompted = false;
          try { prompted = window.localStorage.getItem(promptKey) === '1'; } catch { /* 忽略 */ }
          if (!prompted) {
            try { window.localStorage.setItem(promptKey, '1'); } catch { /* 忽略 */ }
            ui.modal = { type: 'invite' };
            render();
          }
        }
      }
    } catch (error) {
      // 微信登录还没建立会话，失败时不要触发需要令牌的 refresh，直接显示服务器原因（如“已注册为乘客账号”）。
      if (error instanceof AuthRequiredError) { showAuth('登录已过期，请重新登录'); return; }
      if (!(error instanceof ApiError)) console.error(error);
      ui.authError = error instanceof ApiError ? error.message : '微信登录失败，请重试';
      render();
    }
    return;
  }
  if (action === 'pick-suggest') {
    const field = element.dataset.field;
    const item = (ui.suggest[field] || [])[Number(element.dataset.index)];
    if (!item) return;
    ui[field] = item.label;
    // 直接保存建议项的坐标：显示文本带“ · ”分隔符，再拿去地理编码会失败，导致路线算不出来。
    if (Number.isFinite(item.lat) && Number.isFinite(item.lon)) ui[`${field}Point`] = { lat: item.lat, lon: item.lon };
    ui.suggest[field] = [];
    ui.routes = null;
    ui.wazeHint = null;
    ui.calculating = isPlacesReady();
    render();
    if (isPlacesReady()) scheduleRouteCalc();
    return;
  }
  if (action === 'logout') { await logoutAccount(); ui.authMode = 'login'; ui.authForm = {}; showAuth(); return; }
  if (action === 'booking-type') { ui.bookingType = element.dataset.type; render(); return; }
  if (action === 'recalibrate') { requestCurrentLocation(); return; }
  if (action === 'charter-kind') { ui.charterKind = element.dataset.kind; render(); return; }
  if (action === 'payment-method') { ui.paymentMethod = element.dataset.payment; render(); return; }
  if (action === 'select-route') { ui.selectedRoute = element.dataset.route; render(); return; }
  if (action === 'waze-start') {
    // 自动打开 Waze：地址先转成坐标，Waze 自动填好起终点并自动开始导航（已装应用则拉起应用，否则打开网页版）。
    if (typeof window === 'undefined' || !window.open) return;
    showToast('正在定位起终点，马上在 Waze 自动开始…');
    // 默认“当前位置”时优先用浏览器定位；无定位时不给 from（Waze 从当前 GPS 出发），绝不拿“当前位置”四个字去地理编码。
    // 地址建议点选过的地址直接用已保存坐标，避免带分隔符的显示文本解析失败。
    const isDefaultPickup = ui.pickup === defaultPickupLabel();
    const fromPoint = isDefaultPickup ? ui.currentLocation : (ui.pickupPoint || await geocodeAddress(ui.pickup));
    const toPoint = ui.destinationPoint || await geocodeAddress(ui.destination);
    const from = fromPoint ? `ll.${fromPoint.lat},${fromPoint.lon}` : '';
    const to = toPoint ? `ll.${toPoint.lat},${toPoint.lon}` : ui.destination;
    window.open(wazeRouteUrl(from, to), '_blank', 'noopener');
    // 页面内常驻一条 Waze 导航提示，地址变化后自动消失。
    ui.wazeHint = { to: ui.destination.trim(), minutes: selectedRoute().minutes };
    syncRouteSection();
    return;
  }
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
    const order = data.orders.find((item) => item.id === id);
    const etaMinutes = await estimateEtaMinutes(order);
    await acceptOrder(id, etaMinutes);
    await refresh();
    ui.pickupDistanceKm = null;
    refreshPickupDistance(); // 接单后立刻计算“司机位置 → 上车点”的实际驾车距离
    showToast(etaMinutes ? `已接单，预计 ${etaMinutes} 分钟后到达上车点` : '已接单，乘客端已收到司机信息');
    return;
  }
  if (action === 'driver-arrived') {
    await arriveOrder(id); await refresh(); showToast('已到达上车点，等待乘客上车'); return;
  }
  if (action === 'driver-board') {
    await boardOrder(id); await refresh(); showToast('客人已上车，可以开始行程'); return;
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
  if (action === 'email-support') { window.location.href = 'mailto:migogo@outlook.it?subject=Milano%20Ride%20客服咨询'; return; }
  if (action === 'open-deviation') { ui.modal = { type: 'deviation', orderId: id }; render(); return; }
  if (action === 'open-invite') { ui.modal = { type: 'invite' }; render(); return; }
  if (action === 'copy-invite') {
    const code = data.me?.inviteCode || '';
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      showToast(`邀请码 ${code} 已复制`);
    } catch {
      showToast(`我的邀请码：${code}`);
    }
    return;
  }
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
  if (button.dataset.action === 'close-modal') {
    // × 关闭按钮始终有效；点击弹窗外部空白处关闭；点击弹窗内部的其他内容不关闭。
    const clickedInsideModal = Boolean(event.target.closest('[data-stop]'));
    const isCloseButton = Boolean(button.classList?.contains('modal-close'));
    if (!clickedInsideModal || isCloseButton) await guarded(() => handleAction('close-modal', button));
    return;
  }
  await guarded(() => handleAction(button.dataset.action, button));
});

app.addEventListener('input', (event) => {
  const field = event.target.dataset.field;
  if (!field) return;
  if (field === 'distanceKm') { ui.distanceKm = Number(event.target.value); render(); return; }
  if (field === 'pickup' || field === 'destination') {
    ui[field] = event.target.value;
    ui[`${field}Point`] = null; // 文字被手动改动，之前建议项保存的坐标作废
    if (event.target.classList) event.target.classList.toggle('place-hint', event.target.value === defaultLabel(field));
    // 地址已变，旧路线与 Waze 导航提示立即作废（地图上的线清除，等新路线算好再画）。
    ui.routes = null;
    ui.wazeHint = null;
    if (isPlacesReady()) ui.calculating = true;
    syncRouteSection();
    if (browserCanMap()) requestAnimationFrame(syncLiveMap);
    scheduleRouteCalc();
    scheduleSuggest(field);
    return;
  }
  if (field === 'scheduledAt') ui[field] = event.target.value;
});

// 示例地址淡色提示：点击输入框自动清空；留空失焦后恢复示例地址。
// 注意：地址建议按钮也带 data-field（data-action="pick-suggest"），focusin/focusout 必须只处理真正的 <input>，
// 否则点选建议后该按钮被 render 移除时触发的 focusout 会把目的地误当成空输入而重置回默认值，导致三条路线消失。
app.addEventListener('focusin', (event) => {
  const field = event.target.dataset?.field;
  if (field !== 'pickup' && field !== 'destination') return;
  if (event.target.tagName !== 'INPUT') return;
  if (ui[field] === defaultLabel(field)) {
    event.target.value = '';
    ui[field] = '';
    ui[`${field}Point`] = null;
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
  if (event.target.tagName !== 'INPUT') return; // 只处理真正的地址输入框，建议按钮带 data-field 但不应触发重置
  const value = String(event.target.value || '').trim();
  if (!value) {
    event.target.value = defaultLabel(field);
    ui[field] = defaultLabel(field);
    ui[`${field}Point`] = null;
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
    return;
  }
  // 司机认证照片：选中后立刻读成 data URL 并局部显示预览。
  // 注意：不能在这里调用 render() 整页重绘——会重建表单 DOM，把司机已填写的其他字段全部清空。
  const photoField = event.target.dataset?.field;
  if ((photoField === 'licensePhoto' || photoField === 'chinaIdPhoto') && event.target.type === 'file' && event.target.files?.[0]) {
    const file = event.target.files[0];
    const label = event.target.closest('label.photo-upload');
    const showPhotoError = (message) => {
      ui.authError = message;
      label?.querySelector('.photo-error')?.remove();
      if (label) {
        const note = document.createElement('p');
        note.className = 'photo-error';
        note.textContent = message;
        label.appendChild(note);
      }
    };
    if (!/^image\/(png|jpe?g|webp)$/.test(file.type)) {
      showPhotoError(`${photoField === 'licensePhoto' ? '驾照' : '身份证'}照片需要是 JPG/PNG/WebP 图片`);
      return;
    }
    if (file.size > 3 * 1024 * 1024) {
      showPhotoError(`${photoField === 'licensePhoto' ? '驾照' : '身份证'}照片不能超过 3MB`);
      return;
    }
    if (typeof FileReader === 'undefined') return;
    const reader = new FileReader();
    reader.onload = () => {
      ui.driverPhotos = { ...ui.driverPhotos, [photoField]: String(reader.result) };
      ui.authError = '';
      // 只更新预览图，不重绘整页，保留司机已填写的其他字段。
      label?.querySelector('.photo-preview')?.remove();
      label?.querySelector('.photo-error')?.remove();
      if (label) {
        const img = document.createElement('img');
        img.className = 'photo-preview';
        img.alt = photoField === 'licensePhoto' ? '驾照照片预览' : '身份证照片预览';
        img.src = String(reader.result);
        label.appendChild(img);
      }
    };
    reader.readAsDataURL(file);
  }
});

app.addEventListener('submit', async (event) => {
  const form = event.target.closest('form[data-form]');
  if (!form) return;
  event.preventDefault();
  const fields = new FormData(form);
  const kind = form.dataset.form;
  if (kind === 'login' || kind === 'register' || kind === 'driver-verify') { await submitAuth(kind, fields); return; }
  await guarded(async () => {
    if (kind === 'rating') {
      await submitRating({ orderId: fields.get('orderId'), score: Number(fields.get('score')), comment: fields.get('comment') });
      ui.modal = null; await refresh(); showToast(data.dataSource === 'database' ? '感谢你的评价' : '感谢你的评价，已保存到本地演示数据');
    }
    if (kind === 'complaint') {
      await createComplaint({ orderId: fields.get('orderId'), reason: fields.get('reason'), description: fields.get('description') });
      ui.modal = null; await refresh(); showToast('投诉已提交，客服将在 24 小时内回复（模拟）');
    }
    if (kind === 'lost') {
      await createLostItem({ orderId: fields.get('orderId'), description: fields.get('description') });
      ui.modal = null; await refresh(); showToast(`已记录失物：${fields.get('description')}`);
    }
    if (kind === 'invite') {
      const result = await applyInvite(fields.get('code'));
      ui.modal = null; await refresh();
      showToast(result?.balanceCents > 0 ? '邀请码有效，5 欧返现已到账（余额可抵扣车费）' : '邀请码已绑定');
    }
  });
});

await initApi();
if (!hasSession()) {
  showAuth();
} else {
  await guarded(async () => { await refresh(); render(); });
}
if (ui.screen !== 'auth') requestCurrentLocation();
// 司机端实时上报位置（watchPosition），地图蓝点随司机移动实时刷新。
startDriverLocationWatch();
// 真实浏览器才启动双端轮询同步（测试环境无 navigator，且不产生定时器）。
if (typeof navigator !== 'undefined') startPolling();
if (!data && ui.screen !== 'auth') {
  app.innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>暂时无法连接服务器</h1><p>请确认已运行 npm.cmd run dev，然后刷新页面。</p></main>';
}

})().catch((error) => {
  console.error(error);
  document.querySelector('#app').innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>页面没有启动</h1><p>请刷新后重试。错误信息已输出到浏览器开发者工具。</p></main>';
});
