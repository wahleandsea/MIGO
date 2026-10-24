/**
 * 将浏览器模块合并为一个普通 JavaScript 文件。
 * 这样 index.html 能被直接双击打开，不再要求本地 HTTP 服务器。
 */
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(root, relativePath), 'utf8');

const pricing = read('src/pricing.js')
  .replaceAll('export const ', 'const ')
  .replaceAll('export function ', 'function ');

const storage = read('src/services/storage.js')
  .replaceAll('export function ', 'function ');

const api = read('src/services/api.js')
  .replace(/import\s+\{[\s\S]*?\}\s+from '\.\/storage\.js';\r?\n\r?\n/, '')
  .replaceAll('export async function ', 'async function ')
  .replaceAll('export function ', 'function ')
  .replaceAll('export class ', 'class ');

const app = read('src/app.js')
  .replace(/^import[\s\S]*?from '\.\/services\/api\.js';\r?\n\r?\n/, '');

function makeBundle(role) {
  const buildStamp = new Date().toLocaleString('zh-CN', { hour12: false });
  return `/* 自动生成：运行 npm.cmd run build 可重新生成。 */\nwindow.MILANO_RIDE_APP_ROLE = '${role}';\nwindow.MILANO_RIDE_BUILD = '${buildStamp}';\n(async () => {\n${pricing}\n\n${storage}\n\n${api}\n\n${app}\n})().catch((error) => {\n  console.error(error);\n  document.querySelector('#app').innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>页面没有启动</h1><p>请刷新后重试。错误信息已输出到浏览器开发者工具。</p></main>';\n});\n`;
}

const passengerBundle = makeBundle('passenger');
const driverBundle = makeBundle('driver');

// 每次构建自动重写入口页：app.js 引用带时间戳版本号，防止浏览器缓存旧的 app.js 导致看不到最新改动。
const buildStamp = Date.now();
function writeIndex(dir, roleTitle) {
  const html = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0, viewport-fit=cover" />
    <meta name="theme-color" content="#1855ff" />
    <title>Milano Ride Demo 5 · ${roleTitle}</title>
    <link rel="stylesheet" href="https://unpkg.com/leaflet@1.9.4/dist/leaflet.css" />
    <link rel="stylesheet" href="./styles.css" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://unpkg.com/leaflet@1.9.4/dist/leaflet.js"></script>
    <script src="./app.js?v=${buildStamp}"></script>
  </body>
</html>`;
  fs.writeFileSync(path.join(root, `${dir}/index.html`), html, 'utf8');
}

// 保留旧入口，默认作为乘客端打开。
fs.writeFileSync(path.join(root, 'src/app-standalone.js'), passengerBundle, 'utf8');
fs.writeFileSync(path.join(root, 'passenger-miniapp/app.js'), passengerBundle, 'utf8');
fs.writeFileSync(path.join(root, 'driver-miniapp/app.js'), driverBundle, 'utf8');
fs.copyFileSync(path.join(root, 'src/styles.css'), path.join(root, 'passenger-miniapp/styles.css'));
fs.copyFileSync(path.join(root, 'src/styles.css'), path.join(root, 'driver-miniapp/styles.css'));
writeIndex('passenger-miniapp', '乘客');
writeIndex('driver-miniapp', '司机');

// 后台审核台：独立页面（不经过 bundle 转换），源码在 src/admin-app.js。
fs.mkdirSync(path.join(root, 'admin-miniapp'), { recursive: true });
fs.copyFileSync(path.join(root, 'src/admin-app.js'), path.join(root, 'admin-miniapp/app.js'));
fs.writeFileSync(path.join(root, 'admin-miniapp/index.html'), `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="theme-color" content="#16325c" />
    <title>Milano Ride · 司机审核台</title>
  </head>
  <body>
    <div id="app"></div>
    <script src="./app.js?v=${buildStamp}"></script>
  </body>
</html>`, 'utf8');
console.log('已生成独立的乘客小程序、司机小程序与司机审核台（admin-miniapp），可分别双击各自的 index.html 打开。');
