import http from "node:http";

/**
 * 一个假的 OpenAI 兼容服务，用来在没有真实密钥时验证评测流水线。
 * 它按 system prompt 判断调用的是 judge 还是 agent，返回格式合法的响应。
 */
const s = http.createServer((req, res) => {
  let body = "";
  req.on("data", (chunk) => (body += chunk));
  req.on("end", () => {
    const payload = JSON.parse(body || "{}");
    const system = (payload.messages?.[0]?.content ?? "").includes("评测员");
    const user = payload.messages?.[1]?.content ?? "";
    const file = /### ([^\s:]+):(\d+)-(\d+)/.exec(user)?.[1] ?? "src/app.py";
    const content = system
      ? JSON.stringify({
          score: 4,
          reason: "覆盖了大部分要点",
          hitPoints: ["要点一"],
          missedPoints: [],
        })
      : `这个行为由主流程控制。[${file}:1-10]`;
    res.setHeader("Content-Type", "application/json");
    res.end(
      JSON.stringify({
        id: "mock",
        choices: [{ message: { role: "assistant", content } }],
        usage: {
          prompt_tokens: 1200,
          completion_tokens: 300,
          prompt_cache_hit_tokens: 800,
          prompt_cache_miss_tokens: 400,
        },
      }),
    );
  });
});

s.listen(8799, "127.0.0.1", () => console.log("mock llm up on 8799"));
