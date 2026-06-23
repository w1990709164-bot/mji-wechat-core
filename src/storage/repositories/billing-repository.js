"use strict";

const {
  assertTenantId,
  assertUuid,
  withTenantTransaction,
} = require("../postgres/tenant-transaction");

class BillingRepository {
  constructor(pool) {
    if (!pool || typeof pool.connect !== "function") {
      throw new TypeError("BillingRepository requires a PostgreSQL pool");
    }
    this.pool = pool;
  }

  async ensureWallet(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `INSERT INTO user_wallets (tenant_id, user_id)
           VALUES ($1, $2)
           ON CONFLICT (tenant_id, user_id)
           DO UPDATE SET updated_at = NOW()
           RETURNING id, tenant_id, user_id, balance_credits,
                     reserved_credits, status, metadata,
                     created_at, updated_at`,
          [input.tenantId, input.userId]
        );
        return mapWallet(result.rows[0]);
      },
      { ...options, userId: input.userId }
    );
  }

  async getWallet(input, options = {}) {
    assertTenantId(input?.tenantId);
    assertUuid(input?.userId, "userId");

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const result = await client.query(
          `SELECT id, tenant_id, user_id, balance_credits,
                  reserved_credits, status, metadata,
                  created_at, updated_at
           FROM user_wallets
           WHERE tenant_id = $1 AND user_id = $2
           LIMIT 1`,
          [input.tenantId, input.userId]
        );
        return result.rows[0] ? mapWallet(result.rows[0]) : null;
      },
      { ...options, userId: input.userId }
    );
  }

  async topUpCredits(input, options = {}) {
    return this.applyBalanceIncrease({
      ...input,
      transactionType: input.transactionType || "topup",
    }, options);
  }

  async refundCredits(input, options = {}) {
    return this.applyBalanceIncrease({
      ...input,
      transactionType: "refund",
    }, options);
  }

  async reserveCredits(input, options = {}) {
    validateWalletMutationInput(input);
    const credits = normalizePositiveCredits(input.credits);
    const referenceKey = buildReferenceKey("reserve", input.referenceKey);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const existing = await findTransaction(client, input.tenantId, referenceKey);
        if (existing) {
          return {
            ok: true,
            duplicate: true,
            transaction: mapTransaction(existing),
            wallet: await loadWallet(client, input.tenantId, input.userId),
          };
        }

        const wallet = await lockWallet(client, input.tenantId, input.userId);
        if (!wallet) {
          throw new Error("wallet not found");
        }
        if (wallet.status !== "active") {
          return {
            ok: false,
            code: "wallet_unavailable",
            wallet: mapWallet(wallet),
            requiredCredits: credits,
          };
        }

        const balance = toCreditsNumber(wallet.balance_credits);
        const reserved = toCreditsNumber(wallet.reserved_credits);
        const available = roundCredits(balance - reserved);
        if (available < credits) {
          return {
            ok: false,
            code: "insufficient_balance",
            wallet: mapWallet(wallet),
            availableCredits: available,
            requiredCredits: credits,
          };
        }

        const nextReserved = roundCredits(reserved + credits);
        const updated = await client.query(
          `UPDATE user_wallets
           SET reserved_credits = $3, updated_at = NOW()
           WHERE tenant_id = $1 AND user_id = $2
           RETURNING id, tenant_id, user_id, balance_credits,
                     reserved_credits, status, metadata,
                     created_at, updated_at`,
          [input.tenantId, input.userId, nextReserved]
        );
        const updatedWallet = updated.rows[0];
        const transaction = await insertTransaction(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          walletId: updatedWallet.id,
          transactionType: "reserve",
          credits,
          balanceAfter: updatedWallet.balance_credits,
          reservedAfter: updatedWallet.reserved_credits,
          referenceKey,
          description: input.description || "Reserve credits for AI reply",
          metadata: input.metadata,
        });

        return {
          ok: true,
          duplicate: false,
          wallet: mapWallet(updatedWallet),
          transaction: mapTransaction(transaction),
          reservedCredits: credits,
        };
      },
      { ...options, userId: input.userId }
    );
  }

  async captureCredits(input, options = {}) {
    return this.completeReservation({
      ...input,
      transactionType: "capture",
    }, options);
  }

  async releaseCredits(input, options = {}) {
    return this.completeReservation({
      ...input,
      transactionType: "release",
    }, options);
  }

  async applyBalanceIncrease(input, options = {}) {
    validateWalletMutationInput(input);
    const credits = normalizePositiveCredits(input.credits);
    const transactionType = normalizeIncreaseType(input.transactionType);
    const referenceKey = buildReferenceKey(transactionType, input.referenceKey);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const existing = await findTransaction(client, input.tenantId, referenceKey);
        if (existing) {
          return {
            ok: true,
            duplicate: true,
            transaction: mapTransaction(existing),
            wallet: await loadWallet(client, input.tenantId, input.userId),
          };
        }

        let wallet = await lockWallet(client, input.tenantId, input.userId);
        if (!wallet) {
          await client.query(
            `INSERT INTO user_wallets (tenant_id, user_id)
             VALUES ($1, $2)
             ON CONFLICT (tenant_id, user_id) DO NOTHING`,
            [input.tenantId, input.userId]
          );
          wallet = await lockWallet(client, input.tenantId, input.userId);
        }

        const nextBalance = roundCredits(toCreditsNumber(wallet.balance_credits) + credits);
        const updated = await client.query(
          `UPDATE user_wallets
           SET balance_credits = $3, updated_at = NOW()
           WHERE tenant_id = $1 AND user_id = $2
           RETURNING id, tenant_id, user_id, balance_credits,
                     reserved_credits, status, metadata,
                     created_at, updated_at`,
          [input.tenantId, input.userId, nextBalance]
        );
        const updatedWallet = updated.rows[0];
        const transaction = await insertTransaction(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          walletId: updatedWallet.id,
          transactionType,
          credits,
          balanceAfter: updatedWallet.balance_credits,
          reservedAfter: updatedWallet.reserved_credits,
          referenceKey,
          description: input.description || "Wallet balance increase",
          metadata: input.metadata,
        });

        return {
          ok: true,
          duplicate: false,
          wallet: mapWallet(updatedWallet),
          transaction: mapTransaction(transaction),
        };
      },
      { ...options, userId: input.userId }
    );
  }

  async completeReservation(input, options = {}) {
    validateWalletMutationInput(input);
    const credits = normalizePositiveCredits(input.credits);
    const transactionType = input.transactionType;
    const referenceKey = buildReferenceKey(transactionType, input.referenceKey);
    const reserveKey = buildReferenceKey("reserve", input.referenceKey);

    return withTenantTransaction(
      this.pool,
      input.tenantId,
      async (client) => {
        const existing = await findTransaction(client, input.tenantId, referenceKey);
        if (existing) {
          return {
            ok: true,
            duplicate: true,
            transaction: mapTransaction(existing),
            wallet: await loadWallet(client, input.tenantId, input.userId),
          };
        }

        const reserve = await findTransaction(client, input.tenantId, reserveKey);
        if (!reserve) {
          throw new Error(`reservation not found for ${input.referenceKey}`);
        }

        const oppositeType = transactionType === "capture" ? "release" : "capture";
        const opposite = await findTransaction(
          client,
          input.tenantId,
          buildReferenceKey(oppositeType, input.referenceKey)
        );
        if (opposite) {
          return {
            ok: false,
            code: `already_${oppositeType}d`,
            transaction: mapTransaction(opposite),
            wallet: await loadWallet(client, input.tenantId, input.userId),
          };
        }

        const wallet = await lockWallet(client, input.tenantId, input.userId);
        if (!wallet) throw new Error("wallet not found");

        const balance = toCreditsNumber(wallet.balance_credits);
        const reserved = toCreditsNumber(wallet.reserved_credits);
        if (reserved < credits) {
          throw new Error("reserved credits are lower than requested amount");
        }

        const nextReserved = roundCredits(reserved - credits);
        const nextBalance = transactionType === "capture"
          ? roundCredits(balance - credits)
          : balance;
        if (nextBalance < 0) {
          throw new Error("wallet balance would become negative");
        }

        const updated = await client.query(
          `UPDATE user_wallets
           SET balance_credits = $3,
               reserved_credits = $4,
               updated_at = NOW()
           WHERE tenant_id = $1 AND user_id = $2
           RETURNING id, tenant_id, user_id, balance_credits,
                     reserved_credits, status, metadata,
                     created_at, updated_at`,
          [input.tenantId, input.userId, nextBalance, nextReserved]
        );
        const updatedWallet = updated.rows[0];
        const transaction = await insertTransaction(client, {
          tenantId: input.tenantId,
          userId: input.userId,
          walletId: updatedWallet.id,
          transactionType,
          credits,
          balanceAfter: updatedWallet.balance_credits,
          reservedAfter: updatedWallet.reserved_credits,
          referenceKey,
          description: input.description || `${transactionType} AI reply credits`,
          metadata: input.metadata,
        });

        return {
          ok: true,
          duplicate: false,
          wallet: mapWallet(updatedWallet),
          transaction: mapTransaction(transaction),
        };
      },
      { ...options, userId: input.userId }
    );
  }
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

