#!/usr/bin/env node
/**
 * Tiny loopback page shown immediately when beautiCode starts DSH.
 * DSH cannot serve its real UI until the plugin tree is up; this page
 * holds the browser tab and jumps to DSH as soon as the bridge answers.
 */
import http from "node:http";

const target = process.argv[2] || "http://127.0.0.1:3080";
const port = Number(process.argv[3] || "3099");
if (!Number.isInteger(port) || port < 1 || port > 65535) {
  process.stderr.write("port must be 1-65535\n");
  process.exit(1);
}

const html = `<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>beautiCode · 正在打开 DeepSeek Harness</title>
  <style>
    html, body { height: 100%; margin: 0; background: #1E201D; color: #F1EEE7;
      font-family: "Microsoft YaHei UI", "Segoe UI", sans-serif; }
    main { min-height: 100%; display: flex; flex-direction: column;
      align-items: center; justify-content: center; gap: 12px; }
    h1 { margin: 0; font-size: 22px; }
    p { margin: 0; color: #9CA198; font-size: 14px; }
    .mark { width: 54px; height: 54px; border-radius: 14px; background: #242723;
      display: grid; place-items: center; color: #86AA91; font-weight: 700; font-size: 20px; }
  </style>
</head>
<body>
  <main>
    <div class="mark">美</div>
    <h1>正在打开 DeepSeek Harness</h1>
    <p id="status">先加载页面，插件树随后就绪</p>
  </main>
  <script>
    const target = ${JSON.stringify(target.replace(/\/$/, ""))};
    const status = document.getElementById("status");
    let n = 0;
    async function tick() {
      n += 1;
      try {
        const res = await fetch(target + "/__beauticode/version", { cache: "no-store" });
        if (res.ok) {
          status.textContent = "已成功启动，正在进入…";
          location.replace(target + "/");
          return;
        }
      } catch {}
      status.textContent = n < 8
        ? "先加载页面，插件树随后就绪"
        : "插件树仍在加载，请稍候…";
      setTimeout(tick, 400);
    }
    tick();
  </script>
</body>
</html>
`;

const server = http.createServer((req, res) => {
  const url = req.url?.split("?")[0] ?? "/";
  if (url === "/health") {
    res.writeHead(200, { "Content-Type": "text/plain; charset=utf-8" });
    res.end("ok");
    return;
  }
  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
});

server.listen(port, "127.0.0.1", () => {
  process.stdout.write(`http://127.0.0.1:${port}/\n`);
});

setTimeout(() => {
  try { server.close(); } catch {}
  process.exit(0);
}, 180_000);
