# neptune-charge

浙大「尼普顿 / 新能充电」（szlzxn.cn 老系统）单文件工具：**全校充电站点空闲监视 + 本人账号定时开电**。零依赖，Node 18+ 直接跑。

> 本项目灵感与站点数据来自 [ZJU-Charger](https://github.com/ZJU-Charger/ZJU-Charger)（GPLv3），感谢原作者。
> 设备控制协议由作者对**本人账号**的一次微信 H5 操作抓包独立还原，代码全部原创编写，未复制上游源码。

## 功能

| 命令 | 说明 | 需要账号 |
|---|---|---|
| `node neptune.mjs stations` | 全校 35 个站点 / 131 台设备的空闲、占用、故障一览 | 否 |
| `node neptune.mjs watch 5` | 持续监视（默认 5 分钟/轮），站点从满员到有空位时弹 macOS 系统通知 | 否 |
| `node neptune.mjs status` | 本人余额、充电中订单、我的桩端口状态 | 是 |
| `node neptune.mjs start` | 定时开电（幂等：已有订单自动跳过；余额不足拒绝；设备无响应自动轮询重试） | 是 |
| `node neptune.mjs stop` | 结束充电（两步确认协议，退款约 30 秒到账） | 是 |

## 配置

复制模板并填入**你自己的**账号信息：

```bash
cp neptune.config.local.example.json neptune.config.local.json
# 编辑 neptune.config.local.json
```

| 字段 | 含义 | 获取方式 |
|---|---|---|
| `openId` | 你的微信 openid（系统唯一身份） | 抓包一次充电页请求 |
| `devaddress` | 桩设备号（桩身二维码对应） | 同上 |
| `port` | 你常用的插座口（两位） | 同上 |
| `employeeId` | 数字用户 id | 同上（仅断电时用到） |
| `money` | 页面"开始充电"发送的金额选项 | 抓包原值（对应预扣 ¥2） |

也可以用环境变量代替：`NPD_OPEN_ID`、`NPD_DEVADDRESS`、`NPD_PORT`、`NPD_EMPLOYEE_ID`、`NPD_MONEY`、`NPD_AREA_ID`。

**`neptune.config.local.json` 已被 `.gitignore` 排除，请勿把含真实 openId 的配置提交到任何仓库。**

## 定时开电

```bash
crontab -e
# 周一到周五 6:30 自动开电（桩工作时间 6:00-24:00）
30 6 * * 1-5 /usr/bin/env node /path/to/neptune.mjs start >> /tmp/neptune.log 2>&1
```

## 工作原理（协议要点）

- 该系统接口无鉴权，身份即请求体中的静态 `openId`，扣费为账户预存款。
- 开电为两阶段：`beginCharge` 先返回订单流水 `msgflag`，客户端需带 `msgflag` 轮询至设备确认（10~20 秒属正常）。
- 断电 `offCharge` 同为两阶段（`count=1` 取流水 → `count=2` 确认）；订单关闭与退款有约 30 秒延迟。
- 端口状态串 `portstatur`：`0` 空闲、`1` 占用、`3` 故障，每台设备 12 路。

## 免责声明

- 本项目仅供学习交流与个人自用自动化（操作**本人**账号、**本人**的设备与余额），不得用于商业用途，不得操作他人账号或设备，不得对服务端进行高频请求或攻击。
- 使用本工具产生的一切后果由使用者自行承担；请遵守学校相关规定及当地法律法规。
- 接口为非官方逆向，随时可能变更，不保证持续可用。

## License

[MIT](./LICENSE)。站点数据来自 ZJU-Charger（GPLv3），按事实数据处理并已在文中署名；如你是上游作者且希望调整引用方式，请提 issue。
