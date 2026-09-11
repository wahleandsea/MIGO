# PostgreSQL 数据库说明

项目已使用 Aiven PostgreSQL。连接信息由 `.env` 提供，表结构由 [db/schema.sql](./db/schema.sql) 创建。

## 当前已保存的数据

| 表 | 用途 |
| --- | --- |
| `profiles` | 乘客与司机资料、模拟认证、司机在线状态 |
| `orders` | 即时、预约、包车订单；接单、取消、开始、完成等状态 |
| `ratings` | 已完成订单的评分 |
| `complaints` | 订单投诉与反馈 |
| `lost_items` | 失物招领记录，自动保留一个月 |
| `app_meta` | 取消次数与演示应用状态 |

订单及服务表会在 `data` JSONB 字段保留完整页面数据，同时把 `status`、时间等常用字段独立出来，方便后续加索引或拆表。

## 后续可扩展项

- 登录后增加 `users` 表，用真实用户 ID 替代当前练习用的单一乘客/司机资料。
- 增加 `vehicles`、`route_quotes`、`payments` 和 `emergency_events`。
- 地图、身份认证和支付密钥都只放服务器环境变量，不能放在网页 JavaScript。
- 上线前将 JSONB 内稳定的字段迁移为结构化列，并增加权限和订单状态校验。

## 常用命令

```powershell
npm.cmd run db:check     # 验证 Aiven 连接
npm.cmd run db:migrate   # 创建表（可重复运行）
npm.cmd run dev          # 启动页面和 API
```
