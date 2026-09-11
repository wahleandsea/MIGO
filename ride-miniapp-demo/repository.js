/**
 * 业务数据访问层。表保留核心字段用于索引，完整订单内容存 JSONB，
 * 便于练手阶段快速迭代页面字段，后期可以逐步拆成更细的关系表。
 */
const { query, transaction } = require('./database.js');

const passengerDefault = { name: '陈小满', email: 'xiaoman@example.com', verified: false };
const driverDefault = {
  name: 'Marco Rossi', rating: 4.92, creditScore: 98,
  italianLicenseVerified: true, chinaIdVerified: true, online: true
};

const newId = (prefix) => `${prefix}_${Date.now()}_${Math.random().toString(16).slice(2, 8)}`;
const now = () => new Date().toISOString();

function asNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

async function getState() {
  const [profileResult, orderResult, ratingResult, complaintResult, metaResult] = await Promise.all([
    query('SELECT role, data FROM profiles'),
    query('SELECT data FROM orders ORDER BY created_at DESC'),
    query('SELECT data FROM ratings ORDER BY created_at DESC'),
    query('SELECT data FROM complaints ORDER BY created_at DESC'),
    query('SELECT key, value FROM app_meta')
  ]);
  const profiles = { passenger: passengerDefault, driver: driverDefault };
  for (const row of profileResult.rows) profiles[row.role] = { ...profiles[row.role], ...row.data };
  const meta = Object.fromEntries(metaResult.rows.map((row) => [row.key, row.value]));
  return {
    profile: profiles,
    orders: orderResult.rows.map((row) => row.data),
    ratings: ratingResult.rows.map((row) => row.data),
    complaints: complaintResult.rows.map((row) => row.data),
    cancellationCount: asNumber(meta.cancellationCount),
    lastResetAt: meta.lastResetAt || now()
  };
}

async function createOrder(payload) {
  const order = {
    id: payload.id || newId('ord'), createdAt: now(), status: 'matching',
    driver: null, deviationAlert: false, ...payload
  };
  await query('INSERT INTO orders (id, status, data, created_at, updated_at) VALUES ($1, $2, $3, $4, NOW())', [order.id, order.status, order, order.createdAt]);
  return order;
}

async function updateOrder(orderId, patch) {
  return transaction(async (client) => {
    const existing = await client.query('SELECT data FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!existing.rowCount) return null;
    const order = { ...existing.rows[0].data, ...patch, updatedAt: now() };
    await client.query('UPDATE orders SET status = $2, data = $3, updated_at = NOW() WHERE id = $1', [orderId, order.status, order]);
    return order;
  });
}

async function cancelOrder(orderId) {
  return transaction(async (client) => {
    const existing = await client.query('SELECT data FROM orders WHERE id = $1 FOR UPDATE', [orderId]);
    if (!existing.rowCount) return null;
    const meta = await client.query("SELECT value FROM app_meta WHERE key = 'cancellationCount' FOR UPDATE");
    const count = asNumber(meta.rows[0]?.value);
    const order = { ...existing.rows[0].data };
    const fee = count >= 3 ? Math.round(asNumber(order.fare) * 0.05 * 100) / 100 : 0;
    const cancelled = { ...order, status: 'cancelled', cancellationFee: fee, updatedAt: now() };
    await client.query('UPDATE orders SET status = $2, data = $3, updated_at = NOW() WHERE id = $1', [orderId, cancelled.status, cancelled]);
    await client.query("INSERT INTO app_meta (key, value, updated_at) VALUES ('cancellationCount', $1, NOW()) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW()", [count + 1]);
    return cancelled;
  });
}

async function addRating(payload) {
  const rating = { id: payload.id || newId('rating'), createdAt: now(), ...payload };
  await query('INSERT INTO ratings (id, order_id, data, created_at) VALUES ($1, $2, $3, $4)', [rating.id, rating.orderId || null, rating, rating.createdAt]);
  return rating;
}

async function addComplaint(payload) {
  const complaint = { id: payload.id || newId('complaint'), createdAt: now(), status: 'received', ...payload };
  await query('INSERT INTO complaints (id, order_id, data, created_at) VALUES ($1, $2, $3, $4)', [complaint.id, complaint.orderId || null, complaint, complaint.createdAt]);
  return complaint;
}

async function addLostItem(payload) {
  const item = { id: payload.id || newId('lost'), createdAt: now(), status: 'open', ...payload };
  await query('INSERT INTO lost_items (id, order_id, data, created_at) VALUES ($1, $2, $3, $4)', [item.id, item.orderId || null, item, item.createdAt]);
  return item;
}

async function updateProfile(role, patch) {
  if (!['passenger', 'driver'].includes(role)) return null;
  return transaction(async (client) => {
    const existing = await client.query('SELECT data FROM profiles WHERE role = $1 FOR UPDATE', [role]);
    const base = role === 'passenger' ? passengerDefault : driverDefault;
    const profile = { ...base, ...(existing.rows[0]?.data || {}), ...patch };
    await client.query('INSERT INTO profiles (role, data, updated_at) VALUES ($1, $2, NOW()) ON CONFLICT (role) DO UPDATE SET data = EXCLUDED.data, updated_at = NOW()', [role, profile]);
    return profile;
  });
}

module.exports = { getState, createOrder, updateOrder, cancelOrder, addRating, addComplaint, addLostItem, updateProfile };
