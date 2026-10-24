/**
 * MongoDB Atlas 连接层。连接串只从 .env 的 MONGO_URI 读取，绝不写进前端代码。
 *
 * 本机网络说明：当系统 UDP 53 DNS 被内网防火墙拦截（node 解析报 ECONNREFUSED）时，
 * 这里自动改用 DNS-over-HTTPS 完成 Atlas 的 SRV/TXT/A 解析，
 * 并用自定义 lookup 让驱动以“真实主机名 + 真实 IP”连接（保证 TLS SNI 与证书匹配）。
 *
 * 稳定性：DoH 走多个公网端点（Cloudflare → Google → 阿里 → 腾讯）依次回退，
 * 解析结果按 60 秒缓存；单一端点返回空/超时不会让连接中断。
 */
let client;

const DOH_ENDPOINTS = [
  'https://cloudflare-dns.com/dns-query',
  'https://dns.google/resolve',
  'https://dns.alidns.com/resolve',
  'https://doh.pub/dns-query'
];

function configured() {
  return Boolean(process.env.MONGO_URI && !String(process.env.MONGO_URI).includes('REPLACE_WITH_'));
}

// ---------- DNS-over-HTTPS 解析（多端点回退 + 缓存） ----------

const DNS_TYPES = { SRV: 33, TXT: 16, A: 1, AAAA: 28 };
const dnsCache = new Map(); // key: "name:type" → { at, answers }
const CACHE_TTL_MS = 60_000;

/** 依次尝试所有 DoH 端点；只接受“返回了对应类型真实答案”的结果，空 Answer 视为失败换下一个端点。 */
async function dohQuery(name, type) {
  let lastErr;
  for (const endpoint of DOH_ENDPOINTS) {
    try {
      const url = `${endpoint}?name=${encodeURIComponent(name)}&type=${type}`;
      const res = await fetch(url, {
        headers: { Accept: 'application/dns-json' },
        signal: AbortSignal.timeout(8_000)
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const body = await res.json();
      const answers = (body.Answer || []).filter((a) => a.type === DNS_TYPES[type]);
      if (answers.length) return answers;
      lastErr = new Error(`${endpoint} 返回空 Answer`);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('所有 DoH 端点均失败');
}

async function dohQueryCached(name, type) {
  const key = `${name}:${type}`;
  const hit = dnsCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MS) return hit.answers;
  const answers = await dohQuery(name, type);
  dnsCache.set(key, { at: Date.now(), answers });
  return answers;
}

let patched = false;
/** mongodb 驱动的 SRV/TXT 解析（dns.promises）改为走 DoH；全部端点失败时回退系统解析。 */
function patchDns() {
  if (patched) return;
  patched = true;
  const dns = require('node:dns');
  const originalSrv = dns.promises.resolveSrv.bind(dns.promises);
  const originalTxt = dns.promises.resolveTxt.bind(dns.promises);
  dns.promises.resolveSrv = async (name) => {
    const answers = await dohQueryCached(name, 'SRV').catch(() => []);
    if (!answers.length) return originalSrv(name);
    return answers.map((a) => {
      const [, , port, host] = a.data.split(/\s+/);
      return { priority: 0, weight: 0, port: Number(port), name: host };
    });
  };
  dns.promises.resolveTxt = async (name) => {
    const answers = await dohQueryCached(name, 'TXT').catch(() => []);
    if (!answers.length) return originalTxt(name);
    // 驱动期望 [[...chunks]]：record[0].join('') 拼接一条 TXT 记录的多个片段。
    return answers.map((a) => [String(a.data).replace(/^"|"$/g, '')]);
  };
}

async function dohResolve(hostname) {
  const answers = await dohQueryCached(hostname, 'A');
  const ips = answers.map((a) => a.data).filter((x) => /^\d{1,3}(\.\d{1,3}){3}$/.test(x));
  if (!ips.length) throw new Error(`DoH 无法解析 ${hostname} 的 A 记录`);
  return ips;
}

/** net.connect 自定义 lookup：DoH 解析真实 IP，驱动仍以主机名发起（TLS SNI 正确）。
 * 注意：Node ≥20 默认 autoSelectFamily，lookup 以 all 模式被调用，回调需返回 [{address, family}]。 */
function dohLookup(hostname, options, callback) {
  if (typeof options === 'function') { callback = options; options = {}; }
  dohResolve(hostname).then(
    (ips) => callback(null, ips.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }))),
    (err) => callback(err)
  );
}

async function getClient() {
  if (!configured()) {
    const error = new Error('DATABASE_NOT_CONFIGURED');
    error.code = 'DATABASE_NOT_CONFIGURED';
    throw error;
  }
  if (client) return client;
  patchDns(); // 必须在 require('mongodb') 之前：驱动延迟 require，patch 后其 dns.promises 调用走 DoH
  const { MongoClient } = require('mongodb');
  client = new MongoClient(process.env.MONGO_URI, {
    serverSelectionTimeoutMS: 10_000,
    connectTimeoutMS: 10_000,
    lookup: dohLookup
  });
  await client.connect();
  return client;
}

async function db() {
  const c = await getClient();
  return c.db(process.env.MONGO_DB || 'milano_ride');
}

async function closeClient() {
  if (client) {
    try { await client.close(); } catch { /* 忽略关闭失败 */ }
  }
  client = undefined;
}

module.exports = { configured, getClient, db, closeClient };
