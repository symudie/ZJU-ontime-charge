#!/usr/bin/env node
// 浙江大学尼普顿（新能充电 szlzxn.cn 老系统）定时开电工具
// 控制协议来自作者本人微信 H5 抓包独立还原，仅用于操作本人账号与设备（扣账户预存款）。
//
// 用法：
//   node neptune.mjs login    # 配置向导（粘贴充电页链接，一次即可）
//   node neptune.mjs install  # 一键写入 crontab 定时开电（install [HH:MM] [周几]，如 install 6:30 1-5）
//   node neptune.mjs start     # 开电（用配置里的桩位，幂等）
//   node neptune.mjs chargeon  # 预约下一个 6:30 自动开电：chargeon <设备编号> <插座号>
//                              # chargeon now ... = 立即开电；chargeon cancel = 取消预约
//   node neptune.mjs stop      # 结束充电
//   node neptune.mjs serve     # 预约服务器：POST {time,设备号,插座号} 到点自动开电
//   node neptune.mjs status   # 余额 / 充电订单 / 端口状态
//   node neptune.mjs parse    # 从充电页链接解析 openId 等字段（只打印不写配置）

import { readFileSync, writeFileSync } from "node:fs";
import http from "node:http";
import { URLSearchParams } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createInterface } from "node:readline/promises";

const execFileAsync = promisify(execFile);

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
  serverChanKey: process.env.NPD_SERVERCHAN_KEY || LOCAL.serverChanKey || "", // Server酱 SendKey（可选，开电结果推送到微信）
  retryMinutes: Number(process.env.NPD_RETRY_MINUTES ?? LOCAL.retryMinutes ?? 15), // start 失败重试窗口（分钟），应对桩未到营业时间
  serveToken: process.env.NPD_SERVE_TOKEN || LOCAL.serveToken || "", // 预约服务访问令牌（可选，公网部署建议设置）
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

/** Server酱推送（未配置 key 时为空操作，失败不影响主流程） */
async function push(title, desp) {
  if (!CONFIG.serverChanKey) return;
  try {
    await fetch(`https://sctapi.ftqq.com/${CONFIG.serverChanKey}.send`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ title, desp }).toString(),
    });
  } catch {
    /* 忽略推送失败 */
  }
}

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

// 交互模式（TTY）走 readline；管道模式一次性读完 stdin 按行分发（readline 在管道下会丢行）
let pipedLines = null;
async function readAllStdin() {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString();
}
async function ask(rl, q) {
  if (!process.stdin.isTTY) {
    if (pipedLines === null) pipedLines = (await readAllStdin()).split("\n").map((s) => s.trim());
    return pipedLines.shift() ?? "";
  }
  return rl
    .question(q)
    .then((v) => (v ?? "").trim())
    .catch(() => "");
}

async function cmdLogin() {
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
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
    rl?.close();
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
  // start 是给定时任务用的：失败自动重试（默认 15 分钟窗口，覆盖桩实际 6:35 左右才上线的情况）
  return startCharging(CONFIG.devaddress, CONFIG.port, CONFIG.retryMinutes);
}

/** 计算下一个开电时点：6:30；早上 10 点前运行都算"今天早上这轮"（到点即触发，靠重试窗口兜住） */
function nextChargeTime() {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 30);
  if (t <= now && now.getHours() >= 10) t.setDate(t.getDate() + 1);
  return t;
}

/** chargeon：预约下一个 6:30 左右自动开电（写预约队列，由 serve 到点执行）
 *  chargeon [设备号] [插座号]           → 预约
 *  chargeon now [设备号] [插座号]       → 不预约，立即开电（人在场）
 *  chargeon cancel                      → 取消预约 */
