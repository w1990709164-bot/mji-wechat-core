"use strict";

const crypto = require("crypto");
const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

class RechargeRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("RechargeRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async listActivePackages(input, options = {}) {
    assertTenantId(input?.tenantId);
    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `SELECT id, tenant_id, code, name, price_cents, credits,
                  description, status, sort_order, metadata,
                  created_at, updated_at
           FROM recharge_packages
           WHERE tenant_id = $1 AND status = 'active'
           ORDER BY sort_order ASC, price_cents ASC, created_at ASC`,
          [input.tenantId]
        );
        return result.rows.map(mapPackage);
      },
      options
    );
  }

  async listPackages(input, options = {}) {
    assertTenantId(input?.tenantId);
    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `SELECT id, tenant_id, code, name, price_cents, credits,
                  description, status, sort_order, metadata,
                  created_at, updated_at
           FROM recharge_packages
           WHERE tenant_id = $1
           ORDER BY sort_order ASC, price_cents ASC, created_at ASC`,
          [input.tenantId]
        );
        return result.rows.map(mapPackage);
      },
      options
    );
  }

  async createPackage(input, options = {}) {
    assertTenantId(input?.tenantId);
    const value = normalizePackageInput(input);
    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `INSERT INTO recharge_packages (
             tenant_id, code, name, price_cents, credits,
             description, status, sort_order, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::jsonb)
           RETURNING id, tenant_id, code, name, price_cents, credits,
                     description, status, sort_order, metadata,
                     created_at, updated_at`,
          [
            input.tenantId,
            value.code,
            value.name,
            value.priceCents,
            value.credits,
            value.description,
            value.status,
            value.sortOrder,
            JSON.stringify(value.metadata),
          ]
        );
        return mapPackage(result.rows[0]);
      },
      options
    );
  }

  async updatePackage(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.packageId, "packageId");
    const value = normalizePackageInput(input);
    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `UPDATE recharge_packages
           SET code = $3,
               name = $4,
               price_cents = $5,
               credits = $6,
               description = $7,
               status = $8,
               sort_order = $9,
               metadata = metadata || $10::jsonb,
               updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2
           RETURNING id, tenant_id, code, name, price_cents, credits,
                     description, status, sort_order, metadata,
                     created_at, updated_at`,
          [
            input.tenantId,
            input.packageId,
            value.code,
            value.name,
            value.priceCents,
            value.credits,
            value.description,
            value.status,
            value.sortOrder,
            JSON.stringify(value.metadata),
          ]
        );
        return result.rows[0] ? mapPackage(result.rows[0]) : null;
      },
      options
    );
  }

  async createOrder(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    assertUuid(input?.packageId, "packageId");

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const packageResult = await client.query(
          `SELECT id, tenant_id, code, name, price_cents, credits,
                  description, status, sort_order, metadata,
                  created_at, updated_at
           FROM recharge_packages
           WHERE tenant_id = $1 AND id = $2 AND status = 'active'
           LIMIT 1`,
          [input.tenantId, input.packageId]
        );
        const packageRow = packageResult.rows[0];
        if (!packageRow) {
          const error = new Error("充值套餐不存在或已停用");
          error.code = "package_unavailable";
          throw error;
        }

        const orderNo = await createUniqueOrderNo(client, input.tenantId);
        const result = await client.query(
          `INSERT INTO recharge_orders (
             tenant_id, user_id, package_id, order_no,
             amount_cents, credits, status, payment_note, metadata
           ) VALUES ($1, $2, $3, $4, $5, $6, 'pending', '', $7::jsonb)
           RETURNING id, tenant_id, user_id, package_id, order_no,
                     amount_cents, credits, status, payment_note, metadata,
                     paid_at, cancelled_at, created_at, updated_at`,
          [
            input.tenantId,
            input.userId,
            input.packageId,
            orderNo,
            packageRow.price_cents,
            packageRow.credits,
            JSON.stringify(asObject(input.metadata)),
          ]
        );
        return {
          order: mapOrder(result.rows[0]),
          package: mapPackage(packageRow),
        };
      },
      { ...options, userId: input.userId }
    );
  }

  async listUserOrders(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");
    const limit = clampInteger(input.limit, 1, 100, 10);
    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `SELECT o.id, o.tenant_id, o.user_id, o.package_id, o.order_no,
                  o.amount_cents, o.credits, o.status, o.payment_note,
                  o.metadata, o.paid_at, o.cancelled_at,
                  o.created_at, o.updated_at,
                  p.code AS package_code, p.name AS package_name
           FROM recharge_orders o
           JOIN recharge_packages p
             ON p.tenant_id = o.tenant_id AND p.id = o.package_id
           WHERE o.tenant_id = $1 AND o.user_id = $2
           ORDER BY o.created_at DESC, o.id DESC
           LIMIT $3`,
          [input.tenantId, input.userId, limit]
        );
        return result.rows.map(mapOrderWithPackage);
      },
      { ...options, userId: input.userId }
    );
  }

  async listOrders(input, options = {}) {
    assertTenantId(input?.tenantId);
    const limit = clampInteger(input.limit, 1, 500, 200);
    const status = normalizeOrderStatusFilter(input.status);
    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `SELECT o.id, o.tenant_id, o.user_id, o.package_id, o.order_no,
                  o.amount_cents, o.credits, o.status, o.payment_note,
                  o.metadata, o.paid_at, o.cancelled_at,
                  o.created_at, o.updated_at,
                  p.code AS package_code, p.name AS package_name,
                  u.display_name,
                  ci.nickname,
                  ci.provider_user_id
           FROM recharge_orders o
           JOIN recharge_packages p
             ON p.tenant_id = o.tenant_id AND p.id = o.package_id
           JOIN app_users u
             ON u.tenant_id = o.tenant_id AND u.id = o.user_id
           LEFT JOIN LATERAL (
             SELECT nickname, provider_user_id
             FROM channel_identities
             WHERE tenant_id = o.tenant_id AND user_id = o.user_id
             ORDER BY last_seen_at DESC, created_at DESC
             LIMIT 1
           ) ci ON TRUE
           WHERE o.tenant_id = $1
             AND ($2::text IS NULL OR o.status = $2)
           ORDER BY
             CASE o.status WHEN 'pending' THEN 0 WHEN 'paid' THEN 1 ELSE 2 END,
             o.created_at DESC,
             o.id DESC
           LIMIT $3`,
          [input.tenantId, status, limit]
        );
        return result.rows.map((row) => ({
          ...mapOrderWithPackage(row),
          displayName: row.display_name || "微信用户",
          nickname: row.nickname || "",
          providerUserId: row.provider_user_id || "",
        }));
      },
      options
    );
  }

  async confirmOrder(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.orderId, "orderId");
    const paymentNote = normalizeText(input.paymentNote).slice(0, 500);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const orderResult = await client.query(
          `SELECT id, tenant_id, user_id, package_id, order_no,
                  amount_cents, credits, status, payment_note, metadata,
                  paid_at, cancelled_at, created_at, updated_at
           FROM recharge_orders
           WHERE tenant_id = $1 AND id = $2
           FOR UPDATE`,
          [input.tenantId, input.orderId]
        );
        const order = orderResult.rows[0];
        if (!order) {
          const error = new Error("充值订单不存在");
          error.code = "order_not_found";
          throw error;
        }

        if (order.status === "paid") {
          return {
            ok: true,
            duplicate: true,
            order: mapOrder(order),
            wallet: await loadWallet(client, input.tenantId, order.user_id),
          };
        }
        if (order.status === "cancelled") {
          const error = new Error("已取消的订单不能确认到账");
          error.code = "order_cancelled";
          throw error;
        }

        let wallet = await lockWallet(client, input.tenantId, order.user_id);
        if (!wallet) {
          await client.query(
            `INSERT INTO user_wallets (tenant_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (tenant_id, user_id) DO NOTHING`,
            [input.tenantId, order.user_id]
          );
          wallet = await lockWallet(client, input.tenantId, order.user_id);
        }

        const referenceKey = `topup:recharge-order:${order.id}`;
        const existing = await client.query(
          `SELECT id
           FROM wallet_transactions
           WHERE tenant_id = $1 AND reference_key = $2
           LIMIT 1`,
          [input.tenantId, referenceKey]
        );

        let updatedWallet = wallet;
        if (!existing.rows[0]) {
          const nextBalance = roundCredits(
            toCreditsNumber(wallet.balance_credits) + toCreditsNumber(order.credits)
          );
          const walletResult = await client.query(
            `UPDATE user_wallets
             SET balance_credits = $3, updated_at = NOW()
             WHERE tenant_id = $1 AND user_id = $2
             RETURNING id, tenant_id, user_id, balance_credits,
                       reserved_credits, status, metadata,
                       created_at, updated_at`,
            [input.tenantId, order.user_id, nextBalance]
          );
          updatedWallet = walletResult.rows[0];
          await client.query(
            `INSERT INTO wallet_transactions (
               tenant_id, user_id, wallet_id, transaction_type,
               amount_credits, balance_after, reserved_after,
               reference_key, description, metadata
             ) VALUES (
               $1, $2, $3, 'topup',
               $4, $5, $6,
               $7, $8, $9::jsonb
             )`,
            [
              input.tenantId,
              order.user_id,
              updatedWallet.id,
              order.credits,
              updatedWallet.balance_credits,
              updatedWallet.reserved_credits,
              referenceKey,
              `充值订单 ${order.order_no} 到账`,
              JSON.stringify({
                source: "recharge_order",
                orderId: order.id,
                orderNo: order.order_no,
                operator: normalizeText(input.operator) || "local-admin-hub",
              }),
            ]
          );
        }

        const paidResult = await client.query(
          `UPDATE recharge_orders
           SET status = 'paid',
               payment_note = $3,
               paid_at = COALESCE(paid_at, NOW()),
               updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2
           RETURNING id, tenant_id, user_id, package_id, order_no,
                     amount_cents, credits, status, payment_note, metadata,
                     paid_at, cancelled_at, created_at, updated_at`,
          [input.tenantId, input.orderId, paymentNote]
        );

        return {
          ok: true,
          duplicate: Boolean(existing.rows[0]),
          order: mapOrder(paidResult.rows[0]),
          wallet: mapWallet(updatedWallet),
        };
      },
      options
    );
  }

  async cancelOrder(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.orderId, "orderId");
    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `UPDATE recharge_orders
           SET status = 'cancelled',
               cancelled_at = COALESCE(cancelled_at, NOW()),
               updated_at = NOW()
           WHERE tenant_id = $1 AND id = $2 AND status = 'pending'
           RETURNING id, tenant_id, user_id, package_id, order_no,
                     amount_cents, credits, status, payment_note, metadata,
                     paid_at, cancelled_at, created_at, updated_at`,
          [input.tenantId, input.orderId]
        );
        if (result.rows[0]) return mapOrder(result.rows[0]);

        const existing = await client.query(
          `SELECT id, tenant_id, user_id, package_id, order_no,
                  amount_cents, credits, status, payment_note, metadata,
                  paid_at, cancelled_at, created_at, updated_at
           FROM recharge_orders
           WHERE tenant_id = $1 AND id = $2
           LIMIT 1`,
          [input.tenantId, input.orderId]
        );
        if (!existing.rows[0]) return null;
        if (existing.rows[0].status === "paid") {
          const error = new Error("已到账订单不能取消");
          error.code = "order_paid";
          throw error;
        }
        return mapOrder(existing.rows[0]);
      },
      options
    );
  }
}

