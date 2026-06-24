-- M叽微信版：充值套餐、充值订单与幂等到账
-- Target: PostgreSQL 15+

BEGIN;

CREATE TABLE recharge_packages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  code text NOT NULL,
  name text NOT NULL,
  price_cents integer NOT NULL CHECK (price_cents > 0),
  credits numeric(18,3) NOT NULL CHECK (credits > 0),
  description text NOT NULL DEFAULT '',
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'inactive')),
  sort_order integer NOT NULL DEFAULT 100,
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  UNIQUE (tenant_id, code),
  UNIQUE (tenant_id, id)
);

CREATE INDEX recharge_packages_status_sort_idx
  ON recharge_packages (tenant_id, status, sort_order, created_at);

CREATE TRIGGER recharge_packages_set_updated_at
BEFORE UPDATE ON recharge_packages
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE recharge_orders (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  package_id uuid NOT NULL,
  order_no text NOT NULL,
  amount_cents integer NOT NULL CHECK (amount_cents > 0),
  credits numeric(18,3) NOT NULL CHECK (credits > 0),
  status text NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'paid', 'cancelled')),
  payment_note text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  paid_at timestamptz,
  cancelled_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, package_id)
    REFERENCES recharge_packages(tenant_id, id) ON DELETE RESTRICT,
  UNIQUE (tenant_id, order_no),
  UNIQUE (tenant_id, id)
);

CREATE INDEX recharge_orders_user_time_idx
  ON recharge_orders (tenant_id, user_id, created_at DESC, id DESC);

CREATE INDEX recharge_orders_status_time_idx
  ON recharge_orders (tenant_id, status, created_at DESC, id DESC);

CREATE TRIGGER recharge_orders_set_updated_at
BEFORE UPDATE ON recharge_orders
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

ALTER TABLE recharge_packages ENABLE ROW LEVEL SECURITY;
ALTER TABLE recharge_orders ENABLE ROW LEVEL SECURITY;

CREATE POLICY recharge_packages_tenant_policy ON recharge_packages
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());

CREATE POLICY recharge_orders_tenant_policy ON recharge_orders
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());

INSERT INTO recharge_packages (
  tenant_id, code, name, price_cents, credits, description, sort_order
)
SELECT id, 'starter-10', '轻量陪伴包', 1000, 100, '适合短期体验与少量聊天', 10
FROM tenants
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO recharge_packages (
  tenant_id, code, name, price_cents, credits, description, sort_order
)
SELECT id, 'standard-30', '日常陪伴包', 3000, 330, '含 30 额外赠送额度', 20
FROM tenants
ON CONFLICT (tenant_id, code) DO NOTHING;

INSERT INTO recharge_packages (
  tenant_id, code, name, price_cents, credits, description, sort_order
)
SELECT id, 'plus-50', '深度陪伴包', 5000, 600, '含 100 额外赠送额度', 30
FROM tenants
ON CONFLICT (tenant_id, code) DO NOTHING;

COMMIT;
