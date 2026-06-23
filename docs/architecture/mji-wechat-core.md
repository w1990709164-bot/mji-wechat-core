# M叽微信版架构设计（基于 Cyberboss 改造）

## 总体目标

将 Cyberboss 的“单用户本地 Agent”改造为：

> 支持多用户的微信陪伴 AI 服务系统（M叽）

---

## 一、系统分层

### 1. 微信接入层（Channel Layer）
- 微信 Bot Bridge（基于 Cyberboss 保留）
- 负责消息收发
- 支持主动推送（受微信规则约束）

---

### 2. 核心 AI 层（AI Core）

替换单用户 runtime 为多租户系统：

- Chat Runtime（OpenAI / Codex / Claude）
- Prompt Manager（角色系统）
- Context Builder（上下文拼接）

---

### 3. 用户系统（Multi-Tenant Layer）

新增能力：

- user_id（微信 openid）
- tenant_id（付费用户隔离）
- character_id（角色）

---

### 4. 记忆系统（Memory Engine）

替代本地文件：

- 长期记忆（facts）
- 情绪记忆（emotion state）
- 禁忌记忆（avoid list）

---

### 5. 时间与行为系统（Time Core）

- 所有消息统一 timestamp
- 生成 session timeline
- 行为轨迹建模

---

### 6. 主动唤醒系统（Wake Engine）

Cyberboss check-in 改造为：

- 多用户调度器
- 用户级随机唤醒策略
- 微信合规消息发送

---

### 7. 执行系统（Execution Layer）

分级：

- 云端执行（默认聊天）
- 本地执行（高级用户 Codex bridge）

---

## 二、与 Cyberboss 的差异

| 模块 | Cyberboss | M叽微信版 |
|------|----------|-----------|
| 用户模型 | 单用户 | 多租户 |
| 存储 | 本地文件 | 数据库 |
| 主动系统 | 单线程 check-in | 分布式调度 |
| 微信 | 单账号 Bot | 多用户绑定 |
| 商业化 | 无 | 订阅/额度系统 |

---

## 三、下一步开发顺序

1. 多用户数据库结构
2. 微信 user_id 绑定
3. memory service 重写
4. wake engine 多用户调度
5. 角色系统（M叽核心卖点）

---

## 四、原则

- 不破坏 Cyberboss 原结构
- 逐步迁移核心能力
- 所有新增模块必须支持多用户隔离
