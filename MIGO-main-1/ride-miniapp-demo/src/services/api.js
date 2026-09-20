/**
 * 数据访问层。两种模式：
 * - remote（远程）：通过 http://localhost:5173 运行，并且数据库已配置。所有数据来自服务器，需要登录；
 *   服务器会拒绝不合规则的操作（比如订单已被别的司机接走），这些错误会原样提示给用户，不会悄悄改用本地数据。
 * - local（本机演示）：双击 index.html 或数据库未配置。数据只保存在浏览器 localStorage，不需要登录。
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

/** 启动时调用一次：判断是连接服务器数据库，还是使用本机演示数据。 */
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

/** 本机演示模式不需要登录；远程模式需要有登录令牌。 */
export function hasSession() {
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

export async function loginAccount({ email, password }) {
  const result = await call('/api/auth/login', { method: 'POST', body: { email, password, role: ROLE }, auth: false });
  setToken(result.token);
  return result.user;
}

export async function registerAccount(fields) {
  const result = await call('/api/auth/register', { method: 'POST', body: { ...fields, role: ROLE }, auth: false });
  setToken(result.token);
  return result.user;
}

export async function logoutAccount() {
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

export async function getAppState() {
  if (mode !== 'remote') return localState();
  return { ...(await call('/api/state')), dataSource: 'postgresql' };
}

/** request 发给服务器（服务器自己算价格）；localOrder 只在本机演示模式下使用。 */
export async function createOrder(request, localOrder) {
  if (mode === 'remote') return call('/api/orders', { method: 'POST', body: request });
  await wait(260);
  const order = {
    id: newId('ord'), createdAt: nowIso(), status: 'matching', driver: null, driverId: null, deviationAlert: false,
    passengerName: getState().profile.passenger.name, ...localOrder
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

export async function acceptOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/accept`, { method: 'POST' });
  await wait();
  const profile = getState().profile.driver;
  return patchLocalOrder(orderId, {
    status: 'accepted', driverId: LOCAL_DRIVER_ID,
    driver: { name: profile.name, car: profile.car || LOCAL_DRIVER_DEFAULTS.car, rating: profile.rating, phone: profile.phone || LOCAL_DRIVER_DEFAULTS.phone }
  });
}

export async function declineOrder(orderId) {
  if (mode === 'remote') return call(`/api/orders/${encodeURIComponent(orderId)}/decline`, { method: 'POST' });
  await wait();
  return patchLocalOrder(orderId, { status: 'matching', driverRejected: true, assignmentNote: '当前司机拒绝，系统重新分配中' });
}

/** 仅本机演示：司机拒单后，模拟另一位司机接单。 */
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

/** 远程模式下资料属于当前登录的账号，role 参数只用于本机演示模式。 */
export async function updateProfile(role, patch) {
  if (mode === 'remote') return call('/api/profile', { method: 'PATCH', body: patch });
  updateState((state) => ({ ...state, profile: { ...state.profile, [role]: { ...state.profile[role], ...patch } } }));
  return getState().profile[role];
}

export async function resetLocalDemoData() {
  resetDemoData();
  return localState();
}
