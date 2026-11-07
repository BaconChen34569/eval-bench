// 用 Chrome DevTools Protocol 截取页面某个板块。
// 站点是客户端渲染的，直接给 URL 加 #hash 截图经常拍到空白，所以这里等渲染完成后再滚到目标板块再截。
//
// 用法：node scripts/shot.mjs <url> <css选择器> <输出路径> [宽度] [高度] [缩放] [点击前的JS表达式]
// 点击前的 JS 表达式用于展开折叠面板，例如点击第一道题的展开按钮。

import { spawn } from "node:child_process";
import { mkdtemp, readFile, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const [url, selector, outPath, widthArg, heightArg, scaleArg, prelude] =
  process.argv.slice(2);

if (!url || !selector || !outPath) {
  console.error("用法：node scripts/shot.mjs <url> <css选择器> <输出路径> [宽度] [高度] [缩放]");
  process.exit(1);
}

const width = Number(widthArg ?? 1440);
const height = Number(heightArg ?? 900);
const scale = Number(scaleArg ?? 2);

const CHROME =
  process.env.CHROME_PATH ??
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";

const profile = await mkdtemp(join(tmpdir(), "shot-"));
const chrome = spawn(
  CHROME,
  [
    "--headless=new",
    "--disable-gpu",
    "--hide-scrollbars",
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=0`,
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

const target = await fetch(`http://127.0.0.1:${port}/json/new?${encodeURIComponent(url)}`, {
  method: "PUT",
}).then((response) => response.json());

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
    for (const waiter of waiters) waiter(message.params);
  }
});

const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });

const waitFor = (method, timeoutMs = 15000) =>
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
  deviceScaleFactor: scale,
  mobile: false,
});

const loaded = waitFor("Page.loadEventFired");
await send("Page.navigate", { url });
await loaded;

// 等客户端渲染把内容填进去，再滚到目标板块
await new Promise((resolve) => setTimeout(resolve, 2000));

if (prelude) {
  await send("Runtime.evaluate", { expression: prelude, awaitPromise: true });
  await new Promise((resolve) => setTimeout(resolve, 600));
}

const isViewport = selector === "viewport";

const box = await send("Runtime.evaluate", {
  expression: `(() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      x: rect.left + window.scrollX,
      y: rect.top + window.scrollY,
      width: rect.width,
      height: rect.height,
    };
  })()`,
  returnByValue: true,
});

// selector 传 viewport 时截当前可见区域，sticky 导航不会盖住标题。
let x = 0;
let y = 0;
let boxWidth = 0;
let boxHeight = 0;

if (isViewport) {
  const view = await send("Runtime.evaluate", {
    expression: `({ x: 0, y: window.scrollY, width: window.innerWidth, height: window.innerHeight })`,
    returnByValue: true,
  });
  ({ x, y, width: boxWidth, height: boxHeight } = view.result.value);
} else {
  if (!box.result.value) throw new Error(`找不到元素：${selector}`);
  ({ x, y, width: boxWidth, height: boxHeight } = box.result.value);
  await send("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)}).scrollIntoView({block: "start"})`,
  });
  await new Promise((resolve) => setTimeout(resolve, 400));
}

const shot = await send("Page.captureScreenshot", {
  format: "png",
  captureBeyondViewport: true,
  clip: {
    x,
    y,
    width: boxWidth,
    height: boxHeight,
    scale,
  },
});

await writeFile(outPath, Buffer.from(shot.data, "base64"));
console.log(`已保存 ${outPath}（${Math.round(boxWidth)}x${Math.round(boxHeight)} @${scale}x）`);

socket.close();
await cleanup();
process.exit(0);
