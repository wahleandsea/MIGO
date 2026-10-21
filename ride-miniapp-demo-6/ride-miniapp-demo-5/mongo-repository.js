/**
 * MongoDB Atlas 数据读写（替代 repository.js 的 PostgreSQL 版）。
 * 规则与 PostgreSQL 版一致：
 * 1. 所有查询都用参数/变量组装，绝不拼接用户输入（MongoDB 查询本身就是结构化对象，不存在 SQL 拼接面）。
 * 2. 状态修改都用“条件更新（findOneAndUpdate / updateOne 带状态条件）”，让数据库保证不会出现两个司机接同一单。
 * 3. 只做数据读写；价格、校验、谁能做什么由 rules.js / server.js 负责。
 * 订单完整内容存在 data 字段里，方便页面加字段；status、passengerId、driverId 是独立字段，用来查询和加锁。
 */
const { db } = require('./mongo-database.js');
const { HttpError } = require('./errors.js');
const { RULES, OPEN_STATUSES, ACTIVE_STATUSES, TRANSITIONS, newId, generateInviteCode, INVITE_REWARD_CENTS } = require('./rules.js');

const notFound = () => new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
const badState = () => new HttpError(409, 'INVALID_STATE', '订单当前的状态不允许这个操作，请刷新后重试');
const LIST_LIMIT = 200;

const copy = (value) => JSON.parse(JSON.stringify(value));
const dupKey = (error) => error && error.code === 11000;

function docToUser(doc) {
  if (!doc) return null;
  return {
    id: doc._id, email: doc.email, role: doc.role, name: doc.name, approved: doc.approved,
    profile: doc.profile || {}, passwordHash: doc.passwordHash,
    cancellationCount: doc.cancellationCount, cancellationPeriod: doc.cancellationPeriod,
    inviteCode: doc.inviteCode || '', invitedBy: doc.invitedBy || '', balanceCents: Number(doc.balanceCents) || 0
  };
}

/** 首次使用前创建唯一索引（MongoDB 无建表概念，索引负责唯一性与查询性能）。 */
let readyPromise;
function ready() {
  if (readyPromise) return readyPromise;
  readyPromise = (async () => {
    const d = await db();
    const users = d.collection('users');
    const sessions = d.collection('sessions');
    const orders = d.collection('orders');
    const ratings = d.collection('ratings');
    const complaints = d.collection('complaints');
    const lostItems = d.collection('lost_items');
    const declines = d.collection('order_declines');
    await users.createIndex({ email: 1 }, { unique: true });
    await users.createIndex({ inviteCode: 1 }, { unique: true, sparse: true }); // 8 位邀请码全局唯一；老账号无邀请码时允许缺失
    await sessions.createIndex({ tokenHash: 1 }, { unique: true });
    await orders.createIndex({ passengerId: 1, seq: -1 });
    await orders.createIndex({ driverId: 1, seq: -1 });
    await orders.createIndex({ status: 1, seq: -1 });
    await ratings.createIndex({ orderId: 1, userId: 1 }, { unique: true });
    await complaints.createIndex({ orderId: 1, userId: 1 }, { unique: true });
    await lostItems.createIndex({ orderId: 1, userId: 1 }, { unique: true });
    await declines.createIndex({ orderId: 1, driverId: 1 }, { unique: true });
    await orders.createIndex({ seq: -1 });
  })().catch((error) => { readyPromise = undefined; throw error; });
  return readyPromise;
}

async function nextSeq() {
  const d = await db();
  const counter = await d.collection('counters').findOneAndUpdate(
    { _id: 'order_seq' },
    { $inc: { value: 1 } },
    { upsert: true, returnDocument: 'after' }
  );
  return (counter && counter.value) || 1;
}

async function health() {
  if (!require('./mongo-database.js').configured()) return false;
  try {
    await ready();
    await (await db()).command({ ping: 1 });
    return true;
  } catch (error) {
    console.error('MongoDB 健康检查失败：', error.message);
    return false;
  }
}

