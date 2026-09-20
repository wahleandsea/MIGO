/**
 * PostgreSQL 数据读写。规则：
 * 1. 所有 SQL 都用 $1、$2 参数，绝不拼接用户输入。
 * 2. 状态修改都写成 “UPDATE ... WHERE 状态符合”，让数据库来保证不会出现两个司机接同一单。
 * 3. 只做数据读写；价格、校验、谁能做什么由 rules.js / server.js 负责。
 * 订单完整内容仍存在 data(JSONB) 里，方便页面加字段；status、passenger_id、driver_id 是独立的列，用来查询和加锁。
 */
const { query, transaction, configured } = require('./database.js');
const { HttpError } = require('./errors.js');
const { RULES, OPEN_STATUSES, ACTIVE_STATUSES, TRANSITIONS, newId } = require('./rules.js');

const json = (value) => JSON.stringify(value);
const notFound = () => new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
const badState = () => new HttpError(409, 'INVALID_STATE', '订单当前的状态不允许这个操作，请刷新后重试');
const LIST_LIMIT = 200;

function rowToUser(row) {
  if (!row) return null;
  return {
    id: row.id, email: row.email, role: row.role, name: row.name, approved: row.approved,
    profile: row.profile || {}, passwordHash: row.password_hash,
    cancellationCount: row.cancellation_count, cancellationPeriod: row.cancellation_period
  };
}

async function health() {
  if (!configured()) return false;
  try {
    await query('SELECT 1');
    return true;
  } catch (error) {
    console.error('数据库健康检查失败：', error.message);
    return false;
  }
}

// ---------- 账号与登录状态 ----------

async function createUser(user) {
  try {
    const result = await query(
      `INSERT INTO users (id, email, password_hash, role, name, approved, profile)
       VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb) RETURNING *`,
      [user.id, user.email, user.passwordHash, user.role, user.name, user.approved, json(user.profile)]
    );
    return rowToUser(result.rows[0]);
  } catch (error) {
    if (error.code === '23505') throw new HttpError(409, 'EMAIL_TAKEN', '这个邮箱已经注册过了，请直接登录');
    throw error;
  }
}

async function findUserByEmail(email) {
  const result = await query('SELECT * FROM users WHERE LOWER(email) = LOWER($1)', [email]);
  return rowToUser(result.rows[0]);
}

/** 管理员批准司机（scripts/approve-driver.js 使用）。返回是否找到了这个司机。 */
async function approveDriver(email) {
  const result = await query("UPDATE users SET approved = TRUE, updated_at = NOW() WHERE role = 'driver' AND LOWER(email) = LOWER($1)", [email]);
  return result.rowCount > 0;
}

async function createSession(userId, tokenHash, expiresAt) {
  await query('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES ($1, $2, $3)', [tokenHash, userId, expiresAt]);
}

async function findSessionUser(tokenHash) {
  const result = await query(
    `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id
     WHERE s.token_hash = $1 AND s.expires_at > NOW()`,
    [tokenHash]
  );
  return rowToUser(result.rows[0]);
}

async function deleteSession(tokenHash) {
  await query('DELETE FROM sessions WHERE token_hash = $1', [tokenHash]);
}

async function purgeExpiredSessions() {
  await query('DELETE FROM sessions WHERE expires_at <= NOW()');
}

// ---------- 读取：每个人只能读到自己该看的数据 ----------