async function createUniqueOrderNo(client, tenantId) {
  for (let attempt = 0; attempt < 5; attempt += 1) {
    const now = new Date();
    const date = [
      now.getFullYear(),
      String(now.getMonth() + 1).padStart(2, "0"),
      String(now.getDate()).padStart(2, "0"),
    ].join("");
    const suffix = crypto.randomBytes(4).toString("hex").toUpperCase();
    const orderNo = `MJ${date}${suffix}`;
    const result = await client.query(
      `SELECT 1 FROM recharge_orders WHERE tenant_id = $1 AND order_no = $2 LIMIT 1`,
      [tenantId, orderNo]
    );
    if (!result.rows[0]) return orderNo;
  }
  throw new Error("无法生成唯一充值订单号，请重试");
}

async function lockWallet(client, tenantId, userId) {
  const result = await client.query(
    `SELECT id, tenant_id, user_id, balance_credits,
            reserved_credits, status, metadata,
            created_at, updated_at
     FROM user_wallets
     WHERE tenant_id = $1 AND user_id = $2
     FOR UPDATE`,
    [tenantId, userId]
  );
  return result.rows[0] || null;
}

async function loadWallet(client, tenantId, userId) {
  const result = await client.query(
    `SELECT id, tenant_id, user_id, balance_credits,
            reserved_credits, status, metadata,
            created_at, updated_at
     FROM user_wallets
     WHERE tenant_id = $1 AND user_id = $2
     LIMIT 1`,
    [tenantId, userId]
  );
  return result.rows[0] ? mapWallet(result.rows[0]) : null;
}

