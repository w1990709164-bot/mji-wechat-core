# M叽微信版数据库

数据库基线：**PostgreSQL 15+**。

它适合从 50 人规模起步，也方便以后扩展。相比 Cyberboss 原有的单用户 JSON 文件，PostgreSQL 更适合多用户隔离、付费额度、任务队列和长期记忆。

## 迁移顺序

依次执行：

1. `db/migrations/001_initial_schema.sql`
2. `db/migrations/002_fix_optional_fk_delete_actions.sql`

## 核心数据链

```text
tenants
  └─ app_users
      ├─ channel_identities
      ├─ user_characters
      │   ├─ conversations
      │   │   └─ messages
      │   ├─ memories
      │   ├─ life_events
      │   ├─ wake_preferences
      │   └─ wake_jobs
      ├─ subscriptions
      └─ usage_records
```

## 表用途

| 表 | 用途 |
|---|---|
| `tenants` | 运营空间。第一阶段可只有一个 M叽租户。 |
| `app_users` | M叽内部用户主档案。 |
| `channel_accounts` | 微信 Bot 或其他渠道账号。 |
| `channel_identities` | 微信侧用户标识与 M叽内部用户的绑定。 |
| `characters` | 角色模板。 |
| `user_characters` | 某位用户与某角色之间的独立关系实例。 |
| `conversations` | 会话线程。 |
| `messages` | 原始消息、模型输出、时间和 Token。 |
| `memories` | 长期记忆、喜好、边界、承诺和摘要。 |
| `life_events` | 生活轨迹和时间轴事件。 |
| `wake_preferences` | 主动唤醒设置。 |
| `wake_jobs` | 等待执行的主动消息任务。 |
| `subscriptions` | 套餐、有效期和额度。 |
| `usage_records` | 模型调用和成本统计。 |
| `audit_events` | 管理和敏感操作审计。 |

## 身份必须分层

必须区分：

```text
tenant_id        哪个运营空间
user_id          M叽内部用户
provider_user_id  微信等外部渠道的用户标识
```

不能直接把微信用户标识当数据库主键。这样以后重新绑定微信，或新增 Web、App 入口时，用户档案仍然保持不变。

## 角色隔离

`characters` 是公共角色模板，`user_characters` 才保存用户专属状态。

同一个角色可以被不同用户使用，但记忆、情绪、关系和主动频率必须完全隔离。

## 记忆分层

`memories.memory_type` 支持：

```text
profile preference relationship event emotion habit
promise boundary avoid world summary other
```

不要只保存一整段不断增长的聊天摘要。事实、喜好、边界、承诺和事件应分别存储。

## 多租户隔离

业务表都带 `tenant_id`，并启用了 PostgreSQL 行级安全策略。

应用在每个数据库事务开始时都必须设置当前租户。RLS 负责租户之间的隔离；代码仍必须继续使用 `user_id` 和 `user_character_id` 限定查询。

## 删除策略

- 角色和渠道账号优先停用，不直接删除。
- 用户注销先标记状态，再进入延迟清理流程。
- 消息、生活轨迹和账单数据设置明确保留期限。
- 物理删除前写入 `audit_events`。
- 位置、健康和情绪等敏感信息允许用户单独清除。

## 凭据安全

`channel_accounts.credential_ref` 只保存凭据引用，不保存明文密钥或登录令牌。

## 下一步接入文件

后续代码层建议增加：

```text
src/storage/postgres/client.js
src/storage/postgres/tenant-transaction.js
src/storage/repositories/user-repository.js
src/storage/repositories/memory-repository.js
src/storage/repositories/wake-job-repository.js
```

在仓储层完成前，不把现有 JSON 文件读写直接替换成零散 SQL。
