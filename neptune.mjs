#!/usr/bin/env node
// 浙江大学尼普顿充电桩工具
// 协议由作者本人账号抓包还原，仅操作本人账号（扣账户预存款）。
// 命令：login 配置 / chargeon 预约下一个北京时间 6:30 / chargeon cancel 取消 / status / stop

import { readFileSync, writeFileSync, writeSync, renameSync, openSync, closeSync, unlinkSync } from "node:fs";
import { spawn, execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";

const DIR = dirname(fileURLToPath(import.meta.url));
const CONFIG_FILE = join(DIR, "neptune.config.local.json");
const BASE = "https://www.szlzxn.cn/wxn";
const LOCAL = (() => {
  try {
    return JSON.parse(readFileSync(CONFIG_FILE, "utf8"));
  } catch (err) {
    if (err.code === "ENOENT") return {};
    console.log(`配置文件 ${CONFIG_FILE} 无法解析（${err.message}），请修正或删除后重新 login。`);
    process.exit(2);
  }
})();
const CONFIG = {
  areaId: LOCAL.areaId || "6",
  openId: LOCAL.openId || "",
  money: LOCAL.money || "7", // 页面开电时的金额选项（对应预扣 ¥2）
  retryMinutes: Number(LOCAL.retryMinutes ?? 15), // 桩 6:35 才上线的重试窗口
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const yuan = (fen) => `¥${((fen || 0) / 100).toFixed(2)}`;
// 原子写：先写临时文件再 rename，避免中途崩溃留下半截 JSON；0600 防止 openId 被其他用户读取
function writeJsonAtomic(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  renameSync(tmp, file);
}
// 这些错误发生在连接建立之前，请求必然未到达服务器，写操作重发也不会重复下单
const PRE_SEND = new Set(["ENOTFOUND", "EAI_AGAIN", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);
const notSent = (err) => PRE_SEND.has(err?.cause?.code);

async function post(path, data) {
  const body = new URLSearchParams(data).toString();
  const readOnly = ["getUserInfo", "getDeviceInfo", "isChargeing"].includes(path);
  const attempts = readOnly ? 2 : 1;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const resp = await fetch(`${BASE}/${path}`, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8" },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
      const result = await resp.json();
      if (!result || typeof result.success !== "boolean") throw new Error("接口返回格式异常");
      if (readOnly && !result.success) throw new Error(result.msg || "查询失败");
      return result;
    } catch (err) {
      if (!readOnly) {
        if (notSent(err)) {
          throw Object.assign(new Error(`网络不可用，请求未发出（${err.cause.code}）`, { cause: err }), { retryable: true });
        }
        throw new Error(`请求结果未确认，未自动重发；请用 status 或微信确认（${err.message}）`, { cause: err });
      }
      if (attempt === attempts) throw Object.assign(err, { retryable: true });
      await sleep(2000);
    }
  }
}

const getUserInfo = async () =>
  (await post("getUserInfo", { openId: CONFIG.openId, areaId: CONFIG.areaId })).obj ?? {};
const getDeviceInfo = async (devaddress) =>
  (await post("getDeviceInfo", { areaId: CONFIG.areaId, devaddress })).obj ?? {};
const isCharging = async () =>
  (await post("isChargeing", { areaId: CONFIG.areaId, openId: CONFIG.openId })).obj ?? null;

function requireOpenId() {
  if (!CONFIG.openId) {
    console.log("缺少账号配置，先运行：node neptune.mjs login");
    process.exit(2);
  }
}

function requireRetryMinutes() {
  if (!Number.isFinite(CONFIG.retryMinutes) || CONFIG.retryMinutes < 0) {
    throw new Error("retryMinutes 必须是大于等于 0 的有限数字。");
  }
}

// ---- 开电核心：两阶段指令（拿流水→轮询确认）+ 失败重试窗口 ----
async function startCharging(devaddress, port, retryMinutes = 0) {
  const deadline = Date.now() + retryMinutes * 60_000;
  const retry = async (msg) => {
    if (Date.now() + 30_000 > deadline) return false;
    console.log(`${msg}，30 秒后重试…`);
    await sleep(30_000);
    return true;
  };

  for (let attempt = 1; ; attempt++) {
    try {
      // 每轮先查订单：既避免重复下单，也能发现"上一轮其实已成功"
      const ch = await isCharging();
      if (ch) {
        console.log(
          attempt === 1
            ? `已有充电订单（插座 ${ch.devport}，${ch.begindt} 开始）。`
            : `检测到订单已创建（插座 ${ch.devport}）。`
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
      if (dev.isWorkTime === 0) console.log(`设备未在营业时间（${dev.workTime ?? "?"}）`);

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

      // 阶段 1：下发指令，拿流水号
      const r = await post("beginCharge", base);
      if (!r.success) {
        if (await retry(`开电失败（${r.msg}）`)) continue;
        console.log(`开电失败：${r.msg}`);
        return 1;
      }
      const msgflag = r.obj;
      if ((typeof msgflag !== "string" && typeof msgflag !== "number") || String(msgflag).trim() === "") {
        throw new Error("开电接口未返回有效流水号；请用 status 或微信确认，勿重复下单。");
      }
      console.log(`指令已下发（流水 ${msgflag}），等待设备确认…`);

      // 阶段 2：轮询确认
      for (let i = 1; i <= 6; i++) {
        await sleep(3000);
        let result;
        try {
          result = await post("beginCharge", { ...base, msgflag });
        } catch (err) {
          // 带流水号的确认请求本就会重复发送，网络抖动时继续轮询即可
          console.log(`确认请求异常（${err.cause?.message ?? err.message}），第 ${i}/6 次轮询…`);
          continue;
        }
        if (result.success) {
          const obj = result.obj ?? {};
          console.log(
            `开电成功：设备 ${devaddress} 插座 ${port}，${obj.begindt ?? ""} 起，预扣 ${yuan(obj.yfMoney)}，最长 ${obj.ycTime ?? 0} 分钟` +
              (attempt > 1 ? `（重试 ${attempt - 1} 次后成功）` : "")
          );
          return 0;
        }
        console.log(`设备无响应，第 ${i}/6 次轮询…`);
      }

      const pending = await isCharging();
      if (pending) {
        console.log(`订单已创建（插座 ${pending.devport}），设备尚未确认，请用 status 或微信确认。`);
        return 0;
      }
      if (await retry("设备无响应")) continue;
      console.log("设备持续无响应，开电可能失败。请检查充电器是否插好，并用 status 确认。");
      return 1;
    } catch (err) {
      // 网络不通（如刚唤醒 Wi-Fi 未连上）也走重试窗口；仅限查询失败或请求确定未发出的情况
      if (err.retryable && (await retry(`网络异常（${err.cause?.code ?? err.message}）`))) continue;
      throw err;
    }
  }
}

// ---- login：配置向导 ----
async function cmdLogin() {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    console.log("\n请查看 README.md 获取充电页链接。链接含 openId，请勿外传。\n");
    const link = (await rl.question("粘贴链接: ")).trim().replace(/&amp;/g, "&");
    if (/open\.weixin\.qq\.com\/connect\/oauth2\/authorize/.test(link)) {
      console.log("这是 OAuth 中间页，没有 openId。请在微信里等充电页完整显示后再复制链接。");
      return 1;
    }
    let openId = "";
    let areaId = CONFIG.areaId;
    try {
      const u = new URL(link);
      openId = u.searchParams.get("openId") || "";
      areaId = u.searchParams.get("areaid") || areaId;
    } catch {}
    if (!openId) {
      console.log("未解析到 openId，请粘贴充电页链接（…indexn.html?openId=…）。");
      return 1;
    }

    const user = (await post("getUserInfo", { openId, areaId })).obj;
    if (!user?.employeeid) {
      console.log("openId 无效，请重新复制链接。");
      return 1;
    }
    console.log(`账号有效：id=${user.employeeid}，余额 ${yuan(user.readyaccountmoney)}`);

    const merged = { ...LOCAL, areaId, openId };
    for (const key of ["employeeId", "devaddress", "port"]) delete merged[key];
    writeJsonAtomic(CONFIG_FILE, merged);
    console.log("\n配置已写入。\n预约开电：node neptune.mjs chargeon <设备号> <插座号>");
    return 0;
  } finally {
    rl.close();
  }
}

// ---- chargeon：预约下一个北京时间 6:30 / cancel 取消 ----
function nextChargeTime() {
  const now = Date.now();
  const bj = new Date(now + 8 * 3600_000); // 用 getUTC* 读出北京墙钟
  let target = Date.UTC(bj.getUTCFullYear(), bj.getUTCMonth(), bj.getUTCDate(), 6 - 8, 30);
  if (target <= now) target += 86400_000;
  return new Date(target);
}
function bjFormat(t) {
  const pad2 = (n) => String(n).padStart(2, "0");
  const b = new Date(t.getTime() + 8 * 3600_000);
  return `${b.getUTCFullYear()}-${pad2(b.getUTCMonth() + 1)}-${pad2(b.getUTCDate())} ${pad2(b.getUTCHours())}:${pad2(b.getUTCMinutes())}`;
}
async function cmdChargeOn(a = "", b = "") {
  if (a === "cancel") {
    saveAppointments([]);
    console.log("已取消预约。");
    return 0;
  }

  requireOpenId();
  const devaddress = a.trim();
  const port = b.trim();
  if (!/^\d{6,}$/.test(devaddress) || !/^\d{2}$/.test(port)) {
    console.log('用法: node neptune.mjs chargeon <设备号> <插座号>   例: chargeon 50359162 04');
    return 1;
  }
  requireRetryMinutes();
  const t = nextChargeTime();
  const timeLocal = bjFormat(t);
  saveAppointments([{ time: t.toISOString(), timeLocal, devaddress, port }]);
  ensureServeRunning();
  console.log(`已预约 ${timeLocal} 自动开电：设备 ${devaddress} 插座 ${port}\n取消：node neptune.mjs chargeon cancel`);
  return 0;
}
// ---- serve：预约执行器（轮询队列文件，到点开电，队列空自动退出）----
const APPT_FILE = join(DIR, "neptune.serve.json");
const PID_FILE = join(DIR, "neptune.serve.pid");
/** 确保执行器（serve）在后台运行：不在则自动拉起，等价于 nohup ... & */
function readPid() {
  try {
    const pid = Number(readFileSync(PID_FILE, "utf8").trim());
    return Number.isSafeInteger(pid) && pid > 0 ? pid : 0;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return 0;
  }
}
/** pid 存活且确实是本工具的 serve（防止重启后 PID 被其他进程复用） */
function isServeAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
  } catch (err) {
    if (err.code !== "EPERM") return false;
  }
  try {
    return execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).includes("neptune.mjs serve");
  } catch {
    return true; // 无 ps 可用时保守认为存活
  }
}
/** 单实例锁：O_EXCL 创建 PID 文件是原子的，并发启动的多个 serve 只有一个能拿到 */
function acquireLock() {
  try {
    const fd = openSync(PID_FILE, "wx", 0o600);
    writeSync(fd, String(process.pid));
    closeSync(fd);
    return true;
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
    if (isServeAlive(readPid())) return false;
    unlinkSync(PID_FILE); // 清理失效的锁后重试
    return acquireLock();
  }
}
function releaseLock() {
  try {
    if (readPid() === process.pid) unlinkSync(PID_FILE);
  } catch {}
}
function ensureServeRunning() {
  // 仅为提示用的快速路径；真正的互斥由 serve 内的 acquireLock 保证
  if (isServeAlive(readPid())) return console.log("执行器已在运行，复用现有进程。");
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
    const appointments = JSON.parse(readFileSync(APPT_FILE, "utf8"));
    if (!Array.isArray(appointments)) throw new Error("预约文件必须是数组。");
    // 无效时间会让预约永远不到点、执行器永不退出，加载时直接剔除
    const valid = appointments.filter(
      (a) => Number.isFinite(Date.parse(a?.time)) && /^\d{6,}$/.test(a?.devaddress) && /^\d{2}$/.test(a?.port)
    );
    if (valid.length !== appointments.length) console.log(`[serve] 忽略 ${appointments.length - valid.length} 条格式无效的预约`);
    return valid;
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
    return [];
  }
}
function saveAppointments(list) {
  writeJsonAtomic(APPT_FILE, list);
}
async function cmdServe() {
  requireOpenId();
  requireRetryMinutes();
  if (!acquireLock()) {
    console.log("[serve] 已有执行器在运行，本进程退出。");
    return 0;
  }
  // finally 在信号或 process.exit 下不会执行，用 exit 事件同步清理锁
  process.on("exit", releaseLock);
  process.once("SIGTERM", () => process.exit(143));
  process.once("SIGINT", () => process.exit(130));
  console.log(`[serve] 执行器已启动（pid ${process.pid}），轮询预约队列中…`);
  // 串行等待，无需 setInterval 的 firing 标记；最多每 20 秒重读外部预约。
  while (true) {
    const appointments = loadAppointments();
    if (appointments.length === 0) {
      console.log("[serve] 队列为空，执行器退出。下次 chargeon 会自动拉起。");
      return 0;
    }
    const now = Date.now();
    const due = appointments.find((a) => new Date(a.time).getTime() <= now);
    if (due) {
      saveAppointments(appointments.filter((a) => a !== due));
      if (now - new Date(due.time).getTime() > 3600_000) {
        console.log(`[serve] 丢弃过期预约 ${due.timeLocal}`);
        continue;
      }
      console.log(`[serve] 预约到点：设备 ${due.devaddress} 插座 ${due.port}，执行开电…`);
      let code;
      try {
        code = await startCharging(due.devaddress, due.port, CONFIG.retryMinutes);
      } catch (err) {
        console.log(`[serve] 开电异常：${err.message}`);
        code = 1;
      }
      console.log(`[serve] 开电流程结束，exit=${code}`);
      if (loadAppointments().length === 0) return code;
      continue;
    }
    // 睡到最近的预约时间以准点触发；上限 20 秒，兼顾外部改动和系统休眠后的时钟跳变
    const next = Math.min(...appointments.map((a) => Date.parse(a.time)));
    await sleep(Math.max(0, Math.min(20_000, next - Date.now())));
  }
}