function normalizePackageInput(input = {}) {
  const code = normalizeText(input.code).toLowerCase().replace(/[^a-z0-9_-]+/g, "-").slice(0, 80);
  const name = normalizeText(input.name).slice(0, 120);
  const priceCents = normalizePositiveInteger(input.priceCents, "priceCents", 10_000_000);
  const credits = normalizePositiveCredits(input.credits);
  const status = normalizeText(input.status).toLowerCase() === "inactive" ? "inactive" : "active";
  if (!code) throw new Error("套餐 code 不能为空");
  if (!name) throw new Error("套餐名称不能为空");
  return {
    code,
    name,
    priceCents,
    credits,
    description: normalizeText(input.description).slice(0, 500),
    status,
    sortOrder: clampInteger(input.sortOrder, 0, 100000, 100),
    metadata: asObject(input.metadata),
  };
}

function normalizeOrderStatusFilter(value) {
  const status = normalizeText(value).toLowerCase();
  return ["pending", "paid", "cancelled"].includes(status) ? status : null;
}

function normalizePositiveInteger(value, fieldName, maximum) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > maximum) {
    throw new Error(`${fieldName} 不合法`);
  }
  return parsed;
}

function normalizePositiveCredits(value) {
  const parsed = roundCredits(Number(value));
  if (!Number.isFinite(parsed) || parsed <= 0 || parsed > 10_000_000) {
    throw new Error("credits 不合法");
  }
  return parsed;
}