async function cmdChargeOn(a, b, c, d) {
  requireAccount();
  if (a === "cancel") {
    saveAppointments([]);
    console.log("✅ 已取消预约。");
    return 0;
  }
  if (a === "now") {
    return chargeInteractive(b, c);
  }

  let devaddress = (a || "").trim();
  let port = (b || "").trim();
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (!devaddress) devaddress = await ask(rl, "设备编号（如 50359162）: ");
    if (!port) port = await ask(rl, "插座号（两位，如 04）: ");
  } finally {
    rl?.close();
  }
  if (!/^\d{6,}$/.test(devaddress) || !/^\d{2}$/.test(port)) {
    console.log("❌ 格式不对：设备号应为≥6位数字，插座号为两位数字。");
    return 1;
  }

  const target = nextChargeTime();
  const timeLocal = `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())} ${pad2(target.getHours())}:${pad2(target.getMinutes())}`;
  saveAppointments([
    {
      time: target.toISOString(),
      timeLocal,
      devaddress,
      port,
      bookedAt: new Date().toISOString(),
    },
  ]);
  console.log(
    `✅ 已预约 ${timeLocal} 自动开电：设备 ${devaddress} 插座 ${port}\n` +
      `到点由 serve 自动执行（幂等 + 15 分钟重试窗口，桩 6:35 上线也不怕）。\n` +
      `取消：node neptune.mjs chargeon cancel`
  );
  await push("尼普顿预约成功", `${timeLocal} 自动开电（设备 ${devaddress} 插座 ${port}）`);
  return 0;
}

/** 立即开电（chargeon now）：一问一答，人在场失败即时报 */
async function chargeInteractive(devArg, portArg) {
  let devaddress = (devArg || "").trim();
  let port = (portArg || "").trim();
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    if (!devaddress) devaddress = await ask(rl, "设备编号（如 50359162）: ");
    if (!port) port = await ask(rl, "插座号（两位，如 04）: ");
  } finally {
    rl?.close();
  }
  if (!/^\d{6,}$/.test(devaddress) || !/^\d{2}$/.test(port)) {
    console.log("❌ 格式不对：设备号应为≥6位数字，插座号为两位数字。");
    return 1;
  }
  return startCharging(devaddress, port, 0);
}

/** 核心开电流程：start（配置里的桩）与 chargeon（现场问桩号）共用
 *  retryMinutes > 0 时失败自动重试（每 30 秒一次），应对桩未营业/设备未上线（如 6:30 定时但实际 6:35 才开） */
