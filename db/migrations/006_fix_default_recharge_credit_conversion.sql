-- 修正已创建默认套餐的额度换算
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

COMMIT;
