"use strict";

const { createPostgresClient, createPostgresPool } = require("./postgres/client");
const { withTenantTransaction } = require("./postgres/tenant-transaction");
const { UserRepository } = require("./repositories/user-repository");
const { ChatRepository } = require("./repositories/chat-repository");
const { BillingRepository } = require("./repositories/billing-repository");
const { MemoryRepository } = require("./repositories/memory-repository");
const { WakeJobRepository } = require("./repositories/wake-job-repository");

function createStorage(config = {}, options = {}) {
  const postgres = createPostgresClient(config, options);

  return {
    postgres,
    users: new UserRepository(postgres.pool),
    chats: new ChatRepository(postgres.pool),
    billing: new BillingRepository(postgres.pool),
    memories: new MemoryRepository(postgres.pool),
    wakeJobs: new WakeJobRepository(postgres.pool),

    withTenant(tenantId, callback, transactionOptions = {}) {
      return withTenantTransaction(
        postgres.pool,
        tenantId,
        callback,
        transactionOptions
      );
    },

    async close() {
      await postgres.close();
    },
  };
}

module.exports = {
  BillingRepository,
  ChatRepository,
  MemoryRepository,
  UserRepository,
  WakeJobRepository,
  createPostgresClient,
  createPostgresPool,
  createStorage,
  withTenantTransaction,
};
