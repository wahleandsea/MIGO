// 诊断：Atlas 连接被拒（alert 80）的根因排查
// 1) DoH 解析 cluster 域名 + SRV
// 2) 对每个分片 IP 做 TLS 握手（27017）
// 3) 对照测试普通 HTTPS 站点（确认基础网络正常）
const https = require('https');
const tls = require('tls');
const net = require('net');

const HOST = 'migo.ryeynab.mongodb.net';

function dohQuery(type) {
  const host = type === 'A' ? 'A' : 'SRV';
  const qname = type === 'A' ? HOST : `_mongodb._tcp.${HOST}`;
  return new Promise((resolve) => {
    https.get(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(qname)}&type=${type}`, {
      headers: { accept: 'application/dns-json' },
      timeout: 10000
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          const answers = (j.Answer || [])
            .filter((a) => a.type === (type === 'A' ? 1 : 33))
            .map((a) => a.data);
          resolve({ ok: true, answers });
        } catch (e) { resolve({ ok: false, error: e.message }); }
      });
    }).on('error', (e) => resolve({ ok: false, error: e.message }));
  });
}

function tlsProbe(ip, port = 27017) {
  return new Promise((resolve) => {
    const started = Date.now();
    const socket = tls.connect({
      host: HOST, // SNI
      servername: HOST,
      socket: net.connect({ host: ip, port }),
      rejectUnauthorized: false,
      timeout: 8000
    }, () => {
      resolve({ ok: true, ms: Date.now() - started });
      socket.end();
    });
    socket.on('error', (e) => resolve({ ok: false, error: e.message, ms: Date.now() - started }));
    socket.on('timeout', () => { socket.destroy(); resolve({ ok: false, error: 'timeout', ms: Date.now() - started }); });
  });
}

async function main() {
  console.log('=== 1) DoH 解析 ===');
  const a = await dohQuery('A');
  const srv = await dohQuery('SRV');
  console.log('A 记录:', JSON.stringify(a));
  console.log('SRV 记录:', JSON.stringify(srv));

  console.log('\n=== 2) 对照：普通 HTTPS 站点（基础网络） ===');
  for (const h of ['www.google.com', 'cloud.mongodb.com']) {
    await new Promise((resolve) => {
      const t = Date.now();
      https.get(`https://${h}`, { timeout: 8000 }, (res) => {
        console.log(`  ${h}: OK (${Date.now() - t}ms, status=${res.statusCode})`);
        res.destroy(); resolve();
      }).on('error', (e) => {
        console.log(`  ${h}: FAIL ${e.message}`);
        resolve();
      });
    });
  }

  console.log('\n=== 3) Atlas 分片 IP TLS 握手（27017） ===');
  const ips = [];
  const srvAnswers = srv.answers || [];
  const targets = [...new Set(srvAnswers.map((s) => s.replace(/^.*?\./, '')))];
  // SRV data 形如 "0 0 27017 ac-xxx-shard-00-00.ryeynab.mongodb.net."，取最后一段主机名
  const hosts = srvAnswers.map((s) => {
    const parts = s.trim().split(/\s+/);
    return parts[parts.length - 1].replace(/\.$/, '');
  }).filter(Boolean);
  console.log('SRV 目标主机:', hosts);

  if (hosts.length) {
    for (const h of hosts) {
      const aRes = await dohQuery('A');
      // DoH 按 h 查
      const ipRes = await new Promise((resolve) => {
        https.get(`https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(h)}&type=A`, {
          headers: { accept: 'application/dns-json' }, timeout: 10000
        }, (res) => {
          let d = '';
          res.on('data', (c) => (d += c));
          res.on('end', () => {
            try { resolve(JSON.parse(d).Answer?.filter((x) => x.type === 1).map((x) => x.data) || []); }
            catch { resolve([]); }
          });
        }).on('error', () => resolve([]));
      });
      for (const ip of ipRes) {
        const r = await tlsProbe(ip);
        console.log(`  ${h} (${ip}): ${r.ok ? 'OK' : 'FAIL'} ${r.error || ''} ${r.ms}ms`);
      }
    }
  } else {
    console.log('  无法解析 SRV（DoH 异常），退化为直接 A 记录直连测试');
    const directA = a.answers || [];
    for (const ip of directA) {
      const r = await tlsProbe(ip);
      console.log(`  ${HOST} (${ip}): ${r.ok ? 'OK' : 'FAIL'} ${r.error || ''} ${r.ms}ms`);
    }
  }
  console.log('\n=== 诊断完成 ===');
}

main().catch((e) => { console.error('脚本异常:', e); process.exit(1); });
