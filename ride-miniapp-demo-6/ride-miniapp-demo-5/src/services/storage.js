const KEY = 'milan-ride-demo-state-v1';

const defaultState = {
  profile: {
    passenger: { name: '陈小满', email: 'xiaoman@example.com', verified: false },
    driver: {
      name: 'Marco Rossi',
      car: 'Mercedes Vito · IT 786 MR',
      phone: '+39 333 820 4681',
      rating: 4.92,
      creditScore: 98,
      accountStatus: 'active', // active 正常 / suspended 暂停使用 / closed 强制关闭（不符合平台规定）
      italianLicenseVerified: false,
      chinaIdVerified: false,
      online: false,
      // 司机认证资料与审核流转（与服务器 docs 同构）：none → pending → approved / rejected
      docs: {
        status: 'none', submittedAt: null, reviewedAt: null, rejectReason: '',
        italianLicense: null, chinaId: null
      }
    }
  },
  orders: [],
  ratings: [],
  complaints: [],
  cancellationCount: 0,
  lastResetAt: new Date().toISOString(),
  // 按微信 openid 隔离的司机资料：不同微信登录 = 不同司机账号（本地演示模拟真实微信 OAuth）。
  // profile.driver 始终是“当前登录微信身份”的司机资料快照，driverProfiles[openid] 保存每个微信身份的独立档案。
  driverProfiles: {},
  currentOpenid: ''
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getState() {
  try {
    const saved = window.localStorage.getItem(KEY);
    const state = { ...clone(defaultState), ...(saved ? JSON.parse(saved) : {}) };
    state.driverProfiles = state.driverProfiles || {};
    state.currentOpenid = state.currentOpenid || '';
    // 迁移旧版本数据：老结构只有 profile.driver，把已提交认证的司机存进 __legacy__ 槽位，后台列表不丢。
    if (Object.keys(state.driverProfiles).length === 0
      && state.profile?.driver?.docs?.status
      && state.profile.driver.docs.status !== 'none') {
      state.driverProfiles.__legacy__ = state.profile.driver;
    }
    return state;
  } catch {
    return clone(defaultState);
  }
}

export function saveState(nextState) {
  window.localStorage.setItem(KEY, JSON.stringify(nextState));
  return nextState;
}

export function updateState(updater) {
  const current = getState();
  const next = updater(current) || current;
  // 当前微信身份的资料变更自动写回它自己的档案，保证换微信登录时互不干扰。
  if (next.currentOpenid && next.profile?.driver) {
    next.driverProfiles = { ...(next.driverProfiles || {}), [next.currentOpenid]: next.profile.driver };
  }
  return saveState(next);
}

export function resetDemoData() {
  window.localStorage.removeItem(KEY);
  return getState();
}