async function findTransaction(client, tenantId, referenceKey) {
  const result = await client.query(
    `SELECT id, tenant_id, user_id, wallet_id, transaction_type,
            amount_credits, balance_after, reserved_after,
            reference_key, description, metadata,
            occurred_at, created_at
     FROM wallet_transactions
     WHERE tenant_id = $1 AND reference_key = $2
     LIMIT 1`,
    [tenantId, referenceKey]
  );
  return result.rows[0] || null;
}

async function insertTransaction(client, input) {
  const result = await client.query(
    `INSERT INTO wallet_transactions (
       tenant_id, user_id, wallet_id, transaction_type,
       amount_credits, balance_after, reserved_after,
       reference_key, description, metadata
     ) VALUES (
       $1, $2, $3, $4,
       $5, $6, $7,
       $8, $9, $10::jsonb
     )
     RETURNING id, tenant_id, user_id, wallet_id, transaction_type,
               amount_credits, balance_after, reserved_after,
               reference_key, description, metadata,
               occurred_at, created_at`,
    [
      input.tenantId,
      input.userId,
      input.walletId,
      input.transactionType,
      input.credits,
      input.balanceAfter,
      input.reservedAfter,
      input.referenceKey,
      normalizeText(input.description),
      JSON.stringify(asObject(input.metadata)),
    ]
  );
  return result.rows[0];
}

