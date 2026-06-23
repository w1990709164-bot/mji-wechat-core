# 多用户数据隔离规则

这份规则约束后续所有 M叽微信版代码。

## 1. 每次查询必须携带的范围

普通用户数据查询至少需要：

```text
tenant_id + user_id
```

角色相关数据查询至少需要：

```text
tenant_id + user_id + user_character_id
```

不能只用消息 ID、微信用户 ID、角色 ID 或会话 ID 单独查询用户数据。

## 2. 微信标识只用于绑定

微信侧标识只存在于 `channel_identities` 中。

收到微信消息后的处理顺序：

```text
微信 provider_user_id
  → channel_identities
  → app_users.id
  → user_characters.id
  → conversations / memories / life_events
```

## 3. 公共角色与用户角色分开

- `characters`：公共模板和基础提示词。
- `user_characters`：用户与角色之间的关系、情绪、称呼和偏好。

禁止把某个用户的关系状态写回 `characters`。

## 4. 记忆的可见范围

- `user_character_id` 有值：只允许对应角色读取。
- `user_character_id` 为空：用户级共享记忆，可由上下文构建器按规则选择。
- `avoid` 和 `boundary` 类型的记忆优先级高于普通偏好。

## 5. 主动唤醒隔离

每条 `wake_jobs` 必须同时绑定：

```text
tenant_id
user_id
user_character_id
```

调度器不能使用一个全局 prompt 扫描所有用户后统一生成消息。每个任务都必须在独立用户上下文中执行。

## 6. 计费记录不可覆盖

`usage_records` 只追加，不在普通业务流程中更新或删除。纠错通过新增冲正记录或审计记录完成。

## 7. 删除与注销

- 停用优先于物理删除。
- 用户注销后停止主动唤醒和模型调用。
- 实际清理前确认订阅、账单和审计保留要求。
- 删除必须写入 `audit_events`。

## 8. 日志脱敏

运行日志不得打印：

- 完整微信用户标识；
- 完整聊天正文；
- API 密钥和登录令牌；
- 用户本地文件内容；
- 精确位置和健康信息。

排查时使用内部 UUID、截断标识和错误码。