async function listState(user, { period }) {
  if (user.role === 'passenger') {
    const [orders, ratings, complaints] = await Promise.all([
      query('SELECT data FROM orders WHERE passenger_id = $1 ORDER BY created_at DESC LIMIT $2', [user.id, LIST_LIMIT]),
      query('SELECT data FROM ratings WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [user.id, LIST_LIMIT]),
      query('SELECT data FROM complaints WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2', [user.id, LIST_LIMIT])
    ]);
    return {
      orders: orders.rows.map((row) => row.data),
      ratings: ratings.rows.map((row) => row.data),
      complaints: complaints.rows.map((row) => row.data),
      cancellationCount: user.cancellationPeriod === period ? user.cancellationCount : 0
    };
  }
  // 司机：自己的订单 + （已审核且在线时）没人接、且自己没拒绝过的新订单。
  const canSeeOpen = user.approved && user.profile.online === true;
  const orders = await query(
    `SELECT o.data FROM orders o
     WHERE o.driver_id = $1
        OR ($2::boolean AND o.driver_id IS NULL AND o.status = ANY($3::text[])
            AND NOT EXISTS (SELECT 1 FROM order_declines d WHERE d.order_id = o.id AND d.driver_id = $1))
     ORDER BY o.created_at DESC LIMIT $4`,
    [user.id, canSeeOpen, OPEN_STATUSES, LIST_LIMIT]
  );
  return { orders: orders.rows.map((row) => row.data), ratings: [], complaints: [], cancellationCount: 0 };
}

// ---------- 订单：创建 / 取消 ----------

async function createOrder(user, order) {
  return transaction(async (client) => {
    // 先锁住这位乘客，避免同时提交多个订单绕过“最多 5 个未结束订单”的限制。
    await client.query('SELECT id FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    const open = await client.query(
      'SELECT COUNT(*)::int AS n FROM orders WHERE passenger_id = $1 AND status = ANY($2::text[])',
      [user.id, ACTIVE_STATUSES]
    );
    if (open.rows[0].n >= RULES.maxOpenOrders) {
      throw new HttpError(409, 'TOO_MANY_OPEN_ORDERS', `未结束的订单已经有 ${RULES.maxOpenOrders} 个，请先完成或取消一些订单`);
    }
    await client.query(
      'INSERT INTO orders (id, status, passenger_id, data, created_at, updated_at) VALUES ($1, $2, $3, $4::jsonb, $5, NOW())',
      [order.id, order.status, user.id, json(order), order.createdAt]
    );
    return order;
  });
}

async function cancelOrder(user, orderId, { now, period, feeFor }) {
  return transaction(async (client) => {
    const owner = await client.query('SELECT cancellation_count, cancellation_period FROM users WHERE id = $1 FOR UPDATE', [user.id]);
    const found = await client.query('SELECT status, data FROM orders WHERE id = $1 AND passenger_id = $2 FOR UPDATE', [orderId, user.id]);
    if (!found.rowCount) throw notFound();
    if (!TRANSITIONS.cancel.from.includes(found.rows[0].status)) throw badState();

    const used = owner.rows[0].cancellation_period === period ? owner.rows[0].cancellation_count : 0;
    const patch = { status: 'cancelled', cancellationFee: feeFor(found.rows[0].data, used), cancelledAt: now.toISOString(), updatedAt: now.toISOString() };
    const updated = await client.query(
      "UPDATE orders SET status = 'cancelled', data = data || $2::jsonb, updated_at = NOW() WHERE id = $1 RETURNING data",
      [orderId, json(patch)]
    );
    await client.query('UPDATE users SET cancellation_count = $2, cancellation_period = $3, updated_at = NOW() WHERE id = $1', [user.id, used + 1, period]);
    return updated.rows[0].data;
  });
}

// ---------- 订单：司机操作 ----------

async function acceptOrder(user, orderId, { now }) {
  return transaction(async (client) => {
    // 锁住这位司机：同一位司机同时点两次“接单”也只会成功一次。
    const me = rowToUser((await client.query('SELECT * FROM users WHERE id = $1 FOR UPDATE', [user.id])).rows[0]);
    if (!me.approved) throw new HttpError(403, 'NOT_APPROVED', '账号还没有通过审核，暂时不能接单');
    if (me.profile.online !== true) throw new HttpError(409, 'OFFLINE', '请先打开“接单中”开关');
    const busy = await client.query('SELECT 1 FROM orders WHERE driver_id = $1 AND status = ANY($2::text[]) LIMIT 1', [me.id, ['accepted', 'in_progress']]);
    if (busy.rowCount) throw new HttpError(409, 'ACTIVE_TRIP_EXISTS', '你还有未完成的行程，请先完成后再接新单');

    const patch = {
      status: 'accepted', driverId: me.id, acceptedAt: now.toISOString(), updatedAt: now.toISOString(),
      driver: { name: me.name, car: me.profile.car || '', rating: me.profile.rating ?? 5, phone: me.profile.phone || '' }
    };
    // 关键：只有“还没司机 + 还是待接单状态”时才会更新成功；后到的司机会更新 0 行。
    const result = await client.query(
      `UPDATE orders SET status = 'accepted', driver_id = $2, data = data || $3::jsonb, updated_at = NOW()
       WHERE id = $1 AND driver_id IS NULL AND status = ANY($4::text[]) RETURNING data`,
      [orderId, me.id, json(patch), TRANSITIONS.accept.from]
    );
    if (result.rowCount) return result.rows[0].data;
    const exists = await client.query('SELECT 1 FROM orders WHERE id = $1', [orderId]);
    if (!exists.rowCount) throw notFound();
    throw new HttpError(409, 'ORDER_UNAVAILABLE', '这个订单已经被其他司机接走或已取消');
  });
}

async function declineOrder(user, orderId) {
  if (!user.approved) throw new HttpError(403, 'NOT_APPROVED', '账号还没有通过审核');
  const order = await query('SELECT status, driver_id FROM orders WHERE id = $1', [orderId]);
  if (!order.rowCount) throw notFound();
  if (order.rows[0].driver_id || !OPEN_STATUSES.includes(order.rows[0].status)) {
    throw new HttpError(409, 'ORDER_UNAVAILABLE', '这个订单已经被其他司机接走或已取消');
  }
  await query('INSERT INTO order_declines (order_id, driver_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [orderId, user.id]);
}

/** 通用的状态流转：只有订单属于该用户、并且当前状态符合规则时才会更新。 */
async function transition(client, { orderId, by, userId, action, patch }) {
  if (by !== 'passenger_id' && by !== 'driver_id') throw new Error('invalid column');
  const rule = TRANSITIONS[action];
  const result = await client.query(
    `UPDATE orders SET status = $3, data = data || $4::jsonb, updated_at = NOW()
     WHERE id = $1 AND ${by} = $2 AND status = ANY($5::text[]) RETURNING data`,
    [orderId, userId, rule.to, json({ ...patch, status: rule.to }), rule.from]
  );
  if (result.rowCount) return result.rows[0].data;
  const exists = await client.query(`SELECT 1 FROM orders WHERE id = $1 AND ${by} = $2`, [orderId, userId]);
  throw exists.rowCount ? badState() : notFound();
}

const startTrip = (user, orderId, { now }) => transaction((client) => transition(client, {
  orderId, by: 'driver_id', userId: user.id, action: 'start', patch: { startedAt: now.toISOString(), updatedAt: now.toISOString() }
}));

const completeTrip = (user, orderId, { now }) => transaction((client) => transition(client, {
  orderId, by: 'driver_id', userId: user.id, action: 'complete', patch: { completedAt: now.toISOString(), updatedAt: now.toISOString() }
}));

async function setSafety(user, orderId, kind, { now }) {
  const patch = kind === 'safe'
    ? { deviationAlert: false, passengerConfirmedSafeAt: now.toISOString(), updatedAt: now.toISOString() }
    : { deviationAlert: true, emergencyNotifiedAt: now.toISOString(), updatedAt: now.toISOString() };
  const result = await query(
    "UPDATE orders SET data = data || $3::jsonb, updated_at = NOW() WHERE id = $1 AND passenger_id = $2 AND status = 'in_progress' RETURNING data",
    [orderId, user.id, json(patch)]
  );
  if (result.rowCount) return result.rows[0].data;
  const exists = await query('SELECT 1 FROM orders WHERE id = $1 AND passenger_id = $2', [orderId, user.id]);
  throw exists.rowCount ? badState() : notFound();
}

// ---------- 评价 / 投诉 / 失物 ----------

/** 订单必须属于该乘客、已完成，并且在允许的时间窗口内。 */
async function loadCompletedOrder(client, user, orderId, { now, windowMs, tooLate }) {
  const found = await client.query('SELECT status, data, updated_at FROM orders WHERE id = $1 AND passenger_id = $2', [orderId, user.id]);
  if (!found.rowCount) throw notFound();
  const row = found.rows[0];
  if (row.status !== 'completed') throw new HttpError(409, 'ORDER_NOT_COMPLETED', '只有已完成的订单才能进行这个操作');
  const completedAt = Date.parse(row.data.completedAt) || new Date(row.updated_at).getTime();
  if (now.getTime() - completedAt > windowMs) throw new HttpError(409, 'WINDOW_CLOSED', tooLate);
}

async function addRating(user, input, { now }) {
  return transaction(async (client) => {
    await loadCompletedOrder(client, user, input.orderId, { now, windowMs: RULES.ratingWindowMs, tooLate: '已经超过行程结束后 24 小时，不能再评价了' });
    const rating = { id: newId('rating'), orderId: input.orderId, score: input.score, comment: input.comment, createdAt: now.toISOString() };
    try {
      await client.query('INSERT INTO ratings (id, order_id, user_id, data, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [rating.id, rating.orderId, user.id, json(rating), rating.createdAt]);
    } catch (error) {
      if (error.code === '23505') throw new HttpError(409, 'ALREADY_RATED', '这个订单已经评价过了');
      throw error;
    }
    return rating;
  });
}

async function addComplaint(user, input, { now }) {
  return transaction(async (client) => {
    await loadCompletedOrder(client, user, input.orderId, { now, windowMs: RULES.complaintWindowMs, tooLate: '已经超过行程结束后 7 天，不能再投诉了' });
    const complaint = { id: newId('complaint'), orderId: input.orderId, reason: input.reason, description: input.description, status: 'received', createdAt: now.toISOString() };
    await client.query('INSERT INTO complaints (id, order_id, user_id, data, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [complaint.id, complaint.orderId, user.id, json(complaint), complaint.createdAt]);
    return complaint;
  });
}

async function addLostItem(user, input, { now }) {
  return transaction(async (client) => {
    await loadCompletedOrder(client, user, input.orderId, { now, windowMs: RULES.lostItemWindowMs, tooLate: '订单记录已经超过 1 个月，无法再登记失物' });
    const item = { id: newId('lost'), orderId: input.orderId, description: input.description, status: 'open', createdAt: now.toISOString() };
    await client.query('INSERT INTO lost_items (id, order_id, user_id, data, created_at) VALUES ($1, $2, $3, $4::jsonb, $5)', [item.id, item.orderId, user.id, json(item), item.createdAt]);
    return item;
  });
}

// ---------- 个人资料 ----------

async function updateProfile(user, patch) {
  const result = await query(
    'UPDATE users SET name = COALESCE($2, name), profile = profile || $3::jsonb, updated_at = NOW() WHERE id = $1 RETURNING *',
    [user.id, patch.name ?? null, json(patch.profile || {})]
  );
  return rowToUser(result.rows[0]);
}

module.exports = {
  health, createUser, findUserByEmail, approveDriver, createSession, findSessionUser, deleteSession, purgeExpiredSessions,
  listState, createOrder, cancelOrder, acceptOrder, declineOrder, startTrip, completeTrip, setSafety,
  addRating, addComplaint, addLostItem, updateProfile
};
