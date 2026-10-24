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
const ACTIVE_STATUSES = [...OPEN_STATUSES, 'accepted', 'arrived', 'onboard', 'in_progress']; // 还没结束的订单
const ALL_STATUSES = [...ACTIVE_STATUSES, 'completed', 'cancelled'];

/** 订单状态流转表：谁（role）可以在什么状态（from）下做什么操作，结果是什么状态（to）。 */
const TRANSITIONS = {
  cancel: { role: 'passenger', from: ['matching', 'waiting_driver', 'accepted', 'arrived'], to: 'cancelled' },
  accept: { role: 'driver', from: ['matching', 'waiting_driver'], to: 'accepted' },
  arrive: { role: 'driver', from: ['accepted'], to: 'arrived' },      // 司机到达上车点
  board: { role: 'driver', from: ['arrived'], to: 'onboard' },        // 客人已上车
  start: { role: 'driver', from: ['onboard'], to: 'in_progress' },
  complete: { role: 'driver', from: ['in_progress'], to: 'completed' }
};

const ROUTE_IDS = ['balanced', 'fast', 'economy'];
const PAYMENT_METHODS = ['alipay', 'wechat'];
const CHARTER_KINDS = ['mxp', 'linate', 'half-day', 'full-day'];
const COMPLAINT_REASONS = ['司机不当行为', '路线问题', '费用问题', '其他问题'];

// 邀请码：8 位字母+数字混合，去掉易混淆字符（0/O、1/I/L），避免用户输错。
const INVITE_CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const INVITE_CODE_LENGTH = 8;
const INVITE_REWARD_CENTS = 500; // 被邀请人获得 5 欧返现（余额，单位欧分）

/** 生成一个 8 位邀请码（crypto 随机，字母+数字）。 */
function generateInviteCode() {
  const bytes = crypto.randomBytes(INVITE_CODE_LENGTH);
  let code = '';
  for (let i = 0; i < INVITE_CODE_LENGTH; i += 1) code += INVITE_CODE_ALPHABET[bytes[i] % INVITE_CODE_ALPHABET.length];
  return code;
}

/** 校验“输入邀请码”请求：只接受非空字符串，规范化（大写 + 去空格）后交给仓库层查询。 */
function validateInviteApply(body) {
  const b = ensureObject(body);
  return { code: text(b.code, '邀请码', { min: 1, max: 20 }).toUpperCase().replace(/[^A-Z0-9]/g, '') };
}

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

// 可选坐标（客户端地理编码得到的上车点经纬度，用于计算司机到达时间）。缺省/空值返回 null。
function optionalCoordinate(value, label, min, max) {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw bad(`${label}不正确`);
  return Math.round(value * 1e6) / 1e6;
}

// 三条路线的真实距离（客户端由 OSRM 计算）：{ balanced: 8.8, fast: 9.5, economy: 8.1 }，缺省项回落用下单距离。
function validateRouteDistances(body) {
  const value = body.routeDistances;
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw bad('路线距离不正确');
  const out = {};
  for (const id of ROUTE_IDS) {
    const km = value[id];
    if (km === undefined || km === null) continue;
    if (typeof km !== 'number' || !Number.isFinite(km) || km < 1 || km > 200) throw bad('路线距离不正确');
    out[id] = Math.round(km * 10) / 10;
  }
  return out;
}

// 所选路线的地图几何（OSRM polyline6 字符串，用于司机端地图画线）；限制长度防止滥用。
function validateRoutePolyline(body) {
  const value = body.routePolyline;
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || value.length < 4 || value.length > 30000) throw bad('路线数据不正确');
  return value;
}

// 所选路线的真实行驶分钟数（1–600）。
function validateRouteMinutes(body) {
  const value = body.routeMinutes;
  if (value === undefined || value === null) return null;
  if (!Number.isInteger(value) || value < 1 || value > 600) throw bad('路线时长不正确');
  return value;
}

