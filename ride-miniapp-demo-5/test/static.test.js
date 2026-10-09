// 静态文件服务器：只能下载网页需要的文件，不能下载 .env、源码、数据库脚本；畸形请求不会让服务器崩溃。
// 假的密码文件只放在系统临时目录里，不会碰你的项目文件夹。
const { describe, it, before, after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { createMemoryRepository } = require('./memory-repository.js');
const { startTestServer } = require('./helpers.js');

describe('静态文件与畸形请求（开启锁）', () => {
  let temp;       // 临时目录：里面放了假的密码文件和源码，用来证明它们下载不到
  let sandbox;    // 使用临时目录作为网站根目录的服务器
  let real;       // 使用真实项目目录的服务器
  let open;       // 锁关闭时的服务器（LOCK_STATIC_FILES = false）
  before(async () => {
    temp = fs.mkdtempSync(path.join(os.tmpdir(), 'migo-static-'));
    const files = {
      '.env': 'DATABASE_URL=postgres://demo:FAKE_PASSWORD@localhost/db\n', 'certs/aiven-ca.pem': 'fake', 'server.js': '// secret source',
      'database.js': '// secret', 'repository.js': '// secret', 'package.json': '{}', 'db/schema.sql': '-- sql', 'README.md': '# readme',
      'scripts/migrate.js': '//', 'test/api.test.js': '//', '.git/config': '[core]',
      'index.html': '<h1>ok</h1>', 'passenger-miniapp/index.html': '<h1>ok</h1>', 'passenger-miniapp/app.js': '//ok', 'src/styles.css': '/*ok*/'
    };
    for (const [file, content] of Object.entries(files)) {
      const full = path.join(temp, file);
      fs.mkdirSync(path.dirname(full), { recursive: true });
      fs.writeFileSync(full, content);
    }
    sandbox = await startTestServer(createMemoryRepository(), { config: { staticRoot: temp, lockStaticFiles: true } });
    real = await startTestServer(createMemoryRepository(), { config: { lockStaticFiles: true } });
    open = await startTestServer(createMemoryRepository(), { config: { staticRoot: temp, lockStaticFiles: false } });
  });
  after(async () => {
    await sandbox.close();
    await real.close();
    await open.close();
    fs.rmSync(temp, { recursive: true, force: true });
  });

  const status = async (server, pathname) => (await fetch(server.baseUrl + pathname, { redirect: 'manual' })).status;
  // fetch 会自动整理 /../ 和 %2e%2e，这里用原始 socket 发送，才能真正测到路径穿越和畸形请求
  function rawStatus(server, rawPath, host = 'localhost') {
    const port = Number(new URL(server.baseUrl).port);
    return new Promise((resolve, reject) => {
      const socket = net.connect(port, '127.0.0.1', () => socket.write(`GET ${rawPath} HTTP/1.1\r\nHost: ${host}\r\nConnection: close\r\n\r\n`));
      let data = '';
      socket.on('data', (chunk) => { data += chunk; });
      socket.on('end', () => resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(data)?.[1])));
      socket.on('error', reject);
    });
  }

  it('密码文件、源码、数据库脚本即使真的存在，也都不能下载', async () => {
    for (const p of ['/.env', '/certs/aiven-ca.pem', '/server.js', '/database.js', '/repository.js', '/package.json', '/db/schema.sql',
      '/README.md', '/scripts/migrate.js', '/test/api.test.js', '/.git/config', '/SERVER.JS', '/passenger-miniapp/../.env']) {
      assert.equal(await status(sandbox, p), 404, p);
    }
  });

  it('路径穿越（../、%2e%2e）都拿不到内容', async () => {
    for (const p of ['/src/../.env', '/%2e%2e/server.js', '/src/%2e%2e/.env', '/..%2f.env', '/src/..%5c..%5c.env', '/passenger-miniapp/%2e%2e/.env']) {
      assert.notEqual(await rawStatus(sandbox, p), 200, p);
    }
  });

  it('网页文件可以正常访问（临时目录与真实项目目录）', async () => {
    for (const p of ['/', '/index.html', '/passenger-miniapp/', '/passenger-miniapp/app.js', '/src/styles.css']) assert.equal(await status(sandbox, p), 200, `临时目录 ${p}`);
    for (const p of ['/', '/index.html', '/passenger-miniapp/', '/driver-miniapp/', '/passenger-miniapp/app.js', '/driver-miniapp/app.js', '/driver-miniapp/styles.css', '/src/styles.css']) {
      assert.equal(await status(real, p), 200, `项目目录 ${p}`);
    }
    assert.equal(await status(real, '/passenger-miniapp'), 301);
  });

  it('真实项目目录里的敏感文件也不能下载', async () => {
    for (const p of ['/.env', '/.env.example', '/server.js', '/rules.js', '/auth.js', '/repository.js', '/package.json', '/db/schema.sql', '/scripts/approve-driver.js']) {
      assert.equal(await status(real, p), 404, p);
    }
  });

  it('畸形请求返回 400，服务器不会崩溃', async () => {
    assert.equal(await rawStatus(real, '/%'), 400);
    assert.equal(await rawStatus(real, '/%00'), 400);
    assert.equal(await rawStatus(real, '/api/orders/%zz/cancel'), 400);
    assert.equal(await rawStatus(real, '/', 'a b'), 400);
    assert.equal(await status(real, '/api/health'), 200); // 依然活着
  });

  it('接口带有安全响应头', async () => {
    const response = await fetch(`${real.baseUrl}/api/health`);
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.deepEqual(await response.json(), { database: true, mode: 'postgresql' });
  });

  it('锁关闭时不限制文件，但仍然不能走出网站根目录', async () => {
    assert.equal(await status(open, '/.env'), 200);
    assert.equal(await status(open, '/server.js'), 200);
    assert.equal(await status(open, '/index.html'), 200);
    for (const p of ['/%2e%2e/%2e%2e/etc/passwd', '/src/%2e%2e/%2e%2e/secret.txt', '/..%2f..%2fetc%2fpasswd']) {
      assert.notEqual(await rawStatus(open, p), 200, p);
    }
  });
});
