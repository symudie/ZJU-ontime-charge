#!/usr/bin/env node
// 浙江大学尼普顿（新能充电 szlzxn.cn 老系统）定时开电工具
// 控制协议来自作者本人微信 H5 抓包独立还原，仅用于操作本人账号与设备（扣账户预存款）。
//
// 用法：
//   node neptune.mjs login    # 配置向导（粘贴充电页链接，一次即可）
//   node neptune.mjs start    # 开电（幂等：已在充电则跳过）——配合 crontab 做定时开电
//   node neptune.mjs stop     # 结束充电
//   node neptune.mjs status   # 余额 / 充电订单 / 端口状态
//   node neptune.mjs parse    # 从充电页链接解析 openId 等字段（只打印不写配置）
//
// 定时开电（crontab，周一到周五 6:30）：
//   30 6 * * 1-5 /usr/bin/env node /path/to/neptune.mjs start >> /tmp/neptune.log 2>&1

import { readFileSync, writeFileSync } from "node:fs";
import { URLSearchParams } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const BASE = "http://www.szlzxn.cn/wxn";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36 " +
  "NetType/WIFI MicroMessenger/7.0.20.1781(0x6700143B) MacWechat/3.8.7(0x13080712)";

// ===== 账号配置加载：环境变量优先，其次本地配置文件（不入库） =====
function loadLocalConfig() {
  try {
    const p = join(dirname(fileURLToPath(import.meta.url)), "neptune.config.local.json");
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return {};
  }
}
const LOCAL = loadLocalConfig();
const CONFIG = {
  areaId: process.env.NPD_AREA_ID || LOCAL.areaId || "6",
  openId: process.env.NPD_OPEN_ID || LOCAL.openId || "",
  employeeId: process.env.NPD_EMPLOYEE_ID || LOCAL.employeeId || "",
  devaddress: process.env.NPD_DEVADDRESS || LOCAL.devaddress || "",
  port: process.env.NPD_PORT || LOCAL.port || "",
  money: process.env.NPD_MONEY || LOCAL.money || "7", // 页面"开始充电"时的 money 选项（抓包原值，对应预付 ¥2）
};

function requireAccount() {
  if (!CONFIG.openId || !CONFIG.devaddress || !CONFIG.port) {
    console.log(
      "缺少账号配置（openId / devaddress / port）。\n" +
        "推荐运行 `node neptune.mjs login` 走向导；\n" +
        "或设置环境变量 NPD_OPEN_ID / NPD_DEVADDRESS / NPD_PORT，\n" +
        "或参照 neptune.config.local.example.json 创建本地配置（已被 .gitignore 排除）。"
    );
    process.exit(2);
  }
}

const RETRY_POLL = 6; // beginCharge 带 msgflag 轮询次数（设备无响应时重试）
const POLL_INTERVAL = 3000; // 轮询间隔 ms

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yuan = (fen) => `¥${((fen || 0) / 100).toFixed(2)}`;

async function post(path, data) {
  const body = new URLSearchParams(data).toString();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: {
          "User-Agent": UA,
          "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
          Origin: "http://www.szlzxn.cn",
        },
        body,
      });
      return await resp.json();
    } catch (err) {
      if (attempt === 2) throw err;
      await sleep(2000);
    }
  }
}

const getUserInfo = async () =>
  (await post("getUserInfo", { openId: CONFIG.openId, areaId: CONFIG.areaId })).obj ?? {};

const getDeviceInfo = async (devaddress = CONFIG.devaddress) =>
  (await post("getDeviceInfo", { areaId: CONFIG.areaId, devaddress })).obj ?? {};

async function isCharging() {
  const r = await post("isChargeing", { areaId: CONFIG.areaId, openId: CONFIG.openId });
  return r.obj ?? null;
}

// ============================ 配置向导 ============================

const CONFIG_FILE = join(dirname(fileURLToPath(import.meta.url)), "neptune.config.local.json");

// stdin 关闭（EOF/管道输入耗尽）时返回空串而不是抛异常
const ask = (rl, q) => rl.question(q).then((v) => (v ?? "").trim()).catch(() => "");