// ---------- 账号与登录状态 ----------

async function createUser(user) {
  await ready();
  const stored = {
    _id: user.id, email: user.email, passwordHash: user.passwordHash, role: user.role,
    name: user.name, approved: user.approved, profile: copy(user.profile || {}),
    cancellationCount: 0, cancellationPeriod: '', balanceCents: 0, invitedBy: '',
    createdAt: new Date()
  };
  // 每个账号分配一个唯一的 8 位邀请码；撞码（极小概率）时重试生成。
  const users = (await db()).collection('users');
  const emailTaken = await users.findOne({ email: stored.email });
  if (emailTaken) throw new HttpError(409, 'EMAIL_TAKEN', '这个邮箱已经注册过了，请直接登录');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    stored.inviteCode = generateInviteCode();
    try {
      await users.insertOne(stored);
      return docToUser(stored);
    } catch (error) {
      if (!dupKey(error)) throw error;
      if (attempt === 4) throw error; // 5 次都撞码：当作唯一性失败上报
    }
  }
  throw new HttpError(500, 'INVITE_CODE_FAILED', '邀请码生成失败，请重试');
}

async function findUserByEmail(email) {
  await ready();
  const doc = await (await db()).collection('users').findOne({ email: String(email || '').toLowerCase() });
  return docToUser(doc);
}

/** 给存量老账号补发唯一 8 位邀请码（老账号在邀请码功能上线前注册，没有该字段）。成功返回邀请码，5 次撞码返回 null。 */
async function ensureInviteCode(userId) {
  await ready();
  const users = (await db()).collection('users');
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const code = generateInviteCode();
    try {
      const result = await users.updateOne(
        { _id: userId, inviteCode: { $in: [null, ''] } },
        { $set: { inviteCode: code } }
      );
      if (result.modifiedCount > 0) return code;
      return null; // 已有邀请码，无需补发
    } catch (error) {
      if (!dupKey(error)) throw error;
      // 撞码：换一个再试
    }
  }
  return null;
}

/** 输入邀请码 → 绑定推荐关系 + 给被邀请人发放 5 欧返现（余额，欧分）。 */
async function applyInvite(user, code) {
  await ready();
  const d = await db();
  const normalized = String(code || '').trim().toUpperCase();
  if (!/^[A-Z0-9]{8}$/.test(normalized)) {
    throw new HttpError(400, 'INVITE_CODE_INVALID', '邀请码需要是 8 位字母或数字');
  }
  const me = await d.collection('users').findOne({ _id: user.id });
  if (!me) throw notFound();
  if (me.invitedBy) throw new HttpError(409, 'ALREADY_INVITED', '你已经绑定过邀请码，不能重复使用');
  if (me.inviteCode === normalized) throw new HttpError(400, 'SELF_INVITE', '不能使用自己的邀请码');
  const inviter = await d.collection('users').findOne({ inviteCode: normalized });
  if (!inviter) throw new HttpError(404, 'INVITE_NOT_FOUND', '这个邀请码不存在，请检查后重试');
  // 条件更新保证原子性：只有尚未绑定时才会成功，避免并发重复领取。
  const updated = await d.collection('users').findOneAndUpdate(
    { _id: user.id, invitedBy: { $in: [null, ''] } },
    { $set: { invitedBy: inviter._id }, $inc: { balanceCents: INVITE_REWARD_CENTS } },
    { returnDocument: 'after' }
  );
  if (!updated) throw new HttpError(409, 'ALREADY_INVITED', '你已经绑定过邀请码，不能重复使用');
  return docToUser(updated);
}