async function startCharging(devaddress, port, retryMinutes = 0) {
  const deadline = Date.now() + retryMinutes * 60_000;
  let attempt = 0;
  while (true) {
    attempt++;
    const ch = await isCharging();
    if (ch) {
      if (attempt === 1) console.log(`已有充电订单（插座 ${ch.devport}，${ch.begindt} 开始），跳过开电。`);
      else console.log(`检测到订单已创建（插座 ${ch.devport}），视为开电成功。`);
      return 0;
    }

    const [dev, user] = await Promise.all([getDeviceInfo(devaddress), getUserInfo()]);
    const balance = user.readyaccountmoney ?? 0;
    if (attempt === 1) {
      console.log(
        `本次开电：设备 ${devaddress} 插座 ${port}（${dev.devdescript ?? "未知设备"}，账号 id=${user.employeeid ?? "?"}，余额 ${yuan(balance)}）`
      );
    }
    if (balance < 200) {
      console.log(`余额不足（${yuan(balance)}，开电需预扣约 ¥2），中止。`);
      await push("尼普顿开电中止", `余额不足（${yuan(balance)}），请充值后重试`);
      return 1;
    }
    if (dev.isWorkTime === 0) console.log(`设备未在营业时间（${dev.workTime ?? "?"}），仍尝试提交…`);

    const base = {
      devaddress,
      port,
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
      if (Date.now() < deadline) {
        console.log(
          `开电失败（${r.msg}），30 秒后重试（窗口剩余 ${Math.max(1, Math.ceil((deadline - Date.now()) / 60000))} 分钟）…`
        );
        await sleep(30_000);
        continue;
      }
      console.log(`开电失败：${r.msg}`);
      await push("尼普顿开电失败", r.msg ?? "未知错误");
      return 1;
    }
    const msgflag = r.obj;
    console.log(`指令已下发（流水 ${msgflag}），等待设备确认…`);

    let result = null;
    for (let i = 1; i <= RETRY_POLL; i++) {
      await sleep(POLL_INTERVAL);
      result = await post("beginCharge", { ...base, msgflag });
      if (result.success) break;
      console.log(`设备无响应，第 ${i}/${RETRY_POLL} 次轮询…`);
    }

    if (result?.success) {
      const obj = result.obj ?? {};
      console.log(
        `✅ 开始充电成功：设备 ${devaddress} 插座 ${port}，${obj.begindt ?? ""} 起，` +
          `预扣 ${yuan(obj.yfMoney)}，最长 ${obj.ycTime ?? 0} 分钟`
      );
      await push(
        "尼普顿开电成功",
        `设备 ${devaddress} 插座 ${port}，${obj.begindt ?? ""} 起，预扣 ${yuan(obj.yfMoney)}，余额 ${yuan(user.readyaccountmoney)}` +
          (attempt > 1 ? `（重试 ${attempt - 1} 次后成功）` : "")
      );
      return 0;
    }

    // 设备未确认：可能订单已建但设备未上线，查一下订单再决定是否进入重试
    const pending = await isCharging();
    if (pending) {
      console.log(`订单已创建（插座 ${pending.devport}），设备尚未确认，继续观察…`);
      if (Date.now() < deadline) {
        await sleep(30_000);
        continue;
      }
      console.log("订单已创建但设备长时间未确认，稍后可用 status 查看。");
      return 0;
    }
    if (Date.now() < deadline) {
      console.log(
        `设备持续无响应，30 秒后重试（窗口剩余 ${Math.max(1, Math.ceil((deadline - Date.now()) / 60000))} 分钟）…`
      );
      continue;
    }
    console.log("设备持续无响应，开电失败。请检查充电器是否插好。");
    await push("尼普顿开电失败", "设备持续无响应，请检查充电器是否插好");
    return 1;
  }
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
    await push("尼普顿已断电", `插座 ${ch.devport}，退款稍后到账`);
    return 0;
  }
  console.log(`结束充电确认失败：${r2.msg}，请到微信里手动确认。`);
  return 1;
}

// ============================ 定时任务安装 ============================

const MARK_BEGIN = "# BEGIN neptune-charge";
const MARK_END = "# END neptune-charge";

/** 一键把 start 写入 crontab：自动处理绝对路径、时区、日志，幂等（更新不重复堆积） */
async function cmdInstall(timeArg, daysArg) {
  const match = (timeArg || "").match(/^(\d{1,2}):(\d{2})$/);
  const hh = String(Number(match ? match[1] : 6)).padStart(2, "0");
  const mm = match ? match[2] : "30";
  const days = daysArg && /^[\d*,\-/]+$/.test(daysArg) ? daysArg : "*"; // 默认每天，如 1-5 为工作日
  const script = fileURLToPath(import.meta.url);
  const log = join(dirname(script), "neptune.log");
  const block = [
    MARK_BEGIN,
    "CRON_TZ=Asia/Shanghai",
    `${mm} ${hh} * * ${days} ${process.execPath} ${script} start >> ${log} 2>&1`,
    MARK_END,
  ].join("\n");

  let current = "";
  try {
    current = (await execFileAsync("crontab", ["-l"])).stdout;
  } catch {
    current = ""; // 当前用户没有 crontab
  }
  const cleaned = current
    .replace(new RegExp(`${MARK_BEGIN}[\\s\\S]*?${MARK_END}\\n?`, "m"), "")
    .trimEnd();
  const next = (cleaned ? cleaned + "\n\n" : "") + block + "\n";

  console.log("\n将写入以下定时任务（不影响 crontab 里的其他任务）：\n\n" + block + "\n");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const ok = (await ask(rl, "确认写入 crontab？(y/N): ")).toLowerCase() === "y";
  rl.close();
  if (!ok) {
    console.log("已取消，未做任何修改。");
    return 1;
  }
  await execFileAsync("crontab", ["-"], { input: next });
  console.log("✅ 已安装。`crontab -l` 可查看，日志在同目录 neptune.log。");
  await push("尼普顿定时任务已安装", `每天/每周计划：${hh}:${mm}（周${days}）自动开电`);
  return 0;
}

