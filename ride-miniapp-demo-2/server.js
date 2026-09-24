try {
  require('dotenv').config();
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  // 未安装依赖时仍允许运行本机演示模式；数据库功能需要 npm.cmd install。
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { HttpError } = require('./errors.js');
const auth = require('./auth.js');
const rules = require('./rules.js');
const { loadPricing } = require('./pricing-loader.js');

const root = __dirname;
const MAX_BODY_BYTES = 64_000;
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'
};

// 【锁】是否限制网页服务器能下载的文件。
//   true  = 只公开下面白名单里的网页文件，.env、源码、数据库脚本、证书都下载不到；
//   false = 不限制（目前为了开发方便设为 false）。
// 全部做完、要部署到网上之前，请改回 true。
const LOCK_STATIC_FILES = false;

// 开启上面的锁时，只有下面这些文件/目录会作为网页公开（白名单，而不是黑名单）。
const PUBLIC_ROOT_FILES = new Set(['index.html']);
const PUBLIC_DIRS = new Set(['passenger-miniapp', 'driver-miniapp', 'src']);

const SECURITY_HEADERS = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'no-referrer' };

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...SECURITY_HEADERS });
  response.end(JSON.stringify(value));
}

function sendText(response, status, text) {
  response.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', ...SECURITY_HEADERS });
  response.end(text);
}

function apiError(response, error) {
  if (error instanceof HttpError) {
    sendJson(response, error.status, { error: error.code, message: error.message });
    return;
  }
  if (error?.code === 'DATABASE_NOT_CONFIGURED') {
    sendJson(response, 503, { error: 'DATABASE_NOT_CONFIGURED', message: '请按 README 配置 .env 后再使用 PostgreSQL。' });
    return;
  }
  console.error(error);
  sendJson(response, 500, { error: 'SERVER_ERROR', message: '服务器出错了，请稍后再试。开发者请查看 VS Code 终端。' });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    request.on('data', (chunk) => {
      if (size > MAX_BODY_BYTES) return; // 已超限并已拒绝：丢弃剩余数据，不再占用内存
      size += chunk.length;
      if (size > MAX_BODY_BYTES) { chunks.length = 0; reject(new HttpError(413, 'PAYLOAD_TOO_LARGE', '提交的内容太大')); return; }
      chunks.push(chunk);
    });
    request.on('end', () => {
      if (size > MAX_BODY_BYTES) return;
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body) { resolve({}); return; }
      try { resolve(JSON.parse(body)); } catch { reject(new HttpError(400, 'INVALID_JSON', '请求的 JSON 格式错误')); }
    });
    request.on('error', reject);
  });
}

/**
 * 创建服务器。repository（数据库读写）、pricing（计价）、clock（当前时间）都从外面传入，
 * 这样测试时可以换成内存版本，不需要真的数据库。
 */
