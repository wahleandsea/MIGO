-- Milano Ride：Aiven PostgreSQL 初始化表结构
-- 此文件可重复执行；不会删除已有订单。

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

INSERT INTO profiles (role, data) VALUES
  ('passenger', '{"name":"陈小满","email":"xiaoman@example.com","verified":false}'::jsonb),
  ('driver', '{"name":"Marco Rossi","rating":4.92,"creditScore":98,"italianLicenseVerified":true,"chinaIdVerified":true,"online":true}'::jsonb)
ON CONFLICT (role) DO NOTHING;

INSERT INTO app_meta (key, value) VALUES
  ('cancellationCount', '0'::jsonb),
  ('lastResetAt', to_jsonb(NOW()::text))
ON CONFLICT (key) DO NOTHING;