// ============================ 预约服务器（最简） ============================

const SERVE_FILE = join(dirname(fileURLToPath(import.meta.url)), "neptune.serve.json");
const pad2 = (n) => String(n).padStart(2, "0");

/** 支持 "YYYY-MM-DD HH:MM" / "MM-DD HH:MM" / "HH:MM"（取最近的未来时刻） */
function parseAtTime(str) {
  const now = new Date();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})$/);
  let target;
  if (m) {
    target = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  } else if ((m = str.match(/^(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})$/))) {
    target = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
    if (target <= now) target.setFullYear(target.getFullYear() + 1);
  } else if ((m = str.match(/^(\d{1,2}):(\d{2})$/))) {
    target = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2]);
    if (target <= now) target.setDate(target.getDate() + 1);
  } else {
    return null;
  }
  if (Number.isNaN(target.getTime()) || target <= now) return null;
  return target;
}

function loadAppointments() {
  try {
    return JSON.parse(readFileSync(SERVE_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveAppointments(list) {
  writeFileSync(SERVE_FILE, JSON.stringify(list, null, 2) + "\n");
}

/** 极简预约服务：把 {time, 设备号, 插座号} POST 过来，到点自动执行开电 */
async function cmdServe(portArg) {
  requireAccount();
  const port = Number(portArg) || Number(process.env.NPD_SERVE_PORT) || 7755;
  let appointments = loadAppointments();
  let firing = false;

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj, null, 2));
    };
    if (CONFIG.serveToken && req.headers["x-token"] !== CONFIG.serveToken) {
      return send(401, { ok: false, error: "令牌不对" });
    }
    const url = new URL(req.url, "http://localhost");
    try {
      if (req.method === "GET" && (url.pathname === "/" || url.pathname === "/status")) {
        let charging = null;
        try {
          charging = await isCharging();
        } catch {}
        return send(200, {
          ok: true,
          appointments,
          charging: charging ? `插座 ${charging.devport}，${charging.begindt} 起` : null,
        });
      }
      if (req.method === "POST" && url.pathname === "/at") {
        let body = "";
        for await (const c of req) body += c;
        const j = JSON.parse(body || "{}");
        const target = parseAtTime(String(j.time || "").trim());
        if (!target) {
          return send(400, {
            ok: false,
            error: 'time 格式不对，支持 "HH:MM" / "MM-DD HH:MM" / "YYYY-MM-DD HH:MM"',
          });
        }
        const devaddress = /^\d{6,}$/.test(j.devaddress || "") ? j.devaddress : CONFIG.devaddress;
        const pilePort = /^\d{2}$/.test(j.port || "") ? j.port : CONFIG.port;
        appointments = [
          {
            time: target.toISOString(),
            timeLocal: `${target.getFullYear()}-${pad2(target.getMonth() + 1)}-${pad2(target.getDate())} ${pad2(target.getHours())}:${pad2(target.getMinutes())}`,
            devaddress,
            port: pilePort,
            bookedAt: new Date().toISOString(),
          },
        ]; // 最简模型：只保留一条预约，新预约覆盖旧的
        saveAppointments(appointments);
        return send(200, { ok: true, booked: appointments });
      }
      if (req.method === "POST" && url.pathname === "/cancel") {
        appointments = [];
        saveAppointments(appointments);
        return send(200, { ok: true, appointments });
      }
      send(404, { ok: false, error: "POST /at {time,devaddress?,port?} | POST /cancel | GET /status" });
    } catch (err) {
      send(500, { ok: false, error: String(err.message || err) });
    }
  });

  // 每 20 秒重读预约队列文件（支持 chargeon 等外部进程写入）并检查到点；过期超 1 小时的直接丢弃
  setInterval(async () => {
    if (firing) return;
    appointments = loadAppointments();
    const now = Date.now();
    const due = appointments.find((a) => new Date(a.time).getTime() <= now);
    if (!due) return;
    appointments = appointments.filter((a) => a !== due);
    saveAppointments(appointments);
    if (now - new Date(due.time).getTime() > 3600_000) {
      console.log(`[serve] 丢弃过期预约（${due.timeLocal ?? due.time}，已超时 1 小时）`);
      return;
    }
    firing = true;
    console.log(`[serve] 预约到点：设备 ${due.devaddress} 插座 ${due.port}，执行开电…`);
    try {
      const code = await startCharging(due.devaddress, due.port, CONFIG.retryMinutes);
      console.log(`[serve] 开电流程结束，exit=${code}`);
    } catch (err) {
      console.log(`[serve] 开电异常：${err.message}`);
      await push("尼普顿预约开电异常", String(err.message || err));
    }
    firing = false;
  }, 20_000);

  server.listen(port, () => {
    console.log(
      [
        "",
        `预约服务器已启动：http://0.0.0.0:${port}`,
        `  预约  curl -X POST http://127.0.0.1:${port}/at -H 'Content-Type: application/json' \\`,
        `        -d '{"time":"11-08 06:35","devaddress":"${CONFIG.devaddress}","port":"${CONFIG.port}"}'`,
        `  快捷  node neptune.mjs chargeon <设备号> <插座号>   # 预约下一个 6:30`,
        `  查看  curl http://127.0.0.1:${port}/status   或   node neptune.mjs status`,
        `  取消  node neptune.mjs chargeon cancel`,
        CONFIG.serveToken
          ? "  已启用令牌校验（请求头 X-Token）"
          : "  ⚠️ 未设置 serveToken：能访问此端口的人都可以预约（消耗你的余额），公网部署请配置令牌或防火墙",
        "",
      ].join("\n")
    );
  });

  // 常驻：不返回，避免入口处的 process.exit 把刚启动的服务杀掉；Ctrl+C 退出
  await new Promise(() => {});
}

