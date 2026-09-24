/**
 * 业务规则（纯函数，不碰数据库）：输入校验、订单状态流转、生成订单、哪些数据能给谁看。
 * 这里的规则由服务器执行，网页里的按钮只是方便用户操作，不能作为安全依据。
 */
const crypto = require('node:crypto');
const { HttpError } = require('./errors.js');

const HOUR = 3_600_000;
const DAY = 24 * HOUR;

const RULES = {
  ratingWindowMs: DAY,            // 行程结束后 24 小时内可评价
  complaintWindowMs: 7 * DAY,     // 7 天内可投诉
  lostItemWindowMs: 30 * DAY,     // 失物记录保留 1 个月
  maxScheduleAheadMs: 90 * DAY,   // 最多预约 90 天以内
  maxOpenOrders: 5,               // 每位乘客同时最多 5 个未结束的订单，防止刷单
  sessionMs: 30 * DAY
};

const OPEN_STATUSES = ['matching', 'waiting_driver'];               // 还没有司机接的订单
const ACTIVE_STATUSES = [...OPEN_STATUSES, 'accepted', 'in_progress']; // 还没结束的订单
const ALL_STATUSES = [...ACTIVE_STATUSES, 'completed', 'cancelled'];

/** 订单状态流转表：谁（role）可以在什么状态（from）下做什么操作，结果是什么状态（to）。 */
const TRANSITIONS = {
  cancel: { role: 'passenger', from: ['matching', 'waiting_driver', 'accepted'], to: 'cancelled' },
  accept: { role: 'driver', from: ['matching', 'waiting_driver'], to: 'accepted' },
  start: { role: 'driver', from: ['accepted'], to: 'in_progress' },
  complete: { role: 'driver', from: ['in_progress'], to: 'completed' }
};

const ROUTE_IDS = ['balanced', 'fast', 'economy'];
const PAYMENT_METHODS = ['alipay', 'wechat'];
const CHARTER_KINDS = ['mxp', 'linate', 'half-day', 'full-day'];
const COMPLAINT_REASONS = ['司机不当行为', '路线问题', '费用问题', '其他问题'];

const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

const bad = (message, code = 'INVALID_INPUT') => new HttpError(400, code, message);
const newId = (prefix) => `${prefix}_${crypto.randomUUID()}`;

// ---------- 通用校验小工具 ----------

function ensureObject(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('请求内容不正确');
  return body;
}

function text(value, label, { min = 1, max }) {
  if (typeof value !== 'string') throw bad(`请填写${label}`);
  const cleaned = value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim();
  if (cleaned.length < min) throw bad(`请填写${label}`);
  if (cleaned.length > max) throw bad(`${label}不能超过 ${max} 个字符`);
  return cleaned;
}

function optionalText(value, label, max) {
  if (value === undefined || value === null || value === '') return '';
  return text(value, label, { min: 0, max });
}

function oneOf(value, list, label) {
  if (typeof value !== 'string' || !list.includes(value)) throw bad(`${label}不正确`);
  return value;
}

function emailAddress(value) {
  const email = text(value, '邮箱', { max: 254 }).toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw bad('邮箱格式不正确');
  return email;
}

function futureInstant(value, now) {
  // 必须带时区（网页会发送 UTC 时间），避免服务器所在时区不同导致时间对不上。
  if (typeof value !== 'string' || !ISO_WITH_ZONE.test(value)) throw bad('出发时间格式不正确');
  const time = Date.parse(value);
  if (!Number.isFinite(time)) throw bad('出发时间格式不正确');
  if (time <= now.getTime()) throw bad('出发时间必须晚于当前时间');
  if (time - now.getTime() > RULES.maxScheduleAheadMs) throw bad('最多只能预约 90 天以内的行程');
  return new Date(time).toISOString();
}

// ---------- 账号 ----------

function validateRegister(body) {
  const b = ensureObject(body);
  const role = oneOf(b.role, ['passenger', 'driver'], '账号类型');
  if (typeof b.password !== 'string' || b.password.length < 8) throw bad('密码至少需要 8 位');
  if (b.password.length > 128) throw bad('密码不能超过 128 个字符');
  const input = { role, email: emailAddress(b.email), password: b.password, name: text(b.name, '姓名', { max: 50 }) };
  if (role === 'driver') {
    input.phone = text(b.phone, '手机号', { min: 6, max: 30 });
    if (!/^[+()\d\s-]{6,30}$/.test(input.phone)) throw bad('手机号格式不正确');
    input.car = text(b.car, '车辆信息', { min: 2, max: 80 });
  }
  return input;
}

function validateLogin(body) {
  const b = ensureObject(body);
  if (typeof b.password !== 'string' || !b.password || b.password.length > 128) throw bad('请输入密码');
  return { email: emailAddress(b.email), password: b.password, role: oneOf(b.role, ['passenger', 'driver'], '账号类型') };
}

function defaultProfile(input) {
  if (input.role === 'passenger') return { verified: false };
  return {
    rating: 5, creditScore: 100, italianLicenseVerified: false, chinaIdVerified: false,
    online: false, car: input.car, phone: input.phone
  };
}

/** 返回给网页的账号信息（不含密码哈希）。 */
function presentUser(user) {
  return { id: user.id, role: user.role, name: user.name, email: user.email, approved: user.approved, ...user.profile };
}

function assertRole(user, role) {
  if (user.role !== role) {
    throw new HttpError(403, 'FORBIDDEN', role === 'driver' ? '此操作仅限司机账号' : '此操作仅限乘客账号');
  }
}

