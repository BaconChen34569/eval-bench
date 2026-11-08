// 移动端横向溢出审计：找出比视口宽的元素。
// 用法：node scripts/audit-mobile.mjs <url> [宽度] [高度]
import { spawn } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, widthArg, heightArg] = process.argv.slice(2);
const width = Number(widthArg ?? 390);
const height = Number(heightArg ?? 844);

const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const profile = await mkdtemp(join(tmpdir(), "audit-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    "--remote-debugging-port=0",
    `--user-data-dir=${profile}`,
    `--window-size=${width},${height}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

const cleanup = async () => {
  chrome.kill();
  await rm(profile, { recursive: true, force: true }).catch(() => {});
};

async function waitForPort() {
  const file = join(profile, "DevToolsActivePort");
  for (let i = 0; i < 100; i++) {
    const content = await readFile(file, "utf8").catch(() => null);
    if (content) {
      const port = Number(content.split("\n")[0]);
      if (port > 0) return port;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Chrome 没有报告调试端口");
}

const port = await waitForPort();
const target = await fetch(
  `http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`,
  { method: "PUT" },
).then((r) => r.json());

const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((resolve, reject) => {
  socket.addEventListener("open", resolve, { once: true });
  socket.addEventListener("error", reject, { once: true });
});

let nextId = 0;
const pending = new Map();
const events = new Map();
socket.addEventListener("message", (event) => {
  const message = JSON.parse(event.data);
  if (message.id !== undefined) {
    const entry = pending.get(message.id);
    pending.delete(message.id);
    if (message.error) entry.reject(new Error(message.error.message));
    else entry.resolve(message.result);
    return;
  }
  const waiters = events.get(message.method);
  if (waiters) {
    events.delete(message.method);
    for (const waiter of waiters) waiter(message.message ?? message.params);
  }
});
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
const waitFor = (method, timeoutMs = 20000) =>
  new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`等待 ${method} 超时`)), timeoutMs);
    const waiter = (params) => {
      clearTimeout(timer);
      resolve(params);
    };
    events.set(method, [...(events.get(method) ?? []), waiter]);
  });

await send("Page.enable");
await send("Runtime.enable");
await send("Emulation.setDeviceMetricsOverride", {
  width,
  height,
  deviceScaleFactor: 1,
  mobile: true,
});

const loaded = waitFor("Page.loadEventFired");
await send("Page.navigate", { url });
await loaded;
await new Promise((r) => setTimeout(r, 2500));

const result = await send("Runtime.evaluate", {
  expression: `(() => {
    const vw = document.documentElement.clientWidth;
    const desc = (el) => {
      let s = el.tagName.toLowerCase();
      if (typeof el.className === "string" && el.className.trim()) {
        s += "." + el.className.trim().split(/\\s+/).slice(0, 5).join(".");
      }
      return s;
    };
    // 自身内容比视口宽（真正的溢出源），且父元素没有更宽
    const out = [];
    for (const el of document.querySelectorAll("body *")) {
      const r = el.getBoundingClientRect();
      if (r.width === 0) continue;
      if (r.width <= vw + 1) continue;
      const p = el.parentElement;
      const pw = p ? p.getBoundingClientRect().width : 0;
      // 只留最外层：父元素不比它宽
      if (p && pw >= r.width - 1 && pw > vw + 1) continue;
      const cs = getComputedStyle(el);
      out.push({
        tag: el.tagName.toLowerCase(),
        cls: (typeof el.className === "string" ? el.className : "").slice(0, 160),
        w: Math.round(r.width),
        left: Math.round(r.left),
        minWidth: cs.minWidth,
        overflowX: cs.overflowX,
        display: cs.display,
        text: (el.textContent || "").trim().slice(0, 50),
        parent: p ? desc(p).slice(0, 120) : null,
      });
    }
    // 顶层节点宽度
    const tops = [...document.body.children].map((el) => ({
      tag: el.tagName.toLowerCase(),
      cls: (typeof el.className === "string" ? el.className : "").slice(0, 100),
      w: Math.round(el.getBoundingClientRect().width),
      scrollW: el.scrollWidth,
    }));
    return {
      vw,
      docScrollW: document.documentElement.scrollWidth,
      tops,
      count: out.length,
      items: out.slice(0, 40),
    };
  })()`,
  returnByValue: true,
});

console.log(JSON.stringify(result.result.value, null, 2));
socket.close();
await cleanup();
process.exit(0);