/** 管理员批准司机（scripts/approve-driver.js 使用）。返回是否找到了这个司机。 */
async function approveDriver(email) {
  await ready();
  const result = await (await db()).collection('users').updateOne(
    { role: 'driver', email: String(email || '').toLowerCase() },
    {
      $set: {
        approved: true,
        'profile.docs.status': 'approved',
        'profile.docs.reviewedAt': new Date().toISOString(),
        'profile.docs.rejectReason': '',
        'profile.italianLicenseVerified': true,
        'profile.chinaIdVerified': true
      }
    }
  );
  return result.matchedCount > 0;
}

/** 后台审核用：按 docs.status 列出司机（status 为空表示“全部已提交认证的”：待审核 + 已通过 + 已拒绝，未提交资料的不展示）。 */
async function listDrivers(status = null) {
  await ready();
  const filter = { role: 'driver' };
  // 已提交认证的司机才有 docs.status（pending / approved / rejected）；只登录未提交资料的不进入后台列表。
  filter['profile.docs.status'] = status || { $in: ['pending', 'approved', 'rejected'] };
  const docs = await (await db()).collection('users').find(filter).sort({ createdAt: -1 }).limit(LIST_LIMIT).toArray();
  return docs.map(docToUser);
}

/** 后台审核司机：通过或拒绝（拒绝带原因），并把资料核验标志同步到 profile。 */
async function reviewDriver(driverId, { action, reason, reviewedAt }) {
  await ready();
  const nowIso = (reviewedAt || new Date()).toISOString();
  const approved = action === 'approve';
  const result = await (await db()).collection('users').findOneAndUpdate(
    { _id: driverId, role: 'driver' },
    {
      $set: {
        approved,
        'profile.docs.status': approved ? 'approved' : 'rejected',
        'profile.docs.reviewedAt': nowIso,
        'profile.docs.rejectReason': approved ? '' : (reason || ''),
        'profile.italianLicenseVerified': approved,
        'profile.chinaIdVerified': approved
      }
    },
    { returnDocument: 'after' }
  );
  if (!result) throw new HttpError(404, 'DRIVER_NOT_FOUND', '没有找到这个司机');
  return docToUser(result);
}

/** 后台管理司机账号：suspend 暂停使用 / close 强制关闭（不符合平台规定）/ restore 恢复。暂停与关闭同时强制下线。 */
async function setDriverAccountStatus(driverId, action, { now }) {
  await ready();
  const accountStatus = action === 'close' ? 'closed' : action === 'suspend' ? 'suspended' : 'active';
  const setFields = { 'profile.accountStatus': accountStatus };
  if (action !== 'restore') setFields['profile.online'] = false;
  const result = await (await db()).collection('users').findOneAndUpdate(
    { _id: driverId, role: 'driver' },
    { $set: setFields },
    { returnDocument: 'after' }
  );
  if (!result) throw new HttpError(404, 'DRIVER_NOT_FOUND', '没有找到这个司机');
  return docToUser(result);
}

/** 后台删除司机账号：只在“已强制关闭（closed）”状态才允许删除，从数据库抹除用户记录及其全部会话。 */
async function deleteDriver(driverId) {
  await ready();
  const d = await db();
  // 先确认存在且处于 closed：防止误删正常/暂停中的账号。
  const target = await d.collection('users').findOne({ _id: driverId, role: 'driver' });
  if (!target) throw new HttpError(404, 'DRIVER_NOT_FOUND', '没有找到这个司机');
  if (target.profile?.accountStatus !== 'closed') {
    throw new HttpError(409, 'NOT_CLOSED', '只有已强制关闭的账号才能删除');
  }
  await d.collection('users').deleteOne({ _id: driverId });
  await d.collection('sessions').deleteMany({ userId: driverId });
  return { ok: true, deletedId: driverId };
}

async function createSession(userId, tokenHash, expiresAt) {
  await ready();
  await (await db()).collection('sessions').insertOne({ tokenHash, userId, expiresAt: new Date(expiresAt) });
}

