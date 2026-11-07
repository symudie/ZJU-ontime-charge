#!/usr/bin/env node
// 浙江大学尼普顿定时开电：微信充电桩（szlzxn.cn 老系统）单文件工具
// 协议由作者本人账号抓包还原，仅操作本人账号（扣账户预存款）。
// 命令：login 配置 / chargeon 预约下一个6:30 / serve 预约服务器 / status / stop

import { readFileSync, writeFileSync, openSync, closeSync } from "node:fs";
import http from "node:http";
import { URLSearchParams } from "node:url";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { spawn } from "node:child_process";
import { createInterface } from "node:readline/promises";

const DIR = dirname(fileURLToPath(import.meta.url));
const BASE = "http://www.szlzxn.cn/wxn";
const LOCAL = (() => {
  try {
    return JSON.parse(readFileSync(join(DIR, "neptune.config.local.json"), "utf8"));
  } catch {
    return {};
  }
})();
const CONFIG = {
  areaId: LOCAL.areaId || "6",
  openId: LOCAL.openId || "",
  employeeId: LOCAL.employeeId || "",
  devaddress: LOCAL.devaddress || "",
  port: LOCAL.port || "",
  money: LOCAL.money || "7", // 页面开电时的金额选项（对应预扣 ¥2）
  retryMinutes: Number(LOCAL.retryMinutes ?? 15), // 桩 6:35 才上线的重试窗口
  serveToken: LOCAL.serveToken || "", // 公网部署的访问令牌（可选）
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yuan = (fen) => `¥${((fen || 0) / 100).toFixed(2)}`;
const pad2 = (n) => String(n).padStart(2, "0");

async function post(path, data) {
  const body = new URLSearchParams(data).toString();
  for (let attempt = 1; attempt <= 2; attempt++) {
    try {
      const resp = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
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
const isCharging = async () =>
  (await post("isChargeing", { areaId: CONFIG.areaId, openId: CONFIG.openId })).obj ?? null;

function requireAccount() {
  if (!CONFIG.openId || !CONFIG.devaddress || !CONFIG.port) {
    console.log("缺少账号配置，先运行：node neptune.mjs login");
    process.exit(2);
  }
}

// ---- 交互：TTY 走 readline；管道一次性读入按行分发 ----
let piped = null;
async function ask(rl, q) {
  if (!process.stdin.isTTY) {
    if (piped === null) {
      const chunks = [];
      for await (const c of process.stdin) chunks.push(c);
      piped = Buffer.concat(chunks).toString().split("\n").map((s) => s.trim());
    }
    return piped.shift() ?? "";
  }
  return rl
    .question(q)
    .then((v) => (v ?? "").trim())
    .catch(() => "");
}

// ---- 开电核心：两阶段指令（拿流水→轮询确认）+ 失败重试窗口 ----
async function startCharging(devaddress, port, retryMinutes = 0) {
  const deadline = Date.now() + retryMinutes * 60_000;
  let attempt = 0;
  while (true) {
    attempt++;
    const ch = await isCharging();
    if (ch) {
      console.log(
        attempt === 1
          ? `已有充电订单（插座 ${ch.devport}，${ch.begindt} 开始），跳过。`
          : `检测到订单已创建（插座 ${ch.devport}），视为成功。`
      );
      return 0;
    }
    const [dev, user] = await Promise.all([getDeviceInfo(devaddress), getUserInfo()]);
    const balance = user.readyaccountmoney ?? 0;
    if (attempt === 1) {
      console.log(
        `本次开电：设备 ${devaddress} 插座 ${port}（${dev.devdescript ?? "?"}，账号 ${user.employeeid ?? "?"}，余额 ${yuan(balance)}）`
      );
    }
    if (balance < 200) {
      console.log(`余额不足（${yuan(balance)}），中止。`);
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
    if (!r.success && Date.now() >= deadline) {
      console.log(`开电失败：${r.msg}`);
      return 1;
    }
    if (!r.success) {
      console.log(`开电失败（${r.msg}），30 秒后重试…`);
      await sleep(30_000);
      continue;
    }
    const msgflag = r.obj;
    console.log(`指令已下发（流水 ${msgflag}），等待设备确认…`);

    let result = null;
    for (let i = 1; i <= 6; i++) {
      await sleep(3000);
      result = await post("beginCharge", { ...base, msgflag });
      if (result.success) break;
      console.log(`设备无响应，第 ${i}/6 次轮询…`);
    }
    if (result?.success) {
      const obj = result.obj ?? {};
      console.log(
        `✅ 开电成功：设备 ${devaddress} 插座 ${port}，${obj.begindt ?? ""} 起，预扣 ${yuan(obj.yfMoney)}，最长 ${obj.ycTime ?? 0} 分钟` +
          (attempt > 1 ? `（重试 ${attempt - 1} 次后成功）` : "")
      );
      return 0;
    }
    const pending = await isCharging();
    if (pending) {
      console.log(`订单已创建（插座 ${pending.devport}），设备尚未确认，继续观察…`);
      if (Date.now() < deadline) {
        await sleep(30_000);
        continue;
      }
      console.log("订单已创建但设备长时间未确认，稍后用 status 查看。");
      return 0;
    }
    if (Date.now() >= deadline) {
      console.log("设备持续无响应，开电失败。请检查充电器是否插好。");
      return 1;
    }
    console.log(`设备持续无响应，30 秒后重试（窗口剩余 ${Math.max(1, Math.ceil((deadline - Date.now()) / 60000))} 分钟）…`);
    await sleep(30_000);
  }
}

// ---- login：配置向导 ----
async function cmdLogin() {
  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stdout }) : null;
  try {
    console.log(
      "\n配置向导：微信打开充电页 → 取链接（新版微信推荐走电脑微信：转发充电页给文件传输助手 →\n" +
        "电脑微信点开 → History 面板右键条目 → Send to Chat 发回传输助手 → 聊天里右键消息 →\n" +
        "Open with Default Browser → 复制地址栏）。链接含 openId，等同账号钥匙，勿外传。\n"
    );
    const link = (await ask(rl, "粘贴链接: ")).replace(/&amp;/g, "&");
    let openId = "";
    let employeeId = "";
    let areaId = CONFIG.areaId;
    if (/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/.test(link)) {
      console.log("❌ 这是 OAuth 中间页，没有 openId。请在微信里等充电页完整显示后再复制链接。");
      return 1;
    }
    const oneTimeCode = (link.match(/[?&]code=([\w-]+)/) || [])[1];
    if (oneTimeCode && /szlzxn\.cn\/wxn\/getOpenId/.test(link)) {
      console.log("检测到一次性 code，尝试换取 openId…");
      try {
        const resp = await fetch(`${BASE}/getOpenId?code=${oneTimeCode}&state=${encodeURIComponent("{'areaid':6}")}`, {
          redirect: "manual",
        });
        openId = new URL(resp.headers.get("location") || "").searchParams.get("openId") || "";
      } catch {}
      if (!openId) return console.log("❌ code 已被消费或过期，请回到充电页重新取链接。"), 1;
    } else {
      try {
        const u = new URL(link);
        openId = u.searchParams.get("openId") || "";
        employeeId = u.searchParams.get("employeeId") || "";
        areaId = u.searchParams.get("areaid") || areaId;
      } catch {
        openId = link;
      }
    }
    if (!openId) return console.log("❌ 未解析到 openId，请粘贴充电页链接（…indexn.html?openId=…）。"), 1;

    const user = (await post("getUserInfo", { openId, areaId })).obj;
    if (!user?.employeeid) return console.log("❌ openId 无效，请重新复制链接。"), 1;
    employeeId = employeeId || String(user.employeeid);
    console.log(`✅ 账号有效：id=${employeeId}，余额 ${yuan(user.readyaccountmoney)}`);

    // 从本月充电记录自动发现常用桩与插座
    const now = new Date();
    const term = `${now.getFullYear()}${pad2(now.getMonth() + 1)}`;
    const log = (await post("getChargeLog", { employeeid: employeeId, term })).obj ?? [];
    const usage = new Map();
    for (const rec of log) {
      const item = usage.get(String(rec.devaddress)) ?? { count: 0, ports: new Map() };
      item.count++;
      const p = String(rec.devport).padStart(2, "0");
      item.ports.set(p, (item.ports.get(p) ?? 0) + 1);
      usage.set(String(rec.devaddress), item);
    }
    const devs = [...usage.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5);
    let devaddress = "";
    let port = "";
    if (devs.length) {
      console.log("\n检测到你近期用过的充电桩：");
      const infos = [];
      for (const [addr, info] of devs) {
        const dev = await getDeviceInfo(addr);
        const top = [...info.ports.entries()].sort((a, b) => b[1] - a[1])[0][0];
        infos.push({ addr, top });
        console.log(`  ${infos.length}. ${dev.devdescript ?? addr}（${addr}，本月 ${info.count} 次，常用插座 ${top}）`);
      }
      const pick = Number((await ask(rl, "选择你的桩（回车=1）: ")) || "1") - 1;
      const chosen = infos[pick] ?? infos[0];
      devaddress = chosen.addr;
      port = (await ask(rl, `插座号（回车=${chosen.top}）: `)) || chosen.top;
    } else {
      devaddress = await ask(rl, "设备号（桩身标签）: ");
      port = await ask(rl, "插座号（两位）: ");
    }
    if (!/^\d{6,}$/.test(devaddress) || !/^\d{2}$/.test(port)) {
      console.log("❌ 设备号/插座号格式不对。");
      return 1;
    }
    const merged = { ...LOCAL, areaId, openId, employeeId, devaddress, port, money: LOCAL.money || "7" };
    writeFileSync(join(DIR, "neptune.config.local.json"), JSON.stringify(merged, null, 2) + "\n");
    console.log(`\n✅ 配置已写入（该文件不入库）。开电：chargeon；取消：chargeon cancel。`);
    return 0;
  } finally {
    rl?.close();
  }
}

// ---- chargeon：预约下一个 6:30（now=立即，cancel=取消）----
function nextChargeTime() {
  const now = new Date();
  const t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 6, 30);
  if (t <= now && now.getHours() >= 10) t.setDate(t.getDate() + 1); // 10 点前都算今天这轮
  return t;
}
async function cmdChargeOn(...args) {
  requireAccount();
  const [a, b] = args;
  if (a === "cancel") {
    saveAppointments([]);
    console.log("✅ 已取消预约。");
    return 0;
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
    console.log("❌ 格式不对：设备号≥6位数字，插座号两位数字。");
    return 1;
  }
  const t = nextChargeTime();
  const timeLocal = `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`;
  saveAppointments([{ time: t.toISOString(), timeLocal, devaddress, port, bookedAt: new Date().toISOString() }]);
  ensureServeRunning();
  console.log(`✅ 已预约 ${timeLocal} 自动开电：设备 ${devaddress} 插座 ${port}\n取消：node neptune.mjs chargeon cancel`);
  return 0;
}
// ---- serve：极简预约服务器（POST /at 预约，到点自动开电）----
const APPT_FILE = join(DIR, "neptune.serve.json");
const PID_FILE = join(DIR, "neptune.serve.pid");
/** 确保执行器（serve）在后台运行：不在则自动拉起，等价于 nohup ... & */
function ensureServeRunning() {
  try {
    process.kill(Number(readFileSync(PID_FILE, "utf8").trim()), 0);
    return console.log("执行器已在运行，复用现有进程。");
  } catch {}
  const log = openSync(join(DIR, "neptune.log"), "a");
  const child = spawn(process.execPath, [join(DIR, "neptune.mjs"), "serve"], {
    detached: true,
    stdio: ["ignore", log, log],
  });
  child.unref();
  closeSync(log);
  console.log("执行器已在后台启动，开电完成后自动退出（日志：neptune.log）。");
}
function loadAppointments() {
  try {
    return JSON.parse(readFileSync(APPT_FILE, "utf8"));
  } catch {
    return [];
  }
}
function saveAppointments(list) {
  writeFileSync(APPT_FILE, JSON.stringify(list, null, 2) + "\n");
}
function parseAtTime(str) {
  const now = new Date();
  let m = str.match(/^(\d{4})-(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})$/);
  let t;
  if (m) t = new Date(+m[1], +m[2] - 1, +m[3], +m[4], +m[5]);
  else if ((m = str.match(/^(\d{1,2})-(\d{1,2})[ T]+(\d{1,2}):(\d{2})$/))) {
    t = new Date(now.getFullYear(), +m[1] - 1, +m[2], +m[3], +m[4]);
    if (t <= now) t.setFullYear(t.getFullYear() + 1);
  } else if ((m = str.match(/^(\d{1,2}):(\d{2})$/))) {
    t = new Date(now.getFullYear(), now.getMonth(), now.getDate(), +m[1], +m[2]);
    if (t <= now) t.setDate(t.getDate() + 1);
  } else return null;
  return Number.isNaN(t.getTime()) || t <= now ? null : t;
}
async function cmdServe(portArg) {
  requireAccount();
  const port = Number(portArg) || 7755;
  writeFileSync(PID_FILE, String(process.pid));
  let appointments = loadAppointments();
  let firing = false;

  const server = http.createServer(async (req, res) => {
    const send = (code, obj) => {
      res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
      res.end(JSON.stringify(obj, null, 2));
    };
    if (CONFIG.serveToken && req.headers["x-token"] !== CONFIG.serveToken) return send(401, { ok: false, error: "令牌不对" });
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
        const t = parseAtTime(String(j.time || "").trim());
        if (!t) return send(400, { ok: false, error: 'time 支持 "HH:MM" / "MM-DD HH:MM" / "YYYY-MM-DD HH:MM"' });
        appointments = [
          {
            time: t.toISOString(),
            timeLocal: `${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())} ${pad2(t.getHours())}:${pad2(t.getMinutes())}`,
            devaddress: /^\d{6,}$/.test(j.devaddress || "") ? j.devaddress : CONFIG.devaddress,
            port: /^\d{2}$/.test(j.port || "") ? j.port : CONFIG.port,
            bookedAt: new Date().toISOString(),
          },
        ];
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

  // 每 20 秒重读预约队列（chargeon 外部写入也能捡到），到点执行；过期超 1 小时丢弃
  setInterval(async () => {
    if (firing) return;
    appointments = loadAppointments();
    if (appointments.length === 0) {
      console.log("[serve] 队列为空，执行器退出。下次 chargeon 会自动拉起。");
      process.exit(0);
    }
    const now = Date.now();
    const due = appointments.find((a) => new Date(a.time).getTime() <= now);
    if (!due) return;
    appointments = appointments.filter((a) => a !== due);
    saveAppointments(appointments);
    if (now - new Date(due.time).getTime() > 3600_000) return console.log(`[serve] 丢弃过期预约 ${due.timeLocal}`);
    firing = true;
    console.log(`[serve] 预约到点：设备 ${due.devaddress} 插座 ${due.port}，执行开电…`);
    try {
      const code = await startCharging(due.devaddress, due.port, CONFIG.retryMinutes);
      console.log(`[serve] 开电流程结束，exit=${code}`);
    } catch (err) {
      console.log(`[serve] 开电异常：${err.message}`);
    }
    firing = false;
  }, 20_000);

  server.listen(port, () => {
    console.log(
      [
        "",
        `预约服务器已启动：http://0.0.0.0:${port}`,
        `  快捷  node neptune.mjs chargeon <设备号> <插座号>   # 预约下一个 6:30`,
        `  预约  curl -X POST http://127.0.0.1:${port}/at -H 'Content-Type: application/json' -d '{"time":"11-08 06:35"}'`,
        `  查看  curl http://127.0.0.1:${port}/status`,
        `  取消  node neptune.mjs chargeon cancel`,
        CONFIG.serveToken ? "" : "  ⚠️ 公网部署建议配置 serveToken（请求头 X-Token），否则谁都能消耗你的余额",
        "",
      ]
        .filter(Boolean)
        .join("\n")
    );
  });
  await new Promise(() => {}); // 常驻，Ctrl+C 退出
}

// ---- status / stop ----
async function cmdStatus() {
  requireAccount();
  const [user, dev, ch] = await Promise.all([getUserInfo(), getDeviceInfo(), isCharging()]);
  console.log(`余额：${yuan(user.readyaccountmoney)}｜设备：${dev.devdescript ?? "?"}｜端口：${dev.portstatur}`);
  console.log(ch ? `⚠️ 充电中：插座 ${ch.devport}，${ch.begindt} 起，预扣 ${yuan(ch.yfMoney)}` : "当前没有充电订单。");
  return 0;
}
async function cmdStop() {
  requireAccount();
  const ch = await isCharging();
  if (!ch) return console.log("当前没有充电订单。"), 0;
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
  if (!r1.success) return console.log(`结束充电失败：${r1.msg}`), 1;
  const r2 = await post("offCharge", { ...base, count: 2, msgflag: r1.obj });
  if (r2.success) {
    console.log(`✅ 已断电（插座 ${ch.devport}），退款约 30 秒到账。`);
    return 0;
  }
  console.log(`断电确认失败：${r2.msg}，请到微信里手动结束。`);
  return 1;
}

// ---- 入口 ----
const actions = {
  login: cmdLogin,
  status: cmdStatus,
  start: () => {
    requireAccount();
    return startCharging(CONFIG.devaddress, CONFIG.port, CONFIG.retryMinutes);
  },
  chargeon: cmdChargeOn,
  stop: cmdStop,
  serve: cmdServe,
};
const cmd = process.argv[2] ?? "status";
if (!actions[cmd]) {
  console.log(
    "浙江大学尼普顿定时开电\n" +
      "用法: node neptune.mjs <login|status|chargeon|start|stop|serve>\n" +
      "  login     配置向导（一次即可）\n" +
      "  chargeon  预约下一个 6:30 自动开电：chargeon [设备号] [插座号]\n" +
      "            chargeon cancel = 取消预约\n" +
      "  start     立即开电（用配置里的桩位，带重试窗口，定时任务用）\n" +
      "  stop      结束充电\n" +
      "  status    余额 / 订单 / 端口状态\n" +
      "  serve     预约执行器（通常无需手动运行：chargeon 会自动拉起，队列空自动退出）"
  );
  process.exit(2);
}
try {
  process.exit((await actions[cmd](process.argv[3], process.argv[4], process.argv[5])) ?? 0);
} catch (err) {
  console.log(`执行出错：${err.message}`);
  process.exit(1);
}