// ============================ 入口 ============================

const actions = {
  login: cmdLogin,
  parse: cmdParse,
  status: cmdStatus,
  start: cmdStart,
  chargeon: cmdChargeOn,
  stop: cmdStop,
  serve: cmdServe,
  install: cmdInstall,
};
const cmd = process.argv[2] ?? "status";
if (!actions[cmd]) {
  console.log(
    "浙江大学尼普顿定时开电\n" +
      "用法: node neptune.mjs <login|parse|status|start|chargeon|stop|serve|install>\n" +
      "  login     配置向导：粘贴充电页链接即可完成配置（新用户从这里开始）\n" +
      "  parse     从链接解析 openId 等字段（只打印，不写配置）\n" +
      "  status    余额 / 充电订单 / 端口状态\n" +
      "  start     开电（用配置里的桩位，幂等，带重试窗口）\n" +
      "  chargeon  预约下一个 6:30 自动开电（chargeon [设备号] [插座号]）\n" +
      "            chargeon now [设备号] [插座号] = 立即开电；chargeon cancel = 取消预约\n" +
      "  stop      结束充电\n" +
      "  serve     预约服务器：POST {time,设备号,插座号} 到点自动开电（serve [端口]）\n" +
      "  install   一键写入 crontab 每日定时（install [HH:MM] [周几]）"
  );
  process.exit(2);
}
try {
  process.exit((await actions[cmd](process.argv[3], process.argv[4], process.argv[5], process.argv[6])) ?? 0);
} catch (err) {
  console.log(`执行出错：${err.message}`);
  process.exit(1);
}
