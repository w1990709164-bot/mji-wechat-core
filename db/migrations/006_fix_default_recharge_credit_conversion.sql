-- 修正已创建默认套餐与未支付订单的额度换算
-- 定价规则：1 额度 = 0.005 RMB

BEGIN;

UPDATE recharge_packages
SET credits = 2000,
    description = '约可完成 200 次正常回复',
    updated_at = NOW()
WHERE code = 'starter-10'
  AND price_cents = 1000;

UPDATE recharge_packages
SET credits = 6000,
    description = '约可完成 600 次正常回复',
    updated_at = NOW()
WHERE code = 'standard-30'
  AND price_cents = 3000;

UPDATE recharge_packages
SET credits = 10000,
    description = '约可完成 1000 次正常回复',
    updated_at = NOW()
WHERE code = 'plus-50'
  AND price_cents = 5000;

UPDATE recharge_orders o
SET credits = CASE p.code
      WHEN 'starter-10' THEN 2000
      WHEN 'standard-30' THEN 6000
      WHEN 'plus-50' THEN 10000
      ELSE o.credits
    END,
    updated_at = NOW()
FROM recharge_packages p
WHERE o.tenant_id = p.tenant_id
  AND o.package_id = p.id
  AND o.status = 'pending'
  AND (
    (p.code = 'starter-10' AND o.amount_cents = 1000)
    OR (p.code = 'standard-30' AND o.amount_cents = 3000)
    OR (p.code = 'plus-50' AND o.amount_cents = 5000)
  );

COMMIT;
