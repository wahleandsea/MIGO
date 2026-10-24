/**
 * 数据访问层。两种模式：
 * - remote（远程）：通过 http://localhost:5173 运行，并且数据库已配置。所有数据来自服务器，需要登录；
 *   服务器会拒绝不合规则的操作（比如订单已被别的司机接走），这些错误会原样提示给用户，不会悄悄改用本地数据。
 * - local（本地模式）：双击 index.html 或数据库未配置。数据只保存在浏览器 localStorage，不需要登录。
 */
import { getState, updateState, resetDemoData } from './storage.js';

const ROLE = window.MILANO_RIDE_APP_ROLE === 'driver' ? 'driver' : 'passenger';
const TOKEN_KEY = `milano-ride-token-${ROLE}`;
const LOCAL_DRIVER_ID = 'local-driver';
const LOCAL_DRIVER_DEFAULTS = { car: 'Mercedes Vito · IT 786 MR', phone: '+39 333 820 4681' };
const LOCAL_REASSIGNED_DRIVER = { id: 'local-driver-2', name: 'Luca Bianchi', car: 'Volkswagen Touran · IT 462 LB', rating: 4.88, phone: '+39 345 612 2094' };

let mode = 'local';

const wait = (milliseconds = 180) => new Promise((resolve) => window.setTimeout(resolve, milliseconds));
const newId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 7)}`;
const nowIso = () => new Date().toISOString();

export class ApiError extends Error {
  constructor(message, status = 0, code = '') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

/** 需要（重新）登录。 */
export class AuthRequiredError extends ApiError {}

// ---------- 模式与登录状态 ----------

export function apiMode() {
  return mode;
}

/** 启动时调用一次：判断是连接服务器数据库，还是使用本地数据。 */
export async function initApi() {
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

/** 无论本地模式还是远程模式，都必须先微信授权登录才能使用服务。 */
export function hasSession() {
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

export async function loginAccount({ email, password }) {
  const result = await call('/api/auth/login', { method: 'POST', body: { email, password, role: ROLE }, auth: false });
  setToken(result.token);
  return result.user;
}

// 微信一键登录：远程模式发给服务器换取会话；本地模式直接进入本地账号。
// 同一浏览器记住同一个微信身份（openid），刷新/换端登录不会变成“新用户”，贴近真实微信 OAuth。
// 退出登录会清除微信身份：重新登录就是“另一个微信”，本地模式下会得到不同的司机账号。
export async function wechatLogin(role = 'passenger') {
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
  // 本地模式：记录登录态（本地令牌），让“未登录必须先进微信授权页”的规则在本地模式下同样成立。
  setToken('local-wechat');
  const docsStatus = driver.docs?.status || (driver.italianLicenseVerified ? 'approved' : 'none');
  return role === 'driver'
    ? { id: 'local-driver', role: 'driver', name: driver.name, approved: docsStatus === 'approved', docs: driver.docs || {} }
    : { id: 'local-wechat', role: 'passenger', name: '微信好友', wechat: true };
}

/** 司机提交认证资料（意大利驾照 + 中国身份证），提交后进入后台待审核。 */
export async function submitDriverApplication(fields) {
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

export async function registerAccount(fields) {
  const result = await call('/api/auth/register', { method: 'POST', body: { ...fields, role: ROLE }, auth: false });
  setToken(result.token);
  return result.user;
}

export async function logoutAccount() {
  // 清除微信身份：退出后重新登录将被当作“另一个微信”（不同 openid → 不同账号）。
  try { window.localStorage.removeItem('milano-ride-wechat-openid'); } catch { /* 忽略 */ }
  updateState((state) => ({ ...state, currentOpenid: '' }));
  if (mode !== 'remote') { setToken(null); return; } // 本地模式没有服务器会话，直接清掉本地登录态
  try { await call('/api/auth/logout', { method: 'POST' }); } catch { /* 即使服务器没回应，也要清掉本机的登录状态 */ }
  setToken(null);
}

// ---------- 本地模式的辅助函数 ----------

function localState() {
  const state = getState();
  const profile = state.profile[ROLE];
  const driverDocs = state.profile.driver.docs?.status || (state.profile.driver.italianLicenseVerified ? 'approved' : 'none');
  // 本地模式：乘客也有自己的邀请码与余额（本地值），页面展示与远程模式一致。
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

export async function getAppState() {
  if (mode !== 'remote') return localState();
  return { ...(await call('/api/state')), dataSource: 'database' };
}

/** request 发给服务器（服务器自己算价格）；localOrder 只在本地模式下使用。 */
export async function createOrder(request, localOrder) {
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

export async function cancelOrder(orderId) {
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

export async function acceptOrder(orderId, etaMinutes) {
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
export async function arriveOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/arrive`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'arrived', arrivedAt: nowIso() });
}

