#!/usr/bin/env node
// 尼普顿充电全能脚本（szlzxn.cn 老系统）：站点监视 + 定时开电
// 站点数据与思路来源：ZJU-Charger (https://github.com/ZJU-Charger/ZJU-Charger)
// 设备控制协议来自作者本人微信 H5 抓包独立还原，仅用于操作本人账号与设备。
//
// 用法：
//   node neptune.mjs status        # 本人：余额 / 充电中订单 / 我的桩端口状态
//   node neptune.mjs start         # 本人：开电（幂等）
//   node neptune.mjs stop          # 本人：结束充电（幂等）
//   node neptune.mjs stations      # 全校：站点空闲/占用/故障一览（无需账号）
//   node neptune.mjs watch [分钟]  # 持续监视（默认 5 分钟一轮），有站点空出插座时弹通知
//
// 账号配置：环境变量（NPD_*）或脚本同目录的 neptune.config.local.json（已被 .gitignore 排除，
// 模板见 neptune.config.local.example.json）。监视类命令（stations/watch）不需要账号。
//
// crontab 示例（周一到周五 6:30 自动开电）：
//   30 6 * * 1-5 /usr/bin/env node /path/to/neptune.mjs start >> /tmp/neptune.log 2>&1

import { readFileSync, writeFileSync } from "node:fs";
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
};

function requireAccount() {
  if (!CONFIG.openId || !CONFIG.devaddress || !CONFIG.port) {
    console.log(
      "缺少账号配置（openId / devaddress / port）。\n" +
        "两种方式任选：\n" +
        "  1. 设置环境变量 NPD_OPEN_ID / NPD_DEVADDRESS / NPD_PORT\n" +
        "  2. 在脚本同目录创建 neptune.config.local.json（模板：neptune.config.local.example.json，该文件已被 .gitignore 排除）\n" +
        "获取方式：用抓包工具观察「尼普顿智慧生活」/ 公众号充电页的一次开电请求，仅限本人账号。"
    );
    process.exit(2);
  }
}

const RETRY_POLL = 6; // beginCharge 带 msgflag 轮询次数
const POLL_INTERVAL = 3000; // 开电轮询间隔 ms
const WATCH_CONCURRENCY = 5; // 站点监视并发数（对服务器友好）
const WATCH_GAP_MS = 150; // 每个请求之间的间隔

