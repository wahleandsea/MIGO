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
      italianLicenseVerified: true,
      chinaIdVerified: true,
      online: true
    }
  },
  orders: [],
  ratings: [],
  complaints: [],
  cancellationCount: 0,
  lastResetAt: new Date().toISOString()
};

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

export function getState() {
  try {
    const saved = window.localStorage.getItem(KEY);
    if (!saved) return clone(defaultState);
    return { ...clone(defaultState), ...JSON.parse(saved) };
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
  return saveState(next);
}

export function resetDemoData() {
  window.localStorage.removeItem(KEY);
  return getState();
}
