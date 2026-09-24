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
  return `/* 自动生成：运行 npm.cmd run build 可重新生成。 */\nwindow.MILANO_RIDE_APP_ROLE = '${role}';\n(async () => {\n${pricing}\n\n${storage}\n\n${api}\n\n${app}\n})().catch((error) => {\n  console.error(error);\n  document.querySelector('#app').innerHTML = '<main style="max-width:560px;margin:40px auto;padding:24px;font-family:system-ui;color:#24324c"><h1>页面没有启动</h1><p>请刷新后重试。错误信息已输出到浏览器开发者工具。</p></main>';\n});\n`;
}

const passengerBundle = makeBundle('passenger');
const driverBundle = makeBundle('driver');

// 保留旧入口，默认作为乘客端打开。
fs.writeFileSync(path.join(root, 'src/app-standalone.js'), passengerBundle, 'utf8');
fs.writeFileSync(path.join(root, 'passenger-miniapp/app.js'), passengerBundle, 'utf8');
fs.writeFileSync(path.join(root, 'driver-miniapp/app.js'), driverBundle, 'utf8');
fs.copyFileSync(path.join(root, 'src/styles.css'), path.join(root, 'passenger-miniapp/styles.css'));
fs.copyFileSync(path.join(root, 'src/styles.css'), path.join(root, 'driver-miniapp/styles.css'));
console.log('已生成独立的乘客小程序与司机小程序，可分别双击各自的 index.html 打开。');
