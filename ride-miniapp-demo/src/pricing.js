/**
 * 统一计价规则。
 * 需求中的样例：20 km = €50、30 km = €60、40 km = €70、50 km = €80。
 * 这里使用连续的分段计算，便于之后直接替换为后端报价引擎。
 */
export const PRICING = {
  shortTripRate: 3.5,
  airport: {
    mxp: { label: 'Malpensa · MXP', price: 80 },
    linate: { label: 'Linate · LIN', price: 50 }
  },
  charter: {
    halfDayHours: 4,
    fullDayHours: 8,
    overtimeHourly: 30,
    // TODO: PRICING 确认半日包/全日包基础价格后填写。
    halfDayBase: null,
    fullDayBase: null
  }
};

export function roundMoney(value) {
  return Math.round(value * 100) / 100;
}

export function estimateFare(distanceKm, multiplier = 1) {
  const km = Math.max(0, Number(distanceKm) || 0);
  let fare;
  if (km <= 10) {
    fare = km * PRICING.shortTripRate;
  } else if (km <= 20) {
    fare = 35 + (km - 10) * 1.5;
  } else if (km <= 50) {
    fare = 50 + (km - 20);
  } else {
    // 思维导图“50 km 以上 1.6–1.8 欧/km”，示例取中位数 €1.7/km。
    fare = 80 + (km - 50) * 1.7;
  }
  return roundMoney(fare * multiplier);
}

export function makeRouteOptions(distanceKm) {
  const base = Math.max(2, Number(distanceKm) || 12);
  return [
    {
      id: 'balanced',
      label: '推荐路线',
      note: '路况更稳定',
      distanceKm: roundMoney(base),
      minutes: Math.round(base * 3.2 + 4),
      multiplier: 1
    },
    {
      id: 'fast',
      label: '最快路线',
      note: '可能经过拥堵路段',
      distanceKm: roundMoney(base * 1.08),
      minutes: Math.round(base * 2.7 + 3),
      multiplier: 1.08
    },
    {
      id: 'economy',
      label: '省钱路线',
      note: '时间稍长',
      distanceKm: roundMoney(base * 0.92),
      minutes: Math.round(base * 3.8 + 5),
      multiplier: 0.91
    }
  ].map((route) => ({ ...route, fare: estimateFare(route.distanceKm, route.multiplier) }));
}

export function cancellationFee(cancelledCount) {
  // 每月前三次免费，从第四次开始收订单金额的 5%。
  return cancelledCount >= 3 ? 0.05 : 0;
}

export function formatEuro(value) {
  if (value === null || value === undefined) return '待配置';
  return `€${Number(value).toFixed(2)}`;
}
