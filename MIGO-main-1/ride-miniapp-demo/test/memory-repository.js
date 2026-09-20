/**
 * 测试专用：用内存模拟 repository.js（PostgreSQL 版）的行为。
 * 两份实现必须遵守同一套约定，test/scenarios.js 里的测试会分别在内存版和真实数据库上各跑一遍。
 */
const { HttpError } = require('../errors.js');
const { RULES, OPEN_STATUSES, ACTIVE_STATUSES, TRANSITIONS, newId } = require('../rules.js');

const copy = (value) => structuredClone(value);
const notFound = () => new HttpError(404, 'ORDER_NOT_FOUND', '订单不存在');
const badState = () => new HttpError(409, 'INVALID_STATE', '订单当前的状态不允许这个操作，请刷新后重试');

function createMemoryRepository() {
  const users = new Map();
  const sessions = new Map();
  const orders = new Map(); // id -> { status, passengerId, driverId, data, createdAt }
  const ratings = [];
  const complaints = [];
  const lostItems = [];
  const declines = new Set();
  let sequence = 0;

  const userByEmail = (email) => [...users.values()].find((u) => u.email.toLowerCase() === email.toLowerCase());
  const view = (user) => user && copy(user);
  const saveOrder = (row, patch) => { row.data = { ...row.data, ...patch }; row.status = row.data.status; return copy(row.data); };

  function transition(orderId, by, userId, action, patch) {
    const rule = TRANSITIONS[action];
    const row = orders.get(orderId);
    if (!row || row[by] !== userId) throw notFound();
    if (!rule.from.includes(row.status)) throw badState();
    return saveOrder(row, { ...patch, status: rule.to });
  }

  function completedOrder(user, orderId, now, windowMs, tooLate) {
    const row = orders.get(orderId);
    if (!row || row.passengerId !== user.id) throw notFound();
    if (row.status !== 'completed') throw new HttpError(409, 'ORDER_NOT_COMPLETED', '只有已完成的订单才能进行这个操作');
    if (now.getTime() - Date.parse(row.data.completedAt) > windowMs) throw new HttpError(409, 'WINDOW_CLOSED', tooLate);
  }

  return {
    async health() { return true; },

    async createUser(user) {
      if (userByEmail(user.email)) throw new HttpError(409, 'EMAIL_TAKEN', '这个邮箱已经注册过了，请直接登录');
      const stored = { ...copy(user), cancellationCount: 0, cancellationPeriod: '' };
      users.set(stored.id, stored);
      return view(stored);
    },
    async findUserByEmail(email) { return view(userByEmail(email)); },
    async approveDriver(email) {
      const user = userByEmail(email);
      if (!user || user.role !== 'driver') return false;
      user.approved = true;
      return true;
    },
    async createSession(userId, tokenHash, expiresAt) { sessions.set(tokenHash, { userId, expiresAt }); },
    async findSessionUser(tokenHash) {
      const session = sessions.get(tokenHash);
      if (!session || session.expiresAt.getTime() <= Date.now()) return null;
      return view(users.get(session.userId));
    },
    async deleteSession(tokenHash) { sessions.delete(tokenHash); },
    async purgeExpiredSessions() {},

    async listState(user, { period }) {
      const byNewest = (a, b) => b.seq - a.seq;
      const rows = [...orders.values()].sort(byNewest);
      if (user.role === 'passenger') {
        return {
          orders: rows.filter((r) => r.passengerId === user.id).map((r) => copy(r.data)),
          ratings: ratings.filter((r) => r.userId === user.id).map((r) => copy(r.data)).reverse(),
          complaints: complaints.filter((r) => r.userId === user.id).map((r) => copy(r.data)).reverse(),
          cancellationCount: user.cancellationPeriod === period ? user.cancellationCount : 0
        };
      }
      const canSeeOpen = user.approved && user.profile.online === true;
      const visible = rows.filter((r) => r.driverId === user.id
        || (canSeeOpen && !r.driverId && OPEN_STATUSES.includes(r.status) && !declines.has(`${r.data.id}|${user.id}`)));
      return { orders: visible.map((r) => copy(r.data)), ratings: [], complaints: [], cancellationCount: 0 };
    },

    async createOrder(user, order) {
      const open = [...orders.values()].filter((r) => r.passengerId === user.id && ACTIVE_STATUSES.includes(r.status)).length;
      if (open >= RULES.maxOpenOrders) throw new HttpError(409, 'TOO_MANY_OPEN_ORDERS', `未结束的订单已经有 ${RULES.maxOpenOrders} 个，请先完成或取消一些订单`);
      orders.set(order.id, { seq: ++sequence, status: order.status, passengerId: user.id, driverId: null, data: copy(order) });
      return copy(order);
    },

    async cancelOrder(user, orderId, { now, period, feeFor }) {
      const owner = users.get(user.id);
      const row = orders.get(orderId);
      if (!row || row.passengerId !== user.id) throw notFound();
      if (!TRANSITIONS.cancel.from.includes(row.status)) throw badState();
      const used = owner.cancellationPeriod === period ? owner.cancellationCount : 0;
      const result = saveOrder(row, { status: 'cancelled', cancellationFee: feeFor(row.data, used), cancelledAt: now.toISOString(), updatedAt: now.toISOString() });
      owner.cancellationCount = used + 1;
      owner.cancellationPeriod = period;
      return result;
    },

    async acceptOrder(user, orderId, { now }) {
      const me = users.get(user.id);
      if (!me.approved) throw new HttpError(403, 'NOT_APPROVED', '账号还没有通过审核，暂时不能接单');
      if (me.profile.online !== true) throw new HttpError(409, 'OFFLINE', '请先打开“接单中”开关');
      const busy = [...orders.values()].some((r) => r.driverId === me.id && ['accepted', 'in_progress'].includes(r.status));
      if (busy) throw new HttpError(409, 'ACTIVE_TRIP_EXISTS', '你还有未完成的行程，请先完成后再接新单');
      const row = orders.get(orderId);
      if (!row) throw notFound();
      if (row.driverId || !TRANSITIONS.accept.from.includes(row.status)) {
        throw new HttpError(409, 'ORDER_UNAVAILABLE', '这个订单已经被其他司机接走或已取消');
      }
      row.driverId = me.id;
      return saveOrder(row, {
        status: 'accepted', driverId: me.id, acceptedAt: now.toISOString(), updatedAt: now.toISOString(),
        driver: { name: me.name, car: me.profile.car || '', rating: me.profile.rating ?? 5, phone: me.profile.phone || '' }
      });
    },

    async declineOrder(user, orderId) {
      if (!user.approved) throw new HttpError(403, 'NOT_APPROVED', '账号还没有通过审核');
      const row = orders.get(orderId);
      if (!row) throw notFound();
      if (row.driverId || !OPEN_STATUSES.includes(row.status)) throw new HttpError(409, 'ORDER_UNAVAILABLE', '这个订单已经被其他司机接走或已取消');
      declines.add(`${orderId}|${user.id}`);
    },

    async startTrip(user, orderId, { now }) {
      return transition(orderId, 'driverId', user.id, 'start', { startedAt: now.toISOString(), updatedAt: now.toISOString() });
    },
    async completeTrip(user, orderId, { now }) {
      return transition(orderId, 'driverId', user.id, 'complete', { completedAt: now.toISOString(), updatedAt: now.toISOString() });
    },

    async setSafety(user, orderId, kind, { now }) {
      const row = orders.get(orderId);
      if (!row || row.passengerId !== user.id) throw notFound();
      if (row.status !== 'in_progress') throw badState();
      return saveOrder(row, kind === 'safe'
        ? { deviationAlert: false, passengerConfirmedSafeAt: now.toISOString(), updatedAt: now.toISOString() }
        : { deviationAlert: true, emergencyNotifiedAt: now.toISOString(), updatedAt: now.toISOString() });
    },

    async addRating(user, input, { now }) {
      completedOrder(user, input.orderId, now, RULES.ratingWindowMs, '已经超过行程结束后 24 小时，不能再评价了');
      if (ratings.some((r) => r.data.orderId === input.orderId)) throw new HttpError(409, 'ALREADY_RATED', '这个订单已经评价过了');
      const rating = { id: newId('rating'), orderId: input.orderId, score: input.score, comment: input.comment, createdAt: now.toISOString() };
      ratings.push({ userId: user.id, data: rating });
      return copy(rating);
    },
    async addComplaint(user, input, { now }) {
      completedOrder(user, input.orderId, now, RULES.complaintWindowMs, '已经超过行程结束后 7 天，不能再投诉了');
      const complaint = { id: newId('complaint'), orderId: input.orderId, reason: input.reason, description: input.description, status: 'received', createdAt: now.toISOString() };
      complaints.push({ userId: user.id, data: complaint });
      return copy(complaint);
    },
    async addLostItem(user, input, { now }) {
      completedOrder(user, input.orderId, now, RULES.lostItemWindowMs, '订单记录已经超过 1 个月，无法再登记失物');
      const item = { id: newId('lost'), orderId: input.orderId, description: input.description, status: 'open', createdAt: now.toISOString() };
      lostItems.push({ userId: user.id, data: item });
      return copy(item);
    },

    async updateProfile(user, patch) {
      const stored = users.get(user.id);
      if (patch.name) stored.name = patch.name;
      stored.profile = { ...stored.profile, ...patch.profile };
      return view(stored);
    }
  };
}

module.exports = { createMemoryRepository };
