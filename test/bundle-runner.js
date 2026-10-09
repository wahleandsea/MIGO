/**
 * 在 Node 里运行真正的网页程序（passenger-miniapp/app.js、driver-miniapp/app.js），
 * 假装成浏览器：有 document、localStorage、fetch。用来测试“网页 + 服务器”连起来是否正常。
 */
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');

function createStorage(initial = {}) {
  const data = { ...initial };
  return {
    data,
    getItem: (key) => (key in data ? data[key] : null),
    setItem: (key, value) => { data[key] = String(value); },
    removeItem: (key) => { delete data[key]; }
  };
}

async function waitFor(check, description = '条件', timeout = 4000) {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeout) throw new Error(`等待超时：${description}`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** role: 'passenger' | 'driver'；传入 baseUrl 表示通过服务器访问（http），不传表示双击打开（file://，本机演示模式）。 */
async function openApp(role, { baseUrl, storage = createStorage() } = {}) {
  const listeners = {};
  const appElement = { innerHTML: '', addEventListener: (type, handler) => { listeners[type] = handler; } };
  const timers = new Set();
  const window = {
    location: { protocol: baseUrl ? 'http:' : 'file:' },
    localStorage: storage,
    setTimeout: (fn, ms) => { const timer = setTimeout(fn, ms); timers.add(timer); return timer; },
    clearTimeout: (timer) => { clearTimeout(timer); timers.delete(timer); }
  };
  class FakeFormData {
    constructor(form) { this.values = form.__values || {}; }
    get(name) { return name in this.values ? this.values[name] : null; }
  }
  // 网页遇到错误时会 console.error（例如订单已被别人接走）；测试里改为记录下来，不刷屏。
  const errors = [];
  const quietConsole = { ...console, error: (...args) => errors.push(args) };
  const context = vm.createContext({
    window, console: quietConsole, FormData: FakeFormData,
    document: { querySelector: () => appElement },
    fetch: baseUrl ? (url, options) => fetch(new URL(url, baseUrl), options) : undefined
  });
  vm.runInContext(fs.readFileSync(path.join(root, `${role}-miniapp`, 'app.js'), 'utf8'), context);
  await waitFor(() => appElement.innerHTML !== '', '页面完成首次渲染');

  const clickTarget = (dataset) => ({ target: { closest: (selector) => (selector === '[data-action]' ? { dataset } : null) } });
  return {
    storage, errors,
    html: () => appElement.innerHTML,
    /** 点击一个带 data-action 的按钮，dataset 例如 { action: 'nav', screen: 'orders' } */
    click: (dataset) => listeners.click(clickTarget(dataset)),
    /** 在输入框里输入（例如上车点） */
    type: (field, value) => listeners.input({ target: { dataset: { field }, value } }),
    /** 打开/关闭“接单中”开关 */
    toggle: (field, checked) => listeners.change({ target: { dataset: { field }, checked } }),
    /** 提交表单，values 是表单里各个字段的值 */
    submit: (kind, values) => {
      const form = { dataset: { form: kind }, __values: values };
      return listeners.submit({ target: { closest: (selector) => (selector === 'form[data-form]' ? form : null) }, preventDefault() {} });
    },
    /** 从当前页面里取出某个按钮的 data-id，例如 idOf('driver-accept') */
    idOf(action) {
      const match = new RegExp(`data-action="${action}"[^>]*data-id="([^"]+)"`).exec(appElement.innerHTML);
      return match ? match[1] : null;
    },
    close() { for (const timer of timers) clearTimeout(timer); timers.clear(); }
  };
}

module.exports = { openApp, createStorage, waitFor };