async function findSessionUser(tokenHash) {
  await ready();
  const d = await db();
  const session = await d.collection('sessions').findOne({ tokenHash, expiresAt: { $gt: new Date() } });
  if (!session) return null;
  const doc = await d.collection('users').findOne({ _id: session.userId });
  return docToUser(doc);
}

async function deleteSession(tokenHash) {
  await ready();
  await (await db()).collection('sessions').deleteOne({ tokenHash });
}

async function purgeExpiredSessions() {
  await ready();
  await (await db()).collection('sessions').deleteMany({ expiresAt: { $lte: new Date() } });
}

// ---------- 读取：每个人只能读到自己该看的数据 ----------

async function listState(user, { period }) {
  await ready();
  const d = await db();
  if (user.role === 'passenger') {
    const [orders, ratings, complaints] = await Promise.all([
      d.collection('orders').find({ passengerId: user.id }).sort({ seq: -1 }).limit(LIST_LIMIT).toArray(),
      d.collection('ratings').find({ userId: user.id }).sort({ seq: -1 }).limit(LIST_LIMIT).toArray(),
      d.collection('complaints').find({ userId: user.id }).sort({ seq: -1 }).limit(LIST_LIMIT).toArray()
    ]);
    return {
      orders: orders.map((row) => row.data),
      ratings: ratings.map((row) => row.data),
      complaints: complaints.map((row) => row.data),
      cancellationCount: user.cancellationPeriod === period ? user.cancellationCount : 0
    };
  }
  // 司机：自己的订单 + （已审核且在线时）没人接、且自己没拒绝过的新订单。
  const canSeeOpen = user.approved && user.profile.online === true;
  const declined = new Set(
    (await d.collection('order_declines').find({ driverId: user.id }).toArray()).map((row) => row.orderId)
  );
  const mine = await d.collection('orders').find({ driverId: user.id }).sort({ seq: -1 }).limit(LIST_LIMIT).toArray();
  const open = canSeeOpen
    ? (await d.collection('orders').find({
        driverId: null,
        status: { $in: OPEN_STATUSES },
        id: { $nin: [...declined] }
      }).sort({ seq: -1 }).limit(LIST_LIMIT).toArray())
    : [];
  const rows = [...open, ...mine];
  return { orders: rows.map((row) => row.data), ratings: [], complaints: [], cancellationCount: 0 };
}

// ---------- 订单：创建 / 取消 ----------

/** 创建订单。discountCents：用账户余额抵扣的部分（由 server 按当前余额算出）；抵扣后订单实付 payableCents = fare - discount。 */
async function createOrder(user, order, { discountCents = 0 } = {}) {
  await ready();
  const d = await db();
  const open = await d.collection('orders').countDocuments({
    passengerId: user.id, status: { $in: ACTIVE_STATUSES }
  });
  if (open >= RULES.maxOpenOrders) {
    throw new HttpError(409, 'TOO_MANY_OPEN_ORDERS', `未结束的订单已经有 ${RULES.maxOpenOrders} 个，请先完成或取消一些订单`);
  }
  // 只有订单价格已确定（非待报价）才允许抵扣；余额不足时按实际余额抵扣。
  let discount = 0;
  if (Number.isFinite(order.fare) && order.fare > 0 && !order.pricePending) {
    const me = await d.collection('users').findOne({ _id: user.id });
    const balance = Number(me?.balanceCents) || 0;
    discount = Math.min(balance, Math.round(order.fare * 100));
    if (discount > 0) {
      // 条件扣减：余额足够才扣；扣减失败（余额被并发花掉）则本次不抵扣。
      const deducted = await d.collection('users').updateOne(
        { _id: user.id, balanceCents: { $gte: discount } },
        { $inc: { balanceCents: -discount } }
      );
      if (deducted.matchedCount !== 1) discount = 0;
    }
  }
  const orderWithDiscount = discount > 0
    ? { ...order, discountCents: discount, payableCents: Math.max(0, Math.round(order.fare * 100) - discount) }
    : { ...order, discountCents: 0, payableCents: order.pricePending ? null : Math.round(order.fare * 100) };
  const doc = {
    _id: order.id, id: order.id, status: order.status, passengerId: user.id, driverId: null,
    data: copy(orderWithDiscount), seq: await nextSeq(), createdAt: new Date(), updatedAt: new Date()
  };
  await d.collection('orders').insertOne(doc);
  return copy(orderWithDiscount);
}

