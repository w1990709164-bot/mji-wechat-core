"use strict";

const { createPostgresClient, createPostgresPool } = require("./postgres/client");
const { withTenantTransaction } = require("./postgres/tenant-transaction");
const { UserRepository } = require("./repositories/user-repository");
const { ChatRepository } = require("./repositories/chat-repository");
const { PersistentChatRepository } = require("./repositories/persistent-chat-repository");
const { BillingRepository } = require("./repositories/billing-repository");
const { RechargeRepository } = require("./repositories/recharge-repository");
const { MemoryRepository } = require("./repositories/memory-repository");
const { ManagedMemoryRepository } = require("./repositories/managed-memory-repository");
const { PersonaRepository } = require("./repositories/persona-repository");
const { WakeJobRepository } = require("./repositories/wake-job-repository");

function createStorage(config = {}, options = {}) {
  const postgres = createPostgresClient(config, options);

  return {
    postgres,
    users: new UserRepository(postgres.pool),
    chats: new PersistentChatRepository(postgres.pool),
    billing: new BillingRepository(postgres.pool),
    recharge: new RechargeRepository(postgres.pool),
    memories: new ManagedMemoryRepository(postgres.pool),
    personas: new PersonaRepository(postgres.pool),
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
  ManagedMemoryRepository,
  MemoryRepository,
  PersonaRepository,
  PersistentChatRepository,
  RechargeRepository,
  UserRepository,
  WakeJobRepository,
  createPostgresClient,
  createPostgresPool,
  createStorage,
  withTenantTransaction,
};
