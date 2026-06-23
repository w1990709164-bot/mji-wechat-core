# 自动长期记忆

M叽微信版在每次正常聊天调用中，同时完成回复与少量长期记忆提取，不额外发起第二次模型调用。

## 工作流程

1. 根据当前微信用户读取 `memories` 表中的相关长期记忆；
2. 将长期记忆作为临时系统上下文注入本次模型调用；
3. 模型正常回复，并在不可见区块中输出少量记忆更新；
4. 程序移除不可见区块，用户只会收到正常回复；
5. 程序将新记忆写入或更新到 `memories` 表；
6. 相同稳定 key 的事实会更新，不会无限重复新增。

## 可记录类型

- `profile`：姓名、身份、生日等稳定资料；
- `preference`：长期喜好与厌恶；
- `relationship`：用户与角色的关系变化；
- `event`：重要经历和事件；
- `emotion`：具有长期意义的情绪经历；
- `habit`：稳定习惯；
- `promise`：承诺和约定；
- `boundary`：用户明确提出的边界；
- `avoid`：应避免的话题或行为；
- `world`：用户世界观或长期环境信息；
- `summary`、`other`：其他长期摘要。

普通寒暄、一次性小事和模型推测不会主动保存。密码、验证码、API 密钥、支付卡信息、证件号码、精确家庭地址等高敏感秘密会被过滤。

## 环境变量

```env
MJI_LONG_TERM_MEMORY_ENABLED=true
MJI_LONG_TERM_MEMORY_LIMIT=30
MJI_LONG_TERM_MEMORY_MIN_IMPORTANCE=35
MJI_LONG_TERM_MEMORY_MAX_UPDATES=6
```

这些设置分别控制是否启用、每次最多注入多少条记忆、最低重要度和每轮最多写入多少条更新。

## 成本

长期记忆提取与正常回复共用同一次上游模型调用，因此仍按一次成功回复扣用户 10 额度，上游仍记录一次 4.5 额度成本，不会因为记忆提取再扣一次。

## 测试

先发送：

```text
我不吃香菜，而且每周六下午都会去游泳。
```

正常回复后，在 Neon 查询：

```sql
SELECT memory_type, subject, content, normalized_key,
       importance, confidence, created_at, updated_at
FROM memories
WHERE forgotten_at IS NULL
ORDER BY updated_at DESC
LIMIT 20;
```

应能看到偏好或避免类记忆，以及习惯类记忆。随后聊够多轮或重启程序，再问相关内容，M叽应能自然记得。
