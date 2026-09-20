/**
 * 服务器与网页共用同一份计价规则：src/pricing.js（只维护这一份，避免两边算出的价格不一致）。
 * 它是给浏览器用的 ES 模块（带 export），Node 的 require 不能直接读取，
 * 所以这里和 scripts/build-standalone.js 一样，先去掉 export 关键字再执行。
 */
const fs = require('node:fs');
const path = require('node:path');

function loadPricing() {
  const source = fs.readFileSync(path.join(__dirname, 'src', 'pricing.js'), 'utf8')
    .replaceAll('export const ', 'const ')
    .replaceAll('export function ', 'function ');
  if (/^\s*(export|import)\s/m.test(source)) {
    throw new Error('src/pricing.js 只能使用 "export const" 和 "export function"，不要使用 import / export default。');
  }
  const factory = new Function(`${source}\nreturn { PRICING, roundMoney, estimateFare, makeRouteOptions, cancellationFee };`);
  return factory();
}

module.exports = { loadPricing };
