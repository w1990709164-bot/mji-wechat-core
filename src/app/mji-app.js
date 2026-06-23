"use strict";

const { CyberbossApp } = require("../core/app");
const { createStorage } = require("../storage");
const { PlatformRepository } = require("../storage/repositories/platform-repository");

class MjiApp extends CyberbossApp {
  constructor(config) {
    super(config);
    this.mjiStorage = config.databaseUrl ? createStorage(config) : null;
    this.mjiPlatform = this.mjiStorage
      ? new PlatformRepository(this.mjiStorage.postgres.pool)
      : null;
    this.mjiTenant = null;
    this.mjiChannelAccount = null;
  }

  async start() {
    try {
      await this.initializeMjiStorage();
      return await super.start();
    } finally {
      if (this.mjiStorage) {
        await this.mjiStorage.close().catch((error) => {
          console.error(`[mji] database close failed: ${formatError(error)}`);
        });
      }
    }
  }

  async initializeMjiStorage() {
    if (!this.mjiStorage || !this.mjiPlatform) {
      console.warn("[mji] MJI_DATABASE_URL is not configured; running in legacy single-user mode.");
      return null;
    }

    await this.mjiStorage.postgres.ping();
    const account = this.channelAdapter.resolveAccount();
    const tenant = await this.mjiPlatform.ensureTenant({
      slug: this.config.mjiTenantSlug,
      name: this.config.mjiTenantName,
      settings: {
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
      },
    });
    const channelAccount = await this.mjiPlatform.ensureChannelAccount({
      tenantId: tenant.id,
      provider: "weixin",
      providerAccountId: account.accountId,
      displayName: account.userId || account.accountId,
      settings: {
        baseUrl: account.baseUrl,
      },
    });

    this.mjiTenant = tenant;
    this.mjiChannelAccount = channelAccount;
    console.log(`[mji] database=ready tenant=${tenant.slug} channelAccount=${channelAccount.id}`);
    return { tenant, channelAccount };
  }

  async handlePreparedMessage(normalized, options) {
    if (!this.mjiStorage || !this.mjiTenant || !this.mjiChannelAccount) {
      return super.handlePreparedMessage(normalized, options);
    }

    try {
      const identity = await this.mjiStorage.users.resolveOrCreateByChannelIdentity({
        tenantId: this.mjiTenant.id,
        channelAccountId: this.mjiChannelAccount.id,
        providerUserId: normalized.senderId,
        providerChatId: normalized.chatId || normalized.senderId,
        displayName: "微信用户",
        timezone: "Asia/Shanghai",
        locale: "zh-CN",
        profile: {
          source: "weixin",
        },
        identityMetadata: {
          lastMessageId: normalized.messageId || null,
          lastThreadKey: normalized.threadKey || null,
        },
      });

      const enriched = {
        ...normalized,
        mji: {
          tenantId: this.mjiTenant.id,
          channelAccountId: this.mjiChannelAccount.id,
          userId: identity.userId,
          identityId: identity.identity?.id || null,
          isNewUser: Boolean(identity.created),
        },
      };

      if (identity.created) {
        console.log(`[mji] created user=${identity.userId} provider=weixin`);
      }
      return super.handlePreparedMessage(enriched, options);
    } catch (error) {
      console.error(`[mji] user onboarding failed: ${formatError(error)}`);
      await this.channelAdapter.sendText({
        userId: normalized.senderId,
        contextToken: normalized.contextToken,
        text: "系统正在同步你的账号，请稍后再试。",
      }).catch(() => {});
      return false;
    }
  }
}

function formatError(error) {
  return error instanceof Error ? error.stack || error.message : String(error || "unknown error");
}

module.exports = { MjiApp };
