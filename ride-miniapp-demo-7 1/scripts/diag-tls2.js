// 修正版：用「分片域名」作为 SNI 直连分片 IP（与 mongo-database.js 真实连接方式一致）
const https = require('https');
const tls = require('tls');
const net = require('net');

const PAIRS = [
  ['ac-3izeimr-shard-00-00.ryeynab.mongodb.net', '65.62.241.105'],
  ['ac-3izeimr-shard-00-01.ryeynab.mongodb.net', '65.62.241.114'],
  ['ac-3izeimr-shard-00-02.ryeynab.mongodb.net', '65.62.241.124']
];

function probe(hostname, ip, port = 27017) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const s = tls.connect({
      host: hostname,
      servername: hostname,
      socket: net.connect({ host: ip, port }),
      rejectUnauthorized: false,
      timeout: 8000
    }, () => {
      resolve(`OK ${Date.now() - t0}ms`);
      s.end();
    });
    s.on('error', (e) => resolve(`FAIL ${Date.now() - t0}ms ${e.message.split('\n')[0]}`));
    s.on('timeout', () => { s.destroy(); resolve(`TIMEOUT ${Date.now() - t0}ms`); });
  });
}

(async () => {
  for (const [host, ip] of PAIRS) {
    console.log(`${host} (${ip}): ${await probe(host, ip)}`);
  }
  // 对照：无 SNI 校验的 raw TLS
  console.log('--- 对照：不指定 servername ---');
  for (const [host, ip] of PAIRS) {
    await new Promise((resolve) => {
      const t0 = Date.now();
      const s = tls.connect({ host: ip, socket: net.connect({ host: ip, port: 27017 }), rejectUnauthorized: false, timeout: 8000 },
        () => { console.log(`${ip}: OK ${Date.now() - t0}ms`); s.end(); resolve(); });
      s.on('error', (e) => { console.log(`${ip}: FAIL ${Date.now() - t0}ms ${e.message.split('\n')[0]}`); resolve(); });
      s.on('timeout', () => { s.destroy(); console.log(`${ip}: TIMEOUT`); resolve(); });
    });
  }
})();
