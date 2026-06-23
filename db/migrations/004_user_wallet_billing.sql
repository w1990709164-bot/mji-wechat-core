-- M叽微信版：用户余额、预扣与消费流水
-- Target: PostgreSQL 15+

BEGIN;

CREATE TABLE user_wallets (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  balance_credits numeric(18,3) NOT NULL DEFAULT 0
    CHECK (balance_credits >= 0),
  reserved_credits numeric(18,3) NOT NULL DEFAULT 0
    CHECK (reserved_credits >= 0 AND reserved_credits <= balance_credits),
  status text NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'frozen', 'closed')),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT NOW(),
  updated_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, user_id),
  UNIQUE (tenant_id, id)
);

CREATE INDEX user_wallets_balance_idx
  ON user_wallets (tenant_id, status, balance_credits);

CREATE TRIGGER user_wallets_set_updated_at
BEFORE UPDATE ON user_wallets
FOR EACH ROW EXECUTE FUNCTION mji_set_updated_at();

CREATE TABLE wallet_transactions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  tenant_id uuid NOT NULL REFERENCES tenants(id) ON DELETE CASCADE,
  user_id uuid NOT NULL,
  wallet_id uuid NOT NULL,
  transaction_type text NOT NULL
    CHECK (transaction_type IN (
      'topup', 'reserve', 'capture', 'release', 'refund', 'adjustment'
    )),
  amount_credits numeric(18,3) NOT NULL
    CHECK (amount_credits > 0),
  balance_after numeric(18,3) NOT NULL
    CHECK (balance_after >= 0),
  reserved_after numeric(18,3) NOT NULL
    CHECK (reserved_after >= 0 AND reserved_after <= balance_after),
  reference_key text NOT NULL,
  description text NOT NULL DEFAULT '',
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  occurred_at timestamptz NOT NULL DEFAULT NOW(),
  created_at timestamptz NOT NULL DEFAULT NOW(),
  FOREIGN KEY (tenant_id, user_id)
    REFERENCES app_users(tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, wallet_id)
    REFERENCES user_wallets(tenant_id, id) ON DELETE CASCADE,
  UNIQUE (tenant_id, reference_key),
  UNIQUE (tenant_id, id)
);

CREATE INDEX wallet_transactions_user_time_idx
  ON wallet_transactions (tenant_id, user_id, occurred_at DESC, id DESC);

CREATE INDEX wallet_transactions_type_time_idx
  ON wallet_transactions (tenant_id, transaction_type, occurred_at DESC);

CREATE OR REPLACE FUNCTION mji_create_user_wallet()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  INSERT INTO user_wallets (tenant_id, user_id)
  VALUES (NEW.tenant_id, NEW.id)
  ON CONFLICT (tenant_id, user_id) DO NOTHING;
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS app_users_create_wallet ON app_users;
CREATE TRIGGER app_users_create_wallet
AFTER INSERT ON app_users
FOR EACH ROW EXECUTE FUNCTION mji_create_user_wallet();

INSERT INTO user_wallets (tenant_id, user_id)
SELECT tenant_id, id
FROM app_users
ON CONFLICT (tenant_id, user_id) DO NOTHING;

ALTER TABLE user_wallets ENABLE ROW LEVEL SECURITY;
ALTER TABLE wallet_transactions ENABLE ROW LEVEL SECURITY;

CREATE POLICY user_wallets_tenant_policy ON user_wallets
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());

CREATE POLICY wallet_transactions_tenant_policy ON wallet_transactions
  USING (tenant_id = mji_current_tenant_id())
  WITH CHECK (tenant_id = mji_current_tenant_id());

COMMIT;
