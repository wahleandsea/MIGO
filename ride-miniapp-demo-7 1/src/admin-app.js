/**
 * Milano Ride · 司机审核台（后台）
 * 司机提交意大利驾照 + 中国身份证资料后，在这里审核：通过 / 拒绝（带原因）。
 * - 数据库版（http + MongoDB 已配置）：调用服务器 /api/admin/* 接口（管理员密钥在页面输入）。
 * - 本地版（双击打开或数据库未配置）：直接读写浏览器 localStorage 里的司机资料。
 * 本页面为独立脚本，不参与乘客/司机小程序的 bundle 构建；npm.cmd run build 会复制到 admin-miniapp/app.js。
 */
(() => {
  const app = document.querySelector('#app');
  const STORAGE_KEY = 'milan-ride-demo-state-v1';
  const DEFAULT_ADMIN_KEY = 'demo-admin';
  const STATUS_LABEL = { none: '未提交', pending: '待审核', approved: '已通过', rejected: '已拒绝' };
  const ACCOUNT_LABEL = { suspended: '已暂停', closed: '已关闭' };
  const ACCOUNT_NOTE = { suspended: '使用权限已暂停', closed: '不符合平台规定' };
  const TABS = [
    ['pending', '待审核'],
    ['approved', '已通过'],
    ['rejected', '已拒绝'],
    ['', '全部']
  ];

  let mode = 'local';
  let adminKey = DEFAULT_ADMIN_KEY;
  let tab = 'pending';
  let drivers = [];
  let error = '';

  const el = (tag, className, text) => {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  };

  const injectStyle = () => {
    const style = document.createElement('style');
    style.textContent = `
      * { box-sizing: border-box; }
      body { margin: 0; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; background: #eef2f8; color: #24324c; }
      .wrap { max-width: 720px; margin: 0 auto; padding: 22px 16px 60px; }
      header { display: flex; align-items: center; justify-content: space-between; gap: 10px; margin-bottom: 16px; }
      h1 { margin: 0; font-size: 20px; color: #1a2f52; }
      .mode-pill { border-radius: 999px; padding: 5px 11px; background: #dde7fb; color: #2b4a9b; font-size: 11px; font-weight: 700; }
      .panel { border-radius: 16px; padding: 15px; background: #fff; box-shadow: 0 6px 18px rgba(32,59,107,.07); margin-bottom: 13px; }
      .key-row { display: flex; gap: 8px; }
      .key-row input { flex: 1; border: 1px solid #d5dfef; border-radius: 10px; padding: 9px 11px; font-size: 12px; }
      .tabs { display: flex; gap: 7px; margin-bottom: 13px; }
      .tabs button { flex: 1; border: 1px solid #d5dfef; border-radius: 999px; padding: 8px 0; background: #fff; color: #52627e; font-size: 12px; font-weight: 700; cursor: pointer; }
      .tabs button.on { border-color: #1f5df5; background: #1f5df5; color: #fff; }
      .card { border: 1px solid #e3e9f4; border-radius: 14px; padding: 13px; background: #fbfcfe; margin-bottom: 11px; }
      .card h3 { margin: 0 0 8px; font-size: 14px; color: #1c3258; }
      .card .meta { display: grid; grid-template-columns: 1fr 1fr; gap: 4px 12px; color: #5c6c88; font-size: 11px; }
      .card .meta b { color: #34435d; }
      .status { border-radius: 999px; padding: 3px 9px; font-size: 10px; font-weight: 800; }
      .status.pending { background: #fff4d6; color: #a06a00; }
      .status.approved { background: #e0f6ea; color: #1e7d4c; }
      .status.rejected { background: #fde8e6; color: #c0392b; }
      .status.none { background: #eceff5; color: #68758c; }
      .status.account { background: #f6e7e7; color: #b23a2e; }
      .status.account.suspended { background: #fff2d6; color: #a06a00; }
      .doc-block { margin: 9px 0 0; border-radius: 10px; padding: 9px 11px; background: #eef3fb; color: #45566f; font-size: 11px; line-height: 1.6; }
      .doc-photo-box { display: inline-block; margin: 6px 10px 2px 0; text-align: center; vertical-align: top; }
      .doc-photo { display: block; max-width: 110px; max-height: 110px; border-radius: 6px; border: 1px solid #c9d7e8; cursor: zoom-in; }
      .doc-photo-box figcaption { font-size: 11px; color: #5b6b83; margin-top: 3px; }
      .actions { display: flex; gap: 8px; margin-top: 11px; }
      .actions button { flex: 1; border: 0; border-radius: 10px; padding: 10px 0; font-size: 12px; font-weight: 800; cursor: pointer; }
      .approve { background: #1f9d63; color: #fff; }
      .reject { background: #e05b4d; color: #fff; }
      .suspend { background: #f0a500; color: #fff; }
      .empty { padding: 26px 12px; text-align: center; color: #8b98ab; font-size: 12px; }
      .error { border: 1px solid #f3c9c4; background: #fef1ef; border-radius: 10px; padding: 9px 11px; color: #c0392b; font-size: 12px; margin-bottom: 11px; }
      .foot { color: #94a0b3; font-size: 10px; text-align: center; margin-top: 18px; line-height: 1.6; }
    `;
    document.head.appendChild(style);
  };

  const maskChinaId = (number) => {
    const value = String(number || '');
    return value.length === 18 ? `${value.slice(0, 6)}********${value.slice(14)}` : (value || '未提供');
  };

  const renderCard = (driver) => {
    const docs = driver.docs || {};
    const status = docs.status || (driver.italianLicenseVerified ? 'approved' : 'none');
    const card = el('div', 'card');
    const head = el('div');
    const title = el('h3', '', driver.name || driver.email || '未知司机');
    const pill = el('span', `status ${status}`, STATUS_LABEL[status] || status);
    head.style.display = 'flex';
    head.style.alignItems = 'center';
    head.style.gap = '8px';
    head.appendChild(title);
    head.appendChild(pill);
    // 账号状态徽标：暂停使用 / 强制关闭（仅对已通过审核的司机展示）
    const accountStatus = driver.profile?.accountStatus || 'active';
    if (status === 'approved' && accountStatus !== 'active') {
      head.appendChild(el('span', `status account ${accountStatus}`, ACCOUNT_LABEL[accountStatus] || accountStatus));
    }
    card.appendChild(head);

    const meta = el('div', 'meta');
    const pair = (label, value) => {
      const row = el('div', '', `${label}：`);
      const b = el('b', '', value);
      row.appendChild(b);
      return row;
    };
    meta.appendChild(pair('邮箱', driver.email || '—'));
    // 远程 API 返回扁平的 phone/car；本地版存在 profile 里。两种都兼容读取。
    meta.appendChild(pair('手机', driver.phone || driver.profile?.phone || '—'));
    meta.appendChild(pair('车辆', driver.car || driver.profile?.car || '—'));
    meta.appendChild(pair('提交时间', docs.submittedAt ? new Date(docs.submittedAt).toLocaleString('zh-CN', { hour12: false }) : '—'));
    card.appendChild(meta);

    if (docs.italianLicense || docs.chinaId) {
      const doc = el('div', 'doc-block');
      doc.appendChild(el('div', '', `🇮🇹 意大利驾照：${docs.italianLicense?.number || '—'}（有效期 ${docs.italianLicense?.expiry || '—'}）`));
      doc.appendChild(el('div', '', `🇨🇳 中国身份证：${maskChinaId(docs.chinaId?.number)}`));
      // 证件照片（data URL）缩略图，点击查看原图
      const photo = (src, label) => {
        const box = el('figure', 'doc-photo-box');
        const img = el('img', 'doc-photo');
        img.src = src;
        img.alt = label;
        img.title = label;
        box.appendChild(img);
        box.appendChild(el('figcaption', '', label));
        return box;
      };
      if (docs.italianLicense?.photo) doc.appendChild(photo(docs.italianLicense.photo, '驾照照片'));
      if (docs.chinaId?.photo) doc.appendChild(photo(docs.chinaId.photo, '身份证照片'));
      card.appendChild(doc);
    }
    if (docs.rejectReason) {
      const reason = el('div', 'doc-block', `拒绝原因：${docs.rejectReason}`);
      reason.style.background = '#fdeeee';
      card.appendChild(reason);
    }

    if (status === 'pending') {
      const actions = el('div', 'actions');
      const approve = el('button', 'approve', '✓ 通过');
      const reject = el('button', 'reject', '✕ 拒绝');
      approve.addEventListener('click', () => review(driver.id, 'approve', ''));
      reject.addEventListener('click', () => {
        const reason = window.prompt('请输入拒绝原因（司机端会显示）：', '资料不符合要求');
        if (reason === null) return;
        review(driver.id, 'reject', String(reason).trim() || '资料不符合要求');
      });
      actions.appendChild(approve);
      actions.appendChild(reject);
      card.appendChild(actions);
    } else if (status === 'approved') {
      // 已通过审核的司机：后台可暂停使用权限或强制关闭账号（司机端提示“不符合平台规定”）。
      const actions = el('div', 'actions');
      const confirmText = (action) => {
        if (action === 'close') return '确认强制关闭该司机账号？司机端将提示“不符合平台规定”，且无法再上线接单。';
        if (action === 'suspend') return '确认暂停该司机使用权限？司机端将提示“使用权限已暂停”。';
        return '';
      };
      const run = (action) => {
        const note = confirmText(action);
        if (note && !window.confirm(note)) return;
        accountAction(driver.id, action);
      };
      if (accountStatus === 'active') {
        actions.appendChild(el('button', 'suspend', '⏸ 暂停使用')).addEventListener('click', () => run('suspend'));
        actions.appendChild(el('button', 'reject', '⛔ 强制关闭')).addEventListener('click', () => run('close'));
      } else if (accountStatus === 'suspended') {
        actions.appendChild(el('button', 'approve', '▶ 恢复使用')).addEventListener('click', () => run('restore'));
        actions.appendChild(el('button', 'reject', '⛔ 强制关闭')).addEventListener('click', () => run('close'));
      } else {
        actions.appendChild(el('button', 'approve', '▶ 恢复使用')).addEventListener('click', () => run('restore'));
        // 已强制关闭的账号可删除：从数据库抹除（含账号与登录会话），司机端无法再登录。
        actions.appendChild(el('button', 'reject', '🗑 删除账号')).addEventListener('click', () => {
          const note = '确认永久删除该司机账号？此操作不可恢复：账号资料与登录会话将从数据库抹除。';
          if (!window.confirm(note)) return;
          deleteDriverAction(driver.id);
        });
      }
      card.appendChild(actions);
    }
    return card;
  };

  const render = () => {
    app.textContent = '';
    const wrap = el('div', 'wrap');
    const header = el('header');
    const title = el('h1', '', 'Milano Ride · 司机审核台');
    header.appendChild(title);
    header.appendChild(el('span', 'mode-pill', mode === 'remote' ? '数据库版' : '本地版'));
    wrap.appendChild(header);

    if (error) wrap.appendChild(el('div', 'error', error));

    if (mode === 'remote') {
      const panel = el('div', 'panel');
      panel.appendChild(el('div', '', '管理员密钥：'));
      const row = el('div', 'key-row');
      const input = document.createElement('input');
      input.type = 'password';
      input.value = adminKey;
      input.placeholder = '后台管理员密钥';
      input.addEventListener('change', () => { adminKey = input.value.trim() || DEFAULT_ADMIN_KEY; load(); });
      const button = el('button', '', '刷新列表');
      button.style.cssText = 'border:0;border-radius:10px;padding:9px 14px;background:#1f5df5;color:#fff;font-weight:800;cursor:pointer;';
      button.addEventListener('click', load);
      row.appendChild(input);
      row.appendChild(button);
      panel.appendChild(row);
      wrap.appendChild(panel);
    }

    const tabs = el('div', 'tabs');
    for (const [value, label] of TABS) {
      const button = el('button', value === tab ? 'on' : '', label);
      button.addEventListener('click', () => { tab = value; load(); });
      tabs.appendChild(button);
    }
    wrap.appendChild(tabs);

    if (drivers.length === 0) {
      wrap.appendChild(el('div', 'empty', mode === 'remote' ? '没有这个状态的司机。' : '当前没有司机认证申请。'));
    } else {
      drivers.forEach((driver) => wrap.appendChild(renderCard(driver)));
    }
    wrap.appendChild(el('div', 'foot', mode === 'remote'
      ? '数据来自服务器 MongoDB Atlas。密钥默认 demo-admin（可在 .env 的 ADMIN_KEY 修改）。真实上线请做完整权限控制。'
      : '本地版直接读写浏览器 localStorage，与司机端同源共享数据。点“通过/拒绝”审核；已通过司机可“暂停使用”或“强制关闭”。'));
    app.appendChild(wrap);
  };

  async function load() {
    error = '';
    try {
      if (mode === 'local') {
        drivers = localDrivers();
      } else {
        const query = tab ? `?status=${encodeURIComponent(tab)}` : '';
        const response = await fetch(`/api/admin/drivers${query}`, { headers: { 'X-Admin-Key': adminKey } });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || `加载失败（${response.status}）`);
        drivers = payload.drivers || [];
      }
    } catch (loadError) {
      drivers = [];
      error = String(loadError.message || loadError);
    }
    render();
  }

  function localDrivers() {
    let saved = null;
    try { saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null'); } catch { /* 损坏的数据按空处理 */ }
    if (!saved) return [];
    const list = [];
    const seen = new Set();
    // 每个微信身份（openid）一份独立司机档案：换微信登录会出现多位司机，后台都能看到。
    const push = (id, driver) => {
      if (!driver) return;
      const docs = driver.docs || {};
      const status = docs.status || (driver.italianLicenseVerified ? 'approved' : 'none');
      // “全部”也只展示已提交认证的司机（待审核/已通过/已拒绝），未提交资料的不进入列表。
      if (tab ? status !== tab : !['pending', 'approved', 'rejected'].includes(status)) return;
      seen.add(id);
      list.push({ id, name: driver.name || `微信司机·${String(id).slice(-4)}`, email: `微信司机（${String(id).slice(-8)}）`, approved: status === 'approved', profile: driver, docs });
    };
    for (const [openid, driver] of Object.entries(saved.driverProfiles || {})) push(openid, driver);
    // 兼容旧数据：当前快照里还有未进档案的认证司机
    const current = saved.profile?.driver;
    const curOpenid = saved.currentOpenid || '';
    if (current && (current.docs?.status || current.italianLicenseVerified) && !seen.has(curOpenid) && !seen.has('current')) {
      push(curOpenid || 'current', current);
    }
    return list;
  }

  async function review(driverId, action, reason) {
    error = '';
    try {
      if (mode === 'local') {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
        const profiles = saved.driverProfiles || {};
        // driverId 是该微信身份的 openid；'current' 指当前快照（旧数据兼容）
        const driver = driverId === 'current' ? saved.profile?.driver : (profiles[driverId] || saved.profile?.driver);
        if (!driver) throw new Error('没有找到司机资料');
        const now = new Date().toISOString();
        const docsStatus = action === 'approve' ? 'approved' : 'rejected'; // 状态机取值是 approved/rejected，不是按钮名 approve/reject
        driver.docs = {
          ...(driver.docs || {}),
          status: docsStatus, reviewedAt: now, rejectReason: action === 'reject' ? reason : ''
        };
        driver.italianLicenseVerified = action === 'approve';
        driver.chinaIdVerified = action === 'approve';
        profiles[driverId] = driver;
        saved.driverProfiles = profiles;
        if (saved.currentOpenid && profiles[saved.currentOpenid] === driver) saved.profile.driver = driver;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        drivers = localDrivers();
      } else {
        const response = await fetch(`/api/admin/drivers/${encodeURIComponent(driverId)}/review`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
          body: JSON.stringify(action === 'reject' ? { action, reason } : { action })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || `审核失败（${response.status}）`);
        await load();
        return;
      }
    } catch (reviewError) {
      error = String(reviewError.message || reviewError);
    }
    render();
  }

  /** 账号管理：suspend 暂停使用 / close 强制关闭（不符合平台规定）/ restore 恢复。暂停与关闭同时强制司机下线。 */
  async function accountAction(driverId, action) {
    error = '';
    try {
      if (mode === 'local') {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
        const profiles = saved.driverProfiles || {};
        const driver = driverId === 'current' ? saved.profile?.driver : (profiles[driverId] || saved.profile?.driver);
        if (!driver) throw new Error('没有找到司机资料');
        driver.accountStatus = action === 'close' ? 'closed' : action === 'suspend' ? 'suspended' : 'active';
        if (action !== 'restore') driver.online = false;
        profiles[driverId] = driver;
        saved.driverProfiles = profiles;
        if (saved.currentOpenid && profiles[saved.currentOpenid] === driver) saved.profile.driver = driver;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        drivers = localDrivers();
      } else {
        const response = await fetch(`/api/admin/drivers/${encodeURIComponent(driverId)}/account`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Admin-Key': adminKey },
          body: JSON.stringify({ action })
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || `操作失败（${response.status}）`);
        await load();
        return;
      }
    } catch (accountError) {
      error = String(accountError.message || accountError);
    }
    render();
  }

  /** 删除司机账号（仅已强制关闭的账号）：远程调用服务器删除接口（抹除用户记录与会话）；本地版从 localStorage 移除档案。 */
  async function deleteDriverAction(driverId) {
    error = '';
    try {
      if (mode === 'local') {
        const saved = JSON.parse(window.localStorage.getItem(STORAGE_KEY) || 'null');
        if (!saved) throw new Error('没有找到司机资料');
        const profiles = saved.driverProfiles || {};
        if (driverId !== 'current') delete profiles[driverId];
        if (saved.currentOpenid === driverId) delete saved.profile?.driver;
        window.localStorage.removeItem('milano-ride-token-driver');
        saved.driverProfiles = profiles;
        window.localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
        drivers = localDrivers();
      } else {
        const response = await fetch(`/api/admin/drivers/${encodeURIComponent(driverId)}/delete`, {
          method: 'POST',
          headers: { 'X-Admin-Key': adminKey }
        });
        const payload = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(payload.message || `删除失败（${response.status}）`);
        await load();
        return;
      }
    } catch (deleteError) {
      error = String(deleteError.message || deleteError);
    }
    render();
  }

  async function init() {
    injectStyle();
    if (window.location.protocol === 'file:') {
      mode = 'local';
    } else {
      try {
        const health = await fetch('/api/health').then((response) => response.json()).catch(() => ({}));
        mode = health?.database === true ? 'remote' : 'local';
      } catch {
        mode = 'local';
      }
    }
    await load();
  }

  init();
})();