// ---- status / stop ----
async function cmdStatus() {
  requireOpenId();
  const [user, ch] = await Promise.all([getUserInfo(), isCharging()]);
  console.log(`余额：${yuan(user.readyaccountmoney)}`);
  console.log(ch ? `充电中：插座 ${ch.devport}，${ch.begindt} 起，预扣 ${yuan(ch.yfMoney)}` : "当前没有充电订单。");
  return 0;
}

async function cmdStop() {
  requireOpenId();
  const ch = await isCharging();
  if (!ch) return console.log("当前没有充电订单。"), 0;
  const user = await getUserInfo();
  if (!user.employeeid) throw new Error("未获取到用户编号，无法安全停止充电；请到微信里手动结束。");
  const base = {
    devaddress: ch.devaddress,
    port: ch.devport,
    openId: CONFIG.openId,
    employeeid: user.employeeid,
    beforemoney: user.readyaccountmoney ?? 0,
    edtType: 0,
    count: 1,
  };
  const r1 = await post("offCharge", base);
  if (!r1.success) return console.log(`结束充电失败：${r1.msg}`), 1;
  if ((typeof r1.obj !== "string" && typeof r1.obj !== "number") || String(r1.obj).trim() === "") {
    throw new Error("停电接口未返回有效流水号；请用 status 或微信确认。");
  }
  const r2 = await post("offCharge", { ...base, count: 2, msgflag: r1.obj });
  if (r2.success) {
    console.log(`已断电（插座 ${ch.devport}），退款约 30 秒到账。`);
    return 0;
  }
  console.log(`断电确认失败：${r2.msg}，请到微信里手动结束。`);
  return 1;
}