async function cancelOrder(user, orderId, { now, period, feeFor }) {
  await ready();
  const d = await db();
  const row = await d.collection('orders').findOne({ _id: orderId, passengerId: user.id });
  if (!row) throw notFound();
  if (!TRANSITIONS.cancel.from.includes(row.status)) throw badState();

  const owner = await d.collection('users').findOne({ _id: user.id });
  const used = owner && owner.cancellationPeriod === period ? owner.cancellationCount : 0;
  const patch = { status: 'cancelled', cancellationFee: feeFor(row.data, used), cancelledAt: now.toISOString(), updatedAt: now.toISOString() };
  await d.collection('orders').updateOne({ _id: orderId, passengerId: user.id }, {
    $set: { status: 'cancelled', data: { ...row.data, ...patch }, updatedAt: new Date() }
  });
  await d.collection('users').updateOne({ _id: user.id }, {
    $set: { cancellationCount: used + 1, cancellationPeriod: period }
  });
  // 下单时用余额抵扣过的部分，取消订单时退回账户余额。
  const usedDiscount = Number(row.data?.discountCents) || 0;
  if (usedDiscount > 0) {
    await d.collection('users').updateOne({ _id: user.id }, { $inc: { balanceCents: usedDiscount } });
  }
  return { ...row.data, ...patch };
}

// ---------- 订单：司机操作 ----------