function createApp({ repository, pricing, clock = () => new Date(), config = {} }) {
  const limiters = {
    login: auth.createLimiter({ max: config.loginLimit ?? 8, windowMs: 15 * 60_000 }),
    register: auth.createLimiter({ max: config.registerLimit ?? 10, windowMs: 60 * 60_000 })
  };
  const clientIp = (request) => request.socket.remoteAddress || 'unknown';
  const feeFor = (order, usedThisMonth) => pricing.roundMoney(Number(order.fare || 0) * pricing.cancellationFee(usedThisMonth));

  async function startSession(user) {
    const { token, tokenHash } = auth.newToken();
    const expiresAt = new Date(clock().getTime() + rules.RULES.sessionMs);
    await repository.createSession(user.id, tokenHash, expiresAt);
    repository.purgeExpiredSessions().catch(() => {});
    return { token, expiresAt: expiresAt.toISOString(), user: rules.presentUser(user) };
  }

  async function authenticate(request) {
    const token = auth.readBearerToken(request);
    if (!token) throw new HttpError(401, 'AUTH_REQUIRED', '请先登录');
    const tokenHash = auth.hashToken(token);
    const user = await repository.findSessionUser(tokenHash);
    if (!user) throw new HttpError(401, 'AUTH_REQUIRED', '登录已过期，请重新登录');
    return { user, tokenHash };
  }

  async function register(request) {
    const key = clientIp(request);
    if (limiters.register.blocked(key)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '注册太频繁了，请稍后再试');
    limiters.register.fail(key);
    const input = rules.validateRegister(await readJson(request));
    const user = await repository.createUser({
      id: rules.newId('usr'), email: input.email, passwordHash: await auth.hashPassword(input.password),
      role: input.role, name: input.name,
      // 乘客直接可用；司机默认需要审核（开发时可在 .env 设置 DRIVER_AUTO_APPROVE=true 跳过）。
      approved: input.role === 'passenger' || config.driverAutoApprove === true,
      profile: rules.defaultProfile(input)
    });
    return startSession(user);
  }

  async function login(request) {
    const input = rules.validateLogin(await readJson(request));
    const key = `${clientIp(request)}|${input.email}`;
    if (limiters.login.blocked(key)) throw new HttpError(429, 'TOO_MANY_ATTEMPTS', '登录失败次数太多，请 15 分钟后再试');
    const user = await repository.findUserByEmail(input.email);
    const ok = user ? await auth.verifyPassword(input.password, user.passwordHash) : (await auth.verifyAgainstDummy(input.password), false);
    if (!ok) {
      limiters.login.fail(key);
      throw new HttpError(401, 'INVALID_CREDENTIALS', '邮箱或密码不正确');
    }
    limiters.login.reset(key);
    if (user.role !== input.role) {
      const name = user.role === 'driver' ? '司机' : '乘客';
      throw new HttpError(403, 'WRONG_APP', `这个账号是${name}账号，请在${name}端登录`);
    }
    return startSession(user);
  }

  async function orderAction(request, user, orderId, action) {
    const now = clock();
    const present = (order) => rules.presentOrder(order, user);
    if (action === 'cancel') {
      rules.assertRole(user, 'passenger');
      return present(await repository.cancelOrder(user, orderId, { now, period: rules.periodOf(now), feeFor }));
    }
    if (action === 'safety') {
      rules.assertRole(user, 'passenger');
      const { kind } = rules.validateSafety(await readJson(request));
      return present(await repository.setSafety(user, orderId, kind, { now }));
    }
    rules.assertRole(user, 'driver');
    if (action === 'accept') return present(await repository.acceptOrder(user, orderId, { now }));
    if (action === 'decline') { await repository.declineOrder(user, orderId); return { ok: true }; }
    if (action === 'start') return present(await repository.startTrip(user, orderId, { now }));
    if (action === 'complete') return present(await repository.completeTrip(user, orderId, { now }));
    throw new HttpError(404, 'API_NOT_FOUND', '接口不存在');
  }

  async function handleApi(request, response, pathname) {
    const { method } = request;
    try {
      if (method === 'GET' && pathname === '/api/health') {
        const database = await repository.health();
        return sendJson(response, 200, { database, mode: database ? 'postgresql' : 'local-fallback' });
      }
      if (method === 'POST' && pathname === '/api/auth/register') return sendJson(response, 201, await register(request));
      if (method === 'POST' && pathname === '/api/auth/login') return sendJson(response, 200, await login(request));

      // ↓ 以下所有接口都必须先登录；用户身份来自登录令牌，而不是网页自己声称的。
      const { user, tokenHash } = await authenticate(request);

      if (method === 'POST' && pathname === '/api/auth/logout') {
        await repository.deleteSession(tokenHash);
        return sendJson(response, 200, { ok: true });
      }
      if (method === 'GET' && pathname === '/api/state') {
        const now = clock();
        const state = await repository.listState(user, { period: rules.periodOf(now) });
        return sendJson(response, 200, {
          me: rules.presentUser(user),
          profile: { [user.role]: { name: user.name, email: user.email, ...user.profile } },
          orders: state.orders.map((order) => rules.presentOrder(order, user)),
          ratings: state.ratings, complaints: state.complaints, cancellationCount: state.cancellationCount
        });
      }
      if (method === 'PATCH' && pathname === '/api/profile') {
        const updated = await repository.updateProfile(user, rules.validateProfilePatch(user, await readJson(request)));
        return sendJson(response, 200, { name: updated.name, email: updated.email, ...updated.profile });
      }
      if (method === 'POST' && pathname === '/api/orders') {
        rules.assertRole(user, 'passenger');
        const now = clock();
        const request_ = rules.validateOrderRequest(await readJson(request), now);
        const order = rules.buildOrder({ request: request_, user, pricing, now });
        return sendJson(response, 201, rules.presentOrder(await repository.createOrder(user, order), user));
      }
      const actionMatch = pathname.match(/^\/api\/orders\/([^/]{1,100})\/(cancel|accept|decline|start|complete|safety)$/);
      if (method === 'POST' && actionMatch) return sendJson(response, 200, await orderAction(request, user, actionMatch[1], actionMatch[2]));

      if (method === 'POST' && pathname === '/api/ratings') {
        rules.assertRole(user, 'passenger');
        return sendJson(response, 201, await repository.addRating(user, rules.validateRating(await readJson(request)), { now: clock() }));
      }
      if (method === 'POST' && pathname === '/api/complaints') {
        rules.assertRole(user, 'passenger');
        return sendJson(response, 201, await repository.addComplaint(user, rules.validateComplaint(await readJson(request)), { now: clock() }));
      }
      if (method === 'POST' && pathname === '/api/lost-items') {
        rules.assertRole(user, 'passenger');
        return sendJson(response, 201, await repository.addLostItem(user, rules.validateLostItem(await readJson(request)), { now: clock() }));
      }
      return sendJson(response, 404, { error: 'API_NOT_FOUND', message: '接口不存在' });
    } catch (error) {
      return apiError(response, error);
    }
  }

  return http.createServer(async (request, response) => {
    try {
      let pathname;
      try {
        // 畸形的 URL（例如 /%）或 Host 头会让下面抛错：返回 400，而不是让整个进程崩溃。
        pathname = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname);
      } catch {
        return sendText(response, 400, 'Bad request');
      }
      if (pathname.startsWith('/api/')) return await handleApi(request, response, pathname);
      return serveStatic(response, pathname, config.staticRoot || root, config.lockStaticFiles ?? LOCK_STATIC_FILES);
    } catch (error) {
      console.error(error);
      if (!response.headersSent) sendText(response, 500, 'Server error');
      else response.end();
    }
  });
}

