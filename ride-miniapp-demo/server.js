try {
  require('dotenv').config();
} catch (error) {
  if (error.code !== 'MODULE_NOT_FOUND') throw error;
  // 未安装依赖时仍允许运行本机演示模式；数据库功能需要 npm.cmd install。
}

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { configured, query, closePool } = require('./database.js');
const repository = require('./repository.js');

const root = __dirname;
const port = Number(process.env.PORT || 5173);
const types = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml'
};

function sendJson(response, status, value) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(value));
}

function apiError(response, error) {
  if (error?.code === 'DATABASE_NOT_CONFIGURED') {
    sendJson(response, 503, { error: 'DATABASE_NOT_CONFIGURED', message: '请按 README 配置 .env 后再使用 PostgreSQL。' });
    return;
  }
  console.error(error);
  sendJson(response, 500, { error: 'DATABASE_ERROR', message: '数据库操作失败，请查看 VS Code 终端。' });
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let body = '';
    request.on('data', (chunk) => {
      size += chunk.length;
      if (size > 1_000_000) { reject(new Error('请求数据过大')); request.destroy(); return; }
      body += chunk;
    });
    request.on('end', () => {
      if (!body) resolve({});
      else try { resolve(JSON.parse(body)); } catch { reject(new Error('请求 JSON 格式错误')); }
    });
    request.on('error', reject);
  });
}

async function handleApi(request, response, pathname) {
  if (request.method === 'GET' && pathname === '/api/health') {
    if (!configured()) return sendJson(response, 200, { database: false, mode: 'local-fallback' });
    try { await query('SELECT 1'); return sendJson(response, 200, { database: true, mode: 'postgresql' }); }
    catch (error) { return apiError(response, error); }
  }
  try {
    if (request.method === 'GET' && pathname === '/api/state') return sendJson(response, 200, await repository.getState());
    if (request.method === 'POST' && pathname === '/api/orders') return sendJson(response, 201, await repository.createOrder(await readJson(request)));
    if (request.method === 'POST' && pathname === '/api/ratings') return sendJson(response, 201, await repository.addRating(await readJson(request)));
    if (request.method === 'POST' && pathname === '/api/complaints') return sendJson(response, 201, await repository.addComplaint(await readJson(request)));
    if (request.method === 'POST' && pathname === '/api/lost-items') return sendJson(response, 201, await repository.addLostItem(await readJson(request)));

    const orderMatch = pathname.match(/^\/api\/orders\/([^/]+)$/);
    if (request.method === 'PATCH' && orderMatch) {
      const order = await repository.updateOrder(decodeURIComponent(orderMatch[1]), await readJson(request));
      return order ? sendJson(response, 200, order) : sendJson(response, 404, { error: 'ORDER_NOT_FOUND' });
    }
    const cancelMatch = pathname.match(/^\/api\/orders\/([^/]+)\/cancel$/);
    if (request.method === 'POST' && cancelMatch) {
      const order = await repository.cancelOrder(decodeURIComponent(cancelMatch[1]));
      return order ? sendJson(response, 200, order) : sendJson(response, 404, { error: 'ORDER_NOT_FOUND' });
    }
    const profileMatch = pathname.match(/^\/api\/profiles\/(passenger|driver)$/);
    if (request.method === 'PATCH' && profileMatch) return sendJson(response, 200, await repository.updateProfile(profileMatch[1], await readJson(request)));
    return sendJson(response, 404, { error: 'API_NOT_FOUND' });
  } catch (error) {
    return apiError(response, error);
  }
}

function serveStatic(response, pathname) {
  let requested = pathname === '/' ? '/index.html' : pathname;
  // /passenger-miniapp/ 与 /driver-miniapp/ 自动返回各自独立入口页。
  if (requested.endsWith('/')) requested += 'index.html';
  const filePath = path.resolve(root, `.${requested}`);
  if (!filePath.startsWith(root + path.sep) && filePath !== path.join(root, 'index.html')) {
    response.writeHead(403); response.end('Forbidden'); return;
  }
  fs.readFile(filePath, (error, content) => {
    if (error) { response.writeHead(error.code === 'ENOENT' ? 404 : 500); response.end(error.code === 'ENOENT' ? 'Not found' : 'Server error'); return; }
    response.writeHead(200, { 'Content-Type': types[path.extname(filePath)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    response.end(content);
  });
}

const server = http.createServer(async (request, response) => {
  const pathname = decodeURIComponent(new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`).pathname);
  if (pathname.startsWith('/api/')) return handleApi(request, response, pathname);
  return serveStatic(response, pathname);
});

server.listen(port, () => {
  console.log(`Milano Ride is running at http://localhost:${port}`);
  console.log(configured() ? 'PostgreSQL：已配置，启动后将使用数据库。' : 'PostgreSQL：未配置，页面将自动使用本机演示数据。');
});

async function shutdown() { server.close(); await closePool(); }
process.on('SIGINT', shutdown); process.on('SIGTERM', shutdown);