function validateWalletMutationInput(input) {
  assertTenantId(input?.tenantId);
  assertUuid(input?.userId, "userId");
  if (!normalizeText(input?.referenceKey)) {
    throw new Error("referenceKey is required");
  }
}

function normalizePositiveCredits(value) {
  const credits = roundCredits(Number(value));
  if (!Number.isFinite(credits) || credits <= 0) {
    throw new Error("credits must be greater than 0");
  }
  return credits;
}

function normalizeIncreaseType(value) {
  const normalized = normalizeText(value).toLowerCase();
  if (!["topup", "refund", "adjustment"].includes(normalized)) {
    throw new Error("transactionType must be topup, refund, or adjustment");
  }
  return normalized;
}

function buildReferenceKey(prefix, value) {
  return `${prefix}:${normalizeText(value)}`;
}

function roundCredits(value) {
  return Math.round(Number(value) * 1000) / 1000;
}

function toCreditsNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? roundCredits(parsed) : 0;
}

function mapWallet(row) {
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

function mapTransaction(row) {
  return {
    id: row.id,
    tenantId: row.tenant_id,
    userId: row.user_id,
    walletId: row.wallet_id,
    transactionType: row.transaction_type,
    amountCredits: toCreditsNumber(row.amount_credits),
    balanceAfter: toCreditsNumber(row.balance_after),
    reservedAfter: toCreditsNumber(row.reserved_after),
    referenceKey: row.reference_key,
    description: row.description,
    metadata: row.metadata || {},
    occurredAt: row.occurred_at,
    createdAt: row.created_at,
  };
}

function normalizeText(value) {
  return typeof value === "string" ? value.trim() : "";
}

function asObject(value) {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

module.exports = { BillingRepository };