async function acceptOrder(user, orderId, { now, etaMinutes }) {
  await ready();
  const d = await db();
  const me = await d.collection('users').findOne({ _id: user.id });
  if (!me) throw notFound();
  if (!me.approved) throw new HttpError(403, 'NOT_APPROVED', '账号还没有通过审核，暂时不能接单');
  if (me.profile.online !== true) throw new HttpError(409, 'OFFLINE', '请先打开“接单中”开关');
  const busy = await d.collection('orders').findOne({
    driverId: me.id, status: { $in: ['accepted', 'arrived', 'onboard', 'in_progress'] }
  });
  if (busy) throw new HttpError(409, 'ACTIVE_TRIP_EXISTS', '你还有未完成的行程，请先完成后再接新单');

  const patch = {
    status: 'accepted', driverId: me.id, acceptedAt: now.toISOString(), updatedAt: now.toISOString(),
    ...(Number.isInteger(etaMinutes) ? { etaMinutes } : {}),
    driver: { name: me.name, car: me.profile.car || '', rating: me.profile.rating ?? 5, phone: me.profile.phone || '' }
  };
  // 关键：只有“还没司机 + 还是待接单状态”时才会更新成功；后到的司机匹配 0 条。
  const result = await d.collection('orders').findOneAndUpdate(
    { _id: orderId, driverId: null, status: { $in: TRANSITIONS.accept.from } },
    { $set: { status: 'accepted', driverId: me.id, data: { ...(await orderData(orderId)), ...patch }, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (result) return result.data;
  const exists = await d.collection('orders').findOne({ _id: orderId });
  if (!exists) throw notFound();
  throw new HttpError(409, 'ORDER_UNAVAILABLE', '这个订单已经被其他司机接走或已取消');
}

/** 读取订单当前 data（条件更新前合并用；订单在 open 状态下字段基本固定，读旧值合并可接受）。 */
async function orderData(orderId) {
  const row = await (await db()).collection('orders').findOne({ _id: orderId });
  return row ? row.data : {};
}

async function declineOrder(user, orderId) {
  await ready();
  if (!user.approved) throw new HttpError(403, 'NOT_APPROVED', '账号还没有通过审核');
  const d = await db();
  const order = await d.collection('orders').findOne({ _id: orderId });
  if (!order) throw notFound();
  if (order.driverId || !OPEN_STATUSES.includes(order.status)) {
    throw new HttpError(409, 'ORDER_UNAVAILABLE', '这个订单已经被其他司机接走或已取消');
  }
  try {
    await d.collection('order_declines').insertOne({ orderId, driverId: user.id });
  } catch (error) {
    if (!dupKey(error)) throw error; // 已拒绝过则忽略
  }
}

/** 通用的状态流转：只有订单属于该用户、并且当前状态符合规则时才会更新。 */
async function transition({ orderId, by, userId, action, patch }) {
  await ready();
  if (by !== 'passengerId' && by !== 'driverId') throw new Error('invalid field');
  const rule = TRANSITIONS[action];
  const d = await db();
  const before = await d.collection('orders').findOne({ _id: orderId, [by]: userId });
  if (!before) throw notFound();
  if (!rule.from.includes(before.status)) throw badState();
  const next = { ...before.data, ...patch, status: rule.to, updatedAt: new Date().toISOString() };
  const result = await d.collection('orders').findOneAndUpdate(
    { _id: orderId, [by]: userId, status: { $in: rule.from } },
    { $set: { status: rule.to, data: next, updatedAt: new Date() } },
    { returnDocument: 'after' }
  );
  if (result) return result.data;
  const exists = await d.collection('orders').findOne({ _id: orderId, [by]: userId });
  throw exists ? badState() : notFound();
}

const startTrip = (user, orderId, { now }) => transition({
  orderId, by: 'driverId', userId: user.id, action: 'start', patch: { startedAt: now.toISOString(), updatedAt: now.toISOString() }
});
const arriveTrip = (user, orderId, { now }) => transition({
  orderId, by: 'driverId', userId: user.id, action: 'arrive', patch: { arrivedAt: now.toISOString(), updatedAt: now.toISOString() }
});
const boardTrip = (user, orderId, { now }) => transition({
  orderId, by: 'driverId', userId: user.id, action: 'board', patch: { boardedAt: now.toISOString(), updatedAt: now.toISOString() }
});
const completeTrip = (user, orderId, { now }) => transition({
  orderId, by: 'driverId', userId: user.id, action: 'complete', patch: { completedAt: now.toISOString(), updatedAt: now.toISOString() }
});

async function setSafety(user, orderId, kind, { now }) {
  await ready();
  const patch = kind === 'safe'
    ? { deviationAlert: false, passengerConfirmedSafeAt: now.toISOString(), updatedAt: now.toISOString() }
    : { deviationAlert: true, emergencyNotifiedAt: now.toISOString(), updatedAt: now.toISOString() };
  const d = await db();
  const before = await d.collection('orders').findOne({ _id: orderId, passengerId: user.id });
  if (!before) throw notFound();
  if (before.status !== 'in_progress') throw badState();
  const next = { ...before.data, ...patch };
  await d.collection('orders').updateOne({ _id: orderId, passengerId: user.id }, {
    $set: { data: next, updatedAt: new Date() }
  });
  return next;
}

// ---------- 评价 / 投诉 / 失物 ----------

/** 订单必须属于该乘客、已完成，并且在允许的时间窗口内。 */
async function loadCompletedOrder(user, orderId, { now, windowMs, tooLate }) {
  const row = await (await db()).collection('orders').findOne({ _id: orderId, passengerId: user.id });
  if (!row) throw notFound();
  if (row.status !== 'completed') throw new HttpError(409, 'ORDER_NOT_COMPLETED', '只有已完成的订单才能进行这个操作');
  const completedAt = Date.parse(row.data.completedAt) || row.updatedAt.getTime();
  if (now.getTime() - completedAt > windowMs) throw new HttpError(409, 'WINDOW_CLOSED', tooLate);
}

async function addRating(user, input, { now }) {
  await ready();
  await loadCompletedOrder(user, input.orderId, { now, windowMs: RULES.ratingWindowMs, tooLate: '已经超过行程结束后 24 小时，不能再评价了' });
  const rating = { id: newId('rating'), orderId: input.orderId, score: input.score, comment: input.comment, createdAt: now.toISOString() };
  try {
    await (await db()).collection('ratings').insertOne({ _id: rating.id, orderId: rating.orderId, userId: user.id, data: rating, seq: await nextSeq(), createdAt: new Date() });
  } catch (error) {
    if (dupKey(error)) throw new HttpError(409, 'ALREADY_RATED', '这个订单已经评价过了');
    throw error;
  }
  return rating;
}

async function addComplaint(user, input, { now }) {
  await ready();
  await loadCompletedOrder(user, input.orderId, { now, windowMs: RULES.complaintWindowMs, tooLate: '已经超过行程结束后 7 天，不能再投诉了' });
  const complaint = { id: newId('complaint'), orderId: input.orderId, reason: input.reason, description: input.description, status: 'received', createdAt: now.toISOString() };
  await (await db()).collection('complaints').insertOne({ _id: complaint.id, orderId: complaint.orderId, userId: user.id, data: complaint, seq: await nextSeq(), createdAt: new Date() });
  return complaint;
}

async function addLostItem(user, input, { now }) {
  await ready();
  await loadCompletedOrder(user, input.orderId, { now, windowMs: RULES.lostItemWindowMs, tooLate: '订单记录已经超过 1 个月，无法再登记失物' });
  const item = { id: newId('lost'), orderId: input.orderId, description: input.description, status: 'open', createdAt: now.toISOString() };
  await (await db()).collection('lost_items').insertOne({ _id: item.id, orderId: item.orderId, userId: user.id, data: item, seq: await nextSeq(), createdAt: new Date() });
  return item;
}

// ---------- 个人资料 ----------

async function updateProfile(user, patch) {
  await ready();
  const setFields = {};
  if (patch.name != null) setFields.name = patch.name;
  for (const [key, value] of Object.entries(patch.profile || {})) setFields[`profile.${key}`] = value;
  const result = await (await db()).collection('users').findOneAndUpdate(
    { _id: user.id },
    { $set: setFields },
    { returnDocument: 'after' }
  );
  return docToUser(result);
}

/** 司机提交认证资料：回到“待审核”，清掉旧的拒绝状态。 */
async function submitDriverApplication(user, input, { now }) {
  await ready();
  const profilePatch = {
    phone: input.phone, car: input.car,
    italianLicenseVerified: false, chinaIdVerified: false,
    docs: {
      status: 'pending', submittedAt: now.toISOString(), reviewedAt: null, rejectReason: '',
      italianLicense: input.italianLicense, chinaId: input.chinaId
    }
  };
  const setFields = { approved: false };
  for (const [key, value] of Object.entries(profilePatch)) setFields[`profile.${key}`] = value;
  const result = await (await db()).collection('users').findOneAndUpdate(
    { _id: user.id },
    { $set: setFields },
    { returnDocument: 'after' }
  );
  return docToUser(result);
}

module.exports = {
  health, createUser, findUserByEmail, ensureInviteCode, applyInvite, approveDriver, listDrivers, reviewDriver, setDriverAccountStatus, deleteDriver, createSession, findSessionUser, deleteSession, purgeExpiredSessions,
  listState, createOrder, cancelOrder, acceptOrder, declineOrder, arriveTrip, boardTrip, startTrip, completeTrip, setSafety,
  addRating, addComplaint, addLostItem, updateProfile, submitDriverApplication
};