function isPublicFile(relative) {
  if (!relative || path.isAbsolute(relative)) return false;
  const segments = relative.split(path.sep);
  // 任何以 . 开头的路径段（.env、.git、..）和空段一律拒绝。
  if (segments.some((segment) => segment === '' || segment.startsWith('.'))) return false;
  if (!Object.hasOwn(types, path.extname(relative).toLowerCase())) return false;
  return segments.length === 1 ? PUBLIC_ROOT_FILES.has(segments[0]) : PUBLIC_DIRS.has(segments[0]);
}

function isInsideRoot(relative) {
  return Boolean(relative) && !path.isAbsolute(relative) && !relative.split(path.sep).includes('..');
}

function serveStatic(response, pathname, staticRoot, lock) {
  if (pathname.includes('\0')) return sendText(response, 400, 'Bad request');
  let requested = pathname === '/' ? '/index.html' : pathname;
  // /passenger-miniapp/ 与 /driver-miniapp/ 自动返回各自独立入口页。
  if (requested.endsWith('/')) requested += 'index.html';
  const filePath = path.resolve(staticRoot, `.${requested}`);
  const relative = path.relative(staticRoot, filePath);
  // /passenger-miniapp（少了结尾斜杠）会让相对路径的 app.js 加载失败，所以补上斜杠。
  if (PUBLIC_DIRS.has(relative)) {
    response.writeHead(301, { Location: `/${relative}/` });
    response.end();
    return;
  }
  // 无论锁开不开，都不允许走出网站根目录（../）。
  if (!(lock ? isPublicFile(relative) : isInsideRoot(relative))) return sendText(response, 404, 'Not found');
  fs.readFile(filePath, (error, content) => {
    if (error) {
      const missing = error.code === 'ENOENT' || error.code === 'EISDIR';
      return sendText(response, missing ? 404 : 500, missing ? 'Not found' : 'Server error');
    }
    response.writeHead(200, { 'Content-Type': types[path.extname(filePath).toLowerCase()] || 'application/octet-stream', ...SECURITY_HEADERS });
    response.end(content);
  });
}

function start() {
  const { configured, closePool } = require('./database.js');
  const port = Number(process.env.PORT || 5173);
  // 默认只允许本机访问（localhost）；同一个 Wi-Fi 里的其他人访问不到。需要手机测试时可设置 HOST=0.0.0.0。
  const host = process.env.HOST || '127.0.0.1';
  const server = createApp({
    repository: require('./repository.js'),
    pricing: loadPricing(),
    config: { driverAutoApprove: process.env.DRIVER_AUTO_APPROVE === 'true' }
  });
  server.listen(port, host, () => {
    console.log(`Milano Ride is running at http://localhost:${port}`);
    console.log(configured() ? 'PostgreSQL：已配置，启动后将使用数据库（需要登录）。' : 'PostgreSQL：未配置，页面将自动使用本机演示数据（无需登录）。');
  });
  const shutdown = async () => { server.close(); await closePool(); };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) start();

module.exports = { createApp, isPublicFile };
