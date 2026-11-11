# ZJU-ontime-charge

浙江大学尼普顿充电桩在指定时间自动开电。

灵感来自 [ZJU-Charger](https://github.com/ZJU-Charger/ZJU-Charger) 

## 快速上手

首先克隆本仓库。

需要 Node.js 18 或更新版本，无需安装 npm 依赖。

```bash
git clone https://github.com/symudie/ZJU-ontime-charge.git
cd ZJU-ontime-charge 
```

进行登录操作。

```bash
node neptune.mjs login    # ① 配置向导，一次即可
```

按提示在电脑微信上获得**充电页链接**，之后粘贴进去：

1. 手机把充电页转发给「文件传输助手」
2. 电脑微信点开 → 打开 H5 窗口的 **History** 面板 → 右键随便一个相关条目 → **Send to Chat** → 发回文件传输助手
3. 聊天里**右键这条消息 → Open with Default Browser** → 复制浏览器地址栏

<p align="center">
  <img src="docs/pc-wechat-history.png" width="400" alt="History 面板：右键条目 Send to Chat">&nbsp;&nbsp;
  <img src="docs/pc-wechat-open-in-browser.png" width="230" alt="右键消息卡片：Open with Default Browser">
</p>

目标链接形如：

```
https://www.szlzxn.cn/wx/indexn.html?openId=****&areaid=6&employeeId=****&accountmoney=…#/
```

请注意千万不要泄漏相关参数。

理论上执行 login 之后会自动生成配置文件，若想手动调整，直接编辑 `neptune.config.local.json` 即可。

## 日常开电：chargeon

晚上插好充电器后执行（设备号和两位插座号按实际填写）：

```bash
node neptune.mjs chargeon 50359162 04    # 预约下一个 6:30 自动开电
node neptune.mjs chargeon cancel           # 取消预约
node neptune.mjs status                    # 看余额 / 在充状态
```

- `chargeon` 只保存预约，不会立即开电；新预约会替换尚未执行的旧预约。
- 时间固定为北京时间的**下一个 6:30**，与电脑或服务器的时区无关。当天 6:30 已过，就预约第二天，不再生成已经过期的任务。
- 执行器会自动在后台启动，每 20 秒检查一次预约；开电时提供 15 分钟重试窗口，覆盖充电桩稍晚上线的情况。执行完毕或预约被取消后会自动退出。
- `chargeon cancel` 取消尚未执行的预约，不会中止已经开始的开电流程；已有充电订单可用 `stop` 或微信结束。
- 运行脚本的电脑或服务器需保持开机、唤醒、联网；关机或休眠期间无法保证定时执行。迟到超过 1 小时的任务会被丢弃，不自动补开电。
- 后台结果查看 `neptune.log`；`status` 查询余额和充电订单，不显示预约队列。实际是否通电仍以设备或微信页面确认为准。

## 其他命令

```bash
node neptune.mjs status   # 余额 / 充电订单
node neptune.mjs stop     # 结束充电（退款约 30 秒到账）
node neptune.mjs --help   # 查看用法
```

## 说明

- 扣费为账户预存款。
- 仅供学习交流与**本人账号**自用自动化；勿操作他人设备、勿高频请求；接口为非官方逆向，随时可能变更。
- 也可复制 `neptune.config.local.example.json` 为 `neptune.config.local.json` 后填写 `openId`。可选字段：`areaId`（默认 `"6"`）、`money`（默认 `"7"`）、`retryMinutes`（默认 `15`，非负有限数字，`0` 表示不进行外层重试）。桩位在每次 `chargeon` 时给出；用户编号会在需要时查询，不用保存到配置。
- 查询请求可自动重试一次；开电、停电请求遇到网络异常时不自动重发，避免结果未确认时重复提交。此时请先用 `status` 或微信确认，再决定下一步。例外：DNS 失败、连接被拒等请求确定未发出的错误，以及查询失败，会在定时开电的重试窗口内自动重试（覆盖刚唤醒时网络未就绪的情况）。
- `neptune.config.local.json`、`neptune.serve.json`、`neptune.serve.pid` 和 `neptune.log` 都是本地运行数据，不应提交到仓库。

## License

[MIT](./LICENSE)
