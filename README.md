# Milano Ride · Demo 5

米兰打车小程序练手项目（Node.js + 原生前端，无构建框架）。乘客端下单，司机端接单，两端实时联动。

## 快速开始

```powershell
npm install
npm run dev
```

然后浏览器打开：

- 乘客端：http://localhost:5173/passenger-miniapp/
- 司机端：http://localhost:5173/driver-miniapp/

没配数据库时自动进入本机演示模式，不需要登录，两个页面在同一浏览器里即可体验完整叫车流程。

## 功能

- 乘客端：Leaflet 地图（Esri 瓦片）、三条 OSRM 真实路线对比、地址自动补全（Nominatim / Photon）、即时叫车 / 预约 / 包车
- 司机端：新订单提醒、行程地图、接单 / 到达 / 上车 / 开始 / 完成全流程
- 平台抽成 20%，司机端可见本单收入明细
- 微信一键登录（模拟授权）
- 安全：偏航预警、模拟通知紧急联系人
- 服务：评分、投诉、失物招领、客服邮件
- 取消规则：每月前 3 次免费，第 4 次起扣 5%
- 后端：Node.js + Express 风格 API，业务规则在 `rules.js`，可接 PostgreSQL

## 目录

```
├── server.js              # 静态文件 + API
├── rules.js               # 业务规则与订单状态流转
├── pricing.js / src/pricing.js  # 计价与平台抽成
├── src/app.js             # 前端主程序（地图/路线/地址补全）
├── passenger-miniapp/     # 乘客端构建产物
├── driver-miniapp/        # 司机端构建产物
└── test/                  # 自动化测试（npm test）
```

## 测试

```powershell
npm test
```

当前 63 个自动化测试全部通过。
