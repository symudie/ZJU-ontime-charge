# ZJU-ontime-charge

浙江大学尼普顿充电桩在指定时间自动开电。

灵感来自 [ZJU-Charger](https://github.com/ZJU-Charger/ZJU-Charger) 

## 快速上手

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

理论上执行login之后会自动生成配置文件，若你喜欢抓包也可以自行修改，而后把 .example给去除拼成`neptune.config.local.json`。

## 日常开电：chargeon

```console
$ node neptune.mjs chargeon
设备编号: 50359162
插座号: 04
本次开电：设备 50359162 插座 04（浙大玉泉曹光彪wd12a6，账号 id=1668794，余额 ¥6.55）
✅ 开始充电成功：设备 50359162 插座 04，20261107182814 起，预扣 ¥2.00，最长 480 分钟
```

也可一行带参：`node neptune.mjs chargeon 50359162 04`。

## 服务器预约开电

**一次性部署**：

```bash
git clone https://github.com/symudie/ZJU-ontime-charge.git
cd ZJU-ontime-charge && node neptune.mjs login     # clone 不含本地配置，需交互配置一次（之后无需常驻进程，chargeon 自动管理执行器）
```

之后在你想要预约的前一天晚上，执行：

```bash
node neptune.mjs chargeon 50359162 04      # 预约下一个 6:30 自动开电
node neptune.mjs chargeon cancel           # 取消预约
node neptune.mjs status                    # 看余额 / 在充状态
```

- 我们提供了一个15分钟的轮询窗口，充电桩在6.45之前上线都可以正常充上电。

## 其他命令

```bash
node neptune.mjs status   # 余额 / 充电订单 / 端口状态
node neptune.mjs stop     # 结束充电（退款约 30 秒到账）
```

## 说明

- 扣费为账户预存款。
- 仅供学习交流与**本人账号**自用自动化；勿操作他人设备、勿高频请求；接口为非官方逆向，随时可能变更。
- 也可手动配置：复制 `neptune.config.local.example.json` 为 `neptune.config.local.json` 编辑。

## License

[MIT](./LICENSE)
