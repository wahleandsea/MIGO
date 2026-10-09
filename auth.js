/**
 * 账号安全工具：密码加密、登录令牌、登录次数限制。
 * 只使用 Node 自带的 crypto，不需要额外安装依赖。
 */
const crypto = require('node:crypto');
const { promisify } = require('node:util');

const scrypt = promisify(crypto.scrypt);
const KEY_LENGTH = 64;

/** 密码永远不明文保存：每个用户一个随机盐，再用 scrypt 慢速加密。 */
async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const key = await scrypt(password, salt, KEY_LENGTH);
  return `scrypt$${salt.toString('hex')}$${key.toString('hex')}`;
}

async function verifyPassword(password, stored) {
  const [scheme, saltHex, keyHex] = String(stored || '').split('$');
  if (scheme !== 'scrypt' || !saltHex || !keyHex) return false;
  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return crypto.timingSafeEqual(actual, expected);
}

let dummyHash;
/** 邮箱不存在时也做一次同样耗时的计算，避免别人通过响应速度猜出哪些邮箱已注册。 */
async function verifyAgainstDummy(password) {
  dummyHash ||= await hashPassword('not-a-real-password');
  await verifyPassword(password, dummyHash);
}

/** 登录令牌：发给浏览器的是随机字符串，数据库里只存它的 SHA-256，数据库泄露也不能直接冒用。 */
function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function newToken() {
  const token = crypto.randomBytes(32).toString('base64url');
  return { token, tokenHash: hashToken(token) };
}

function readBearerToken(request) {
  const match = /^Bearer ([A-Za-z0-9_-]{20,200})$/.exec(request.headers.authorization || '');
  return match ? match[1] : null;
}

/** 简单的内存限流：同一个 key 在时间窗口内失败太多次就暂时拒绝。服务器重启后会清零。 */
function createLimiter({ max, windowMs, now = () => Date.now() }) {
  const entries = new Map();
  const live = (key) => {
    const entry = entries.get(key);
    if (entry && entry.resetAt > now()) return entry;
    entries.delete(key);
    return null;
  };
  return {
    blocked: (key) => (live(key)?.count ?? 0) >= max,
    fail(key) {
      const entry = live(key) || { count: 0, resetAt: now() + windowMs };
      entry.count += 1;
      entries.set(key, entry);
      if (entries.size > 10_000) for (const [k] of entries) live(k);
    },
    reset: (key) => { entries.delete(key); }
  };
}

module.exports = { hashPassword, verifyPassword, verifyAgainstDummy, hashToken, newToken, readBearerToken, createLimiter };
