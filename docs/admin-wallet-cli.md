# M叽管理员余额工具

管理员余额工具用于在本机 PowerShell 中查询用户、查看余额、充值、补回额度和查看流水，不需要进入 Neon 手动修改数据。

## 查看用户

```powershell
npm run admin:users
```

输出会显示：

- 微信ID；
- 用户UUID；
- 昵称；
- 余额、预留和可用额度；
- 最后活跃时间。

后续命令可使用“微信ID”或“用户UUID”。用户UUID最稳定。

## 查看单个用户余额

```powershell
npm run admin:balance -- --user "微信ID或用户UUID"
```

## 充值

```powershell
npm run admin:topup -- --user "微信ID或用户UUID" --credits 100 --note "购买套餐"
```

充值会增加用户余额，并在 `wallet_transactions` 中创建 `topup` 流水。

## 补回额度

```powershell
npm run admin:refund -- --user "微信ID或用户UUID" --credits 10 --note "失败补偿"
```

补回也会增加用户余额，并创建 `refund` 流水，用于异常补偿或人工退款额度。

## 查看余额流水

```powershell
npm run admin:history -- --user "微信ID或用户UUID" --limit 20
```

流水会区分充值、补回、调用前预留、成功消费和失败释放。

## 安全规则

- 工具只应在管理员自己的电脑或受控服务器上运行；
- `.env` 包含数据库和模型凭据，不得上传、截图或发送给其他人；
- 每次充值和补回都会留下流水，不应直接使用 SQL 修改余额；
- 正式运营时建议在备注中填写订单号或补偿原因；
- 可使用 `--reference` 提供唯一业务编号，重复执行相同业务编号时不会重复充值。

示例：

```powershell
npm run admin:topup -- --user "用户UUID" --credits 200 --note "套餐订单 20260623-001" --reference "order-20260623-001"
```