// ===== 站点清单（来源：ZJU-Charger neptune_stations.csv，2025-12 版；浙大玉泉/紫金港/华家池） =====
const STATIONS = [
  { campus: "玉泉", name: "出版社楼南侧", devices: ["60459110", "60459111"] },
  { campus: "玉泉", name: "原电工厂", devices: ["50359160", "50359161", "60359118", "60359119"] },
  { campus: "玉泉", name: "建发宿舍（内部）", devices: ["60459101", "60459102"] },
  { campus: "玉泉", name: "教七北侧", devices: ["51059127", "60359122", "60359123"] },
  { campus: "玉泉", name: "教三北侧", devices: ["50359156"] },
  { campus: "玉泉", name: "教十八西侧", devices: ["60359120", "60359121"] },
  { campus: "玉泉", name: "教十（内部）", devices: ["60459109"] },
  { campus: "玉泉", name: "新桥门南侧", devices: ["60359102", "60359127", "60359131"] },
  { campus: "玉泉", name: "曹光彪楼南侧", devices: ["50359162", "50359163", "60459119", "60459120"] },
  { campus: "玉泉", name: "生仪楼南侧", devices: ["50559147", "50559148", "50559149", "50559150"] },
  { campus: "玉泉", name: "电机楼南侧", devices: ["60459129", "60459130"] },
  { campus: "玉泉", name: "科工楼东侧", devices: ["60659111"] },
  { campus: "玉泉", name: "行政楼北侧", devices: ["60359116", "60359117"] },
  { campus: "玉泉", name: "高分子系北侧", devices: ["50359157", "50359164", "50359165", "50359166", "50359167"] },
  { campus: "紫金港", name: "东区留学生A座南侧", devices: ["50559155", "50559154", "50559153", "50559157", "50559158", "50559156"] },
  { campus: "紫金港", name: "东区留学生B座北侧", devices: ["60459124", "60459122", "60459123", "60459112", "60459121"] },
  { campus: "紫金港", name: "西区澄月8舍北侧", devices: ["60359101", "60359102", "60359103"] },
  { campus: "紫金港", name: "西区澄月9舍东侧", devices: ["60359104", "60359105", "60359106", "60359107", "60359108", "60359109"] },
  { campus: "紫金港", name: "化学楼（北）", devices: ["60459108", "60459106"] },
  { campus: "紫金港", name: "化学楼（南）", devices: ["60659108", "60659107"] },
  { campus: "紫金港", name: "东四北侧", devices: ["60459114", "60459115", "60459116", "60459128"] },
  { campus: "紫金港", name: "农学院", devices: ["60359110", "60359124"] },
  { campus: "紫金港", name: "生科院", devices: ["60659105", "60659106"] },
  { campus: "紫金港", name: "药学院", devices: ["60359126", "60359132", "60359133", "60359134", "60359135"] },
  { campus: "紫金港", name: "医学院A区", devices: ["50359171", "50359172", "50359173"] },
  { campus: "紫金港", name: "医学院B区", devices: ["50359168", "50359169", "50359170"] },
  { campus: "紫金港", name: "医学院C区", devices: ["50559141", "50359158", "50359159"] },
  { campus: "紫金港", name: "医学院南侧", devices: ["40759094", "40759093", "40759092", "40759091", "40759090", "40759089", "40759088", "40759087", "40759086", "40359108", "40759084"] },
  { campus: "紫金港", name: "艺博馆东南角", devices: ["50559142", "50559143", "50559144", "50559145", "50559146", "60459117", "60459118"] },
  { campus: "紫金港", name: "玉湖", devices: ["50959123", "50959124", "50959125", "50959126", "50959127", "50959128", "50959129", "50959130"] },
  { campus: "紫金港", name: "银泉足球场北（西侧）", devices: ["50959101", "50959102", "50959103", "50959104", "50959105", "50959106", "50959117", "50959118", "50959119", "50959120"] },
  { campus: "紫金港", name: "银泉足球场北（东侧）", devices: ["50959107", "50959108", "50959109", "50959110", "50959111", "50959112", "50959113", "50959114", "50959115", "50959116"] },
  { campus: "紫金港", name: "动科院北侧", devices: ["60659109", "60659110"] },
  { campus: "华家池", name: "中心北楼", devices: ["60459125", "60459113", "60459126", "60459127"] },
  { campus: "华家池", name: "图书馆", devices: ["50959131", "50959132"] },
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yuan = (fen) => `¥${((fen || 0) / 100).toFixed(2)}`;
const cjkWidth = (s) => [...s].reduce((w, c) => w + (c.codePointAt(0) > 0xff ? 2 : 1), 0);
const pad = (s, n) => s + " ".repeat(Math.max(0, n - cjkWidth(s)));
const padL = (s, n) => " ".repeat(Math.max(0, n - cjkWidth(s))) + s;

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

// ============================ 站点监视 ============================

async function fetchDevice(id) {
  for (let a = 0; a < 2; a++) {
    try {
      const o = await getDeviceInfo(id);
      const ps = o?.portstatur != null ? String(o.portstatur) : null;
      if (ps) {
        const cnt = (c) => [...ps].filter((x) => x === c).length;
        return { id, ok: true, free: cnt("0"), used: cnt("1"), fault: cnt("3"), total: ps.length };
      }
    } catch {
      /* 重试 */
    }
    await sleep(500);
  }
  return { id, ok: false, free: 0, used: 0, fault: 0, total: 0 };
}

async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let i = 0;
  await Promise.all(
    Array.from({ length: limit }, async () => {
      while (i < items.length) {
        const idx = i++;
        results[idx] = await fn(items[idx]);
        await sleep(WATCH_GAP_MS);
      }
    })
  );
  return results;
}

async function pollStations() {
  const tasks = STATIONS.flatMap((s) => s.devices.map((d) => ({ station: s, device: d })));
  const deviceResults = await mapLimit(tasks, WATCH_CONCURRENCY, ({ device }) => fetchDevice(device));
  const byDevice = new Map(deviceResults.map((r) => [r.id, r]));

  return STATIONS.map((s) => {
    const devs = [...new Set(s.devices)].map((d) => byDevice.get(d));
    const agg = devs.reduce(
      (acc, d) => {
        acc.free += d.free;
        acc.used += d.used;
        acc.fault += d.fault;
        acc.total += d.total;
        if (!d.ok) acc.offline++;
        return acc;
      },
      { free: 0, used: 0, fault: 0, total: 0, offline: 0 }
    );
    return {
      campus: s.campus,
      name: s.name,
      mine: CONFIG.devaddress ? s.devices.includes(CONFIG.devaddress) : false,
      ...agg,
    };
  });
}