// ---- 入口 ----
const actions = { login: cmdLogin, status: cmdStatus, chargeon: cmdChargeOn, stop: cmdStop, serve: cmdServe };
const [cmd = "status", ...args] = process.argv.slice(2);
const help = cmd === "--help" || cmd === "help" || cmd === "-h";
if (help || !Object.hasOwn(actions, cmd)) {
  console.log(
    "浙江大学尼普顿定时开电\n" +
      "用法: node neptune.mjs <login|status|chargeon|stop|serve>\n" +
      "  login                      配置向导（一次即可）\n" +
      "  chargeon <设备号> <插座号>  预约下一个北京时间 6:30 自动开电\n" +
      "  chargeon cancel            取消尚未执行的预约\n" +
      "  stop                       结束当前充电\n" +
      "  status                     余额 / 充电订单\n" +
      "  serve                      后台预约执行器（通常无需手动运行）"
  );
  process.exit(help ? 0 : 2);
}
const expectedArgs = cmd === "chargeon" ? (args[0] === "cancel" ? 1 : 2) : 0;
if (args.length !== expectedArgs) {
  console.log("参数有误，运行 node neptune.mjs --help 查看用法。");
  process.exit(2);
}
try {
  process.exit((await actions[cmd](...args)) ?? 0);
} catch (err) {
  console.log(`执行出错：${err.message}`);
  process.exit(1);
}