function clampInteger(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) ? Math.max(min, Math.min(max, parsed)) : fallback;
}

function mapPackage(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    code: row.code,
    name: row.name,
    priceCents: Number(row.price_cents),
    priceYuan: Number(row.price_cents) / 100,
    credits: toCreditsNumber(row.credits),
    description: row.description || "",
    status: row.status,
    sortOrder: Number(row.sort_order || 0),
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrder(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    packageId: row.package_id,
    orderNo: row.order_no,
    amountCents: Number(row.amount_cents),
    amountYuan: Number(row.amount_cents) / 100,
    credits: toCreditsNumber(row.credits),
    status: row.status,
    paymentNote: row.payment_note || "",
    metadata: row.metadata || {},
    paidAt: row.paid_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOrderWithPackage(row) {
  return {
    ...mapOrder(row),
    packageCode: row.package_code || "",
    packageName: row.package_name || "",
  };
}

function mapWallet(row) {
  if (!row) return null;
  const balanceCredits = toCreditsNumber(row.balance_credits);
  const reservedCredits = toCreditsNumber(row.reserved_credits);
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    balanceCredits,
    reservedCredits,
    availableCredits: roundCredits(balanceCredits - reservedCredits),
    status: row.status,
    metadata: row.metadata || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function roundCredits(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function toCreditsNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundCredits(parsed) : 0;
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { RechargeRepository };