function validateProfilePatch(user, body) {
  const b = ensureObject(body);
  const allowed = user.role === 'driver' ? ['name', 'online'] : ['name', 'verified'];
  for (const key of Object.keys(b)) {
    if (!allowed.includes(key)) throw bad(`不支持修改这个字段：${key}`);
  }
  const patch = { profile: {} };
  if ('name' in b) patch.name = text(b.name, '姓名', { max: 50 });
  if ('online' in b) {
    if (typeof b.online !== 'boolean') throw bad('接单状态不正确');
    if (b.online && !user.approved) throw new HttpError(403, 'NOT_APPROVED', '账号还没有通过审核，暂时不能上线接单');
    patch.profile.online = b.online;
  }
  if ('verified' in b) {
    if (typeof b.verified !== 'boolean') throw bad('认证状态不正确');
    patch.profile.verified = b.verified;
  }
  return patch;
}

// ---------- 订单 ----------

function validateOrderRequest(body, now) {
  const b = ensureObject(body);
  const type = oneOf(b.type, ['now', 'scheduled', 'charter'], '订单类型');
  const request = { type, paymentMethod: oneOf(b.paymentMethod, PAYMENT_METHODS, '支付方式') };
  if (type === 'charter') {
    request.charterKind = oneOf(b.charterKind, CHARTER_KINDS, '包车类型');
    request.scheduledAt = b.scheduledAt === undefined || b.scheduledAt === null || b.scheduledAt === ''
      ? null : futureInstant(b.scheduledAt, now);
    return request;
  }
  request.pickup = text(b.pickup, '上车点', { max: 200 });
  request.destination = text(b.destination, '目的地', { max: 200 });
  // 距离目前由用户输入，服务器只能限制范围；接入地图后应由服务器按真实路线计算。
  if (typeof b.distanceKm !== 'number' || !Number.isFinite(b.distanceKm) || b.distanceKm < 1 || b.distanceKm > 200) {
    throw bad('预计距离需要在 1 到 200 公里之间');
  }
  request.distanceKm = b.distanceKm;
  request.routeId = oneOf(b.routeId, ROUTE_IDS, '路线');
  request.scheduledAt = type === 'scheduled' ? futureInstant(b.scheduledAt, now) : null;
  return request;
}

/** 由服务器生成订单：价格、路线、状态全部在这里决定，不接受网页传来的 fare / status / driver。 */
function buildOrder({ request, user, pricing, now, id = newId('ord') }) {
  const base = {
    id, createdAt: now.toISOString(), status: 'matching', type: request.type,
    paymentMethod: request.paymentMethod, scheduledAt: request.scheduledAt,
    passengerName: user.name, driver: null, driverId: null, deviationAlert: false
  };
  if (request.type === 'charter') {
    const airport = pricing.PRICING.airport[request.charterKind];
    const title = airport ? `${airport.label} 机场接送`
      : request.charterKind === 'half-day' ? '半日包车（4小时）' : '全日包车（8小时）';
    return {
      ...base, serviceLabel: title, pickup: '待与司机确认上车点',
      destination: airport ? airport.label : '包车行程待确认', distanceKm: null,
      routeLabel: '包车服务', fare: airport ? airport.price : 0, pricePending: !airport, charterKind: request.charterKind
    };
  }
  const route = pricing.makeRouteOptions(request.distanceKm).find((item) => item.id === request.routeId);
  return {
    ...base, serviceLabel: request.type === 'scheduled' ? '预约快车' : '即时快车',
    pickup: request.pickup, destination: request.destination, distanceKm: route.distanceKm,
    routeId: route.id, routeLabel: route.label, routeMinutes: route.minutes, fare: route.fare, pricePending: false
  };
}

/** 订单给不同的人看，内容不同：司机接单前看不到乘客姓名；乘客看不到司机的内部账号 ID。 */
function presentOrder(order, viewer) {
  const copy = { ...order };
  if (viewer.role === 'driver' && copy.driverId !== viewer.id) delete copy.passengerName;
  if (viewer.role === 'passenger') delete copy.driverId;
  return copy;
}

function validateSafety(body) {
  return { kind: oneOf(ensureObject(body).kind, ['safe', 'emergency'], '安全操作') };
}

// ---------- 评价 / 投诉 / 失物 ----------

function validateRating(body) {
  const b = ensureObject(body);
  if (!Number.isInteger(b.score) || b.score < 1 || b.score > 5) throw bad('评分需要是 1 到 5 的整数');
  return { orderId: text(b.orderId, '订单', { max: 100 }), score: b.score, comment: optionalText(b.comment, '评价内容', 500) };
}

function validateComplaint(body) {
  const b = ensureObject(body);
  return {
    orderId: text(b.orderId, '订单', { max: 100 }),
    reason: oneOf(b.reason, COMPLAINT_REASONS, '投诉类型'),
    description: text(b.description, '问题描述', { max: 1000 })
  };
}

function validateLostItem(body) {
  const b = ensureObject(body);
  return { orderId: text(b.orderId, '订单', { max: 100 }), description: text(b.description, '物品描述', { max: 500 }) };
}

/** 取消次数按“欧洲/罗马时区的自然月”统计，例如 2026-09。 */
function periodOf(date) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Rome', year: 'numeric', month: '2-digit' }).formatToParts(date);
  return `${parts.find((p) => p.type === 'year').value}-${parts.find((p) => p.type === 'month').value}`;
}

module.exports = {
  RULES, OPEN_STATUSES, ACTIVE_STATUSES, ALL_STATUSES, TRANSITIONS, ROUTE_IDS, PAYMENT_METHODS, CHARTER_KINDS, COMPLAINT_REASONS,
  newId, periodOf, assertRole, defaultProfile, presentUser, presentOrder, buildOrder,
  validateRegister, validateLogin, validateProfilePatch, validateOrderRequest, validateSafety,
  validateRating, validateComplaint, validateLostItem
};
