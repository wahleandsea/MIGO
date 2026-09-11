# Milano Ride 打车小程序练手版

这是根据「滴滴计划」制作的打车小程序练手项目。现在已接入 **Aiven PostgreSQL**：乘客、司机、订单、评价、投诉和失物信息均可保存到数据库。

## 两个独立小程序

项目已经拆分为两个独立入口，不能在页面里互相切换：

| 小程序 | 打开地址（运行 `npm.cmd run dev` 后） | 作用 |
| --- | --- | --- |
| 乘客小程序 | [http://localhost:5173/passenger-miniapp/](http://localhost:5173/passenger-miniapp/) | 下单、预约、包车、评价、投诉、失物招领 |
| 司机小程序 | [http://localhost:5173/driver-miniapp/](http://localhost:5173/driver-miniapp/) | 查看新订单、接单/拒单、开始/完成行程 |

两个小程序使用同一套 PostgreSQL 数据，因此乘客端创建的订单会显示在司机端。分别双击两个文件夹内的 `index.html` 时，也会各自打开演示界面；要让两个端共享订单，请使用本地服务器启动。

## 连接 Aiven PostgreSQL（必须通过本地服务器运行）

> 数据库密码只应该存在你电脑里的 `.env` 文件。截图里密码被隐藏是正确的；请在 Aiven 控制台点击显示/复制密码，直接粘贴到 `.env`，不要发到聊天里。

1. 用 VS Code 打开 `ride-miniapp-demo` 文件夹。
2. 在终端运行以下命令：

   ```powershell
   Copy-Item .env.example .env
   npm.cmd install
   ```

3. 打开新生成的 `.env`，最稳妥的方式是用 Aiven 控制台复制出的完整 **Service URI** 覆盖 `DATABASE_URL` 这一整行；这样密码中的特殊字符也会被正确编码。
4. 在 Aiven 控制台的 **CA certificate** 一行点击下载，把证书存为：

   ```text
   ride-miniapp-demo/certs/aiven-ca.pem
   ```

5. 初始化并检查数据库连接：

   ```powershell
   npm.cmd run db:check
   npm.cmd run db:migrate
   npm.cmd run dev
   ```

6. 分别打开上方的“乘客小程序”和“司机小程序”地址。页面“我的”会显示“PostgreSQL 数据库已连接”。

`db:check` 出错时，通常是密码没有替换、证书路径不对，或网络无法访问 Aiven。请先修复再执行迁移。

## 直接双击打开（演示模式）

双击 `passenger-miniapp/index.html` 或 `driver-miniapp/index.html` 都能打开独立界面，但无法连接云数据库，会自动使用本机浏览器的临时演示数据。要让两个端使用同一订单数据，必须按上面的方式运行 `npm.cmd run dev`。

## 功能

- 即时叫车、预约、机场接送、半日/全日包车。
- 路线模拟、不同路线报价与公里阶梯计价。
- 司机接单/拒单/重新分配、开始和完成行程。
- 偏航安全提醒、评分、投诉、失物招领。
- 支付方式与车型的练习界面（真实支付仍未接入）。

## 数据库结构

运行 `npm.cmd run db:migrate` 会创建：

- `profiles`：乘客与司机资料。
- `orders`：订单状态与完整订单数据。
- `ratings`、`complaints`、`lost_items`：服务记录。
- `app_meta`：取消次数等应用状态。

详细设计见 [DATABASE_TODO.md](./DATABASE_TODO.md)，SQL 文件见 [db/schema.sql](./db/schema.sql)。

## 目录

```text
ride-miniapp-demo/
├── .env.example             # Aiven 数据库连接模板（无密码）
├── db/schema.sql            # PostgreSQL 建表 SQL
├── database.js              # 安全读取 .env、连接 Aiven SSL
├── repository.js            # 数据库读写逻辑
├── server.js                # 静态页面 + API 后端
├── passenger-miniapp/       # 独立乘客小程序（index.html、app.js、styles.css）
├── driver-miniapp/          # 独立司机小程序（index.html、app.js、styles.css）
├── scripts/
│   ├── check-db.js          # 检查数据库是否可连
│   ├── migrate.js           # 创建数据表
│   └── build-standalone.js  # 构建双击可打开的演示版
└── src/
    ├── app.js               # 页面与交互
    └── services/api.js      # 前端 API；服务不可用时回退本机演示数据
```

修改前端代码后，若仍要保留“双击打开”模式，请运行：

```powershell
npm.cmd run build
```
