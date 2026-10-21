-- Milano Ride：Aiven PostgreSQL 初始化表结构
-- 此文件可重复执行；不会删除已有订单或用户。每次更新代码后运行 npm.cmd run db:migrate 即可。

-- ===================== 第一版的表（保留） =====================

CREATE TABLE IF NOT EXISTS orders (
  id TEXT PRIMARY KEY,
  status TEXT NOT NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS orders_status_updated_idx ON orders (status, updated_at DESC);

CREATE TABLE IF NOT EXISTS ratings (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS complaints (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS lost_items (
  id TEXT PRIMARY KEY,
  order_id TEXT REFERENCES orders(id) ON DELETE SET NULL,
  data JSONB NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '1 month'
);

-- 第一版的 profiles / app_meta 表：第二版起不再使用（改用下面的 users 表），
-- 为了不丢数据这里保留，确认没用后可以手动删除。
CREATE TABLE IF NOT EXISTS profiles (
  role TEXT PRIMARY KEY CHECK (role IN ('passenger', 'driver')),
  data JSONB NOT NULL DEFAULT '{}'::jsonb,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS app_meta (
  key TEXT PRIMARY KEY,
  value JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ===================== 第二版：账号、登录与权限 =====================

-- 用户：乘客和司机都在这张表，用 role 区分。密码只保存加密后的结果。
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('passenger', 'driver')),
  name TEXT NOT NULL,
  approved BOOLEAN NOT NULL DEFAULT FALSE,           -- 司机需要审核通过后才能接单
  profile JSONB NOT NULL DEFAULT '{}'::jsonb,        -- 评分、车辆、电话、是否在线等
  cancellation_count INTEGER NOT NULL DEFAULT 0,     -- 乘客当月已取消次数
  cancellation_period TEXT NOT NULL DEFAULT '',      -- 上面这个次数是哪个月的，例如 2026-09
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
-- 邮箱不区分大小写，且不能重复。
CREATE UNIQUE INDEX IF NOT EXISTS users_email_lower_idx ON users (LOWER(email));

-- 登录状态：数据库里只存令牌的哈希，不存令牌本身。
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at TIMESTAMPTZ NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user_idx ON sessions (user_id);
CREATE INDEX IF NOT EXISTS sessions_expires_idx ON sessions (expires_at);

-- 订单属于谁：乘客、接单的司机。第一版留下的旧订单这两列是空的，不会出现在任何人的列表里。
ALTER TABLE orders ADD COLUMN IF NOT EXISTS passenger_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE orders ADD COLUMN IF NOT EXISTS driver_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE INDEX IF NOT EXISTS orders_passenger_idx ON orders (passenger_id, created_at DESC);
CREATE INDEX IF NOT EXISTS orders_driver_idx ON orders (driver_id, created_at DESC);

-- 订单状态只能是这几种（NOT VALID：只检查新写入的数据，不会因为旧数据报错）。
ALTER TABLE orders DROP CONSTRAINT IF EXISTS orders_status_check;
ALTER TABLE orders ADD CONSTRAINT orders_status_check
  CHECK (status IN ('matching', 'waiting_driver', 'accepted', 'in_progress', 'completed', 'cancelled')) NOT VALID;

-- 评价、投诉、失物属于哪位乘客；同一个订单只能评价一次（只约束第二版之后的新记录）。
ALTER TABLE ratings ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE complaints ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
ALTER TABLE lost_items ADD COLUMN IF NOT EXISTS user_id TEXT REFERENCES users(id) ON DELETE SET NULL;
CREATE UNIQUE INDEX IF NOT EXISTS ratings_one_per_order_idx ON ratings (order_id) WHERE user_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS ratings_user_idx ON ratings (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS complaints_user_idx ON complaints (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS lost_items_user_idx ON lost_items (user_id, created_at DESC);

-- 司机点了“拒绝”的订单：只对这位司机隐藏，其他司机仍然能看到。
CREATE TABLE IF NOT EXISTS order_declines (
  order_id TEXT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  driver_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (order_id, driver_id)
);
