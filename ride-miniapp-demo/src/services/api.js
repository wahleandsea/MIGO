/**
 * 数据访问层：通过 http://localhost:5173 运行时会优先调用 PostgreSQL 后端。
 * 双击 index.html 或数据库未配置时，会自动降级到 localStorage 演示模式。
 */
import { getState, updateState, resetDemoData } from './storage.js';

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

export async function getAppState() {
  const state = await request('/api/state');
  return state ? { ...state, dataSource: 'postgresql' } : localState();
}

export async function createOrder(payload) {
  const remote = await request('/api/orders', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  await wait(260);
  const order = { id: newId('ord'), createdAt: new Date().toISOString(), status: 'matching', driver: null, deviationAlert: false, ...payload };
  updateState((state) => ({ ...state, orders: [order, ...state.orders] }));
  return order;
}

export async function updateOrder(orderId, patch) {
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

export async function cancelOrder(orderId) {
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

export async function submitRating(payload) {
  const remote = await request('/api/ratings', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  await wait();
  const rating = { id: newId('rating'), createdAt: new Date().toISOString(), ...payload };
  updateState((state) => ({ ...state, ratings: [rating, ...state.ratings] }));
  return rating;
}

export async function createComplaint(payload) {
  const remote = await request('/api/complaints', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  await wait();
  const complaint = { id: newId('complaint'), createdAt: new Date().toISOString(), status: 'received', ...payload };
  updateState((state) => ({ ...state, complaints: [complaint, ...state.complaints] }));
  return complaint;
}

export async function createLostItem(payload) {
  const remote = await request('/api/lost-items', { method: 'POST', body: JSON.stringify(payload) });
  if (remote) return remote;
  return { id: newId('lost'), createdAt: new Date().toISOString(), status: 'open', ...payload };
}

export async function updateProfile(role, patch) {
  const remote = await request(`/api/profiles/${role}`, { method: 'PATCH', body: JSON.stringify(patch) });
  if (remote) return remote;
  updateState((state) => ({ ...state, profile: { ...state.profile, [role]: { ...state.profile[role], ...patch } } }));
  return getState().profile[role];
}

export async function resetLocalDemoData() {
  resetDemoData();
  return localState();
}