function printStations(list, header = "") {
  if (header) console.log(header);
  console.log(
    `${pad("校区", 8)}${pad("站点", 24)}${padL("空闲", 4)}${padL("占用", 4)}${padL("故障", 4)}${padL("总数", 4)}  备注`
  );
  for (const s of list) {
    const remark = [
      s.mine ? "⭐我的桩" : "",
      s.offline ? `⚠️${s.offline}台离线` : "",
    ]
      .filter(Boolean)
      .join(" ");
    console.log(
      `${pad(s.campus, 8)}${pad(s.name, 24)}${padL(String(s.free), 4)}${padL(String(s.used), 4)}${padL(String(s.fault), 4)}${padL(String(s.total), 4)}  ${remark}`
    );
  }
}

async function notify(msg) {
  try {
    await execFileAsync("osascript", [
      "-e",
      `display notification "${msg.replace(/"/g, "")}" with title "尼普顿监视" sound name "Glass"`,
    ]);
  } catch {
    /* 非 GUI 环境忽略 */
  }
}

async function cmdStations() {
  const list = await pollStations();
  const totalFree = list.reduce((a, s) => a + s.free, 0);
  printStations(list, `\n全校站点一览（共 ${list.length} 站，当前总空闲 ${totalFree} 个插座）\n`);
  return 0;
}

async function cmdWatch(minutesArg) {
  const intervalMin = Math.max(1, Number(minutesArg) || 5);
  const lastFree = new Map();
  console.log(`开始监视 ${STATIONS.length} 个站点，每 ${intervalMin} 分钟刷新，Ctrl+C 退出。`);
  while (true) {
    const t0 = new Date();
    const list = await pollStations();
    const totalFree = list.reduce((a, s) => a + s.free, 0);
    const lines = [];
    const notices = [];
    for (const s of list) {
      const prev = lastFree.get(`${s.campus}/${s.name}`);
      lastFree.set(`${s.campus}/${s.name}`, s.free);
      if (prev !== undefined && prev === 0 && s.free > 0) {
        notices.push(`${s.campus}·${s.name} 空出 ${s.free} 个插座`);
      }
      if (s.free > 0) lines.push(`${s.campus}·${s.name} ${s.free}`);
    }
    console.log(
      `[${t0.toLocaleTimeString("zh-CN")}] 总空闲 ${totalFree}：${lines.join("  ") || "全部满员"}`
    );
    if (notices.length) {
      console.log(`🔔 ${notices.join("；")}`);
      await notify(notices.join("；"));
    }
    await sleep(intervalMin * 60_000);
  }
}

// ============================ 本人控制 ============================

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
        "    a) 右上角 ⋯ → 「在浏览器打开」→ 在浏览器地址栏复制完整网址",
        "    b) ⋯ → 转发给「文件传输助手」→ 在电脑微信点开 → 窗口右上角「在浏览器打开」→ 复制网址",
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
    console.log("用法: node neptune.mjs parse \"<充电页链接或openId>\"");
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

// ============================ 入口 ============================

const actions = {
  login: cmdLogin,
  parse: cmdParse,
  status: cmdStatus,
  start: cmdStart,
  stop: cmdStop,
  stations: cmdStations,
  watch: cmdWatch,
};
const cmd = process.argv[2] ?? "status";
if (!actions[cmd]) {
  console.log(
    "用法: node neptune.mjs <login|parse|status|start|stop|stations|watch [分钟]>\n" +
      "  login    配置向导：粘贴充电页链接即可完成配置（推荐新用户从这里开始）\n" +
      "  parse    从链接里解析 openId 等字段（只打印，不写配置）\n" +
      "  status   本人余额/订单/端口（需账号配置）\n" +
      "  start    幂等开电（需账号配置）\n" +
      "  stop     幂等断电（需账号配置）\n" +
      "  stations 全校站点空闲一览（无需账号）\n" +
      "  watch    持续监视（默认 5 分钟/轮，空出插座弹系统通知，无需账号）"
  );
  process.exit(2);
}
try {
  process.exit((await actions[cmd](cmd === "parse" ? process.argv[3] : process.argv[3])) ?? 0);
} catch (err) {
  console.log(`执行出错：${err.message}`);
  process.exit(1);
}
try {
  process.exit((await actions[cmd](process.argv[3])) ?? 0);
} catch (err) {
  console.log(`执行出错：${err.message}`);
  process.exit(1);
}
