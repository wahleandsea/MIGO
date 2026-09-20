# Milano Ride 打车小程序练手版

这是根据「滴滴计划」制作的打车小程序练手项目。已接入 **Aiven PostgreSQL**，并且有**账号登录和权限控制**：乘客、司机各自注册登录；乘客只能看到自己的订单，司机只能接单和操作自己的行程；价格和订单状态由服务器决定。

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

5. 初始化并检查数据库连接（**每次拉取了新代码，都要重新运行一次 `db:migrate`**，它可以重复运行，不会删除数据）：

   ```powershell
   npm.cmd run db:check
   npm.cmd run db:migrate
   npm.cmd run dev
   ```

6. 分别打开上方的“乘客小程序”和“司机小程序”地址，先**注册账号**再使用。页面“我的”会显示“PostgreSQL 数据库已连接”。

`db:check` 出错时，通常是密码没有替换、证书路径不对，或网络无法访问 Aiven。请先修复再执行迁移。

## 账号、登录与权限

- 乘客端、司机端分别注册：邮箱 + 密码（至少 8 位，密码加密保存）。同一个邮箱只能属于一种账号。
- **司机需要审核**：新注册的司机默认“待审核”，不能上线、不能接单。
  - 开发时：`.env` 里保持 `DRIVER_AUTO_APPROVE=true`，注册后自动通过。
  - 想体验审核流程：把它改成 `false`（或删掉这一行），再运行 `npm.cmd run approve-driver -- 司机邮箱@example.com` 批准。
  - **上线前必须关闭 `DRIVER_AUTO_APPROVE`。**
- 服务器负责的规则（网页里的按钮不能绕过）：
  - 订单价格由服务器按 `src/pricing.js` 计算，网页传来的价格会被忽略。
  - 订单状态只能这样流转：待接单 → 已接单 → 行程中 → 已完成；乘客可在“已接单”之前取消；结束后不能再变。
  - 两位司机同时抢同一单，只有一位成功；一位司机同一时间只能有一个进行中的行程。
  - 每位乘客最多同时有 5 个未结束的订单；每月前 3 次取消免费，之后收订单金额 5%（按罗马时区的自然月重置）。
  - 评价 24 小时内、投诉 7 天内、失物 1 个月内；同一订单只能评价一次。
  - 司机接单前看不到乘客姓名。
- 目前距离仍由用户在页面上拖动输入，服务器只能限制范围；接入地图后才能由服务器按真实路线计算。

## 测试

```powershell
npm.cmd test           # 不需要数据库，几秒钟跑完：账号权限、订单规则、价格、网页与服务器联调、防注入
npm.cmd run test:db    # 连接你 .env 里的 Aiven 数据库，把同一套接口规则用真实 SQL 再跑一遍
```

`test:db` 会创建一些邮箱以 `@migo-test.invalid` 结尾的测试账号和订单，结束后自动删除，不会碰其他数据。**改了 `repository.js` 或 `db/schema.sql` 之后请运行它。**

## 直接双击打开（演示模式）

双击 `passenger-miniapp/index.html` 或 `driver-miniapp/index.html` 都能打开独立界面，但无法连接云数据库，会自动使用本机浏览器的临时演示数据（此模式**不需要登录**，也没有权限控制）。数据库没有配置时，运行 `npm.cmd run dev` 也是这个模式。要让两个端使用同一订单数据，必须按上面的方式运行 `npm.cmd run dev`。

## 功能

- 即时叫车、预约、机场接送、半日/全日包车。
- 路线模拟、不同路线报价与公里阶梯计价。
- 司机接单/拒单、开始和完成行程；拒绝的订单只对该司机隐藏，其他司机仍能接。
- 偏航安全提醒、评分、投诉、失物招领。
- 支付方式与车型的练习界面（真实支付仍未接入）。

## 数据库结构

运行 `npm.cmd run db:migrate` 会创建：

- `users`：乘客和司机账号（密码只存加密结果；司机是否通过审核；每月取消次数）。
- `sessions`：登录状态（只存令牌的哈希）。
- `orders`：订单状态、所属乘客、接单司机，以及完整订单数据。
- `order_declines`：司机拒绝过的订单。
- `ratings`、`complaints`、`lost_items`：服务记录，属于提交它的乘客。
- `profiles`、`app_meta`：第一版留下的旧表，现在不再使用（没有数据丢失，确认没用后可手动删除）。

第一版留下的旧订单没有所属乘客，所以不会出现在任何人的列表里。

详细设计见 [DATABASE_TODO.md](./DATABASE_TODO.md)，SQL 文件见 [db/schema.sql](./db/schema.sql)。

## 目录

```text
ride-miniapp-demo/
├── .env.example             # Aiven 数据库连接模板（无密码）
├── db/schema.sql            # PostgreSQL 建表 SQL
├── database.js              # 安全读取 .env、连接 Aiven SSL
├── repository.js            # 数据库读写（所有 SQL 都在这里）
├── rules.js                 # 业务规则：输入校验、订单状态流转、生成订单、谁能看什么
├── auth.js                  # 密码加密、登录令牌、登录次数限制
├── pricing-loader.js        # 让服务器复用 src/pricing.js 的计价规则
├── errors.js                # 带状态码的错误
├── server.js                # 静态页面 + API 后端（文件限制开关 LOCK_STATIC_FILES 在文件开头，部署前改成 true）
├── passenger-miniapp/       # 独立乘客小程序（index.html、app.js、styles.css）
├── driver-miniapp/          # 独立司机小程序（index.html、app.js、styles.css）
├── scripts/
│   ├── check-db.js          # 检查数据库是否可连
│   ├── migrate.js           # 创建/更新数据表
│   ├── approve-driver.js    # 批准司机账号
│   ├── run-tests.js         # 运行测试
│   └── build-standalone.js  # 构建双击可打开的演示版
├── test/                    # 自动化测试（网页与服务器联调、权限、规则、防注入）
└── src/
    ├── app.js               # 页面与交互
    └── services/api.js      # 前端 API：连接服务器（需登录）；未配置数据库时使用本机演示数据
```

三个人一起开发时的注意事项：

- 每个人自己复制 `.env.example` 为 `.env` 并填入数据库地址。**`.gitignore` 里保护 `.env` 和 `certs/` 的几行目前是注释掉的：加上 `.env` 之后、上传到 Git 之前，请把那几行开头的 `#` 去掉。不要把密码发到群里。**
- `passenger-miniapp/app.js`、`driver-miniapp/app.js`、`src/app-standalone.js` 是由 `src/` 自动生成的。合并代码冲突时，只手动解决 `src/` 里的冲突，然后运行 `npm.cmd run build` 重新生成这三个文件。
- 多人共用同一个数据库时，大家的测试订单会混在一起（每个账号只能看到自己的订单，但司机能看到所有人的待接订单）。

修改前端代码后，若仍要保留“双击打开”模式，请运行：

```powershell
npm.cmd run build
```
