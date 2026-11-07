# neptune-charge

浙大「尼普顿 / 新能充电」（szlzxn.cn）单文件工具：**全校充电站点空闲监视 + 本人账号定时开电**。零依赖，Node 18+。

灵感与站点数据来自 [ZJU-Charger](https://github.com/ZJU-Charger/ZJU-Charger)（GPLv3），控制协议由作者对本人账号抓包独立还原，代码原创。

## 使用

```bash
node neptune.mjs login      # ① 配置向导（只需一次）
node neptune.mjs start      # 开电（幂等，重复运行自动跳过）
node neptune.mjs stop       # 断电
node neptune.mjs status     # 余额 / 充电订单 / 端口状态
node neptune.mjs stations   # 全校 35 站空闲一览（无需配置）
node neptune.mjs watch 5    # 持续监视，空出插座弹通知（无需配置）
```

### 取链接（login 第 2 步要粘贴的）

新版微信已移除「复制链接」，实测最稳的路径是走**电脑微信**：

1. 手机把充电页转发给「文件传输助手」
2. 电脑微信点开 → 打开 H5 窗口的 **History** 面板 → 右键「充电服务平台」条目 → **Send to Chat** → 发回文件传输助手
3. 聊天里**右键这条消息 → Open with Default Browser** → 复制浏览器地址栏

<p align="center">
  <img src="docs/pc-wechat-history.png" width="400" alt="History 面板：右键条目 Send to Chat">&nbsp;&nbsp;
  <img src="docs/pc-wechat-open-in-browser.png" width="230" alt="右键消息卡片：Open with Default Browser">
</p>

要的就是地址栏里这条（`openId` 在 `#` 之前，等同支付钥匙，勿外传）：

```
https://www.szlzxn.cn/wx/indexn.html?openId=****&areaid=6&employeeId=****&accountmoney=…#/
```

粘贴给 `login` 即可，它会自动校验账号、从你的充电记录里选出常用桩和插座、写入本地配置（已被 `.gitignore` 排除）。也可手动编辑 `neptune.config.local.example.json` 复制出的本地配置，或用环境变量 `NPD_OPEN_ID` / `NPD_DEVADDRESS` / `NPD_PORT` 等。

### 定时开电

```bash
crontab -e
# 周一到周五 6:30 自动开电（桩工作时间 6:00-24:00）
30 6 * * 1-5 /usr/bin/env node /path/to/neptune.mjs start >> /tmp/neptune.log 2>&1
```

## 说明

- 该系统接口无鉴权，身份即链接中的静态 `openId`，扣费为账户预存款，开电/断电均有设备确认轮询与两阶段协议，脚本已复刻。
- 仅供学习交流与**本人账号**自用自动化；勿操作他人设备、勿高频请求；接口随时可能变更。
- 开电前手机上先插好充电器；断电后退款约 30 秒到账。

## License

[MIT](./LICENSE)