/** 客人已上车。 */
export async function boardOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/board`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'onboard', boardedAt: nowIso() });
}

export async function declineOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/decline`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'matching', driverRejected: true, assignmentNote: '当前司机拒绝，系统重新分配中' });
}

/** 仅本地模式：司机拒单后，由另一位司机接单。 */
export async function simulateLocalReassign(orderId) {
  if (mode === 'remote') return undefined;
  const order = getState().orders.find((item) => item.id === orderId);
  if (order?.status !== 'matching') return order;
  return patchLocalOrder(orderId, { status: 'accepted', driverId: LOCAL_REASSIGNED_DRIVER.id, driver: LOCAL_REASSIGNED_DRIVER });
}

export async function startTrip(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/start`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'in_progress', startedAt: nowIso() });
}

export async function completeTrip(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/complete`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'completed', completedAt: nowIso() });
}

/** kind: 'safe'（我安全）或 'emergency'（通知紧急联系人）。 */
export async function setSafety(orderId, kind) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/safety`, { method: 'POST', body: { kind } });
  await wait();
  return patchLocalOrder(orderId, kind === 'safe'
    ? { deviationAlert: false, passengerConfirmedSafeAt: nowIso() }
    : { deviationAlert: true, emergencyNotifiedAt: nowIso() });
}

export async function submitRating(payload) {
  if (mode === 'remote') return call('/api/ratings', { method: 'POST', body: payload });
  await wait();
  const rating = { id: newId('rating'), createdAt: nowIso(), ...payload };
  updateState((state) => ({ ...state, ratings: [rating, ...state.ratings] }));
  return rating;
}

export async function createComplaint(payload) {
  if (mode === 'remote') return call('/api/complaints', { method: 'POST', body: payload });
  await wait();
  const complaint = { id: newId('complaint'), createdAt: nowIso(), status: 'received', ...payload };
  updateState((state) => ({ ...state, complaints: [complaint, ...state.complaints] }));
  return complaint;
}

export async function createLostItem(payload) {
  if (mode === 'remote') return call('/api/lost-items', { method: 'POST', body: payload });
  return { id: newId('lost'), createdAt: nowIso(), status: 'open', ...payload };
}

/** 输入邀请码：绑定推荐关系 + 被邀请人得 5 欧返现（余额，可抵扣车费）。仅乘客端使用。 */
export async function applyInvite(code) {
  if (mode === 'remote') return call('/api/invite/apply', { method: 'POST', body: { code } });
  // 本地模式：任意 8 位邀请码都可用，直接绑定并返现 5 欧余额。
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

/** 远程模式下资料属于当前登录的账号，role 参数只用于本地模式。 */
export async function updateProfile(role, patch) {
  if (mode === 'remote') return call('/api/profile', { method: 'PATCH', body: patch });
  // 本地模式：与服务器规则保持一致——上线接单要求审核通过，且账号未被暂停/强制关闭。
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

export async function resetLocalDemoData() {
  resetDemoData();
  return localState();
}