async function cmdLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log(
      [
        "",
        "配置向导（约 30 秒，全程无需抓包）：",
        "  第 1 步：微信里打开你的充电页（平时扫码充电的那个页面）",
        "  第 2 步：拿到页面链接（新版微信可能没有「复制链接」，任选其一）：",
        "    a) 电脑微信（最稳）：转发充电页给文件传输助手 → 电脑微信点开 → H5 窗口 History",
        "       面板右键条目 → Send to Chat 发回传输助手 → 聊天里右键消息卡片",
        "       → Open with Default Browser → 复制浏览器地址栏",
        "    b) 手机微信：⋯ → 「在浏览器打开」→ 复制地址栏（部分版本仍有）",
        "    c) 老版本微信：⋯ → 「复制链接」直接用",
        "  第 3 步：把链接粘贴到下面（链接里有你的专属 openId，等同账号钥匙，仅存本机、勿外传）",
        "",
      ].join("\n")
    );
    const link = (await ask(rl, "粘贴链接: ")).replace(/&amp;/g, "&");

    let openId = "";
    let employeeId = "";
    let areaId = CONFIG.areaId;

    if (/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/.test(link)) {
      console.log(
        [
          "❌ 你粘贴的是微信 OAuth 授权中间页（openId 不在里面，复制早了）。",
          "  这种链接只能由微信客户端完成授权：在微信里重新点开它，",
          "  等「充电页」完整显示（能看到插座编号）后，再取链接：",
          "  ⋯ → 「在浏览器打开」→ 复制地址栏里 szlzxn.cn/wx/indexn.html?openId=… 的完整网址。",
        ].join("\n")
      );
      return 1;
    }

    const oneTimeCode = (link.match(/[?&]code=([\w-]+)/) || [])[1];
    if (oneTimeCode && /szlzxn\.cn\/wxn\/getOpenId/.test(link)) {
      // 用户复制到了带一次性 code 的跳转链接：尽力换取 openId（code 约 5 分钟有效，可能已被消费）
      console.log("检测到一次性授权 code，尝试换取 openId…");
      try {
        const resp = await fetch(
          `${BASE}/getOpenId?code=${oneTimeCode}&state=${encodeURIComponent("{'areaid':6}")}`,
          { redirect: "manual", headers: { "User-Agent": UA } }
        );
        const loc = resp.headers.get("location") || "";
        openId = new URL(loc).searchParams.get("openId") || "";
      } catch {
        openId = "";
      }
      if (!openId) {
        console.log("❌ code 换取失败（已被微信消费过或已过期）。请回到充电页重新取链接。");
        return 1;
      }
    } else {
      try {
        const u = new URL(link);
        openId = u.searchParams.get("openId") || "";
        employeeId = u.searchParams.get("employeeId") || "";
        areaId = u.searchParams.get("areaid") || u.searchParams.get("areaId") || areaId;
      } catch {
        /* 不是 URL，退化为纯 openId 输入 */
        openId = link;
      }
    }
    if (!openId) {
      console.log(
        "❌ 未能从输入中解析 openId。\n" +
          "请确认复制的是「充电页」本身的网址（形如 szlzxn.cn/wx/indexn.html?openId=…），\n" +
          "而不是微信 OAuth 跳转中间页（open.weixin.qq.com 开头的没有 openId，需等跳转完成后再复制）。"
      );
      return 1;
    }

    const user = (await post("getUserInfo", { openId, areaId })).obj;
    if (!user?.employeeid) {
      console.log("❌ openId 无效或账号不存在，请重新复制链接。");
      return 1;
    }
    employeeId = employeeId || String(user.employeeid);
    console.log(`✅ 账号有效：id=${employeeId}，余额 ${yuan(user.readyaccountmoney)}`);

    // 从充电历史自动发现常用桩与插座
    const now = new Date();
    const term = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, "0")}`;
    const log = (await post("getChargeLog", { employeeid: employeeId, term })).obj ?? [];
    const usage = new Map(); // devaddress -> { count, ports: Map(port->count) }
    for (const rec of log) {
      const addr = String(rec.devaddress);
      const port = String(rec.devport).padStart(2, "0");
      const item = usage.get(addr) ?? { count: 0, ports: new Map() };
      item.count += 1;
      item.ports.set(port, (item.ports.get(port) ?? 0) + 1);
      usage.set(addr, item);
    }
    const devList = [...usage.entries()].sort((a, b) => b[1].count - a[1].count);

    let devaddress = "";
    let port = "";
    if (devList.length) {
      console.log("\n检测到你近期用过的充电桩：");
      const infos = [];
      for (let i = 0; i < devList.length && i < 5; i++) {
        const [addr, info] = devList[i];
        const dev = await getDeviceInfo(addr);
        const topPort = [...info.ports.entries()].sort((a, b) => b[1] - a[1])[0][0];
        infos.push({ addr, topPort });
        console.log(
          `  ${i + 1}. ${dev.devdescript ?? `设备 ${addr}`}（设备号 ${addr}，本月 ${info.count} 次，常用插座 ${topPort}）`
        );
      }
      const pick = Number((await ask(rl, "选择你的桩（序号，回车=1）: ")) || "1") - 1;
      const chosen = infos[pick] ?? infos[0];
      devaddress = chosen.addr;
      port = (await ask(rl, `插座号（两位，回车=${chosen.topPort}）: `)) || chosen.topPort;
    } else {
      console.log("\n没查到本月充电记录，请手动输入（设备号一般印在桩身标签上）：");
      devaddress = await ask(rl, "设备号: ");
      port = await ask(rl, "插座号（两位，如 04）: ");
    }
    if (!/^\d{6,}$/.test(devaddress) || !/^\d{2}$/.test(port)) {
      console.log("❌ 设备号/插座号格式不对（设备号≥6位数字，插座号两位数字）。");
      return 1;
    }

    const merged = { ...LOCAL, areaId, openId, employeeId, devaddress, port, money: LOCAL.money || "7" };
    writeFileSync(CONFIG_FILE, JSON.stringify(merged, null, 2) + "\n");
    console.log(
      `\n✅ 配置已写入 neptune.config.local.json（该文件已被 .gitignore 排除）\n` +
        `现在可以运行：node neptune.mjs status / start / stop\n` +
        `⚠️ openId 等同账号支付钥匙（拿到它就能用你的余额充电），请勿外传。`
    );
    return 0;
  } finally {
    rl.close();
  }
}

// ============================ 链接解析 ============================

/** 从充电页链接/一次性 code 链接/裸 openId 中解析账号字段，只打印不写配置 */
async function cmdParse(rawLink) {
  const link = (rawLink || "").trim().replace(/&amp;/g, "&");
  if (!link) {
    console.log('用法: node neptune.mjs parse "<充电页链接或openId>"');
    return 2;
  }

  let openId = "";
  let employeeId = "";
  let areaId = CONFIG.areaId;
  let accountmoney = "";

  if (/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/.test(link)) {
    console.log(
      "❌ 这是微信 OAuth 授权中间页，里面没有 openId。\n" +
        "它只能由微信客户端完成授权：在微信里点开会跳到真正的充电页，\n" +
        "等充电页完整显示后再复制 szlzxn.cn/wx/indexn.html?openId=… 那条链接。"
    );
    return 1;
  }

  const oneTimeCode = (link.match(/[?&]code=([\w-]+)/) || [])[1];
  if (oneTimeCode && /szlzxn\.cn\/wxn\/getOpenId/.test(link)) {
    console.log("检测到一次性授权 code，尝试换取 openId…（code 约 5 分钟有效且可能已被消费）");
    try {
      const resp = await fetch(
        `${BASE}/getOpenId?code=${oneTimeCode}&state=${encodeURIComponent("{'areaid':6}")}`,
        { redirect: "manual", headers: { "User-Agent": UA } }
      );
      const loc = resp.headers.get("location") || "";
      const u = new URL(loc);
      openId = u.searchParams.get("openId") || "";
      employeeId = u.searchParams.get("employeeId") || "";
      areaId = u.searchParams.get("areaid") || areaId;
    } catch {
      openId = "";
    }
    if (!openId) {
      console.log("❌ code 换取失败（已被微信消费过或已过期）。");
      return 1;
    }
  } else {
    try {
      const u = new URL(link);
      openId = u.searchParams.get("openId") || "";
      employeeId = u.searchParams.get("employeeId") || "";
      areaId = u.searchParams.get("areaid") || u.searchParams.get("areaId") || areaId;
      accountmoney = u.searchParams.get("accountmoney") || "";
    } catch {
      openId = link;
    }
  }

  if (!openId) {
    console.log("❌ 未解析到 openId。请粘贴充电页完整链接（…indexn.html?openId=…）或裸 openId。");
    return 1;
  }
  console.log("解析结果：");
  console.log(`  openId      = ${openId}`);
  if (employeeId) console.log(`  employeeId  = ${employeeId}`);
  if (areaId) console.log(`  areaId      = ${areaId}`);
  if (accountmoney) console.log(`  余额(参考)  = ${yuan(accountmoney)}`);
  console.log("\n提示：openId 等同账号支付钥匙，请勿外传。");
  return 0;
}

// ============================ 充电控制 ============================

async function cmdStatus() {
  requireAccount();
  const [user, dev, ch] = await Promise.all([getUserInfo(), getDeviceInfo(), isCharging()]);
  console.log(`账户余额：${yuan(user.readyaccountmoney)}`);
  console.log(`设备：${dev.devdescript}（${dev.simDevaddress ?? ""}）`);
  console.log(`端口状态：${dev.portstatur}（0空闲 1占用 3故障）`);
  if (ch) {
    console.log(
      `⚠️ 正在充电：插座 ${ch.devport}，开始 ${ch.begindt}，` +
        `预扣 ${yuan(ch.yfMoney)}，已耗电 ${ch.eleconsum}W·h`
    );
  } else {
    console.log("当前没有充电订单。");
  }
  return 0;
}

async function cmdStart() {
  requireAccount();
  const ch = await isCharging();
  if (ch) {
    console.log(`已有充电订单（插座 ${ch.devport}，${ch.begindt} 开始），跳过开电。`);
    return 0;
  }

  const [dev, user] = await Promise.all([getDeviceInfo(), getUserInfo()]);
  const balance = user.readyaccountmoney ?? 0;
  if (balance < 200) {
    console.log(`余额不足（${yuan(balance)}，开电需预扣约 ¥2），中止。`);
    return 1;
  }

  const base = {
    devaddress: CONFIG.devaddress,
    port: CONFIG.port,
    money: CONFIG.money,
    areaId: CONFIG.areaId,
    openId: CONFIG.openId,
    beforemoney: balance,
    devtypeid: dev.devtypeid ?? 40,
    fullStop: 0,
    payType: 1,
    safeOpen: 0,
    safeCharge: dev.safeCharge ?? 9,
    edtType: 0,
    efee: dev.efee ?? 110,
    eCharge: dev.eCharge ?? 55,
    serviceCharge: dev.serviceCharge ?? 55,
    userId: 0,
    yuan7: 0,
  };

  let r = await post("beginCharge", base);
  if (!r.success) {
    console.log(`开电失败：${r.msg}`);
    return 1;
  }
  const msgflag = r.obj;
  console.log(`指令已下发（流水 ${msgflag}），等待设备确认…`);

  let result = null;
  for (let i = 1; i <= RETRY_POLL; i++) {
    await sleep(POLL_INTERVAL);
    result = await post("beginCharge", { ...base, msgflag });
    if (result.success) break;
    if ((result.msg ?? "").includes("设备无响应")) {
      console.log(`设备无响应，第 ${i}/${RETRY_POLL} 次重试…`);
      continue;
    }
    console.log(`开电失败：${result.msg}`);
    return 1;
  }
  if (!result?.success) {
    console.log("设备持续无响应，开电失败。请检查充电器是否插好。");
    return 1;
  }

  const obj = result.obj ?? {};
  console.log(
    `✅ 开始充电成功：插座 ${CONFIG.port}，${obj.begindt ?? ""} 起，` +
      `预扣 ${yuan(obj.yfMoney)}，最长 ${obj.ycTime ?? 0} 分钟`
  );
  return 0;
}

async function cmdStop() {
  requireAccount();
  const ch = await isCharging();
  if (!ch) {
    console.log("当前没有充电订单，跳过。");
    return 0;
  }
  const user = await getUserInfo();
  const base = {
    devaddress: ch.devaddress,
    port: ch.devport,
    openId: CONFIG.openId,
    employeeid: user.employeeid ?? CONFIG.employeeId,
    beforemoney: user.readyaccountmoney ?? 0,
    edtType: 0,
    count: 1,
  };
  const r1 = await post("offCharge", base);
  if (!r1.success) {
    console.log(`结束充电失败：${r1.msg}`);
    return 1;
  }
  const r2 = await post("offCharge", { ...base, count: 2, msgflag: r1.obj });
  if (r2.success) {
    console.log(`✅ 结束充电成功（插座 ${ch.devport}）。退款到账有约 30 秒延迟。`);
    return 0;
  }
  console.log(`结束充电确认失败：${r2.msg}，请到微信里手动确认。`);
  return 1;
}

// ============================ 入口 ============================

const actions = {
  login: cmdLogin,
  parse: cmdParse,
  status: cmdStatus,
  start: cmdStart,
  stop: cmdStop,
};
const cmd = process.argv[2] ?? "status";
if (!actions[cmd]) {
  console.log(
    "浙江大学尼普顿定时开电\n" +
      "用法: node neptune.mjs <login|parse|status|start|stop>\n" +
      "  login    配置向导：粘贴充电页链接即可完成配置（新用户从这里开始）\n" +
      "  parse    从链接解析 openId 等字段（只打印，不写配置）\n" +
      "  status   余额 / 充电订单 / 端口状态\n" +
      "  start    开电（幂等，配合 crontab 做定时开电）\n" +
      "  stop     结束充电"
  );
  process.exit(2);
}
try {
  process.exit((await actions[cmd](process.argv[3])) ?? 0);
} catch (err) {
  console.log(`执行出错：${err.message}`);
  process.exit(1);
}
