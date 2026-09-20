# PostgreSQL 数据库说明

项目已使用 Aiven PostgreSQL。连接信息由 `.env` 提供，表结构由 [db/schema.sql](./db/schema.sql) 创建。

## 当前的表

| 表 | 用途 |
| --- | --- |
| `users` | 乘客与司机账号：加密后的密码、角色、司机是否通过审核、资料（评分、车辆、电话、是否在线）、当月取消次数 |
| `sessions` | 登录状态：只保存令牌的 SHA-256 哈希和过期时间 |
| `orders` | 订单；`passenger_id`、`driver_id`、`status` 是独立的列，完整订单内容在 `data` JSONB 里 |
| `order_declines` | 司机拒绝过的订单（只对该司机隐藏） |
| `ratings` | 已完成订单的评分（每个订单只能评价一次） |
| `complaints` | 订单投诉与反馈 |
| `lost_items` | 失物招领记录，保留一个月 |
| `profiles`、`app_meta` | 第一版的旧表，已不再使用 |

## 后续可扩展项

- 已完成：账号登录、权限、订单状态校验、抢单保护、服务器计价。
- 司机评分和信誉分：目前评价不会影响司机评分。
- 实时更新：目前页面只在用户操作后才刷新，需要轮询或 WebSocket/SSE 才能立刻看到对方的操作。
- 派单：现在是“所有在线司机都能看到、先到先得”，没有按距离派单，也没有接单超时。
- 地图与真实距离；真实支付；紧急联系人与真实的偏航检测。
- 客服/后台：查看投诉和失物；司机审核目前靠命令行脚本。
- 增加 `vehicles`、`payments`、`emergency_events` 表。
- 上线前把 `data` JSONB 里稳定的字段逐步迁移为结构化列。

## 常用命令

```powershell
npm.cmd run db:check     # 验证 Aiven 连接
npm.cmd run db:migrate   # 创建表（可重复运行）
npm.cmd run dev          # 启动页面和 API
npm.cmd test             # 运行自动化测试（不需要数据库）
npm.cmd run test:db      # 用真实数据库再跑一遍接口规则
npm.cmd run approve-driver -- 司机邮箱   # 批准司机账号
```