// 司机接单时可选携带“预计到达分钟数”（1–120 的整数）；不传返回 null。
function validateEta(body) {
  const b = ensureObject(body);
  if (b.etaMinutes === undefined || b.etaMinutes === null) return null;
  if (!Number.isInteger(b.etaMinutes) || b.etaMinutes < 1 || b.etaMinutes > 120) throw bad('司机预计到达时间不正确');
  return b.etaMinutes;
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
    online: false, car: input.car, phone: input.phone,
    // 司机认证资料与审核流转：none →(提交)→ pending →(通过) approved / (拒绝) rejected →(重新提交)→ pending
    docs: { status: 'none', submittedAt: null, reviewedAt: null, rejectReason: '', italianLicense: null, chinaId: null }
  };
}

/** 返回给网页的账号信息（不含密码哈希）。邀请码 / 推荐关系 / 余额随账号返回，供“我的”页展示与下单抵扣。 */
function presentUser(user) {
  return {
    id: user.id, role: user.role, name: user.name, email: user.email, approved: user.approved, ...user.profile,
    inviteCode: user.inviteCode || '', invitedBy: user.invitedBy || '', balanceCents: Number(user.balanceCents) || 0
  };
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
    const accountStatus = accountStatusOf(user);
    if (b.online && accountStatus === 'closed') throw new HttpError(403, 'ACCOUNT_CLOSED', '账号已被关闭：不符合平台规定');
    if (b.online && accountStatus === 'suspended') throw new HttpError(403, 'ACCOUNT_SUSPENDED', '使用权限已暂停，请联系平台');
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
  request.pickupLat = optionalCoordinate(b.pickupLat, '上车点坐标', -90, 90);
  request.pickupLon = optionalCoordinate(b.pickupLon, '上车点坐标', -180, 180);
  request.routeDistances = validateRouteDistances(b);
  request.routePolyline = validateRoutePolyline(b);
  request.routeMinutes = validateRouteMinutes(b);
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
    pickupLat: request.pickupLat ?? null, pickupLon: request.pickupLon ?? null,
    passengerName: user.name, driver: null, driverId: null, deviationAlert: false
  };
  // 平台抽成：乘客付 fare，其中 platformFee 归平台、driverEarnings 归司机。
  const feeSplit = typeof pricing.splitFare === 'function'
    ? (fare) => ({ platformFee: pricing.splitFare(fare).platformFee, driverEarnings: pricing.splitFare(fare).driverEarnings })
    : () => ({ platformFee: 0, driverEarnings: 0 });
  if (request.type === 'charter') {
    const airport = pricing.PRICING.airport[request.charterKind];
    const title = airport ? `${airport.label} 机场接送`
      : request.charterKind === 'half-day' ? '半日包车（4小时）' : '全日包车（8小时）';
    const fare = airport ? airport.price : 0;
    return {
      ...base, serviceLabel: title, pickup: '待与司机确认上车点',
      destination: airport ? airport.label : '包车行程待确认', distanceKm: null,
      routeLabel: '包车服务', fare, pricePending: !airport, charterKind: request.charterKind,
      ...feeSplit(fare)
    };
  }
  const template = pricing.makeRouteOptions(request.distanceKm).find((item) => item.id === request.routeId);
  // 有真实路线距离时按各自距离计价；否则沿用“下单距离 × 路线系数”的旧逻辑（与测试/兜底一致）。
  const realKm = request.routeDistances?.[request.routeId];
  const routeKm = typeof realKm === 'number' ? realKm : template.distanceKm;
  const fare = pricing.routeFare(template.id, routeKm);
  return {
    ...base, serviceLabel: request.type === 'scheduled' ? '预约快车' : '即时快车',
    pickup: request.pickup, destination: request.destination, distanceKm: routeKm,
    routeId: template.id, routeLabel: template.label,
    routeMinutes: typeof request.routeMinutes === 'number' ? request.routeMinutes : template.minutes,
    fare, pricePending: false,
    routePolyline: request.routePolyline ?? null,
    ...feeSplit(fare)
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

// 中国居民身份证号：18 位 = 17 位数字 + 1 位数字或 X（做格式校验，真实核验由后台人工完成）。
const CHINA_ID_RE = /^\d{17}[\dXx]$/;

/** 司机提交认证资料（意大利驾照 + 中国身份证 + 手机/车辆 + 两张证件照片）。 */
function validateDriverApplication(body) {
  const b = ensureObject(body);
  const phone = text(b.phone, '手机号', { min: 6, max: 30 });
  if (!/^[+()\d\s-]{6,30}$/.test(phone)) throw bad('手机号格式不正确');
  const car = text(b.car, '车辆信息', { min: 2, max: 80 });
  const licenseNumber = text(b.italianLicense?.number, '意大利驾照号码', { min: 5, max: 30 });
  if (!/^[A-Za-z0-9-]{5,30}$/.test(licenseNumber)) throw bad('意大利驾照号码格式不正确');
  const expiry = text(b.italianLicense?.expiry, '驾照有效期', { min: 7, max: 10 });
  if (!/^\d{4}-\d{2}(-\d{2})?$/.test(expiry)) throw bad('驾照有效期格式应为 YYYY-MM');
  const chinaId = text(b.chinaId?.number, '中国身份证号', { min: 18, max: 18 });
  if (!CHINA_ID_RE.test(chinaId)) throw bad('中国身份证号需要是 18 位（17 位数字 + 校验位数字或 X）');
  const licensePhoto = photo(b.italianLicense?.photo, '意大利驾照照片');
  const chinaIdPhoto = photo(b.chinaId?.photo, '中国身份证照片');
  return {
    phone, car,
    italianLicense: { number: licenseNumber.toUpperCase(), expiry, photo: licensePhoto },
    chinaId: { number: chinaId.toUpperCase(), photo: chinaIdPhoto }
  };
}

// 证件照片：data URL 形式的 JPG/PNG/WebP，最长 4MB（真实上线应走对象存储并做证件核验）。
const PHOTO_RE = /^data:image\/(png|jpe?g|webp);base64,[A-Za-z0-9+/=]+$/;
function photo(value, label) {
  const dataUrl = text(value, label, { min: 22, max: 4_200_000 });
  if (!PHOTO_RE.test(dataUrl)) throw bad(`${label}需要是 JPG/PNG/WebP 图片`);
  return dataUrl;
}

/** 后台审核司机：通过或拒绝（拒绝必须给原因）。 */
function validateDriverReview(body) {
  const b = ensureObject(body);
  const action = oneOf(b.action, ['approve', 'reject'], '审核操作');
  if (action === 'reject') return { action, reason: text(b.reason, '拒绝原因', { min: 1, max: 200 }) };
  return { action };
}

/** 后台管理司机账号：暂停使用权限 / 强制关闭（不符合平台规定）/ 恢复。 */
function validateDriverAccountAction(body) {
  const b = ensureObject(body);
  const action = oneOf(b.action, ['suspend', 'close', 'restore'], '账号操作');
  return { action };
}

/** 司机账号状态：active 正常 / suspended 暂停使用 / closed 强制关闭。 */
function accountStatusOf(user) {
  return user.profile?.accountStatus || 'active';
}

// 微信一键登录（只校验授权码非空；真实环境应由微信开放平台用 code 换 openid）。
function validateWechatLogin(body) {
  const b = ensureObject(body);
  if (typeof b.code !== 'string' || !b.code.trim() || b.code.length > 200) throw bad('微信授权失败，请重试');
  return { code: b.code.trim(), role: oneOf(b.role, ['passenger', 'driver'], '账号类型') };
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
  INVITE_CODE_ALPHABET, INVITE_CODE_LENGTH, INVITE_REWARD_CENTS, generateInviteCode, validateInviteApply,
  newId, periodOf, assertRole, defaultProfile, presentUser, presentOrder, buildOrder,
  validateRegister, validateLogin, validateProfilePatch, validateOrderRequest, validateSafety, validateEta, validateRouteDistances, validateRoutePolyline, validateRouteMinutes,
  validateRating, validateComplaint, validateLostItem, validateWechatLogin, validateDriverApplication, validateDriverReview, validateDriverAccountAction, accountStatusOf
};
